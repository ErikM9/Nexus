import { SecretStorage } from 'matrix-js-sdk';
import { u8ToBinaryString } from '../helpers';
import { state } from './state';

const SECRET_STORAGE_KEY_LS = 'mx_ssk_private_key_b64';

/* Standard padded base64, since localStorage doesn't need the unpadded attachment format */
const u8ToB64 = (u8: Uint8Array): string => btoa(u8ToBinaryString(u8));

const b64ToU8 = (b64: string): Uint8Array => {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

/* Persists the secret storage key so it survives reloads without re-entering the recovery key */
export const persistSecretStorageKey = (key: Uint8Array | null) => {
  if (typeof window === 'undefined') return;
  try {
    if (!key) {
      localStorage.removeItem(SECRET_STORAGE_KEY_LS);
      return;
    }
    localStorage.setItem(SECRET_STORAGE_KEY_LS, u8ToB64(key));
  } catch {}
};

export const loadSecretStorageKeyFromStorage = (): Uint8Array | null => {
  if (typeof window === 'undefined') return null;
  try {
    const b64 = localStorage.getItem(SECRET_STORAGE_KEY_LS);
    if (!b64) return null;
    const u8 = b64ToU8(b64);
    if (!u8?.length) return null;
    return u8;
  } catch {
    return null;
  }
};

/* Populates the in-memory cache from localStorage only when it isn't already set */
export const ensureCachedKeyLoaded = () => {
  if (state.cachedSecretStorageKey?.length) return;
  const fromLs = loadSecretStorageKeyFromStorage();
  if (fromLs?.length) state.cachedSecretStorageKey = fromLs;
};

/* Makes a verified key the one this browser remembers, in memory and across reloads */
export const cacheSecretStorageKey = (key: Uint8Array) => {
  state.cachedSecretStorageKey = key;
  persistSecretStorageKey(key);
};

export const clearCachedRecoveryKey = () => {
  state.cachedSecretStorageKey = null;
  state.pendingSecretStorageKey = null;
  persistSecretStorageKey(null);
};

/* Checks a key against a secret storage key description with the MAC the description carries, as the spec defines */
export const secretStorageKeyMatches = async (
  key: Uint8Array,
  info: SecretStorage.SecretStorageKeyDescription
): Promise<boolean> => {
  if (info?.algorithm !== SecretStorage.SECRET_STORAGE_ALGORITHM_V1_AES) return false;
  if (!info.mac) return true;
  try {
    const { mac } = await SecretStorage.calculateKeyCheck(key, info.iv);
    return SecretStorage.trimTrailingEquals(info.mac) === SecretStorage.trimTrailingEquals(mac);
  } catch {
    return false;
  }
};

/* Answers the SDK's getSecretStorageKey callback with a key that really opens one of the requested key IDs, or null so the SDK reports a missing key */
export const getSecretStorageKeyForRequest = async (opts: {
  keys: Record<string, SecretStorage.SecretStorageKeyDescription>;
}): Promise<[string, Uint8Array] | null> => {
  ensureCachedKeyLoaded();
  const candidates = [state.pendingSecretStorageKey, state.cachedSecretStorageKey].filter(
    (k): k is Uint8Array => !!k?.length
  );
  for (const [keyId, info] of Object.entries(opts?.keys ?? {})) {
    for (const key of candidates) {
      if (await secretStorageKeyMatches(key, info)) return [keyId, key];
    }
  }
  return null;
};