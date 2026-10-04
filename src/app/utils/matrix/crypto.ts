/* eslint-disable @typescript-eslint/no-explicit-any */
import { LEGACY_CRYPTO_STORE_PREFIX } from './session';

export const normalizeBaseUrl = (url: string) => url.replace(/\/+$/, '');

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e ?? '')).toLowerCase();

export const isRustCryptoAccountMismatch = (e: unknown) =>
  errorText(e).includes("account in the store doesn't match the account in the constructor");

/* Matches the Rust store's errors for a store another account wrote or that another key encrypted, as opposed to IndexedDB being unavailable */
export const isForeignCryptoStoreError = (e: unknown): boolean => {
  const msg = errorText(e);
  return (
    isRustCryptoAccountMismatch(e) ||
    msg.includes('aead::error') ||
    msg.includes('failed to be decrypted while unpickling') ||
    msg.includes('error encrypting or decrypting a value') ||
    msg.includes('failed to import a store cipher')
  );
};

/* The two IndexedDB databases the Rust crypto store keeps under one prefix */
export const cryptoStoreDatabaseNames = (prefix: string) => [`${prefix}::matrix-sdk-crypto`, `${prefix}::matrix-sdk-crypto-meta`];

const CRYPTO_DB_SUFFIXES = ['::matrix-sdk-crypto', '::matrix-sdk-crypto-meta'];

/* Deleting waits for other connections to close, so a store still held open resolves after the wait and finishes deleting in the background */
const deleteIndexedDb = (name: string, blockedWaitMs: number) =>
  new Promise<void>((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const done = () => {
      if (timer) clearTimeout(timer);
      resolve();
    };
    try {
      const req = indexedDB.deleteDatabase(name);
      req.onsuccess = done;
      req.onerror = done;
      req.onblocked = () => {
        timer = setTimeout(done, blockedWaitMs);
      };
    } catch {
      done();
    }
  });

export const deleteCryptoStore = async (prefix: string, blockedWaitMs = 3000): Promise<void> => {
  if (typeof window === 'undefined' || typeof indexedDB === 'undefined') return;
  await Promise.all(cryptoStoreDatabaseNames(prefix).map((name) => deleteIndexedDb(name, blockedWaitMs)));
};

/* Wipes the Rust crypto stores of every account in this browser, enumerating databases so per-session prefixes are found */
export const wipeRustCryptoStores = async (blockedWaitMs = 3000): Promise<void> => {
  if (typeof window === 'undefined' || typeof indexedDB === 'undefined') return;

  const names = new Set<string>(cryptoStoreDatabaseNames(LEGACY_CRYPTO_STORE_PREFIX));
  try {
    const dbs = (await (indexedDB as any).databases?.()) ?? [];
    for (const db of dbs) {
      const name = db?.name;
      if (typeof name === 'string' && CRYPTO_DB_SUFFIXES.some((suffix) => name.endsWith(suffix))) names.add(name);
    }
  } catch {}

  await Promise.all(Array.from(names).map((name) => deleteIndexedDb(name, blockedWaitMs)));
};

/* Races a promise against a timeout, rejecting with a descriptive error and clearing the timer */
export const withTimeout = async <T,>(p: Promise<T>, ms: number, message: string): Promise<T> => {
  let t: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      p,
      new Promise<T>((_, reject) => {
        t = setTimeout(() => reject(new Error(message)), ms);
      }),
    ]);
  } finally {
    if (t) clearTimeout(t);
  }
};