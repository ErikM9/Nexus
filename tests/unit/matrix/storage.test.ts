import { describe, it, expect, vi, afterEach } from 'vitest';
import { SecretStorage } from 'matrix-js-sdk';
import {
  cacheSecretStorageKey,
  clearCachedRecoveryKey,
  ensureCachedKeyLoaded,
  getSecretStorageKeyForRequest,
  loadSecretStorageKeyFromStorage,
  persistSecretStorageKey,
  secretStorageKeyMatches,
} from '@/app/utils/matrix/storage';
import { state } from '@/app/utils/matrix/state';

const STORED_KEY = 'mx_ssk_private_key_b64';

/* A 32-byte key whose bytes count up from the given value, so different starts give keys that open different descriptions */
const keyFrom = (start: number) => Uint8Array.from({ length: 32 }, (_, i) => (start + i) % 256);

const base64Of = (key: Uint8Array) => Buffer.from(key).toString('base64');

/* The SDK types name and passphrase as required, although a key made from a recovery key is published without either */
const descriptionOf = async (key: Uint8Array): Promise<SecretStorage.SecretStorageKeyDescription> => {
  const { iv, mac } = await SecretStorage.calculateKeyCheck(key);
  return { algorithm: SecretStorage.SECRET_STORAGE_ALGORITHM_V1_AES, iv, mac } as SecretStorage.SecretStorageKeyDescription;
};

/* Nothing in a description without a MAC tells one key from another, so every key opens it */
const descriptionWithoutMac = () => ({ algorithm: SecretStorage.SECRET_STORAGE_ALGORITHM_V1_AES }) as SecretStorage.SecretStorageKeyDescription;

afterEach(() => {
  state.cachedSecretStorageKey = null;
  state.pendingSecretStorageKey = null;
});

describe('persistSecretStorageKey', () => {
  it('stores the key under mx_ssk_private_key_b64 as padded base64', () => {
    const key = keyFrom(200);

    persistSecretStorageKey(key);

    expect(localStorage.getItem(STORED_KEY)).toBe(base64Of(key));
  });

  it('removes the stored key when given null', () => {
    localStorage.setItem(STORED_KEY, base64Of(keyFrom(1)));

    persistSecretStorageKey(null);

    expect(localStorage.getItem(STORED_KEY)).toBeNull();
  });
});

describe('loadSecretStorageKeyFromStorage', () => {
  it('reads the stored key back as its bytes', () => {
    const key = keyFrom(200);
    localStorage.setItem(STORED_KEY, base64Of(key));

    expect(loadSecretStorageKeyFromStorage()).toEqual(key);
  });

  it.each([
    ['nothing is stored', null],
    ['the stored value decodes to no bytes', ' '],
    ['the stored value is not base64', '!!!not-base64!!!'],
  ])('finds no key when %s', (_label, stored) => {
    if (stored !== null) localStorage.setItem(STORED_KEY, stored);

    expect(loadSecretStorageKeyFromStorage()).toBeNull();
  });
});

describe('ensureCachedKeyLoaded', () => {
  it('loads the stored key into memory when none is cached', () => {
    const stored = keyFrom(1);
    localStorage.setItem(STORED_KEY, base64Of(stored));

    ensureCachedKeyLoaded();

    expect(state.cachedSecretStorageKey).toEqual(stored);
  });

  it('keeps the key already in memory over the stored one', () => {
    const cached = keyFrom(1);
    state.cachedSecretStorageKey = cached;
    localStorage.setItem(STORED_KEY, base64Of(keyFrom(2)));

    ensureCachedKeyLoaded();

    expect(state.cachedSecretStorageKey).toBe(cached);
  });
});

describe('cacheSecretStorageKey', () => {
  it('remembers the key in memory and across reloads', () => {
    const key = keyFrom(1);

    cacheSecretStorageKey(key);

    expect(state.cachedSecretStorageKey).toBe(key);
    expect(loadSecretStorageKeyFromStorage()).toEqual(key);
  });

  it('still remembers the key for this session when the browser refuses to store it', () => {
    const key = keyFrom(1);
    vi.mocked(localStorage.setItem).mockImplementationOnce(() => {
      throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
    });

    cacheSecretStorageKey(key);

    expect(state.cachedSecretStorageKey).toBe(key);
  });
});

describe('clearCachedRecoveryKey', () => {
  it('forgets the cached key, a key still being set up and the stored copy', () => {
    cacheSecretStorageKey(keyFrom(1));
    state.pendingSecretStorageKey = keyFrom(2);

    clearCachedRecoveryKey();

    expect(state.cachedSecretStorageKey).toBeNull();
    expect(state.pendingSecretStorageKey).toBeNull();
    expect(localStorage.getItem(STORED_KEY)).toBeNull();
  });
});

describe('secretStorageKeyMatches', () => {
  it.each([
    ['padded base64, as the SDK writes it', (mac: string) => mac],
    ['unpadded base64, as other clients write it', (mac: string) => mac.replace(/=+$/, '')],
  ])('accepts the key a description was made for when its MAC is %s', async (_label, encode) => {
    const key = keyFrom(1);
    const description = await descriptionOf(key);

    const matches = await secretStorageKeyMatches(key, { ...description, mac: encode(description.mac) });

    expect(matches).toBe(true);
  });

  it('rejects a key the description was not made for', async () => {
    const description = await descriptionOf(keyFrom(1));

    expect(await secretStorageKeyMatches(keyFrom(2), description)).toBe(false);
  });

  it('accepts any key for a description without a MAC, as the SDK does', async () => {
    expect(await secretStorageKeyMatches(keyFrom(1), descriptionWithoutMac())).toBe(true);
  });

  it('rejects the right key under a description of another algorithm', async () => {
    const key = keyFrom(1);
    const description = { ...(await descriptionOf(key)), algorithm: 'm.secret_storage.v1.curve25519-aes-sha2' };

    expect(await secretStorageKeyMatches(key, description)).toBe(false);
  });

  it('rejects the right key when the IV of the description is too short to run the check', async () => {
    const key = keyFrom(1);
    const description = { ...(await descriptionOf(key)), iv: 'AAAA' };

    expect(await secretStorageKeyMatches(key, description)).toBe(false);
  });
});

describe('getSecretStorageKeyForRequest', () => {
  it('answers with the cached key and the ID of the description it opens', async () => {
    const key = keyFrom(1);
    state.cachedSecretStorageKey = key;
    const keys = { OLDKEYID: await descriptionOf(keyFrom(2)), CURRENTKEYID: await descriptionOf(key) };

    expect(await getSecretStorageKeyForRequest({ keys })).toEqual(['CURRENTKEYID', key]);
  });

  it('falls back on the stored key when none is in memory', async () => {
    const key = keyFrom(1);
    localStorage.setItem(STORED_KEY, base64Of(key));
    const keys = { CURRENTKEYID: await descriptionOf(key) };

    expect(await getSecretStorageKeyForRequest({ keys })).toEqual(['CURRENTKEYID', key]);
  });

  it('offers a key that is still being set up before the cached one', async () => {
    const pending = keyFrom(1);
    state.pendingSecretStorageKey = pending;
    state.cachedSecretStorageKey = keyFrom(2);

    expect(await getSecretStorageKeyForRequest({ keys: { NEWKEYID: descriptionWithoutMac() } })).toEqual(['NEWKEYID', pending]);
  });

  it('answers for the current key with the cached one while a new key is being set up', async () => {
    const cached = keyFrom(1);
    state.cachedSecretStorageKey = cached;
    state.pendingSecretStorageKey = keyFrom(2);
    const keys = { CURRENTKEYID: await descriptionOf(cached) };

    expect(await getSecretStorageKeyForRequest({ keys })).toEqual(['CURRENTKEYID', cached]);
  });

  it('has no answer when the cached key opens none of the requested descriptions', async () => {
    state.cachedSecretStorageKey = keyFrom(1);
    const keys = { OTHERKEYID: await descriptionOf(keyFrom(2)) };

    expect(await getSecretStorageKeyForRequest({ keys })).toBeNull();
  });

  it('has no answer while no key is known, even for a description without a MAC', async () => {
    expect(await getSecretStorageKeyForRequest({ keys: { CURRENTKEYID: descriptionWithoutMac() } })).toBeNull();
  });
});