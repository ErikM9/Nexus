import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ConnectionError } from 'matrix-js-sdk';
import {
  deleteCryptoStore,
  isForeignCryptoStoreError,
  isRustCryptoAccountMismatch,
  normalizeBaseUrl,
  wipeRustCryptoStores,
  withTimeout,
} from '@/app/utils/matrix/crypto';

describe('normalizeBaseUrl', () => {
  it.each([
    ['no trailing slash', 'https://hs.example'],
    ['one trailing slash', 'https://hs.example/'],
    ['several trailing slashes', 'https://hs.example///'],
  ])('normalises a homeserver URL with %s to https://hs.example', (_label, url) => {
    expect(normalizeBaseUrl(url)).toBe('https://hs.example');
  });
});

const ACCOUNT_MISMATCH = "the account in the store doesn't match the account in the constructor: expected @bob:hs, got @alice:hs";
const UNPICKLING_FAILED = 'An object failed to be decrypted while unpickling';

describe('isForeignCryptoStoreError', () => {
  /* Messages taken from the Rust crypto WASM the SDK ships, as thrown when a store belongs to another account or key */
  it.each([
    [ACCOUNT_MISMATCH],
    [UNPICKLING_FAILED],
    ['Error encrypting or decrypting a value: `aead::Error`'],
    ['Failed to import a store cipher, the export used a passphrase while we are trying to import it using a key or vice-versa'],
  ])('treats "%s" as a store written by someone else', (message) => {
    expect(isForeignCryptoStoreError(new Error(message))).toBe(true);
  });

  it('does not treat a store in a format this version cannot read as written by someone else', () => {
    const formatChanged = new Error('The database format changed in an incompatible way, current version: 13, latest version: 12');

    expect(isForeignCryptoStoreError(formatChanged)).toBe(false);
  });

  it('judges a rejection that is not an Error by its text', () => {
    expect(isForeignCryptoStoreError(UNPICKLING_FAILED)).toBe(true);
  });

  it('does not treat a rejection without a reason as a foreign store', () => {
    expect(isForeignCryptoStoreError(undefined)).toBe(false);
  });
});

describe('isRustCryptoAccountMismatch', () => {
  it('recognises a store that another account wrote', () => {
    expect(isRustCryptoAccountMismatch(new Error(ACCOUNT_MISMATCH))).toBe(true);
  });

  it('does not mistake a store encrypted with another key for one of another account', () => {
    expect(isRustCryptoAccountMismatch(new Error(UNPICKLING_FAILED))).toBe(false);
  });
});

type DeleteRequest = Record<'onsuccess' | 'onerror' | 'onblocked', ((event: Event) => void) | null>;

/* Stands in for IDBFactory, whose delete requests settle in a later task and report blocked only for a database held open */
class FakeIndexedDb {
  readonly names: Set<string>;
  private readonly heldOpen: Set<string>;
  private readonly failing: Set<string>;
  private readonly blocked: Array<{ name: string; request: DeleteRequest }> = [];

  constructor(names: string[], { heldOpen = [], failing = [] }: { heldOpen?: string[]; failing?: string[] } = {}) {
    this.names = new Set(names);
    this.heldOpen = new Set(heldOpen);
    this.failing = new Set(failing);
  }

  deleteDatabase(name: string): DeleteRequest {
    const request: DeleteRequest = { onsuccess: null, onerror: null, onblocked: null };
    setTimeout(() => this.settle(name, request), 0);
    return request;
  }

  /* Closes the other connection, after which the browser carries out the delete requests it blocked */
  closeConnection(name: string) {
    this.heldOpen.delete(name);
    for (const entry of this.blocked.filter((blocked) => blocked.name === name)) {
      setTimeout(() => this.settle(name, entry.request), 0);
    }
  }

  async databases(): Promise<IDBDatabaseInfo[]> {
    return [...this.names].map((name) => ({ name, version: 1 }));
  }

  private settle(name: string, request: DeleteRequest) {
    if (this.heldOpen.has(name)) {
      this.blocked.push({ name, request });
      return request.onblocked?.(new Event('blocked'));
    }
    if (this.failing.has(name)) return request.onerror?.(new Event('error'));
    this.names.delete(name);
    request.onsuccess?.(new Event('success'));
  }
}

/* The two databases the Rust crypto store creates under a prefix */
const storeOf = (prefix: string) => [`${prefix}::matrix-sdk-crypto`, `${prefix}::matrix-sdk-crypto-meta`];

describe('crypto store removal', () => {
  const sharedIndexedDb = window.indexedDB;

  /* The shared setup defines indexedDB as writable but not configurable, so the double replaces only its value */
  const useIndexedDb = <T>(double: T): T => {
    Object.defineProperty(window, 'indexedDB', { value: double });
    return double;
  };

  afterEach(() => {
    useIndexedDb(sharedIndexedDb);
    vi.useRealTimers();
  });

  describe('deleteCryptoStore', () => {
    it('deletes the two databases under the prefix and leaves every other store alone', async () => {
      const db = useIndexedDb(new FakeIndexedDb([...storeOf('nexus-alice'), ...storeOf('nexus-bob'), 'matrix-js-sdk:default']));

      await deleteCryptoStore('nexus-alice');

      expect([...db.names]).toEqual([...storeOf('nexus-bob'), 'matrix-js-sdk:default']);
    });

    it('still deletes the other database when one delete request fails', async () => {
      const db = useIndexedDb(new FakeIndexedDb(storeOf('nexus-alice'), { failing: ['nexus-alice::matrix-sdk-crypto'] }));

      await deleteCryptoStore('nexus-alice');

      expect([...db.names]).toEqual(['nexus-alice::matrix-sdk-crypto']);
    });

    it('resolves when the browser refuses the delete requests outright', async () => {
      useIndexedDb({
        deleteDatabase: () => {
          throw new DOMException('The operation is insecure.', 'SecurityError');
        },
      });

      await expect(deleteCryptoStore('nexus-alice')).resolves.toBeUndefined();
    });
  });

  describe('wipeRustCryptoStores', () => {
    const sessionStores = [...storeOf('nexus-0123456789abcdef'), ...storeOf('nexus-fedcba9876543210')];
    const otherSdkDatabases = ['matrix-js-sdk:default', 'matrix-js-sdk:crypto'];

    it("deletes the crypto store of every session and the SDK's default one, and no other database", async () => {
      const db = useIndexedDb(new FakeIndexedDb([...storeOf('matrix-js-sdk'), ...sessionStores, ...otherSdkDatabases]));

      await wipeRustCryptoStores();

      expect([...db.names]).toEqual(otherSdkDatabases);
    });

    it.each([
      ['cannot list databases', undefined],
      ['fails to list them', () => Promise.reject(new DOMException('Internal error.', 'UnknownError'))],
    ])("still deletes the SDK's default store in a browser that %s", async (_label, databases) => {
      const db = useIndexedDb(Object.assign(new FakeIndexedDb([...storeOf('matrix-js-sdk'), ...sessionStores]), { databases }));

      await wipeRustCryptoStores();

      expect([...db.names]).toEqual(sessionStores);
    });
  });

  describe('a database another connection holds open', () => {
    const heldOpen = () => new FakeIndexedDb(storeOf('matrix-js-sdk'), { heldOpen: ['matrix-js-sdk::matrix-sdk-crypto'] });

    it.each([
      ['deleteCryptoStore', 3000, () => deleteCryptoStore('matrix-js-sdk')],
      ['deleteCryptoStore', 500, () => deleteCryptoStore('matrix-js-sdk', 500)],
      ['wipeRustCryptoStores', 3000, () => wipeRustCryptoStores()],
      ['wipeRustCryptoStores', 500, () => wipeRustCryptoStores(500)],
    ])('holds %s up for %i ms and no longer', async (_name, wait, remove) => {
      vi.useFakeTimers();
      const db = useIndexedDb(heldOpen());
      const finished = vi.fn();

      void remove().then(finished);
      await vi.advanceTimersByTimeAsync(wait - 1);
      expect(finished).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);

      expect(finished).toHaveBeenCalled();
      expect([...db.names]).toEqual(['matrix-js-sdk::matrix-sdk-crypto']);
    });

    it('releases deleteCryptoStore as soon as that connection closes', async () => {
      vi.useFakeTimers();
      const db = useIndexedDb(heldOpen());
      const finished = vi.fn();
      void deleteCryptoStore('matrix-js-sdk').then(finished);
      await vi.advanceTimersByTimeAsync(1000);

      db.closeConnection('matrix-js-sdk::matrix-sdk-crypto');
      await vi.advanceTimersByTimeAsync(0);

      expect(finished).toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    });
  });
});

describe('withTimeout', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('passes on the value of a promise that resolves in time', async () => {
    await expect(withTimeout(Promise.resolve('signed out'), 10_000, 'Timed out signing out')).resolves.toBe('signed out');
  });

  it('passes on the failure of a promise that rejects in time', async () => {
    const failure = new ConnectionError('fetch failed');

    await expect(withTimeout(Promise.reject(failure), 10_000, 'Timed out signing out')).rejects.toBe(failure);
  });

  it('rejects with the given message once the time is up, and not before', async () => {
    const rejected = vi.fn();
    void withTimeout(new Promise(() => {}), 10_000, 'Timed out signing out').catch(rejected);

    await vi.advanceTimersByTimeAsync(9_999);
    expect(rejected).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

    expect(rejected).toHaveBeenCalledWith(new Error('Timed out signing out'));
  });

  it.each([
    ['resolved', () => Promise.resolve('signed out')],
    ['rejected', () => Promise.reject(new ConnectionError('fetch failed'))],
  ])('leaves no timer running once the promise has %s', async (_outcome, settle) => {
    await withTimeout(settle(), 10_000, 'Timed out signing out').catch(() => {});

    expect(vi.getTimerCount()).toBe(0);
  });
});