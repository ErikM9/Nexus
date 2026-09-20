/* eslint-disable @typescript-eslint/no-explicit-any */
import type { MatrixClient } from 'matrix-js-sdk';

export const normalizeBaseUrl = (url: string) => url.replace(/\/+$/, '');

export const getCryptoModule = (client: MatrixClient): any => {
  return (client as any).getCrypto?.() || (client as any).crypto;
};

export const isRustCryptoAccountMismatch = (e: unknown) => {
  const msg = e instanceof Error ? e.message : String(e ?? '');
  return msg.toLowerCase().includes("account in the store doesn't match the account in the constructor");
};

const deleteIndexedDb = (name: string) =>
  new Promise<void>((resolve) => {
    try {
      const req = indexedDB.deleteDatabase(name);
      req.onsuccess = () => resolve();
      req.onerror = () => resolve();
      req.onblocked = () => resolve();
    } catch {
      resolve();
    }
  });

/* Wipes all known Matrix crypto IndexedDB stores, enumerating databases first to catch versioned names */
export const wipeRustCryptoStores = async () => {
  if (typeof window === 'undefined' || typeof indexedDB === 'undefined') return;

  const candidates = new Set<string>(['matrix-sdk-crypto', 'matrix-js-sdk']);

  try {
    const idbAny = indexedDB as any;
    if (typeof idbAny.databases === 'function') {
      const dbs = await idbAny.databases();
      for (const db of dbs || []) {
        const name = db?.name;
        if (typeof name === 'string') {
          if (
            name === 'matrix-sdk-crypto' ||
            name === 'matrix-js-sdk' ||
            name.startsWith('matrix-sdk-crypto') ||
            name.startsWith('matrix-js-sdk')
          ) {
            candidates.add(name);
          }
        }
      }
    }
  } catch {}

  await Promise.all(Array.from(candidates).map((n) => deleteIndexedDb(n)));
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