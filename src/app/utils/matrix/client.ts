import {
  ClientEvent,
  ConnectionError,
  HttpApiEvent,
  MatrixError,
  SyncState,
  TokenRefreshLogoutError,
  createClient,
  type AccessTokens,
  type MatrixClient,
  type SyncStateData,
} from 'matrix-js-sdk';
import type { InitMatrixOptions } from './types';
import { state, type ClientSession, type ClientStartup } from './state';
import {
  deleteCryptoStore,
  isForeignCryptoStoreError,
  normalizeBaseUrl,
  wipeRustCryptoStores,
  withTimeout,
} from './crypto';
import { emitMatrixNotReady, emitMatrixReady, emitMatrixStartupStatus } from './events';
import { clearCachedRecoveryKey, ensureCachedKeyLoaded, getSecretStorageKeyForRequest } from './storage';
import { ensureKeyBackupEnabled } from './recovery';
import { attachVerificationListeners, pickUpPendingVerificationRequests } from './verification';
import { getTabLock } from './tabLock';
import {
  LEGACY_CRYPTO_STORE_PREFIX,
  clearAccountStorage,
  clearAllMatrixStorage,
  clearStoredSession,
  isSameSession,
  loadOrCreateCryptoStoreKey,
  newCryptoStorePrefix,
  readStoredSession,
  updateStoredSession,
  type SessionOwner,
} from './session';

const TOKEN_REFRESH_TIMEOUT_MS = 15_000;
const SIGN_OUT_TIMEOUT_MS = 10_000;

/* Thrown by start-up when the server has ended the session or the user signed out meanwhile */
export class SessionEndedError extends Error {
  constructor(message = 'The session has ended') {
    super(message);
    this.name = 'SessionEndedError';
  }
}

/* Thrown by start-up when another start-up or a stop replaced it */
export class StartupCancelledError extends Error {
  constructor(message = 'Matrix start-up was cancelled') {
    super(message);
    this.name = 'StartupCancelledError';
  }
}

export type SignOutResult = {
  /* False when the server could not be told, so the session may still be listed on the account's other devices */
  serverSignedOut: boolean;
};

/* Tracks whether the session a client was started for has ended, which token refreshes check before and after every await */
type SessionLifecycle = { ended: boolean };
const lifecycles = new WeakMap<MatrixClient, SessionLifecycle>();

const endLifecycle = (client: MatrixClient | null | undefined) => {
  const lifecycle = client ? lifecycles.get(client) : undefined;
  if (lifecycle) lifecycle.ended = true;
};

export const getCryptoReady = (): boolean => state.cryptoReady;

export const getMatrixClient = (): MatrixClient => {
  if (!state.matrixClient) throw new Error('Matrix client is not initialized');
  return state.matrixClient;
};

/* Turns a sync or start-up error into a sentence for the loading screen, without exposing raw exception text */
export const describeStartupProblem = (error: unknown): string => {
  if (error instanceof ConnectionError) return "The homeserver can't be reached. Check your connection.";
  const status = (error as { httpStatus?: number } | null)?.httpStatus;
  if (status === 429) return 'The homeserver is busy right now.';
  if (typeof status === 'number' && status >= 500) return `The homeserver is having problems (error ${status}).`;
  if (error instanceof CryptoStartupError) return error.message;
  return 'The homeserver returned an unexpected error.';
};

class CryptoStartupError extends Error {
  constructor(cause: unknown) {
    super("Encryption couldn't be set up in this browser.");
    this.name = 'CryptoStartupError';
    this.cause = cause;
  }
}

/* Exchanges the refresh token for new tokens and tells the SDK to end the session when the server rejects the refresh token */
const createTokenRefreshFunction =
  (baseUrl: string, owner: SessionOwner, lifecycle: SessionLifecycle) =>
  async (refreshToken: string): Promise<AccessTokens> => {
    if (lifecycle.ended) throw new TokenRefreshLogoutError(new Error('The session has ended'));

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TOKEN_REFRESH_TIMEOUT_MS);
    let status = 0;
    let data: Record<string, unknown> | null = null;
    try {
      const res = await fetch(`${baseUrl}/_matrix/client/v3/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({ refresh_token: refreshToken }),
      });
      status = res.status;
      data = await res.json().catch(() => null);
    } finally {
      clearTimeout(timer);
    }

    /* A rejected refresh token is permanent, while any other failure (network, 5xx, 429) is retried by the SDK */
    if (status === 401 || status === 403 || data?.errcode === 'M_UNKNOWN_TOKEN') {
      throw new TokenRefreshLogoutError(new MatrixError(data ?? {}, status));
    }
    if (status < 200 || status >= 300 || typeof data?.access_token !== 'string' || !data.access_token) {
      throw new Error(`Token refresh failed with status ${status}`);
    }
    if (lifecycle.ended) throw new TokenRefreshLogoutError(new Error('The session has ended'));

    const tokens: AccessTokens = {
      accessToken: data.access_token,
      refreshToken: typeof data.refresh_token === 'string' && data.refresh_token ? data.refresh_token : refreshToken,
      expiry: typeof data.expires_in_ms === 'number' ? new Date(Date.now() + data.expires_in_ms) : undefined,
    };
    updateStoredSession(owner, { accessToken: tokens.accessToken, refreshToken: tokens.refreshToken });
    return tokens;
  };

/* Opens this session's crypto store, and replaces it once when it turns out to belong to another account or key */
const initCryptoStore = async (client: MatrixClient, session: ClientSession): Promise<string> => {
  const storageKey = loadOrCreateCryptoStoreKey(session.userId);
  try {
    await client.initRustCrypto({ cryptoDatabasePrefix: session.cryptoStorePrefix, storageKey });
    return session.cryptoStorePrefix;
  } catch (e) {
    if (!isForeignCryptoStoreError(e)) {
      console.warn('Crypto store could not be opened', e);
      throw new CryptoStartupError(e);
    }
  }

  /* The failed attempt can keep the old database open, so the retry uses a fresh name instead of waiting for the delete */
  void deleteCryptoStore(session.cryptoStorePrefix);
  const prefix = newCryptoStorePrefix();
  try {
    await client.initRustCrypto({ cryptoDatabasePrefix: prefix, storageKey });
  } catch (e) {
    throw new CryptoStartupError(e);
  }
  return prefix;
};

/* Resolves on the first PREPARED or SYNCING, and is attached before startClient so that event can never be missed */
const waitForFirstSync = (client: MatrixClient, signal: AbortSignal): Promise<void> =>
  new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const cleanup = () => {
      client.removeListener(ClientEvent.Sync, onSync);
      signal.removeEventListener('abort', onAbort);
    };
    const onSync = (syncState: SyncState, _prev: SyncState | null, data?: SyncStateData) => {
      if (syncState === SyncState.Prepared || syncState === SyncState.Syncing) {
        cleanup();
        resolve();
      } else if (syncState === SyncState.Error || syncState === SyncState.Reconnecting) {
        emitMatrixStartupStatus({ state: 'reconnecting', message: describeStartupProblem(data?.error) });
      }
    };
    const onAbort = () => {
      cleanup();
      reject(signal.reason);
    };
    client.on(ClientEvent.Sync, onSync);
    signal.addEventListener('abort', onAbort);
  });

const stopClient = (client: MatrixClient | null | undefined) => {
  if (!client) return;
  try { client.stopClient(); } catch {}
  try { client.removeAllListeners(); } catch {}
};

/* Detaches every client from the app state, so in-flight start-ups reject with the given reason and nothing reports ready any more */
const detachClients = (reason: Error): MatrixClient[] => {
  const clients = [state.matrixClient, state.startup?.client].filter((c): c is MatrixClient => !!c);
  state.bumpSessionVersion();
  state.startup?.controller.abort(reason);
  state.startup = null;
  state.initPromise = null;
  state.matrixClient = null;
  state.activeSession = null;
  state.cryptoReady = false;
  return clients;
};

/* Removes everything this session kept in the browser, and with wipeAll the data of every account that used it */
const clearLocalSession = async (session: ClientSession | null, wipeAll: boolean) => {
  clearStoredSession();
  clearCachedRecoveryKey();
  if (session) clearAccountStorage(session.userId);
  state.resetVerificationState();
  emitMatrixStartupStatus({ state: 'connecting' });
  emitMatrixNotReady();

  if (wipeAll) {
    clearAllMatrixStorage();
    await wipeRustCryptoStores();
  } else if (session) {
    await deleteCryptoStore(session.cryptoStorePrefix);
  }
};

const storedClientSession = (): ClientSession | null => {
  const stored = readStoredSession();
  if (!stored) return null;
  return {
    userId: stored.userId,
    deviceId: stored.deviceId,
    baseUrl: normalizeBaseUrl(stored.baseUrl),
    cryptoStorePrefix: stored.cryptoStorePrefix ?? LEGACY_CRYPTO_STORE_PREFIX,
  };
};

/* Ends the session locally after the server invalidated it, which is final because a refresh could not fix the token */
const onSessionLoggedOut = (client: MatrixClient) => {
  if (client !== state.matrixClient && client !== state.startup?.client) return;
  const session = state.activeSession ?? state.startup?.session ?? storedClientSession();
  const clients = detachClients(new SessionEndedError());
  clients.forEach((c) => {
    endLifecycle(c);
    stopClient(c);
  });
  getTabLock().release();
  void clearLocalSession(session, false);
};

const startMatrixClient = async (options: InitMatrixOptions): Promise<MatrixClient> => {
  state.bumpSessionVersion();
  const version = state.sessionVersion;
  const baseUrl = normalizeBaseUrl(options.baseUrl);
  const owner: SessionOwner = { userId: options.userId, deviceId: options.deviceId };
  const lifecycle: SessionLifecycle = { ended: false };

  ensureCachedKeyLoaded();

  const client = createClient({
    baseUrl,
    accessToken: options.accessToken,
    refreshToken: options.refreshToken,
    userId: options.userId,
    deviceId: options.deviceId,
    /* Without timeline support a gappy sync replaces the whole timeline, so back-paginating the live timeline reaches every older event */
    timelineSupport: false,
    tokenRefreshFunction: createTokenRefreshFunction(baseUrl, owner, lifecycle),
    cryptoCallbacks: { getSecretStorageKey: getSecretStorageKeyForRequest },
  });
  lifecycles.set(client, lifecycle);

  const session: ClientSession = {
    userId: options.userId,
    deviceId: options.deviceId,
    baseUrl,
    cryptoStorePrefix: options.cryptoStorePrefix ?? LEGACY_CRYPTO_STORE_PREFIX,
  };
  const startup: ClientStartup = { client, session, controller: new AbortController() };
  const { signal } = startup.controller;
  state.startup = startup;
  state.cryptoReady = false;
  emitMatrixStartupStatus({ state: 'connecting' });

  const ensureCurrent = () => {
    if (signal.aborted) throw signal.reason;
    if (state.sessionVersion !== version) throw new StartupCancelledError();
  };

  client.on(HttpApiEvent.SessionLoggedOut, () => onSessionLoggedOut(client));
  const firstSync = waitForFirstSync(client, signal);
  firstSync.catch(() => {});

  try {
    session.cryptoStorePrefix = await initCryptoStore(client, session);
    ensureCurrent();
    updateStoredSession(owner, { cryptoStorePrefix: session.cryptoStorePrefix });
    state.cryptoReady = true;

    attachVerificationListeners(client);
    await client.startClient({ initialSyncLimit: 20 });
    ensureCurrent();
    await firstSync;
    ensureCurrent();
  } catch (e) {
    if (state.startup === startup) {
      state.startup = null;
      state.cryptoReady = false;
    }
    endLifecycle(client);
    stopClient(client);
    if (!(e instanceof SessionEndedError) && !(e instanceof StartupCancelledError)) {
      emitMatrixStartupStatus({ state: 'failed', message: describeStartupProblem(e) });
    }
    throw e;
  }

  state.startup = null;
  state.matrixClient = client;
  state.activeSession = session;
  emitMatrixReady();

  /* The backup check and pending verifications need a synced client but must never hold up the chat list */
  void ensureKeyBackupEnabled(client).catch((e) => console.warn('Key backup check failed', e));
  pickUpPendingVerificationRequests(client);

  return client;
};

export const initMatrixClient = async (options: InitMatrixOptions): Promise<MatrixClient> => {
  if (typeof window === 'undefined') throw new Error('Matrix client can only be initialized in the browser');
  const owner: SessionOwner = { userId: options.userId, deviceId: options.deviceId };

  if (state.matrixClient && isSameSession(state.activeSession, owner)) return state.matrixClient;
  if (state.startup && state.initPromise && isSameSession(state.startup.session, owner)) return state.initPromise;

  /* A different account or device replaces whatever is running, without touching the stored session */
  detachClients(new StartupCancelledError()).forEach((c) => {
    endLifecycle(c);
    stopClient(c);
  });

  const promise = startMatrixClient(options);
  state.initPromise = promise;
  const settle = () => {
    if (state.initPromise === promise) state.initPromise = null;
  };
  promise.then(settle, settle);
  return promise;
};

/* Asks a start-up that is waiting on the network to try again now, returning false when there is no start-up to poke */
export const retryMatrixStartup = (): boolean => {
  const client = state.startup?.client;
  if (!client) return false;
  emitMatrixStartupStatus({ state: 'connecting' });
  client.retryImmediately();
  return true;
};

/* Stops this tab's client without ending the session, as when another tab takes over */
export const stopMatrixClient = (): void => {
  const clients = detachClients(new StartupCancelledError('Matrix client was stopped'));
  if (!clients.length) return;
  clients.forEach((c) => {
    endLifecycle(c);
    stopClient(c);
  });
  state.resetVerificationState();
  emitMatrixNotReady();
};

let watchingTabLock = false;

/* Starts the client only in the one tab that holds the session lock, taking the lock from another tab when takeOver is set, and resolves to null when another tab keeps it */
export const startMatrixInThisTab = async (
  options: InitMatrixOptions,
  { takeOver = false }: { takeOver?: boolean } = {}
): Promise<MatrixClient | null> => {
  const tabLock = getTabLock();
  if (!watchingTabLock) {
    watchingTabLock = true;
    tabLock.onLost(() => {
      stopMatrixClient();
      emitMatrixStartupStatus({ state: 'other-tab' });
    });
  }
  if (!(await tabLock.claim({ steal: takeOver }))) {
    emitMatrixStartupStatus({ state: 'other-tab' });
    return null;
  }
  return initMatrixClient(options);
};

const isInvalidTokenError = (e: unknown) => (e as { errcode?: string } | null)?.errcode === 'M_UNKNOWN_TOKEN';

/* Revokes the session through the SDK so its token refresh applies, falling back to the app's logout route */
const revokeOnServer = async (client: MatrixClient | null, accessToken: string | null): Promise<boolean> => {
  if (client) {
    try {
      await withTimeout(client.logout(true), SIGN_OUT_TIMEOUT_MS, 'Timed out signing out');
      return true;
    } catch (e) {
      if (isInvalidTokenError(e)) return true;
    }
  }
  if (!accessToken) return false;
  try {
    const res = await withTimeout(
      fetch('/api/logout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accessToken }),
      }),
      SIGN_OUT_TIMEOUT_MS,
      'Timed out signing out'
    );
    return res.ok || res.status === 401;
  } catch {
    return false;
  }
};

/* Signs out the standard Matrix way: revoke on the server, then remove the tokens, keys, device ID and crypto store from this browser */
export const logoutMatrixClient = async (opts: { forgetDevice?: boolean } = {}): Promise<SignOutResult> => {
  const client = state.matrixClient ?? state.startup?.client ?? null;
  const session = state.activeSession ?? state.startup?.session ?? storedClientSession();
  const accessToken = client?.getAccessToken() ?? readStoredSession()?.accessToken ?? null;

  /* Start-up and background work stop at once, while the client stays usable for the logout request and its token refresh */
  const others = detachClients(new SessionEndedError('Signed out')).filter((c) => c !== client);
  others.forEach((c) => {
    endLifecycle(c);
    stopClient(c);
  });

  let serverSignedOut = false;
  try {
    serverSignedOut = await revokeOnServer(client, accessToken);
  } finally {
    endLifecycle(client);
    stopClient(client);
    await clearLocalSession(session, !!opts.forgetDevice).catch(() => {});
    /* With no session left, the next sign-in in any tab may start a client without taking over */
    getTabLock().release();
  }
  return { serverSignedOut };
};