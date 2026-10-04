import { EventEmitter } from 'events';
import { describe, it, expect, vi, beforeEach } from 'vitest';
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
  getCryptoReady,
  getMatrixClient,
  initMatrixClient,
  logoutMatrixClient,
  retryMatrixStartup,
  stopMatrixClient,
} from '@/app/utils/matrix/client';
import { getMatrixStartupStatus } from '@/app/utils/matrix/events';
import { ensureKeyBackupEnabled } from '@/app/utils/matrix/recovery';
import {
  SESSION_STORAGE_KEYS,
  readStoredSession,
  writeStoredSession,
  type StoredSession,
} from '@/app/utils/matrix/session';
import type { InitMatrixOptions } from '@/app/utils/matrix/types';
import { state } from '@/app/utils/matrix/state';

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
  clients = [];
  vi.mocked(createClient).mockImplementation((opts: ICreateClientOpts) => {
    const client = new FakeClient(opts);
    syncsAfterStart(client);
    clients.push(client);
    return client as unknown as MatrixClient;
  });
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
  it('creates the client with the session tokens, device and a normalised homeserver URL', async () => {
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
        tokenRefreshFunction: expect.any(Function),
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

  it('stops the running client when another account starts', async () => {
    await startSession(ALICE);

    const bobClient = await startSession(BOB);

    expect(clients[0].stopClient).toHaveBeenCalled();
    expect(getMatrixClient()).toBe(bobClient);
    expect(readStoredSession()?.userId).toBe(BOB);
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

    for (const key of [...SESSION_STORAGE_KEYS, 'mx_ssk_private_key_b64', `mx_rust_crypto_key_${ALICE}`]) {
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

  it('falls back to the logout route when the SDK request fails', async () => {
    await startSession();
    clients[0].logout.mockRejectedValueOnce(new ConnectionError('fetch failed'));
    vi.mocked(fetch).mockResolvedValueOnce({ ok: true, status: 200 } as Response);

    const result = await logoutMatrixClient();

    expect(fetch).toHaveBeenCalledWith(
      '/api/logout',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ accessToken: 'alice-token' }) })
    );
    expect(result).toEqual({ serverSignedOut: true });
  });

  it('clears the browser but reports it when the server cannot be told', async () => {
    await startSession();
    clients[0].logout.mockRejectedValueOnce(new ConnectionError('fetch failed'));
    vi.mocked(fetch).mockRejectedValueOnce(new TypeError('Failed to fetch'));

    const result = await logoutMatrixClient();

    expect(result).toEqual({ serverSignedOut: false });
    expect(readStoredSession()).toBeNull();
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
  /* Lets pending promise callbacks run without advancing any timers */
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

  it('catches a first sync that completes before startClient returns', async () => {
    vi.mocked(createClient).mockImplementationOnce((opts: ICreateClientOpts) => {
      const client = new FakeClient(opts);
      client.startClient.mockImplementation(async () => client.sync(SyncState.Prepared));
      clients.push(client);
      return client as unknown as MatrixClient;
    });

    const client = await startSession();

    expect(getMatrixClient()).toBe(client);
  });

  it('reports ready without waiting for the key-backup check', async () => {
    vi.mocked(ensureKeyBackupEnabled).mockReturnValueOnce(new Promise(() => {}));

    await startSession();

    expect(window.__matrix_ready).toBe(true);
    expect(ensureKeyBackupEnabled).toHaveBeenCalled();
  });

  it('keeps waiting for a slow first sync instead of giving up', async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(createClient).mockImplementationOnce((opts: ICreateClientOpts) => {
        const client = new FakeClient(opts);
        clients.push(client);
        return client as unknown as MatrixClient;
      });
      const ready = vi.fn();
      void startSession().then(ready);

      await vi.advanceTimersByTimeAsync(120_000);
      expect(ready).not.toHaveBeenCalled();
      clients[0].sync(SyncState.Prepared);
      await vi.advanceTimersByTimeAsync(0);

      expect(ready).toHaveBeenCalled();
      expect(readStoredSession()?.userId).toBe(ALICE);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the stored session and reports the problem while the homeserver is unreachable', async () => {
    vi.mocked(createClient).mockImplementationOnce((opts: ICreateClientOpts) => {
      const client = new FakeClient(opts);
      clients.push(client);
      return client as unknown as MatrixClient;
    });
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

  it('retries a start-up that is waiting on the network at once', async () => {
    vi.mocked(createClient).mockImplementationOnce((opts: ICreateClientOpts) => {
      const client = new FakeClient(opts);
      client.retryImmediately.mockImplementation(() => {
        client.sync(SyncState.Prepared);
        return true;
      });
      clients.push(client);
      return client as unknown as MatrixClient;
    });
    const starting = startSession();
    await settle();

    const retried = retryMatrixStartup();

    expect(retried).toBe(true);
    expect(await starting).toBe(getMatrixClient());
  });

  it('keeps the stored session when encryption cannot start', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const cause = new Error('IndexedDB is not available');
    vi.mocked(createClient).mockImplementationOnce((opts: ICreateClientOpts) => {
      const client = new FakeClient(opts);
      client.initRustCrypto.mockRejectedValue(cause);
      clients.push(client);
      return client as unknown as MatrixClient;
    });

    await expect(startSession()).rejects.toThrow("Encryption couldn't be set up in this browser.");

    expect(getMatrixStartupStatus()).toEqual({ state: 'failed', message: "Encryption couldn't be set up in this browser." });
    expect(readStoredSession()?.userId).toBe(ALICE);
    expect(warn).toHaveBeenCalledWith('Crypto store could not be opened', cause);
    warn.mockRestore();
  });

  it('ends the session when the server rejects its token', async () => {
    vi.mocked(createClient).mockImplementationOnce((opts: ICreateClientOpts) => {
      const client = new FakeClient(opts);
      clients.push(client);
      return client as unknown as MatrixClient;
    });
    const starting = startSession();
    await settle();

    clients[0].emit(HttpApiEvent.SessionLoggedOut, new MatrixError({ errcode: 'M_UNKNOWN_TOKEN' }, 401));

    await expect(starting).rejects.toBeInstanceOf(SessionEndedError);
    await vi.waitFor(() => expect(readStoredSession()).toBeNull());
    expect(window.__matrix_ready).toBe(false);
  });
});

describe('crypto store', () => {
  it('replaces a store written by another account or key and retries once under a fresh name', async () => {
    const deleteDatabase = vi.spyOn(indexedDB, 'deleteDatabase');
    vi.mocked(createClient).mockImplementationOnce((opts: ICreateClientOpts) => {
      const client = new FakeClient(opts);
      client.initRustCrypto.mockRejectedValueOnce(new Error('An object failed to be decrypted while unpickling'));
      syncsAfterStart(client);
      clients.push(client);
      return client as unknown as MatrixClient;
    });

    await startSession();

    const prefixes = clients[0].initRustCrypto.mock.calls.map(([args]) => args.cryptoDatabasePrefix);
    expect(prefixes).toEqual(['nexus-alice', expect.stringMatching(/^nexus-[0-9a-f]{16}$/)]);
    expect(readStoredSession()?.cryptoStorePrefix).toBe(prefixes[1]);
    expect(deleteDatabase).toHaveBeenCalledWith('nexus-alice::matrix-sdk-crypto');
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
    ({ status, ok: status >= 200 && status < 300, json: async () => body }) as Response;

  it('exchanges the refresh token and passes the expiry on so the SDK refreshes ahead of time', async () => {
    await startSession();
    vi.mocked(fetch).mockResolvedValueOnce(refreshReply(200, { access_token: 'a2', refresh_token: 'r2', expires_in_ms: 300_000 }));
    const before = Date.now();

    const tokens = await refreshFunction()('alice-refresh');

    expect(fetch).toHaveBeenCalledWith(
      'https://hs.example/_matrix/client/v3/refresh',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ refresh_token: 'alice-refresh' }) })
    );
    expect(tokens).toMatchObject({ accessToken: 'a2', refreshToken: 'r2' });
    expect(tokens.expiry!.getTime()).toBeGreaterThanOrEqual(before + 300_000);
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
  ])('lets the SDK retry after %s', async (_label, reply) => {
    await startSession();
    vi.mocked(fetch).mockImplementationOnce(reply);

    const error = await refreshFunction()('alice-refresh').catch((e: unknown) => e);

    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(TokenRefreshLogoutError);
    expect(error).not.toBeInstanceOf(MatrixError);
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