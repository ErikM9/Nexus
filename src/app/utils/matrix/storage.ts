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

export const hasCachedRecoveryKey = (): boolean => {
  if (state.cachedSecretStorageKey?.length) return true;
  return !!loadSecretStorageKeyFromStorage()?.length;
};

export const clearCachedRecoveryKey = () => {
  state.cachedSecretStorageKey = null;
  persistSecretStorageKey(null);
};