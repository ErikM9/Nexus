import { EventEmitter } from 'events';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  ClientEvent,
  ConnectionError,
  HttpApiEvent,
  MatrixError,
  SyncState,
  TokenRefreshLogoutError,
  createClient,
  type ICreateClientOpts,
  type MatrixClient,
} from 'matrix-js-sdk';
import {
  SessionEndedError,
  StartupCancelledError,
  describeStartupProblem,
  getCryptoReady,
  getMatrixClient,
  initMatrixClient,
  logoutMatrixClient,
  retryMatrixStartup,
  startMatrixInThisTab,
  stopMatrixClient,
} from '@/app/utils/matrix/client';
import { getMatrixStartupStatus } from '@/app/utils/matrix/events';
import { ensureKeyBackupEnabled } from '@/app/utils/matrix/recovery';
import { readStoredSession, writeStoredSession, type StoredSession } from '@/app/utils/matrix/session';
import type { TabLock } from '@/app/utils/matrix/tabLock';
import type { InitMatrixOptions } from '@/app/utils/matrix/types';
import { attachVerificationListeners, pickUpPendingVerificationRequests } from '@/app/utils/matrix/verification';
import { state } from '@/app/utils/matrix/state';
import { neverAnswerUntilAborted } from '../api/homeserver';

vi.mock('matrix-js-sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('matrix-js-sdk')>()),
  createClient: vi.fn(),
}));

vi.mock('@/app/utils/matrix/recovery', () => ({
  ensureKeyBackupEnabled: vi.fn(async () => {}),
}));

vi.mock('@/app/utils/matrix/verification', () => ({
  attachVerificationListeners: vi.fn(),
  pickUpPendingVerificationRequests: vi.fn(),
}));

/* This tab's session lock, which a test grants, refuses or takes away the way another tab would */
const tabLock = vi.hoisted(() => {
  const lostListeners = new Set<() => void>();
  return {
    claim: vi.fn(async (_opts?: { steal?: boolean }) => true),
    release: vi.fn(),
    onLost: vi.fn((listener: () => void) => {
      lostListeners.add(listener);
      return () => {
        lostListeners.delete(listener);
      };
    }),
    takeOverFromAnotherTab: () => lostListeners.forEach((listener) => listener()),
  };
});

vi.mock('@/app/utils/matrix/tabLock', () => ({
  getTabLock: (): TabLock => tabLock,
}));

const ALICE = '@alice:hs.example';
const BOB = '@bob:hs.example';

/* Stands in for MatrixClient with the members the client module uses, emitting the SDK's real event names and sync states */
class FakeClient extends EventEmitter {
  constructor(readonly opts: ICreateClientOpts) {
    super();
  }

  initRustCrypto = vi.fn(async (_args: { cryptoDatabasePrefix?: string; storageKey?: Uint8Array }) => {});
  startClient = vi.fn(async (_opts?: unknown) => {});
  stopClient = vi.fn();
  retryImmediately = vi.fn(() => true);
  logout = vi.fn(async (_stopClient?: boolean) => ({}));
  getAccessToken = () => this.opts.accessToken ?? null;
  getUserId = () => this.opts.userId ?? null;
  getCrypto = () => undefined;

  sync(syncState: SyncState, data?: { error?: Error }) {
    this.emit(ClientEvent.Sync, syncState, null, data);
  }
}

let clients: FakeClient[] = [];

/* The first sync completes shortly after startClient returns, as it does against a healthy server */
const syncsAfterStart = (client: FakeClient) =>
  client.startClient.mockImplementation(async () => {
    setTimeout(() => client.sync(SyncState.Prepared), 0);
  });

/* Lets a test shape the next client, whose first sync only arrives when the test delivers it, as with a slow server */
const nextClient = (shape: (client: FakeClient) => void = () => {}) =>
  vi.mocked(createClient).mockImplementationOnce((opts: ICreateClientOpts) => {
    const client = new FakeClient(opts);
    shape(client);
    clients.push(client);
    return client as unknown as MatrixClient;
  });

/* Waits one macrotask, so promise callbacks queued by the code under test have run */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

const sessionFor = (userId: string): StoredSession => {
  const name = userId === ALICE ? 'alice' : 'bob';
  return {
    accessToken: `${name}-token`,
    refreshToken: `${name}-refresh`,
    userId,
    deviceId: `${name.toUpperCase()}DEVICE`,
    baseUrl: 'https://hs.example',
    cryptoStorePrefix: `nexus-${name}`,
  };
};

const optionsFor = (session: StoredSession): InitMatrixOptions => ({
  baseUrl: session.baseUrl,
  accessToken: session.accessToken,
  refreshToken: session.refreshToken,
  userId: session.userId,
  deviceId: session.deviceId,
  cryptoStorePrefix: session.cryptoStorePrefix,
});

/* Stores a session and starts the client for it, as the app does after sign-in or on reload */
const startSession = (userId = ALICE) => {
  const session = sessionFor(userId);
  writeStoredSession(session);
  return initMatrixClient(optionsFor(session));
};

beforeEach(() => {
  stopMatrixClient();
  state.cachedSecretStorageKey = null;
  delete window.__matrix_startup;
  clients = [];
  vi.mocked(createClient).mockImplementation((opts: ICreateClientOpts) => {
    const client = new FakeClient(opts);
    syncsAfterStart(client);
    clients.push(client);
    return client as unknown as MatrixClient;
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('getMatrixClient', () => {
  it('throws while no client has started', () => {
    expect(() => getMatrixClient()).toThrow('Matrix client is not initialized');
  });

  it('returns the client once it has synced', async () => {
    const client = await startSession();

    expect(getMatrixClient()).toBe(client);
  });
});

describe('initMatrixClient', () => {
  it('creates the client with the session tokens, device, a normalised homeserver URL and the options the app relies on', async () => {
    const session = sessionFor(ALICE);
    writeStoredSession(session);

    await initMatrixClient({ ...optionsFor(session), baseUrl: 'https://hs.example///' });

    expect(createClient).toHaveBeenCalledWith(
      expect.objectContaining({
        baseUrl: 'https://hs.example',
        accessToken: 'alice-token',
        refreshToken: 'alice-refresh',
        userId: ALICE,
        deviceId: 'ALICEDEVICE',
        timelineSupport: false,
        tokenRefreshFunction: expect.any(Function),
        cryptoCallbacks: { getSecretStorageKey: expect.any(Function) },
      })
    );
  });

  it("opens the session's own crypto store with the account's store key", async () => {
    await startSession();

    expect(clients[0].initRustCrypto).toHaveBeenCalledWith({
      cryptoDatabasePrefix: 'nexus-alice',
      storageKey: expect.any(Uint8Array),
    });
    expect(localStorage.getItem(`mx_rust_crypto_key_${ALICE}`)).not.toBeNull();
  });

  it('reports ready with crypto available once the first sync completes', async () => {
    const onReady = vi.fn();
    window.addEventListener('matrix-ready', onReady);

    await startSession();

    expect(onReady).toHaveBeenCalledTimes(1);
    expect(window.__matrix_ready).toBe(true);
    expect(getCryptoReady()).toBe(true);
    window.removeEventListener('matrix-ready', onReady);
  });

  it('returns the running client when the same session starts again', async () => {
    const first = await startSession();

    const second = await initMatrixClient(optionsFor(sessionFor(ALICE)));

    expect(second).toBe(first);
    expect(createClient).toHaveBeenCalledTimes(1);
  });

  it('joins a start-up that is already under way for the same session', async () => {
    nextClient();
    const first = startSession();
    await settle();

    const second = initMatrixClient(optionsFor(sessionFor(ALICE)));
    clients[0].sync(SyncState.Prepared);

    expect(await second).toBe(await first);
    expect(createClient).toHaveBeenCalledTimes(1);
  });

  it('stops the running client when another account starts', async () => {
    await startSession(ALICE);

    const bobClient = await startSession(BOB);

    expect(clients[0].stopClient).toHaveBeenCalled();
    expect(getMatrixClient()).toBe(bobClient);
    expect(readStoredSession()?.userId).toBe(BOB);
  });

  it('never starts syncing a start-up that another account replaced while its encryption was loading', async () => {
    let finishLoading: () => void = () => {};
    nextClient((client) =>
      client.initRustCrypto.mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            finishLoading = () => resolve();
          })
      )
    );
    const alice = startSession(ALICE).catch((e: unknown) => e);
    await settle();
    await startSession(BOB);

    finishLoading();

    expect(await alice).toBeInstanceOf(StartupCancelledError);
    expect(clients[0].startClient).not.toHaveBeenCalled();
  });
});

describe('logoutMatrixClient', () => {
  const deletedDatabases = (spy: { mock: { calls: unknown[][] } }) => spy.mock.calls.map(([name]) => name).sort();

  it('ends the session on the server through the SDK so its token refresh applies', async () => {
    await startSession();

    const result = await logoutMatrixClient();

    expect(clients[0].logout).toHaveBeenCalledWith(true);
    expect(result).toEqual({ serverSignedOut: true });
  });

  it('removes the tokens, device ID, recovery key and crypto-store key from the browser', async () => {
    await startSession();
    localStorage.setItem('mx_ssk_private_key_b64', 'cmVjb3Zlcnkta2V5');
    state.cachedSecretStorageKey = new Uint8Array([1, 2, 3]);

    await logoutMatrixClient();

    const sessionKeys = ['mx_session', 'mx_access_token', 'mx_refresh_token', 'mx_user_id', 'mx_device_id'];
    for (const key of [...sessionKeys, 'mx_ssk_private_key_b64', `mx_rust_crypto_key_${ALICE}`]) {
      expect(localStorage.getItem(key), key).toBeNull();
    }
    expect(state.cachedSecretStorageKey).toBeNull();
    expect(window.__matrix_ready).toBe(false);
  });

  it("deletes the account's crypto store and leaves other accounts alone", async () => {
    const deleteDatabase = vi.spyOn(indexedDB, 'deleteDatabase');
    localStorage.setItem(`mx_rust_crypto_key_${BOB}`, 'Ym9iLWtleQ==');
    await startSession();

    await logoutMatrixClient();

    expect(deletedDatabases(deleteDatabase)).toEqual(['nexus-alice::matrix-sdk-crypto', 'nexus-alice::matrix-sdk-crypto-meta']);
    expect(localStorage.getItem(`mx_rust_crypto_key_${BOB}`)).not.toBeNull();
  });

  it('frees the session lock, so the next sign-in in any tab starts without taking over', async () => {
    await startSession();

    await logoutMatrixClient();

    expect(tabLock.release).toHaveBeenCalled();
  });

  it('counts a token the server no longer knows as signed out', async () => {
    await startSession();
    clients[0].logout.mockRejectedValueOnce(
      new MatrixError({ errcode: 'M_UNKNOWN_TOKEN', error: 'Invalid access token passed.', soft_logout: false }, 401)
    );

    const result = await logoutMatrixClient();

    expect(result).toEqual({ serverSignedOut: true });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('falls back to the logout route when the SDK request fails', async () => {
    await startSession();
    clients[0].logout.mockRejectedValueOnce(new ConnectionError('fetch failed'));
    vi.mocked(fetch).mockResolvedValueOnce(new Response(null, { status: 200 }));

    const result = await logoutMatrixClient();

    expect(fetch).toHaveBeenCalledWith(
      '/api/logout',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ accessToken: 'alice-token' }) })
    );
    expect(result).toEqual({ serverSignedOut: true });
  });

  it.each([
    ['401, as the token is already gone', 401, true],
    ['a server error', 500, false],
  ])('reports whether the server was told when the logout route answers %s', async (_case, status, told) => {
    await startSession();
    clients[0].logout.mockRejectedValueOnce(new ConnectionError('fetch failed'));
    vi.mocked(fetch).mockResolvedValueOnce(new Response(null, { status }));

    const result = await logoutMatrixClient();

    expect(result).toEqual({ serverSignedOut: told });
  });

  it('falls back to the logout route when the server leaves the sign-out unanswered for 10 seconds', async () => {
    await startSession();
    vi.useFakeTimers();
    clients[0].logout.mockImplementationOnce(() => new Promise<never>(() => {}));
    vi.mocked(fetch).mockResolvedValueOnce(new Response(null, { status: 200 }));
    const signingOut = logoutMatrixClient();

    await vi.advanceTimersByTimeAsync(9_999);
    expect(fetch).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(fetch).toHaveBeenCalledWith('/api/logout', expect.objectContaining({ method: 'POST' }));
    await vi.runAllTimersAsync();
    expect(await signingOut).toEqual({ serverSignedOut: true });
  });

  it('clears the browser but reports it when the server cannot be told', async () => {
    await startSession();
    clients[0].logout.mockRejectedValueOnce(new ConnectionError('fetch failed'));
    vi.mocked(fetch).mockRejectedValueOnce(new TypeError('Failed to fetch'));

    const result = await logoutMatrixClient();

    expect(result).toEqual({ serverSignedOut: false });
    expect(readStoredSession()).toBeNull();
  });

  it('signs out with the stored token through the logout route when no client is running', async () => {
    writeStoredSession(sessionFor(ALICE));
    vi.mocked(fetch).mockResolvedValueOnce(new Response(null, { status: 200 }));

    const result = await logoutMatrixClient();

    expect(fetch).toHaveBeenCalledWith('/api/logout', expect.objectContaining({ body: JSON.stringify({ accessToken: 'alice-token' }) }));
    expect(result).toEqual({ serverSignedOut: true });
  });

  it('deletes the crypto store of a session stored before stores had their own names, with no client running', async () => {
    const deleteDatabase = vi.spyOn(indexedDB, 'deleteDatabase');
    writeStoredSession({ ...sessionFor(ALICE), cryptoStorePrefix: undefined });
    vi.mocked(fetch).mockResolvedValueOnce(new Response(null, { status: 200 }));

    await logoutMatrixClient();

    expect(deletedDatabases(deleteDatabase)).toEqual(['matrix-js-sdk::matrix-sdk-crypto', 'matrix-js-sdk::matrix-sdk-crypto-meta']);
  });

  it('abandons a start-up still waiting for its first sync', async () => {
    nextClient();
    const starting = startSession().catch((e: unknown) => e);
    await settle();

    await logoutMatrixClient();

    expect(await starting).toBeInstanceOf(SessionEndedError);
    expect(window.__matrix_ready).toBe(false);
  });

  it("with forgetDevice wipes every account's keys and crypto stores", async () => {
    const deleteDatabase = vi.spyOn(indexedDB, 'deleteDatabase');
    vi.spyOn(indexedDB, 'databases').mockResolvedValue([
      { name: 'nexus-bob::matrix-sdk-crypto', version: 1 },
      { name: 'unrelated-app-db', version: 1 },
    ]);
    localStorage.setItem(`mx_rust_crypto_key_${BOB}`, 'Ym9iLWtleQ==');
    localStorage.setItem('theme', 'dark');
    await startSession();

    await logoutMatrixClient({ forgetDevice: true });

    expect(localStorage.getItem(`mx_rust_crypto_key_${BOB}`)).toBeNull();
    expect(localStorage.getItem('theme')).toBe('dark');
    expect(deletedDatabases(deleteDatabase)).toContain('nexus-bob::matrix-sdk-crypto');
    expect(deletedDatabases(deleteDatabase)).not.toContain('unrelated-app-db');
  });
});

describe('start-up', () => {
  it('catches a first sync that completes before startClient returns', async () => {
    nextClient((client) => client.startClient.mockImplementation(async () => client.sync(SyncState.Prepared)));

    const client = await startSession();

    expect(getMatrixClient()).toBe(client);
  });

  it('reports ready without waiting for the key-backup check', async () => {
    vi.mocked(ensureKeyBackupEnabled).mockReturnValueOnce(new Promise(() => {}));

    await startSession();

    expect(window.__matrix_ready).toBe(true);
    expect(ensureKeyBackupEnabled).toHaveBeenCalled();
  });

  it('stays ready and only warns when the key-backup check fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const failure = new MatrixError({ errcode: 'M_UNKNOWN', error: 'Internal server error' }, 500);
    vi.mocked(ensureKeyBackupEnabled).mockRejectedValueOnce(failure);

    await startSession();

    await vi.waitFor(() => expect(warn).toHaveBeenCalledWith('Key backup check failed', failure));
    expect(window.__matrix_ready).toBe(true);
  });

  it('listens for verification requests before the first sync, which can already carry one', async () => {
    await startSession();

    const [listening] = vi.mocked(attachVerificationListeners).mock.invocationCallOrder;
    const [syncing] = clients[0].startClient.mock.invocationCallOrder;
    expect(attachVerificationListeners).toHaveBeenCalledWith(clients[0]);
    expect(listening).toBeLessThan(syncing);
  });

  it('picks up verification requests that arrived before the app was listening', async () => {
    const client = await startSession();

    expect(pickUpPendingVerificationRequests).toHaveBeenCalledWith(client);
  });

  it('keeps waiting for a slow first sync instead of giving up', async () => {
    vi.useFakeTimers();
    nextClient();
    const ready = vi.fn();
    void startSession().then(ready);

    await vi.advanceTimersByTimeAsync(120_000);
    expect(ready).not.toHaveBeenCalled();
    clients[0].sync(SyncState.Prepared);
    await vi.advanceTimersByTimeAsync(0);

    expect(ready).toHaveBeenCalled();
    expect(readStoredSession()?.userId).toBe(ALICE);
  });

  it('keeps the stored session and reports the problem while the homeserver is unreachable', async () => {
    nextClient();
    void startSession().catch(() => {});
    await settle();

    clients[0].sync(SyncState.Error, { error: new ConnectionError('fetch failed') });

    expect(getMatrixStartupStatus()).toEqual({
      state: 'reconnecting',
      message: "The homeserver can't be reached. Check your connection.",
    });
    expect(readStoredSession()?.accessToken).toBe('alice-token');
    expect(window.__matrix_ready).toBe(false);
  });

  it('reports the problem while the SDK retries a failed first sync', async () => {
    nextClient();
    void startSession().catch(() => {});
    await settle();

    clients[0].sync(SyncState.Reconnecting, { error: new MatrixError({ errcode: 'M_UNKNOWN', error: 'Bad gateway' }, 502) });

    expect(getMatrixStartupStatus()).toEqual({ state: 'reconnecting', message: 'The homeserver is having problems (error 502).' });
  });

  it('retries a start-up that is waiting on the network at once', async () => {
    nextClient((client) =>
      client.retryImmediately.mockImplementation(() => {
        client.sync(SyncState.Prepared);
        return true;
      })
    );
    const starting = startSession();
    await settle();
    clients[0].sync(SyncState.Error, { error: new ConnectionError('fetch failed') });

    const retried = retryMatrixStartup();

    expect(retried).toBe(true);
    expect(getMatrixStartupStatus()).toEqual({ state: 'connecting' });
    expect(await starting).toBe(getMatrixClient());
  });

  it('answers that there is nothing to retry when no start-up is waiting', () => {
    expect(retryMatrixStartup()).toBe(false);
  });

  it('keeps the stored session when encryption cannot start', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const cause = new Error('IndexedDB is not available');
    nextClient((client) => client.initRustCrypto.mockRejectedValue(cause));

    await expect(startSession()).rejects.toThrow("Encryption couldn't be set up in this browser.");

    expect(getMatrixStartupStatus()).toEqual({ state: 'failed', message: "Encryption couldn't be set up in this browser." });
    expect(readStoredSession()?.userId).toBe(ALICE);
    expect(warn).toHaveBeenCalledWith('Crypto store could not be opened', cause);
    warn.mockRestore();
  });

  it('ends the session when the server rejects its token', async () => {
    nextClient();
    const starting = startSession();
    await settle();

    clients[0].emit(HttpApiEvent.SessionLoggedOut, new MatrixError({ errcode: 'M_UNKNOWN_TOKEN' }, 401));

    await expect(starting).rejects.toBeInstanceOf(SessionEndedError);
    await vi.waitFor(() => expect(readStoredSession()).toBeNull());
    expect(window.__matrix_ready).toBe(false);
    expect(getMatrixStartupStatus()).toEqual({ state: 'connecting' });
  });

  it('stops a running client and ends the session when the server rejects its token', async () => {
    await startSession();

    clients[0].emit(
      HttpApiEvent.SessionLoggedOut,
      new MatrixError({ errcode: 'M_UNKNOWN_TOKEN', error: 'Invalid access token passed.', soft_logout: false }, 401)
    );

    expect(clients[0].stopClient).toHaveBeenCalled();
    expect(tabLock.release).toHaveBeenCalled();
    expect(readStoredSession()).toBeNull();
    expect(window.__matrix_ready).toBe(false);
  });
});

describe('describeStartupProblem', () => {
  it.each([
    ['rate limiting', new MatrixError({ errcode: 'M_LIMIT_EXCEEDED', error: 'Too Many Requests' }, 429), 'The homeserver is busy right now.'],
    ['a server error', new MatrixError({ errcode: 'M_UNKNOWN', error: 'Internal server error' }, 500), 'The homeserver is having problems (error 500).'],
    ['a refused request', new MatrixError({ errcode: 'M_FORBIDDEN', error: 'Forbidden' }, 403), 'The homeserver returned an unexpected error.'],
  ])('describes %s for the loading screen without the raw error text', (_case, error, sentence) => {
    expect(describeStartupProblem(error)).toBe(sentence);
  });
});

describe('crypto store', () => {
  it('replaces a store written by another account or key and retries once under a fresh name', async () => {
    const deleteDatabase = vi.spyOn(indexedDB, 'deleteDatabase');
    nextClient((client) => {
      client.initRustCrypto.mockRejectedValueOnce(new Error('An object failed to be decrypted while unpickling'));
      syncsAfterStart(client);
    });

    await startSession();

    const prefixes = clients[0].initRustCrypto.mock.calls.map(([args]) => args.cryptoDatabasePrefix);
    expect(prefixes).toEqual(['nexus-alice', expect.stringMatching(/^nexus-[0-9a-f]{16}$/)]);
    expect(readStoredSession()?.cryptoStorePrefix).toBe(prefixes[1]);
    expect(deleteDatabase).toHaveBeenCalledWith('nexus-alice::matrix-sdk-crypto');
  });

  it('reports that encryption cannot start when the fresh store fails as well', async () => {
    nextClient((client) =>
      client.initRustCrypto
        .mockRejectedValueOnce(new Error('An object failed to be decrypted while unpickling'))
        .mockRejectedValueOnce(new Error('QuotaExceededError: the quota has been exceeded'))
    );

    await expect(startSession()).rejects.toThrow("Encryption couldn't be set up in this browser.");

    expect(getMatrixStartupStatus()).toEqual({ state: 'failed', message: "Encryption couldn't be set up in this browser." });
  });

  it("reopens the SDK's default store for a session stored before stores had their own names", async () => {
    const legacy = { ...sessionFor(ALICE), cryptoStorePrefix: undefined };
    writeStoredSession(legacy);

    await initMatrixClient(optionsFor(legacy));

    expect(clients[0].initRustCrypto).toHaveBeenCalledWith(expect.objectContaining({ cryptoDatabasePrefix: 'matrix-js-sdk' }));
  });

  it('opens each account with its own store key', async () => {
    await startSession(ALICE);
    await startSession(BOB);

    const [aliceKey, bobKey] = clients.map((c) => c.initRustCrypto.mock.calls[0][0].storageKey);
    expect(aliceKey).not.toEqual(bobKey);
  });
});

describe('token refresh', () => {
  /* The refresh function the SDK was given for the running session */
  const refreshFunction = () => {
    const fn = vi.mocked(createClient).mock.calls.at(-1)?.[0].tokenRefreshFunction;
    if (!fn) throw new Error('No token refresh function was passed to createClient');
    return fn;
  };

  const refreshReply = (status: number, body: Record<string, unknown>) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

  it('exchanges the refresh token and passes the expiry on so the SDK refreshes ahead of time', async () => {
    await startSession();
    vi.mocked(fetch).mockResolvedValueOnce(refreshReply(200, { access_token: 'a2', refresh_token: 'r2', expires_in_ms: 300_000 }));
    const before = Date.now();

    const tokens = await refreshFunction()('alice-refresh');
    const after = Date.now();

    expect(fetch).toHaveBeenCalledWith(
      'https://hs.example/_matrix/client/v3/refresh',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh_token: 'alice-refresh' }),
      })
    );
    expect(tokens).toMatchObject({ accessToken: 'a2', refreshToken: 'r2' });
    expect(tokens.expiry!.getTime()).toBeGreaterThanOrEqual(before + 300_000);
    expect(tokens.expiry!.getTime()).toBeLessThanOrEqual(after + 300_000);
  });

  it('keeps the current refresh token when the server does not rotate it', async () => {
    await startSession();
    vi.mocked(fetch).mockResolvedValueOnce(refreshReply(200, { access_token: 'a2', expires_in_ms: 300_000 }));

    const tokens = await refreshFunction()('alice-refresh');

    expect(tokens.refreshToken).toBe('alice-refresh');
    expect(readStoredSession()).toMatchObject({ accessToken: 'a2', refreshToken: 'alice-refresh' });
  });

  it('stores rotated tokens so a reload resumes with them', async () => {
    await startSession();
    vi.mocked(fetch).mockResolvedValueOnce(refreshReply(200, { access_token: 'a2', refresh_token: 'r2' }));

    await refreshFunction()('alice-refresh');

    expect(readStoredSession()).toMatchObject({ accessToken: 'a2', refreshToken: 'r2' });
  });

  it.each([
    [401, { errcode: 'M_UNKNOWN_TOKEN', error: 'Unknown refresh token', soft_logout: false }],
    [403, { errcode: 'M_FORBIDDEN', error: 'Refresh token revoked' }],
  ])('tells the SDK to end the session when the server answers %i', async (status, body) => {
    await startSession();
    vi.mocked(fetch).mockResolvedValueOnce(refreshReply(status, body));

    await expect(refreshFunction()('alice-refresh')).rejects.toBeInstanceOf(TokenRefreshLogoutError);
  });

  it.each([
    ['a network failure', () => Promise.reject(new TypeError('Failed to fetch'))],
    ['a server error', () => Promise.resolve(refreshReply(502, { error: 'Bad gateway' }))],
    ['rate limiting', () => Promise.resolve(refreshReply(429, { errcode: 'M_LIMIT_EXCEEDED', retry_after_ms: 1000 }))],
    ['a reply without an access token', () => Promise.resolve(refreshReply(200, { refresh_token: 'r2' }))],
  ])('lets the SDK retry after %s', async (_label, reply) => {
    await startSession();
    vi.mocked(fetch).mockImplementationOnce(reply);

    const error = await refreshFunction()('alice-refresh').catch((e: unknown) => e);

    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(TokenRefreshLogoutError);
    expect(error).not.toBeInstanceOf(MatrixError);
  });

  it('gives up on a refresh the server leaves unanswered for 15 seconds, so the SDK can retry', async () => {
    await startSession();
    vi.useFakeTimers();
    vi.mocked(fetch).mockImplementationOnce(neverAnswerUntilAborted);
    const failed = vi.fn();
    void refreshFunction()('alice-refresh').catch(failed);

    await vi.advanceTimersByTimeAsync(14_999);
    expect(failed).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(failed).toHaveBeenCalledTimes(1);
    expect(failed.mock.calls[0][0]).not.toBeInstanceOf(TokenRefreshLogoutError);
  });

  it('never sends the refresh token to the server once the user has signed out', async () => {
    await startSession();
    const refresh = refreshFunction();
    await logoutMatrixClient();

    await expect(refresh('alice-refresh')).rejects.toBeInstanceOf(TokenRefreshLogoutError);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('drops tokens that arrive after the user signed out', async () => {
    await startSession();
    let answer: (res: Response) => void = () => {};
    vi.mocked(fetch).mockImplementationOnce(() => new Promise<Response>((resolve) => { answer = resolve; }));
    const refreshing = refreshFunction()('alice-refresh');

    await logoutMatrixClient();
    answer(refreshReply(200, { access_token: 'late-token', refresh_token: 'late-refresh' }));

    await expect(refreshing).rejects.toBeInstanceOf(TokenRefreshLogoutError);
    expect(readStoredSession()).toBeNull();
    expect(localStorage.getItem('mx_access_token')).toBeNull();
  });
});

describe('startMatrixInThisTab', () => {
  it('starts nothing and says so while another tab runs the session', async () => {
    writeStoredSession(sessionFor(ALICE));
    tabLock.claim.mockResolvedValueOnce(false);

    const client = await startMatrixInThisTab(optionsFor(sessionFor(ALICE)));

    expect(client).toBeNull();
    expect(createClient).not.toHaveBeenCalled();
    expect(getMatrixStartupStatus()).toEqual({ state: 'other-tab' });
  });

  it('takes the session over from another tab when asked and shows it connecting', async () => {
    writeStoredSession(sessionFor(ALICE));
    tabLock.claim.mockResolvedValueOnce(false);
    await startMatrixInThisTab(optionsFor(sessionFor(ALICE)));
    nextClient();

    void startMatrixInThisTab(optionsFor(sessionFor(ALICE)), { takeOver: true }).catch(() => {});
    await settle();

    expect(tabLock.claim).toHaveBeenLastCalledWith({ steal: true });
    expect(getMatrixStartupStatus()).toEqual({ state: 'connecting' });
  });

  it('stops its client and says so when another tab takes the session over', async () => {
    writeStoredSession(sessionFor(ALICE));
    await startMatrixInThisTab(optionsFor(sessionFor(ALICE)));

    tabLock.takeOverFromAnotherTab();

    expect(clients[0].stopClient).toHaveBeenCalled();
    expect(() => getMatrixClient()).toThrow('Matrix client is not initialized');
    expect(window.__matrix_ready).toBe(false);
    expect(getCryptoReady()).toBe(false);
    expect(getMatrixStartupStatus()).toEqual({ state: 'other-tab' });
    expect(readStoredSession()?.userId).toBe(ALICE);
  });
});