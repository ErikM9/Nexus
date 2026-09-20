import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  persistSecretStorageKey,
  loadSecretStorageKeyFromStorage,
  ensureCachedKeyLoaded,
  hasCachedRecoveryKey,
  clearCachedRecoveryKey,
} from '@/app/utils/matrix/storage';
import { state } from '@/app/utils/matrix/state';

vi.mock('@/app/utils/matrix/state', () => ({
  state: {
    cachedSecretStorageKey: null as Uint8Array | null,
  },
}));

describe('Matrix Storage Utilities', () => {
  const SECRET_STORAGE_KEY_LS = 'mx_ssk_private_key_b64';

  beforeEach(() => {
    localStorage.clear();
    state.cachedSecretStorageKey = null;
    vi.clearAllMocks();
  });

  describe('persistSecretStorageKey', () => {
    it('stores key as base64 in localStorage', () => {
      const key = new Uint8Array([1, 2, 3, 4, 5]);
      persistSecretStorageKey(key);

      const stored = localStorage.getItem(SECRET_STORAGE_KEY_LS);
      expect(stored).not.toBeNull();
      expect(typeof stored).toBe('string');
    });

    it('removes key from localStorage when null is passed', () => {
      localStorage.setItem(SECRET_STORAGE_KEY_LS, 'some_value');
      persistSecretStorageKey(null);

      expect(localStorage.getItem(SECRET_STORAGE_KEY_LS)).toBeNull();
    });

    it('stores and retrieves key correctly', () => {
      const originalKey = new Uint8Array([10, 20, 30, 40, 50, 60, 70, 80]);
      persistSecretStorageKey(originalKey);

      const loadedKey = loadSecretStorageKeyFromStorage();
      expect(loadedKey).not.toBeNull();
      expect(loadedKey).toEqual(originalKey);
    });

    it('handles empty Uint8Array', () => {
      const emptyKey = new Uint8Array([]);
      persistSecretStorageKey(emptyKey);

      const stored = localStorage.getItem(SECRET_STORAGE_KEY_LS);
      expect(stored).toBe('');
    });

    it('handles large keys (256-bit)', () => {
      const largeKey = new Uint8Array(32);
      for (let i = 0; i < 32; i++) {
        largeKey[i] = i;
      }
      persistSecretStorageKey(largeKey);

      const loadedKey = loadSecretStorageKeyFromStorage();
      expect(loadedKey).toEqual(largeKey);
    });

    it('handles localStorage errors gracefully', () => {
      const setItemSpy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
        throw new Error('QuotaExceededError');
      });

      expect(() => persistSecretStorageKey(new Uint8Array([1, 2, 3]))).not.toThrow();

      setItemSpy.mockRestore();
    });
  });

  describe('loadSecretStorageKeyFromStorage', () => {
    it('returns null when no key is stored', () => {
      const result = loadSecretStorageKeyFromStorage();
      expect(result).toBeNull();
    });

    it('returns Uint8Array for valid stored key', () => {
      const key = new Uint8Array([100, 150, 200, 250]);
      persistSecretStorageKey(key);

      const result = loadSecretStorageKeyFromStorage();
      expect(result).toBeInstanceOf(Uint8Array);
      expect(result).toEqual(key);
    });

    it('returns null for empty string in storage', () => {
      localStorage.setItem(SECRET_STORAGE_KEY_LS, '');
      const result = loadSecretStorageKeyFromStorage();
      expect(result).toBeNull();
    });

    it('handles corrupted base64 gracefully', () => {
      localStorage.setItem(SECRET_STORAGE_KEY_LS, '!!!invalid-base64!!!');
      const result = loadSecretStorageKeyFromStorage();
      expect(result).toBeNull();
    });

    it('handles localStorage getItem errors', () => {
      const getItemSpy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
        throw new Error('SecurityError');
      });

      const result = loadSecretStorageKeyFromStorage();
      expect(result).toBeNull();

      getItemSpy.mockRestore();
    });
  });

  describe('ensureCachedKeyLoaded', () => {
    it('does nothing if key is already cached', () => {
      const existingKey = new Uint8Array([1, 2, 3]);
      state.cachedSecretStorageKey = existingKey;

      ensureCachedKeyLoaded();

      expect(state.cachedSecretStorageKey).toBe(existingKey);
    });

    it('loads key from localStorage if not cached', () => {
      const storedKey = new Uint8Array([4, 5, 6]);
      persistSecretStorageKey(storedKey);
      state.cachedSecretStorageKey = null;

      ensureCachedKeyLoaded();

      expect(state.cachedSecretStorageKey).toEqual(storedKey);
    });

    it('does not set cached key if nothing in localStorage', () => {
      state.cachedSecretStorageKey = null;
      localStorage.clear();

      ensureCachedKeyLoaded();

      expect(state.cachedSecretStorageKey).toBeNull();
    });

    it('skips loading if cached key has length', () => {
      const cachedKey = new Uint8Array([7, 8, 9]);
      state.cachedSecretStorageKey = cachedKey;

      const differentKey = new Uint8Array([10, 11, 12]);
      persistSecretStorageKey(differentKey);

      ensureCachedKeyLoaded();

      expect(state.cachedSecretStorageKey).toBe(cachedKey);
    });
  });

  describe('hasCachedRecoveryKey', () => {
    it('returns true when key is in state', () => {
      state.cachedSecretStorageKey = new Uint8Array([1, 2, 3]);
      expect(hasCachedRecoveryKey()).toBe(true);
    });

    it('returns true when key is in localStorage but not state', () => {
      state.cachedSecretStorageKey = null;
      persistSecretStorageKey(new Uint8Array([4, 5, 6]));

      expect(hasCachedRecoveryKey()).toBe(true);
    });

    it('returns false when no key anywhere', () => {
      state.cachedSecretStorageKey = null;
      localStorage.clear();

      expect(hasCachedRecoveryKey()).toBe(false);
    });

    it('returns false for empty array in state', () => {
      state.cachedSecretStorageKey = new Uint8Array([]);
      localStorage.clear();

      expect(hasCachedRecoveryKey()).toBe(false);
    });

    it('returns true for non-empty array in state', () => {
      state.cachedSecretStorageKey = new Uint8Array([0]);
      expect(hasCachedRecoveryKey()).toBe(true);
    });
  });

  describe('clearCachedRecoveryKey', () => {
    it('clears key from state', () => {
      state.cachedSecretStorageKey = new Uint8Array([1, 2, 3]);
      clearCachedRecoveryKey();

      expect(state.cachedSecretStorageKey).toBeNull();
    });

    it('clears key from localStorage', () => {
      persistSecretStorageKey(new Uint8Array([4, 5, 6]));
      clearCachedRecoveryKey();

      expect(localStorage.getItem(SECRET_STORAGE_KEY_LS)).toBeNull();
    });

    it('handles already empty state', () => {
      state.cachedSecretStorageKey = null;
      localStorage.clear();

      expect(() => clearCachedRecoveryKey()).not.toThrow();
      expect(state.cachedSecretStorageKey).toBeNull();
    });

    it('clears both state and localStorage together', () => {
      state.cachedSecretStorageKey = new Uint8Array([7, 8, 9]);
      persistSecretStorageKey(new Uint8Array([10, 11, 12]));

      clearCachedRecoveryKey();

      expect(state.cachedSecretStorageKey).toBeNull();
      expect(localStorage.getItem(SECRET_STORAGE_KEY_LS)).toBeNull();
    });
  });

  describe('Base64 encoding/decoding edge cases', () => {
    it('handles all byte values (0-255)', () => {
      const allBytes = new Uint8Array(256);
      for (let i = 0; i < 256; i++) {
        allBytes[i] = i;
      }

      persistSecretStorageKey(allBytes);
      const loaded = loadSecretStorageKeyFromStorage();

      expect(loaded).toEqual(allBytes);
    });

    it('handles typical 32-byte recovery key', () => {
      const typicalKey = new Uint8Array([
        0x12, 0x34, 0x56, 0x78, 0x9a, 0xbc, 0xde, 0xf0,
        0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88,
        0x99, 0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff, 0x00,
        0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08,
      ]);

      persistSecretStorageKey(typicalKey);
      const loaded = loadSecretStorageKeyFromStorage();

      expect(loaded).toEqual(typicalKey);
    });

    it('preserves binary data integrity through round-trip', () => {
      const binaryData = new Uint8Array([0, 255, 128, 64, 32, 16, 8, 4, 2, 1]);

      persistSecretStorageKey(binaryData);
      const loaded = loadSecretStorageKeyFromStorage();

      expect(loaded).toEqual(binaryData);
    });
  });
});