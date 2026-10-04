/* The signed-in session is one localStorage record, mirrored into the individual mx_* keys that older builds read */

export type StoredSession = {
  accessToken: string;
  refreshToken?: string;
  userId: string;
  deviceId?: string;
  baseUrl: string;
  /* IndexedDB name prefix of this session's Rust crypto store, absent for sessions created before each session had its own store */
  cryptoStorePrefix?: string;
};

/* The user and device a session belongs to, which is what decides whether two sessions are the same one */
export type SessionOwner = Pick<StoredSession, 'userId' | 'deviceId'>;

const SESSION_KEY = 'mx_session';

export const SESSION_STORAGE_KEYS = [
  'mx_session',
  'mx_access_token',
  'mx_refresh_token',
  'mx_user_id',
  'mx_device_id',
] as const;

/* The SDK's default crypto database prefix, which sessions from before per-session stores keep using */
export const LEGACY_CRYPTO_STORE_PREFIX = 'matrix-js-sdk';

const cryptoStoreKeyName = (userId: string) => `mx_rust_crypto_key_${userId}`;

const nonEmptyString = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

export const readStoredSession = (): StoredSession | null => {
  if (typeof window === 'undefined') return null;
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredSession> | null;
    if (!nonEmptyString(parsed?.accessToken) || !nonEmptyString(parsed?.userId) || !nonEmptyString(parsed?.baseUrl)) {
      return null;
    }
    return {
      accessToken: parsed.accessToken,
      userId: parsed.userId,
      baseUrl: parsed.baseUrl,
      refreshToken: nonEmptyString(parsed.refreshToken) ? parsed.refreshToken : undefined,
      deviceId: nonEmptyString(parsed.deviceId) ? parsed.deviceId : undefined,
      cryptoStorePrefix: nonEmptyString(parsed.cryptoStorePrefix) ? parsed.cryptoStorePrefix : undefined,
    };
  } catch {
    return null;
  }
};

export const hasStoredSession = (): boolean => readStoredSession() !== null;

export const writeStoredSession = (session: StoredSession): void => {
  localStorage.setItem(SESSION_KEY, JSON.stringify(session));
  localStorage.setItem('mx_access_token', session.accessToken);
  localStorage.setItem('mx_user_id', session.userId);
  if (session.deviceId) localStorage.setItem('mx_device_id', session.deviceId);
  else localStorage.removeItem('mx_device_id');
  if (session.refreshToken) localStorage.setItem('mx_refresh_token', session.refreshToken);
  else localStorage.removeItem('mx_refresh_token');
};

export const isSameSession = (a: SessionOwner | null | undefined, b: SessionOwner | null | undefined): boolean =>
  !!a && !!b && a.userId === b.userId && (a.deviceId ?? '') === (b.deviceId ?? '');

/* Merges a change into the stored session only while it still belongs to the given owner, so a late write from an ended session is dropped */
export const updateStoredSession = (owner: SessionOwner, patch: Partial<StoredSession>): boolean => {
  try {
    const current = readStoredSession();
    if (!current || !isSameSession(current, owner)) return false;
    writeStoredSession({ ...current, ...patch });
    return true;
  } catch {
    return false;
  }
};

export const clearStoredSession = (): void => {
  for (const key of SESSION_STORAGE_KEYS) {
    try { localStorage.removeItem(key); } catch {}
  }
};

/* A fresh store name for each session means no account or device ever opens a store another one wrote */
export const newCryptoStorePrefix = (): string => {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return `nexus-${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
};

/* Returns the per-user key that encrypts the crypto store at rest, creating it on first use */
export const loadOrCreateCryptoStoreKey = (userId: string): Uint8Array => {
  const name = cryptoStoreKeyName(userId);
  let b64 = localStorage.getItem(name);
  if (!b64) {
    const raw = new Uint8Array(32);
    crypto.getRandomValues(raw);
    b64 = btoa(String.fromCharCode(...raw));
    localStorage.setItem(name, b64);
  }
  const bin = atob(b64);
  const key = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) key[i] = bin.charCodeAt(i);
  return key;
};

/* The SDK keeps small caches such as sync filter IDs in localStorage under this prefix, keyed by user ID */
const SDK_STORAGE_PREFIX = 'mxjssdk_';

/* Removes what this browser keeps for one account outside its session record: the crypto-store key and the SDK's caches */
export const clearAccountStorage = (userId: string): void => {
  try {
    const keys = [cryptoStoreKeyName(userId)];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith(SDK_STORAGE_PREFIX) && key.includes(userId)) keys.push(key);
    }
    keys.forEach((key) => localStorage.removeItem(key));
  } catch {}
};

export const DISMISSED_VERIFICATIONS_KEY = 'nexus_dismissed_verifications';

/* Removes every Matrix key the app and the SDK keep in localStorage, for all accounts that ever signed in here */
export const clearAllMatrixStorage = (): void => {
  try {
    const keys: string[] = [DISMISSED_VERIFICATIONS_KEY];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith('mx_') || key?.startsWith(SDK_STORAGE_PREFIX)) keys.push(key);
    }
    keys.forEach((key) => localStorage.removeItem(key));
  } catch {}
};

/* Normalises a user ID or a bare localpart so the same account typed either way compares equal */
const accountLocalpart = (user: string): string => user.trim().replace(/^@/, '').split(':')[0].toLowerCase();

const accountServer = (user: string): string | null => {
  const trimmed = user.trim();
  const idx = trimmed.indexOf(':');
  return trimmed.startsWith('@') && idx > 0 ? trimmed.slice(idx + 1).toLowerCase() : null;
};

/* Device IDs left in storage are only offered back to the server for the account they were issued to */
export const reusableDeviceIdFor = (user: string): string | undefined => {
  try {
    const deviceId = localStorage.getItem('mx_device_id');
    const ownerId = localStorage.getItem('mx_user_id');
    if (!deviceId || !ownerId || !user.trim()) return undefined;
    const typedServer = accountServer(user);
    const ownerServer = accountServer(ownerId);
    if (accountLocalpart(user) !== accountLocalpart(ownerId)) return undefined;
    if (typedServer && ownerServer && typedServer !== ownerServer) return undefined;
    return deviceId;
  } catch {
    return undefined;
  }
};