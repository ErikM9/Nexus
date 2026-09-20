import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('matrix-js-sdk', async () => {
  const actual = await import('../../__mocks__/matrix-js-sdk');
  return actual;
});

vi.mock('@matrix-org/matrix-sdk-crypto-wasm', () => ({
  initAsync: vi.fn(async () => {}),
}));

vi.mock('@/app/utils/matrix/storage', () => ({
  ensureCachedKeyLoaded: vi.fn(),
  persistSecretStorageKey: vi.fn(),
  clearCachedRecoveryKey: vi.fn(),
}));

vi.mock('@/app/utils/matrix/crypto', () => ({
  normalizeBaseUrl: vi.fn((url: string) => url.replace(/\/+$/, '')),
  getCryptoModule: vi.fn((client: any) => client?.getCrypto?.() || client?.crypto),
  isRustCryptoAccountMismatch: vi.fn((e: unknown) => {
    const msg = e instanceof Error ? e.message : String(e ?? '');
    return msg.toLowerCase().includes("account in the store doesn't match");
  }),
  wipeRustCryptoStores: vi.fn(async () => {}),
  withTimeout: vi.fn(async (p, _ms, _msg) => p),
}));

vi.mock('@/app/utils/matrix/events', () => ({
  emitMatrixReady: vi.fn(),
  emitMatrixNotReady: vi.fn(),
}));

vi.mock('@/app/utils/matrix/recovery', () => ({
  ensureKeyBackupEnabled: vi.fn(async () => {}),
}));

vi.mock('@/app/utils/matrix/verification', () => ({
  attachVerificationListeners: vi.fn(),
}));

import {
  getCryptoReady,
  getMatrixClient,
  initMatrixClient,
  refreshAccessToken,
  logoutMatrixClient,
  resetMatrixCryptoStores,
} from '@/app/utils/matrix/client';
import { state } from '@/app/utils/matrix/state';
import { createClient, MockMatrixClient } from '../../__mocks__/matrix-js-sdk';

describe('Matrix Client Module', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.matrixClient = null;
    state.cryptoReady = false;
    state.initPromise = null;
    state.cachedSecretStorageKey = null;
    state.resetVerificationState();
    localStorage.clear();
    (window as any).__matrix_ready = false;
    (createClient as ReturnType<typeof vi.fn>).mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('getCryptoReady', () => {
    it('reflects state changes', () => {
      state.cryptoReady = false;
      expect(getCryptoReady()).toBe(false);
      state.cryptoReady = true;
      expect(getCryptoReady()).toBe(true);
    });
  });

  describe('getMatrixClient', () => {
    it('throws when client not initialized', () => {
      state.matrixClient = null;
      expect(() => getMatrixClient()).toThrow('Matrix client is not initialized');
    });

    it('returns client when initialized', () => {
      const mockClient = new MockMatrixClient() as any;
      state.matrixClient = mockClient;
      expect(getMatrixClient()).toBe(mockClient);
    });
  });

  describe('initMatrixClient', () => {
    const baseOptions = {
      baseUrl: 'https://matrix.org',
      accessToken: 'test_token',
      userId: '@test:matrix.org',
      deviceId: 'TESTDEVICE',
    };

    it('creates and initializes a new client', async () => {
      const client = await initMatrixClient(baseOptions);
      expect(createClient).toHaveBeenCalled();
      expect(client).toBeDefined();
      expect(state.matrixClient).toBe(client);
    });

    it('normalizes base URL', async () => {
      await initMatrixClient({ ...baseOptions, baseUrl: 'https://matrix.org///' });
      expect(createClient).toHaveBeenCalledWith(
        expect.objectContaining({ baseUrl: 'https://matrix.org' })
      );
    });

    it('returns existing client if same user and token', async () => {
      const firstClient = await initMatrixClient(baseOptions);
      state.matrixClient = firstClient;
      const secondClient = await initMatrixClient(baseOptions);
      expect(secondClient).toBe(firstClient);
      expect(createClient).toHaveBeenCalledTimes(1);
    });

    it('creates new client when user changes', async () => {
      const firstClient = await initMatrixClient(baseOptions);
      state.matrixClient = firstClient;
      const secondClient = await initMatrixClient({ ...baseOptions, userId: '@different:matrix.org' });
      expect(secondClient).not.toBe(firstClient);
    });

    it('sets crypto ready state', async () => {
      await initMatrixClient(baseOptions);
      expect(state.cryptoReady).toBe(true);
    });

    it('emits matrix-ready event on success', async () => {
      const { emitMatrixReady } = await import('@/app/utils/matrix/events');
      await initMatrixClient(baseOptions);
      expect(emitMatrixReady).toHaveBeenCalled();
    });

    it('attaches verification listeners', async () => {
      const { attachVerificationListeners } = await import('@/app/utils/matrix/verification');
      await initMatrixClient(baseOptions);
      expect(attachVerificationListeners).toHaveBeenCalled();
    });

    it('enables key backup', async () => {
      const { ensureKeyBackupEnabled } = await import('@/app/utils/matrix/recovery');
      await initMatrixClient(baseOptions);
      expect(ensureKeyBackupEnabled).toHaveBeenCalled();
    });

    it('stores device ID in localStorage', async () => {
      await initMatrixClient(baseOptions);
      expect(localStorage.getItem('mx_device_id')).not.toBeNull();
    });

    it('passes stored device ID to createClient when none is provided', async () => {
      localStorage.setItem('mx_device_id', 'STORED_DEVICE');
      await initMatrixClient({
        baseUrl: 'https://matrix.org',
        accessToken: 'test_token',
        userId: '@test:matrix.org',
      });
      expect(createClient).toHaveBeenCalledWith(
        expect.objectContaining({ deviceId: 'STORED_DEVICE' })
      );
    });

    it('includes refresh token when provided', async () => {
      await initMatrixClient({ ...baseOptions, refreshToken: 'refresh_token' });
      expect(createClient).toHaveBeenCalledWith(
        expect.objectContaining({ refreshToken: 'refresh_token' })
      );
    });

    it('loads cached key before init', async () => {
      const { ensureCachedKeyLoaded } = await import('@/app/utils/matrix/storage');
      await initMatrixClient(baseOptions);
      expect(ensureCachedKeyLoaded).toHaveBeenCalled();
    });
  });

  describe('refreshAccessToken', () => {
    const baseUrl = 'https://matrix.org';

    beforeEach(() => {
      localStorage.setItem('mx_refresh_token', 'valid_refresh_token');
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ access_token: 'new_access_token', refresh_token: 'new_refresh_token' }),
      }));
    });

    it('returns null when no refresh token', async () => {
      localStorage.removeItem('mx_refresh_token');
      expect(await refreshAccessToken(baseUrl)).toBeNull();
    });

    it('calls Matrix refresh endpoint', async () => {
      await refreshAccessToken(baseUrl);
      expect(fetch).toHaveBeenCalledWith(
        'https://matrix.org/_matrix/client/v3/refresh',
        expect.objectContaining({ method: 'POST', headers: { 'Content-Type': 'application/json' } })
      );
    });

    it('returns new access token on success', async () => {
      expect(await refreshAccessToken(baseUrl)).toBe('new_access_token');
    });

    it('updates localStorage with new tokens', async () => {
      await refreshAccessToken(baseUrl);
      expect(localStorage.getItem('mx_access_token')).toBe('new_access_token');
      expect(localStorage.getItem('mx_refresh_token')).toBe('new_refresh_token');
    });

    it('updates session object in localStorage', async () => {
      localStorage.setItem('mx_session', JSON.stringify({
        accessToken: 'old_token',
        refreshToken: 'old_refresh',
        userId: '@test:matrix.org',
        baseUrl: 'https://matrix.org',
      }));
      await refreshAccessToken(baseUrl);
      const session = JSON.parse(localStorage.getItem('mx_session')!);
      expect(session.accessToken).toBe('new_access_token');
      expect(session.refreshToken).toBe('new_refresh_token');
    });

    it('returns null and logs out on 401', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        json: async () => ({ error: 'Unauthorized' }),
      }));
      expect(await refreshAccessToken(baseUrl)).toBeNull();
    });

    it('returns null on network error', async () => {
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Network error')));
      expect(await refreshAccessToken(baseUrl)).toBeNull();
    });

    it('returns null when response has no access_token', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({}),
      }));
      expect(await refreshAccessToken(baseUrl)).toBeNull();
    });

    it('pushes new token into the running client without restarting it', async () => {
      const mockClient = { setAccessToken: vi.fn() };
      state.matrixClient = mockClient as any;
      await refreshAccessToken(baseUrl);
      expect(mockClient.setAccessToken).toHaveBeenCalledWith('new_access_token');
    });

    it('normalizes base URL', async () => {
      await refreshAccessToken('https://matrix.org///');
      expect(fetch).toHaveBeenCalledWith(
        'https://matrix.org/_matrix/client/v3/refresh',
        expect.any(Object)
      );
    });
  });

  describe('logoutMatrixClient', () => {
    beforeEach(() => {
      state.matrixClient = new MockMatrixClient() as any;
      state.cryptoReady = true;
      localStorage.setItem('mx_access_token', 'token');
      localStorage.setItem('mx_session', '{}');
      localStorage.setItem('mx_user_id', '@test:matrix.org');
      localStorage.setItem('mx_refresh_token', 'refresh');
    });

    it('stops and clears the client', () => {
      const client = state.matrixClient;
      logoutMatrixClient();
      expect(client?.stopClient).toHaveBeenCalled();
      expect(state.matrixClient).toBeNull();
    });

    it('clears localStorage tokens', () => {
      logoutMatrixClient();
      expect(localStorage.getItem('mx_access_token')).toBeNull();
      expect(localStorage.getItem('mx_session')).toBeNull();
      expect(localStorage.getItem('mx_user_id')).toBeNull();
      expect(localStorage.getItem('mx_refresh_token')).toBeNull();
    });

    it('sets crypto ready to false', () => {
      logoutMatrixClient();
      expect(state.cryptoReady).toBe(false);
    });

    it('emits matrix-not-ready event', async () => {
      const { emitMatrixNotReady } = await import('@/app/utils/matrix/events');
      logoutMatrixClient();
      expect(emitMatrixNotReady).toHaveBeenCalled();
    });

    it('resets verification state', () => {
      state.verificationReqMap.set('test', {});
      state.verificationListenersAttached = true;
      logoutMatrixClient();
      expect(state.verificationReqMap.size).toBe(0);
      expect(state.verificationListenersAttached).toBe(false);
    });

    it('clears recovery key when forgetDevice is true', async () => {
      const { clearCachedRecoveryKey } = await import('@/app/utils/matrix/storage');
      logoutMatrixClient({ forgetDevice: true });
      expect(clearCachedRecoveryKey).toHaveBeenCalled();
    });

    it('preserves recovery key when forgetDevice is false', async () => {
      const { clearCachedRecoveryKey } = await import('@/app/utils/matrix/storage');
      logoutMatrixClient({ forgetDevice: false });
      expect(clearCachedRecoveryKey).not.toHaveBeenCalled();
    });

    it('bumps session version', () => {
      const initialVersion = state.sessionVersion;
      logoutMatrixClient();
      expect(state.sessionVersion).toBe(initialVersion + 1);
    });

    it('clears init promise', () => {
      state.initPromise = Promise.resolve({} as any);
      logoutMatrixClient();
      expect(state.initPromise).toBeNull();
    });

    it('handles client already null', () => {
      state.matrixClient = null;
      expect(() => logoutMatrixClient()).not.toThrow();
    });
  });

  describe('resetMatrixCryptoStores', () => {
    beforeEach(() => {
      state.matrixClient = new MockMatrixClient() as any;
      state.cryptoReady = true;
      localStorage.setItem('mx_device_id', 'DEVICE');
      localStorage.setItem('mx_session', '{}');
    });

    it('stops and clears the client', async () => {
      const client = state.matrixClient;
      await resetMatrixCryptoStores();
      expect(client?.stopClient).toHaveBeenCalled();
      expect(state.matrixClient).toBeNull();
    });

    it('removes device ID from localStorage', async () => {
      await resetMatrixCryptoStores();
      expect(localStorage.getItem('mx_device_id')).toBeNull();
    });

    it('removes session from localStorage', async () => {
      await resetMatrixCryptoStores();
      expect(localStorage.getItem('mx_session')).toBeNull();
    });

    it('wipes IndexedDB crypto stores', async () => {
      const { wipeRustCryptoStores } = await import('@/app/utils/matrix/crypto');
      await resetMatrixCryptoStores();
      expect(wipeRustCryptoStores).toHaveBeenCalled();
    });

    it('clears cached recovery key', async () => {
      const { clearCachedRecoveryKey } = await import('@/app/utils/matrix/storage');
      await resetMatrixCryptoStores();
      expect(clearCachedRecoveryKey).toHaveBeenCalled();
    });

    it('emits matrix-not-ready event', async () => {
      const { emitMatrixNotReady } = await import('@/app/utils/matrix/events');
      await resetMatrixCryptoStores();
      expect(emitMatrixNotReady).toHaveBeenCalled();
    });

    it('resets verification state', async () => {
      state.verificationListenersAttached = true;
      state.verificationReqMap.set('test', {});
      await resetMatrixCryptoStores();
      expect(state.verificationListenersAttached).toBe(false);
      expect(state.verificationReqMap.size).toBe(0);
    });

    it('bumps session version', async () => {
      const initialVersion = state.sessionVersion;
      await resetMatrixCryptoStores();
      expect(state.sessionVersion).toBe(initialVersion + 1);
    });
  });
});