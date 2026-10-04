import { describe, it, expect, vi } from 'vitest';
import {
  normalizeBaseUrl,
  isForeignCryptoStoreError,
  isRustCryptoAccountMismatch,
  wipeRustCryptoStores,
  withTimeout,
} from '@/app/utils/matrix/crypto';

describe('Matrix Crypto Utilities', () => {
  describe('normalizeBaseUrl', () => {
    it('removes single trailing slash', () => {
      expect(normalizeBaseUrl('https://matrix.org/')).toBe('https://matrix.org');
    });

    it('removes multiple trailing slashes', () => {
      expect(normalizeBaseUrl('https://matrix.org///')).toBe('https://matrix.org');
    });

    it('leaves URL without trailing slash unchanged', () => {
      expect(normalizeBaseUrl('https://matrix.org')).toBe('https://matrix.org');
    });

    it('handles URL with path', () => {
      expect(normalizeBaseUrl('https://matrix.org/path/')).toBe('https://matrix.org/path');
    });

    it('handles empty string', () => {
      expect(normalizeBaseUrl('')).toBe('');
    });

    it('handles URL with port', () => {
      expect(normalizeBaseUrl('https://matrix.org:8448/')).toBe('https://matrix.org:8448');
    });

    it('handles localhost URLs', () => {
      expect(normalizeBaseUrl('http://localhost:8008/')).toBe('http://localhost:8008');
    });

    it('preserves query parameters', () => {
      expect(normalizeBaseUrl('https://matrix.org?param=value/')).toBe('https://matrix.org?param=value');
    });
  });


  describe('isForeignCryptoStoreError', () => {
    /* Messages taken from the Rust crypto WASM the SDK ships, as thrown when a store belongs to another account or key */
    it.each([
      ["the account in the store doesn't match the account in the constructor: expected @bob:hs, got @alice:hs"],
      ['An object failed to be decrypted while unpickling'],
      ['Error encrypting or decrypting a value: `aead::Error`'],
      ['Failed to import a store cipher, the export used a passphrase while we are trying to import it using a key'],
    ])('treats "%s" as a store written by someone else', (message) => {
      expect(isForeignCryptoStoreError(new Error(message))).toBe(true);
    });

    it.each([
      ['The database format changed in an incompatible way'],
      ['IndexedDB is not available'],
    ])('does not treat "%s" as a foreign store', (message) => {
      expect(isForeignCryptoStoreError(new Error(message))).toBe(false);
    });
  });

  describe('isRustCryptoAccountMismatch', () => {
    it('returns true for matching error message', () => {
      const error = new Error("account in the store doesn't match the account in the constructor");
      expect(isRustCryptoAccountMismatch(error)).toBe(true);
    });

    it('returns true for case-insensitive match', () => {
      const error = new Error("ACCOUNT IN THE STORE DOESN'T MATCH THE ACCOUNT IN THE CONSTRUCTOR");
      expect(isRustCryptoAccountMismatch(error)).toBe(true);
    });

    it('returns false for different error', () => {
      expect(isRustCryptoAccountMismatch(new Error('Some other error'))).toBe(false);
    });

    it('returns false for empty error', () => {
      expect(isRustCryptoAccountMismatch(new Error(''))).toBe(false);
    });

    it('handles non-Error objects', () => {
      expect(isRustCryptoAccountMismatch("account in the store doesn't match the account in the constructor")).toBe(true);
    });

    it('handles null/undefined', () => {
      expect(isRustCryptoAccountMismatch(null)).toBe(false);
      expect(isRustCryptoAccountMismatch(undefined)).toBe(false);
    });

    it('returns false for partial match', () => {
      expect(isRustCryptoAccountMismatch(new Error('account in the store'))).toBe(false);
    });
  });

  describe('wipeRustCryptoStores', () => {
    /* The mocked IndexedDB fires onsuccess asynchronously so the delete promises resolve */
    it('resolves without throwing', async () => {
      await expect(wipeRustCryptoStores()).resolves.not.toThrow();
    });
  });

  describe('withTimeout', () => {
    it('returns result when promise resolves before timeout', async () => {
      const result = await withTimeout(Promise.resolve('success'), 1000, 'Timeout');
      expect(result).toBe('success');
    });

    it('throws timeout error when promise takes too long', async () => {
      const slowPromise = new Promise((resolve) => setTimeout(() => resolve('too slow'), 100));
      await expect(withTimeout(slowPromise, 10, 'Operation timed out')).rejects.toThrow('Operation timed out');
    });

    it('propagates promise rejection', async () => {
      const failingPromise = Promise.reject(new Error('Promise failed'));
      await expect(withTimeout(failingPromise, 1000, 'Timeout')).rejects.toThrow('Promise failed');
    });

    it('cleans up timeout after resolution', async () => {
      const clearTimeoutSpy = vi.spyOn(global, 'clearTimeout');
      await withTimeout(Promise.resolve('done'), 1000, 'Timeout');
      expect(clearTimeoutSpy).toHaveBeenCalled();
    });

    it('cleans up timeout after rejection', async () => {
      const clearTimeoutSpy = vi.spyOn(global, 'clearTimeout');
      try {
        await withTimeout(Promise.reject(new Error('error')), 1000, 'Timeout');
      } catch {}
      expect(clearTimeoutSpy).toHaveBeenCalled();
    });

    it('uses custom timeout message', async () => {
      const slowPromise = new Promise((resolve) => setTimeout(() => resolve('slow'), 100));
      await expect(withTimeout(slowPromise, 10, 'Custom timeout message')).rejects.toThrow('Custom timeout message');
    });

    it('handles zero timeout', async () => {
      const promise = new Promise((resolve) => setTimeout(() => resolve('slow'), 10));
      await expect(withTimeout(promise, 0, 'Immediate timeout')).rejects.toThrow('Immediate timeout');
    });

    /* A resolved promise's microtask runs before the zero-ms macrotask timeout */
    it('handles immediate resolution even with zero timeout', async () => {
      const result = await withTimeout(Promise.resolve('immediate'), 0, 'Timeout');
      expect(result).toBe('immediate');
    });
  });
});