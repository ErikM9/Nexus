import type { MatrixClient } from 'matrix-js-sdk';
import {
  CryptoEvent,
  VerificationPhase,
  VerificationRequestEvent,
  VerifierEvent,
  type CryptoApi,
  type VerificationRequest,
  type Verifier,
} from 'matrix-js-sdk/lib/crypto-api';
import type { VerificationSnapshot } from './types';
import { getMatrixClientOrThrow, state } from './state';
import { emitVerificationSnapshot } from './events';

/* Requests and verifiers already followed, and the clients already listening, so nothing is subscribed twice */
const trackedRequests = new WeakSet<VerificationRequest>();
const trackedVerifiers = new WeakSet<Verifier>();
const runningVerifiers = new WeakSet<Verifier>();
const listeningClients = new WeakSet<MatrixClient>();
const localIds = new WeakMap<VerificationRequest, string>();
const failures = new WeakMap<VerificationRequest, string>();

/* A request is known by its transaction ID once sent, which is also the ID the other device uses */
const idOf = (req: VerificationRequest): string => {
  if (req.transactionId) return req.transactionId;
  let id = localIds.get(req);
  if (!id) {
    id = `local-${Math.random().toString(36).slice(2)}`;
    localIds.set(req, id);
  }
  return id;
};

/* The SAS codes of a started emoji comparison, which only exist once both sides exchanged keys */
const sasOf = (req: VerificationRequest) => req.verifier?.getShowSasCallbacks()?.sas ?? null;

/* Maps the SDK's numeric VerificationPhase onto the stages the UI shows, where an ended request wins over leftover SAS codes */
export const phaseOf = (req: VerificationRequest): VerificationSnapshot['phase'] => {
  switch (req.phase) {
    case VerificationPhase.Ready:
      return 'ready';
    case VerificationPhase.Started:
      return sasOf(req) ? 'showing_sas' : 'ready';
    case VerificationPhase.Cancelled:
      return 'cancelled';
    case VerificationPhase.Done:
      return 'done';
    default:
      return 'requested';
  }
};

const cancelReasonOf = (req: VerificationRequest): string | undefined => {
  if (req.phase !== VerificationPhase.Cancelled) return undefined;
  const failure = failures.get(req);
  if (failure) return failure;
  switch (req.cancellationCode) {
    case 'm.timeout':
      return 'The request timed out.';
    case 'm.accepted':
      return 'It was answered on another device.';
    case 'm.mismatched_sas':
    case 'm.key_mismatch':
      return "The emoji didn't match.";
    default:
      return 'It was cancelled.';
  }
};

const snapshotOf = (req: VerificationRequest): VerificationSnapshot => {
  const id = idOf(req);
  const sas = req.phase === VerificationPhase.Started ? sasOf(req) : null;
  return {
    id,
    txnId: req.transactionId,
    fromUserId: req.otherUserId,
    fromDeviceId: req.otherDeviceId,
    createdAt: state.verificationSnapMap.get(id)?.createdAt ?? Date.now(),
    phase: phaseOf(req),
    sasEmojis: sas?.emoji?.map(([emoji]) => emoji),
    sasDecimals: sas?.decimal ? [...sas.decimal] : undefined,
    outgoing: req.initiatedByMe,
    cancelReason: cancelReasonOf(req),
  };
};

const publish = (req: VerificationRequest): VerificationSnapshot => {
  const snap = snapshotOf(req);
  state.verificationReqMap.set(snap.id, req);
  state.verificationSnapMap.set(snap.id, snap);
  emitVerificationSnapshot(snap);
  return snap;
};

const followVerifier = (req: VerificationRequest) => {
  const verifier = req.verifier;
  if (!verifier || trackedVerifiers.has(verifier)) return;
  trackedVerifiers.add(verifier);
  verifier.on(VerifierEvent.ShowSas, () => publish(req));
  verifier.on(VerifierEvent.Cancel, () => publish(req));
};

/* Follows a request's Change events and its verifier, so every phase and the SAS codes reach the UI as snapshots */
const track = (req: VerificationRequest): VerificationSnapshot => {
  if (!trackedRequests.has(req)) {
    trackedRequests.add(req);
    req.on(VerificationRequestEvent.Change, () => {
      followVerifier(req);
      publish(req);
    });
  }
  followVerifier(req);
  return publish(req);
};

const requireCrypto = (client: MatrixClient): CryptoApi => {
  const crypto = client.getCrypto();
  if (!crypto) throw new Error('Encryption is not ready yet.');
  return crypto;
};

/* Records why a request failed locally and cancels it, so the UI shows the reason instead of waiting forever */
const failRequest = (req: VerificationRequest, reason: string) => {
  failures.set(req, reason);
  if (req.phase !== VerificationPhase.Cancelled && req.phase !== VerificationPhase.Done) {
    void req.cancel().catch(() => {});
  }
  publish(req);
};

/* Moves a ready request on to the emoji comparison, starting SAS ourselves or joining the one the other side started */
const proceedToSas = async (req: VerificationRequest): Promise<void> => {
  if (req.phase === VerificationPhase.Ready && !req.verifier) await req.startVerification('m.sas.v1');
  const verifier = req.verifier;
  if (!verifier) throw new Error("The emoji comparison couldn't be started.");
  followVerifier(req);
  if (!runningVerifiers.has(verifier)) {
    runningVerifiers.add(verifier);
    /* verify() settles when the comparison ends, and a rejection just means it was cancelled or failed */
    verifier.verify().then(
      () => publish(req),
      () => publish(req)
    );
  }
  publish(req);
};

/* Starts the emoji comparison for an outgoing request as soon as the other side accepts it */
const proceedWhenAccepted = (req: VerificationRequest) => {
  const onChange = () => {
    const accepted = req.phase === VerificationPhase.Ready || req.phase === VerificationPhase.Started;
    const ended = req.phase === VerificationPhase.Cancelled || req.phase === VerificationPhase.Done;
    if (!accepted && !ended) return;
    req.off(VerificationRequestEvent.Change, onChange);
    if (accepted) {
      proceedToSas(req).catch(() => failRequest(req, "The emoji comparison couldn't be started."));
    }
  };
  req.on(VerificationRequestEvent.Change, onChange);
  onChange();
};

const findRequest = (id: string): VerificationRequest => {
  const req = state.verificationReqMap.get(id) as VerificationRequest | undefined;
  if (!req) throw new Error('This verification request is no longer available.');
  return req;
};

const hasEnded = (req: VerificationRequest) =>
  req.phase === VerificationPhase.Cancelled || req.phase === VerificationPhase.Done;

/* Listens for incoming requests on this client, which the SDK announces while processing each sync, the first one included */
export const attachVerificationListeners = (client: MatrixClient) => {
  if (listeningClients.has(client)) return;
  listeningClients.add(client);
  client.on(CryptoEvent.VerificationRequestReceived, (req: VerificationRequest) => {
    track(req);
  });
};

/* Re-announces requests to this device that are still in progress, such as ones that arrived before the UI was listening */
export const pickUpPendingVerificationRequests = (client: MatrixClient) => {
  const crypto = client.getCrypto();
  const me = client.getUserId();
  if (!crypto || !me) return;
  crypto.getVerificationRequestsToDeviceInProgress(me).forEach(track);
};

/* Accepts a request and starts the emoji comparison, or confirms that the emoji match once they are shown; throws with a message the UI can show */
export const confirmVerificationRequest = async (id: string): Promise<boolean> => {
  const req = findRequest(id);
  track(req);
  if (hasEnded(req)) throw new Error(`This verification has ended. ${cancelReasonOf(req) ?? ''}`.trim());

  const sas = req.verifier?.getShowSasCallbacks();
  if (req.phase === VerificationPhase.Started && sas) {
    await sas.confirm();
    publish(req);
    return true;
  }

  if (req.phase === VerificationPhase.Requested && !req.initiatedByMe) {
    await req.accept().catch(() => {
      throw new Error("The request couldn't be accepted. Check your connection and try again.");
    });
  }
  if (req.phase !== VerificationPhase.Ready && req.phase !== VerificationPhase.Started) {
    throw new Error("The request couldn't be accepted.");
  }
  try {
    await proceedToSas(req);
  } catch {
    failRequest(req, "The emoji comparison couldn't be started.");
    throw new Error("The emoji comparison couldn't be started.");
  }
  return true;
};

/* Declines a request, or reports that the emoji don't match when the comparison is showing */
export const declineVerificationRequest = async (id: string): Promise<boolean> => {
  const req = findRequest(id);
  if (hasEnded(req)) return true;
  const sas = req.verifier?.getShowSasCallbacks();
  if (sas) sas.mismatch();
  else await req.cancel();
  publish(req);
  return true;
};

/* Cancels a request at any stage, for example when the user closes the panel that is waiting on it */
export const cancelVerificationRequest = async (id: string): Promise<boolean> => {
  const req = findRequest(id);
  if (hasEnded(req)) return true;
  const sas = req.verifier?.getShowSasCallbacks();
  if (sas) sas.cancel();
  else await req.cancel();
  publish(req);
  return true;
};

/* Asks one device of any user (including this user's other devices) or, without a device, all of this user's other devices to verify */
export const requestVerificationToUser = async (userId: string, deviceIds?: string[]): Promise<VerificationSnapshot> => {
  const client = getMatrixClientOrThrow();
  const crypto = requireCrypto(client);

  let req: VerificationRequest;
  if (deviceIds?.length === 1) {
    req = await crypto.requestDeviceVerification(userId, deviceIds[0]);
  } else if (!deviceIds?.length && userId === client.getUserId()) {
    req = await crypto.requestOwnUserVerification();
  } else {
    throw new Error('Choose one device to verify.');
  }

  const snap = track(req);
  proceedWhenAccepted(req);
  return snap;
};

/* Asks this user's other devices to verify this one and starts the emoji comparison once one of them accepts */
export const requestVerificationForMyOtherSessions = async (): Promise<VerificationSnapshot> => {
  const req = await requireCrypto(getMatrixClientOrThrow()).requestOwnUserVerification();
  const snap = track(req);
  proceedWhenAccepted(req);
  return snap;
};