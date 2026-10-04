import { EventEmitter } from 'events';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TypedEventEmitter, type MatrixClient } from 'matrix-js-sdk';
import {
  CryptoEvent,
  VerificationPhase,
  VerificationRequestEvent,
  VerifierEvent,
  type ShowQrCodeCallbacks,
  type ShowSasCallbacks,
  type VerificationRequest,
  type VerificationRequestEventHandlerMap,
  type Verifier,
  type VerifierEventHandlerMap,
} from 'matrix-js-sdk/lib/crypto-api';
import {
  attachVerificationListeners,
  cancelVerificationRequest,
  confirmVerificationRequest,
  declineVerificationRequest,
  pickUpPendingVerificationRequests,
  requestVerificationForMyOtherSessions,
  requestVerificationToUser,
} from '@/app/utils/matrix/verification';
import { state } from '@/app/utils/matrix/state';
import { emitVerificationSnapshot } from '@/app/utils/matrix/events';
import type { VerificationSnapshot } from '@/app/utils/matrix/types';

vi.mock('@/app/utils/matrix/events', () => ({
  emitVerificationSnapshot: vi.fn(),
}));

const ME = '@testuser:matrix.org';
const OTHER = '@other:matrix.org';

/* Implements the SDK Verifier interface; the SAS codes appear the way the SDK announces them once keys are exchanged */
class SdkVerifier extends TypedEventEmitter<VerifierEvent, VerifierEventHandlerMap> implements Verifier {
  public readonly userId = OTHER;
  public readonly hasBeenCancelled = false;
  public sasCallbacks: ShowSasCallbacks | null = null;
  /* verify() settles only when the comparison ends, so by default it stays pending like a comparison in progress */
  public readonly verify = vi.fn(() => new Promise<void>(() => {}));
  public readonly cancel = vi.fn();

  public getShowSasCallbacks(): ShowSasCallbacks | null {
    return this.sasCallbacks;
  }

  public getReciprocateQrCodeCallbacks(): ShowQrCodeCallbacks | null {
    return null;
  }

  public showSas(): ShowSasCallbacks {
    this.sasCallbacks = {
      sas: { emoji: [['🐶', 'Dog'], ['🐱', 'Cat'], ['🦁', 'Lion']], decimal: [1234, 5678, 9012] },
      confirm: vi.fn(async () => {}),
      mismatch: vi.fn(),
      cancel: vi.fn(),
    };
    this.emit(VerifierEvent.ShowSas, this.sasCallbacks);
    return this.sasCallbacks;
  }
}

/* Implements the SDK VerificationRequest interface, including the numeric VerificationPhase and its Change event */
class SdkVerificationRequest
  extends TypedEventEmitter<VerificationRequestEvent, VerificationRequestEventHandlerMap>
  implements VerificationRequest
{
  public phase: VerificationPhase = VerificationPhase.Requested;
  public verifier: Verifier | undefined = undefined;
  public cancellationCode: string | null = null;
  public readonly roomId: string | undefined = undefined;
  public readonly isSelfVerification = false;
  public readonly accepting = false;
  public readonly declining = false;
  public readonly timeout: number | null = null;
  public readonly methods: string[] = ['m.sas.v1'];
  public readonly chosenMethod: string | null = null;
  public readonly cancellingUserId: string | undefined = undefined;
  public readonly otherPartySupportsMethod = vi.fn((method: string) => method === 'm.sas.v1');
  public readonly accept = vi.fn(async () => this.moveTo(VerificationPhase.Ready));
  public readonly cancel = vi.fn(async () => this.moveTo(VerificationPhase.Cancelled));
  public readonly startVerification = vi.fn(async (_method: string): Promise<Verifier> => {
    const verifier = new SdkVerifier();
    this.verifier = verifier;
    this.moveTo(VerificationPhase.Started);
    return verifier;
  });
  public readonly scanQRCode = vi.fn(async (_data: Uint8ClampedArray): Promise<Verifier> => {
    throw new Error('QR codes are not offered by the app');
  });
  public readonly generateQRCode = vi.fn(async (): Promise<Uint8ClampedArray | undefined> => undefined);

  public constructor(
    public readonly transactionId: string,
    public readonly otherUserId = OTHER,
    public readonly otherDeviceId: string | undefined = 'OTHERDEVICE',
    public readonly initiatedByMe = false
  ) {
    super();
  }

  public get pending(): boolean {
    return [VerificationPhase.Requested, VerificationPhase.Ready, VerificationPhase.Started].includes(this.phase);
  }

  /* Sets the phase and emits Change, which is how the SDK announces every transition of a request */
  public moveTo(phase: VerificationPhase) {
    this.phase = phase;
    this.emit(VerificationRequestEvent.Change);
  }
}

/* A client whose crypto API hands out the given requests, with the SDK's real event plumbing */
const createClient = (requests: { outgoing?: SdkVerificationRequest; inProgress?: SdkVerificationRequest[] } = {}) => {
  const crypto = {
    requestOwnUserVerification: vi.fn(async () => requests.outgoing!),
    requestDeviceVerification: vi.fn(async () => requests.outgoing!),
    getVerificationRequestsToDeviceInProgress: vi.fn((): VerificationRequest[] => requests.inProgress ?? []),
  };
  const client = Object.assign(new EventEmitter(), {
    getUserId: () => ME,
    getCrypto: () => crypto,
  });
  return { client, crypto };
};

/* Delivers an incoming request through the listener the app attaches when the client starts */
const receive = (request: SdkVerificationRequest) => {
  const { client } = createClient();
  attachVerificationListeners(client as unknown as MatrixClient);
  client.emit(CryptoEvent.VerificationRequestReceived, request);
  return request;
};

/* The newest snapshot emitted for a request, which is what the UI reads from matrix-verification-request */
const latestSnapshot = (id: string): VerificationSnapshot | undefined =>
  vi.mocked(emitVerificationSnapshot).mock.calls.map(([snap]) => snap).filter((snap) => snap.id === id).at(-1);

/* Lets promise callbacks queued by the code under test run */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  state.verificationReqMap.clear();
  state.verificationSnapMap.clear();
  state.matrixClient = null;
});

describe('snapshot phases for SDK VerificationPhase values', () => {
  it('reports a newly received request as requested', () => {
    receive(new SdkVerificationRequest('txn-new'));

    expect(latestSnapshot('txn-new')).toMatchObject({ phase: 'requested', fromUserId: OTHER, fromDeviceId: 'OTHERDEVICE', outgoing: false });
  });

  it('reports an accepted request as ready', () => {
    const request = receive(new SdkVerificationRequest('txn-ready'));

    request.moveTo(VerificationPhase.Ready);

    expect(latestSnapshot('txn-ready')?.phase).toBe('ready');
  });

  it('reports a cancelled request as cancelled with the reason', () => {
    const request = receive(new SdkVerificationRequest('txn-timeout'));

    request.cancellationCode = 'm.timeout';
    request.moveTo(VerificationPhase.Cancelled);

    expect(latestSnapshot('txn-timeout')).toMatchObject({ phase: 'cancelled', cancelReason: 'The request timed out.' });
  });

  it('reports a completed request as done', () => {
    const request = receive(new SdkVerificationRequest('txn-done'));

    request.moveTo(VerificationPhase.Done);

    expect(latestSnapshot('txn-done')?.phase).toBe('done');
  });

  it('shows the emoji once the comparison has started', async () => {
    const request = receive(new SdkVerificationRequest('txn-sas'));
    const verifier = await request.startVerification('m.sas.v1');

    (verifier as SdkVerifier).showSas();

    expect(latestSnapshot('txn-sas')).toMatchObject({
      phase: 'showing_sas',
      sasEmojis: ['🐶', '🐱', '🦁'],
      sasDecimals: [1234, 5678, 9012],
    });
  });

  it('reports a cancelled comparison as cancelled although its emoji remain', async () => {
    const request = receive(new SdkVerificationRequest('txn-sas-cancelled'));
    const verifier = (await request.startVerification('m.sas.v1')) as SdkVerifier;
    verifier.showSas();

    request.moveTo(VerificationPhase.Cancelled);

    expect(latestSnapshot('txn-sas-cancelled')).toMatchObject({ phase: 'cancelled', sasEmojis: undefined });
  });
});

describe('answering a request', () => {
  it('accepts an incoming request and starts the emoji comparison at once', async () => {
    const request = receive(new SdkVerificationRequest('txn-accept'));

    await confirmVerificationRequest('txn-accept');

    expect(request.accept).toHaveBeenCalled();
    expect(request.startVerification).toHaveBeenCalledWith('m.sas.v1');
    expect((request.verifier as SdkVerifier).verify).toHaveBeenCalled();
  });

  it('joins the comparison the other device started instead of starting another', async () => {
    const request = receive(new SdkVerificationRequest('txn-joined'));
    request.verifier = new SdkVerifier();
    request.moveTo(VerificationPhase.Started);

    await confirmVerificationRequest('txn-joined');

    expect(request.startVerification).not.toHaveBeenCalled();
    expect((request.verifier as SdkVerifier).verify).toHaveBeenCalled();
  });

  it('confirms matching emoji on the comparison screen', async () => {
    const request = receive(new SdkVerificationRequest('txn-match'));
    const sas = ((await request.startVerification('m.sas.v1')) as SdkVerifier).showSas();

    await confirmVerificationRequest('txn-match');

    expect(sas.confirm).toHaveBeenCalled();
  });

  it('refuses a request that has already been cancelled and says why', async () => {
    const request = receive(new SdkVerificationRequest('txn-gone'));
    request.cancellationCode = 'm.accepted';
    request.moveTo(VerificationPhase.Cancelled);

    await expect(confirmVerificationRequest('txn-gone')).rejects.toThrow('It was answered on another device.');
    expect(request.accept).not.toHaveBeenCalled();
  });

  it('cancels the request and says so when the comparison cannot start', async () => {
    const request = receive(new SdkVerificationRequest('txn-no-sas'));
    request.startVerification.mockRejectedValueOnce(new Error('Unknown device'));

    await expect(confirmVerificationRequest('txn-no-sas')).rejects.toThrow("The emoji comparison couldn't be started.");
    expect(request.cancel).toHaveBeenCalled();
    expect(latestSnapshot('txn-no-sas')).toMatchObject({
      phase: 'cancelled',
      cancelReason: "The emoji comparison couldn't be started.",
    });
  });

  it('reports a request it no longer knows', async () => {
    await expect(confirmVerificationRequest('txn-unknown')).rejects.toThrow('no longer available');
  });

  it('declines an incoming request by cancelling it', async () => {
    const request = receive(new SdkVerificationRequest('txn-decline'));

    await declineVerificationRequest('txn-decline');

    expect(request.cancel).toHaveBeenCalled();
  });

  it('reports mismatching emoji instead of a plain cancel on the comparison screen', async () => {
    const request = receive(new SdkVerificationRequest('txn-mismatch'));
    const sas = ((await request.startVerification('m.sas.v1')) as SdkVerifier).showSas();

    await declineVerificationRequest('txn-mismatch');

    expect(sas.mismatch).toHaveBeenCalled();
    expect(request.cancel).not.toHaveBeenCalled();
  });

  it('cancels a running comparison through its callbacks', async () => {
    const request = receive(new SdkVerificationRequest('txn-cancel-sas'));
    const sas = ((await request.startVerification('m.sas.v1')) as SdkVerifier).showSas();

    await cancelVerificationRequest('txn-cancel-sas');

    expect(sas.cancel).toHaveBeenCalled();
  });
});

describe('outgoing requests', () => {
  const startWith = (outgoing: SdkVerificationRequest) => {
    const { client, crypto } = createClient({ outgoing });
    state.matrixClient = client as unknown as MatrixClient;
    return crypto;
  };

  it('asks one specific device of another user', async () => {
    const crypto = startWith(new SdkVerificationRequest('txn-bob', '@bob:matrix.org', 'BOBDEVICE', true));

    const snap = await requestVerificationToUser('@bob:matrix.org', ['BOBDEVICE']);

    expect(crypto.requestDeviceVerification).toHaveBeenCalledWith('@bob:matrix.org', 'BOBDEVICE');
    expect(snap).toMatchObject({ id: 'txn-bob', outgoing: true, phase: 'requested' });
  });

  it('asks one of my own devices when a device is given', async () => {
    const crypto = startWith(new SdkVerificationRequest('txn-own-device', ME, 'MYPHONE', true));

    await requestVerificationToUser(ME, ['MYPHONE']);

    expect(crypto.requestDeviceVerification).toHaveBeenCalledWith(ME, 'MYPHONE');
    expect(crypto.requestOwnUserVerification).not.toHaveBeenCalled();
  });

  it('asks all of my other devices when verifying myself without a device', async () => {
    const crypto = startWith(new SdkVerificationRequest('txn-own', ME, undefined, true));

    await requestVerificationToUser(ME);

    expect(crypto.requestOwnUserVerification).toHaveBeenCalled();
  });

  it('needs a device to verify another user', async () => {
    startWith(new SdkVerificationRequest('txn-none', '@bob:matrix.org', undefined, true));

    await expect(requestVerificationToUser('@bob:matrix.org')).rejects.toThrow('Choose one device to verify.');
  });

  it('starts the emoji comparison as soon as the other side accepts', async () => {
    const request = new SdkVerificationRequest('txn-mine', ME, undefined, true);
    startWith(request);
    await requestVerificationForMyOtherSessions();

    request.moveTo(VerificationPhase.Ready);
    await settle();

    expect(request.startVerification).toHaveBeenCalledWith('m.sas.v1');
    expect((request.verifier as SdkVerifier).verify).toHaveBeenCalled();
  });

  it('resolves as soon as the request is sent instead of waiting for an answer', async () => {
    startWith(new SdkVerificationRequest('txn-sent', ME, undefined, true));

    const snap = await requestVerificationForMyOtherSessions();

    expect(snap).toMatchObject({ id: 'txn-sent', phase: 'requested', outgoing: true });
  });
});

describe('listening', () => {
  it('picks up requests that reached the crypto engine before the app listened', () => {
    const early = new SdkVerificationRequest('txn-early', ME, 'MYPHONE');
    const { client, crypto } = createClient({ inProgress: [early] });

    pickUpPendingVerificationRequests(client as unknown as MatrixClient);

    expect(crypto.getVerificationRequestsToDeviceInProgress).toHaveBeenCalledWith(ME);
    expect(latestSnapshot('txn-early')).toMatchObject({ phase: 'requested', fromDeviceId: 'MYPHONE' });
  });

  it('listens once per client, including a client started after another one', () => {
    const first = createClient().client;
    const second = createClient().client;

    attachVerificationListeners(first as unknown as MatrixClient);
    attachVerificationListeners(first as unknown as MatrixClient);
    attachVerificationListeners(second as unknown as MatrixClient);

    expect(first.listenerCount(CryptoEvent.VerificationRequestReceived)).toBe(1);
    expect(second.listenerCount(CryptoEvent.VerificationRequestReceived)).toBe(1);
  });
});