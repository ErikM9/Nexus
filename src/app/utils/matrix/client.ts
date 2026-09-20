/* eslint-disable @typescript-eslint/no-explicit-any */
import { createClient, ClientEvent, type MatrixClient } from 'matrix-js-sdk';
import type { InitMatrixOptions } from './types';
import { state } from './state';
import {
  normalizeBaseUrl,
  isRustCryptoAccountMismatch,
  wipeRustCryptoStores,
  withTimeout,
} from './crypto';
import { emitMatrixNotReady, emitMatrixReady } from './events';
import { clearCachedRecoveryKey, ensureCachedKeyLoaded, persistSecretStorageKey } from './storage';
import { ensureKeyBackupEnabled } from './recovery';
import { attachVerificationListeners } from './verification';
import { isUnknownToken } from '../helpers';

export const getCryptoReady = (): boolean => state.cryptoReady;

/* Waits for the client to reach PREPARED or SYNCING, with a timeout so the app can't hang forever */
const waitForInitialSync = (client: MatrixClient, timeoutMs: number) => {
  let onSync: ((syncState: string) => void) | null = null;

  const p = new Promise<void>((resolve) => {
    onSync = (s: string) => {
      if (s === 'PREPARED' || s === 'SYNCING' || s === 'READY') {
        if (onSync) client.removeListener(ClientEvent.Sync, onSync);
        onSync = null;
        resolve();
      }
    };
    client.on(ClientEvent.Sync, onSync);
  });

  return withTimeout(p, timeoutMs, 'Timed out waiting for Matrix sync').finally(() => {
    if (onSync) {
      try { client.removeListener(ClientEvent.Sync, onSync); } catch {}
      onSync = null;
    }
  });
};

export const getMatrixClient = (): MatrixClient => {
  if (!state.matrixClient) throw new Error('Matrix client is not initialized');
  return state.matrixClient;
};

export const initMatrixClient = async ({
  baseUrl,
  accessToken,
  refreshToken,
  userId,
  deviceId,
}: InitMatrixOptions): Promise<MatrixClient> => {
  if (typeof window === 'undefined') throw new Error('Matrix client can only be initialized in the browser');

  const normalizedBaseUrl = normalizeBaseUrl(baseUrl);

  /* Tear down a client running for a different user or with a stale token before starting fresh */
  if (state.matrixClient) {
    const currentToken =
      (state.matrixClient as any)?.getAccessToken?.() || (state.matrixClient as any)?.http?.opts?.accessToken || '';
    const currentUserId = (state.matrixClient as any)?.getUserId?.() || '';

    if (currentUserId !== userId || (currentToken && currentToken !== accessToken)) {
      try {
        state.matrixClient.stopClient();
        state.matrixClient.removeAllListeners();
      } catch {}
      state.matrixClient = null;
      /* Clear the old session's in-flight promise so the check below doesn't return it */
      state.initPromise = null;
    } else {
      return state.matrixClient;
    }
  }

  if (state.initPromise) return state.initPromise;
  const mySession = state.sessionVersion;

  state.initPromise = (async () => {
    const storedDeviceId = localStorage.getItem('mx_device_id') || undefined;

    ensureCachedKeyLoaded();

    const client = createClient({
      baseUrl: normalizedBaseUrl,
      accessToken,
      refreshToken,
      userId,
      deviceId: deviceId || storedDeviceId,
      timelineSupport: true,
      /* SDK-level token refresh that fires automatically on any 401 */
      tokenRefreshFunction: async (rt: string) => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 15000);
        try {
          const res = await fetch(`${normalizedBaseUrl}/_matrix/client/v3/refresh`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            signal: controller.signal,
            body: JSON.stringify({ refresh_token: rt }),
          });

          const data = await res.json().catch(() => null);

          if (!res.ok || !data?.access_token) {
            const err = new Error(data?.error || 'Failed to refresh access token');
            (err as any).httpStatus = res.status;
            (err as any).errcode = data?.errcode;
            throw err;
          }

          try {
            localStorage.setItem('mx_access_token', data.access_token);
            if (data.refresh_token) localStorage.setItem('mx_refresh_token', data.refresh_token);
          } catch {}

          const rawSession = localStorage.getItem('mx_session');
          if (rawSession) {
            try {
              const s = JSON.parse(rawSession) as any;
              s.accessToken = data.access_token;
              if (data.refresh_token) s.refreshToken = data.refresh_token;
              localStorage.setItem('mx_session', JSON.stringify(s));
            } catch {}
          }

          return { accessToken: data.access_token, refreshToken: data.refresh_token } as any;
        } finally {
          clearTimeout(timer);
        }
      },
      cryptoCallbacks: {
        /* Serves the secret storage key from the in-memory cache for transparent decryption */
        getSecretStorageKey: async (opts: { keys: Record<string, any> }) => {
          ensureCachedKeyLoaded();
          if (!state.cachedSecretStorageKey) return null;
          const keyIds = Object.keys(opts?.keys || {});
          if (!keyIds.length) return null;
          return [keyIds[0], state.cachedSecretStorageKey] as [string, Uint8Array];
        },
        cacheSecretStorageKey: async (_keyId: string, _keyInfo: any, privateKey: Uint8Array) => {
          state.cachedSecretStorageKey = privateKey;
          persistSecretStorageKey(privateKey);
        },
      },
    });

    let authInvalidated = false;

    const safeCleanup = () => {
      try { client.stopClient(); } catch {}
      try { client.removeAllListeners(); } catch {}
    };

    const invalidateAuth = () => {
      if (authInvalidated) return;
      authInvalidated = true;

      state.bumpSessionVersion();
      state.initPromise = null;

      try { client.stopClient(); } catch {}
      try { client.removeAllListeners(); } catch {}

      if (typeof window !== 'undefined') {
        localStorage.removeItem('mx_access_token');
        localStorage.removeItem('mx_user_id');
        localStorage.removeItem('mx_refresh_token');
        localStorage.removeItem('mx_session');
      }

      state.matrixClient = null;
      state.cryptoReady = false;
      state.resetVerificationState();
      emitMatrixNotReady();
    };

    const onSyncAuth = (_state: any, _prevState: any, data: any) => {
      if (isUnknownToken(data?.error)) invalidateAuth();
    };

    try {
      state.cryptoReady = false;

      try { (client as any).on?.(ClientEvent.Sync, onSyncAuth); } catch {}

      /* Patch the HTTP layer so auth failures from any request also trigger invalidateAuth */
      try {
        const http: any = (client as any).http;
        if (http && typeof http.authedRequest === 'function') {
          const orig = http.authedRequest.bind(http);
          http.authedRequest = async (...args: any[]) => {
            try {
              return await orig(...args);
            } catch (e: any) {
              if (isUnknownToken(e)) invalidateAuth();
              throw e;
            }
          };
        }
      } catch {}

      let wipedOnce = false;

      /* Per-user key for encrypting the Rust crypto IndexedDB store */
      let storeKey: Uint8Array | undefined;
      try {
        const storeKeyLsKey = `mx_rust_crypto_key_${userId}`;
        let storedKeyB64 = localStorage.getItem(storeKeyLsKey);
        if (!storedKeyB64) {
          const raw = new Uint8Array(32);
          crypto.getRandomValues(raw);
          storedKeyB64 = btoa(String.fromCharCode(...raw));
          localStorage.setItem(storeKeyLsKey, storedKeyB64);
        }
        const bin = atob(storedKeyB64);
        storeKey = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) storeKey[i] = bin.charCodeAt(i);
      } catch {}

      /* Wipe the store once and retry on a device ID mismatch before giving up */
      while (true) {
        try {
          if (typeof (client as any).initRustCrypto === 'function') {
            const wasm: any = await import('@matrix-org/matrix-sdk-crypto-wasm');
            if (typeof wasm?.initAsync === 'function') await wasm.initAsync();
            await (client as any).initRustCrypto({ storageKey: storeKey });
            state.cryptoReady = true;
          } else if (typeof (client as any).initCrypto === 'function') {
            await (client as any).initCrypto();
            state.cryptoReady = true;
          } else {
            state.cryptoReady = false;
          }
          break;
        } catch (e: unknown) {
          if (!wipedOnce && isRustCryptoAccountMismatch(e)) {
            wipedOnce = true;
            try { localStorage.removeItem('mx_device_id'); } catch {}
            await wipeRustCryptoStores();
            continue;
          }
          state.cryptoReady = false;
          break;
        }
      }

      if (!state.cryptoReady) {
        throw new Error(
          'End-to-end encryption could not be initialized in this browser/environment. Refusing to start an unencrypted session.'
        );
      }

      await client.startClient({ initialSyncLimit: 20 });

      try { attachVerificationListeners(client); } catch {}
      try { await ensureKeyBackupEnabled(client); } catch {}

      await waitForInitialSync(client, 15000);

      /* Bail out if another init superseded this one while waiting for sync */
      if (state.sessionVersion !== mySession) {
        safeCleanup();
        throw new Error('Matrix init was cancelled');
      }

      const actualDeviceId = client.getDeviceId?.();
      if (actualDeviceId) {
        try { localStorage.setItem('mx_device_id', actualDeviceId); } catch {}
      }

      state.matrixClient = client;

      if (state.cryptoReady) emitMatrixReady();
      else emitMatrixNotReady();

      return client;
    } catch (e) {
      safeCleanup();
      throw e instanceof Error ? e : new Error('Failed to initialize Matrix client');
    }
  })();

  try {
    return await state.initPromise;
  } catch (error) {
    state.cryptoReady = false;
    state.matrixClient = null;
    emitMatrixNotReady();
    throw error instanceof Error ? error : new Error('Failed to initialize Matrix client');
  } finally {
    state.initPromise = null;
  }
};

export async function refreshAccessToken(baseUrl: string): Promise<string | null> {
  if (typeof window === 'undefined') return null;

  const normalizedBaseUrl = normalizeBaseUrl(baseUrl);
  const refreshToken = localStorage.getItem('mx_refresh_token');
  if (!refreshToken) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);

  try {
    const res = await fetch(`${normalizedBaseUrl}/_matrix/client/v3/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({ refresh_token: refreshToken }),
    });

    if (res.status === 401 || res.status === 403) {
      logoutMatrixClient({ forgetDevice: false });
      return null;
    }

    const data = await res.json().catch(() => null);
    if (!res.ok || !data?.access_token) return null;

    localStorage.setItem('mx_access_token', data.access_token);
    if (data.refresh_token) localStorage.setItem('mx_refresh_token', data.refresh_token);

    const rawSession = localStorage.getItem('mx_session');
    if (rawSession) {
      try {
        const s = JSON.parse(rawSession) as any;
        s.accessToken = data.access_token;
        if (data.refresh_token) s.refreshToken = data.refresh_token;
        localStorage.setItem('mx_session', JSON.stringify(s));
      } catch {}
    }

    /* Push the new token into the running client without restarting it */
    const c = state.matrixClient as any;
    if (typeof c?.setAccessToken === 'function') c.setAccessToken(data.access_token);
    else if (c?.http?.opts) c.http.opts.accessToken = data.access_token;

    return data.access_token;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export const logoutMatrixClient = (opts?: { forgetDevice?: boolean }) => {
  state.bumpSessionVersion();
  state.initPromise = null;

  if (state.matrixClient) {
    try {
      state.matrixClient.stopClient();
      state.matrixClient.removeAllListeners();
    } catch {}
    state.matrixClient = null;
  }

  if (typeof window !== 'undefined') {
    localStorage.removeItem('mx_access_token');
    localStorage.removeItem('mx_user_id');
    localStorage.removeItem('mx_refresh_token');
    localStorage.removeItem('mx_session');
  }

  state.cryptoReady = false;

  if (opts?.forgetDevice) clearCachedRecoveryKey();

  state.resetVerificationState();
  emitMatrixNotReady();
};

/* Hard reset for an unrecoverable Rust crypto account, requiring re-verification afterwards */
export const resetMatrixCryptoStores = async () => {
  state.bumpSessionVersion();
  state.initPromise = null;

  if (state.matrixClient) {
    try {
      state.matrixClient.stopClient();
      state.matrixClient.removeAllListeners();
    } catch {}
    state.matrixClient = null;
  }

  if (typeof window !== 'undefined') {
    localStorage.removeItem('mx_device_id');
    localStorage.removeItem('mx_session');
  }

  state.cryptoReady = false;
  clearCachedRecoveryKey();
  state.resetVerificationState();
  emitMatrixNotReady();
  await wipeRustCryptoStores();
};