import '@testing-library/jest-dom';
import { vi, beforeEach, afterEach } from 'vitest';

/* Factory so each storage mock gets its own isolated store */
const createStorageMock = () => {
  let store: Record<string, string> = {};
  return {
    getItem: vi.fn((key: string) => store[key] ?? null),
    setItem: vi.fn((key: string, value: string) => {
      store[key] = value;
    }),
    removeItem: vi.fn((key: string) => {
      delete store[key];
    }),
    clear: vi.fn(() => {
      store = {};
    }),
    get length() {
      return Object.keys(store).length;
    },
    key: vi.fn((index: number) => Object.keys(store)[index] ?? null),
  };
};

const localStorageMock = createStorageMock();
const sessionStorageMock = createStorageMock();

Object.defineProperty(window, 'localStorage', {
  value: localStorageMock,
  writable: true,
});

Object.defineProperty(window, 'sessionStorage', {
  value: sessionStorageMock,
  writable: true,
});

const cryptoMock = {
  getRandomValues: vi.fn(<T extends ArrayBufferView | null>(array: T): T => {
    if (array && 'BYTES_PER_ELEMENT' in array) {
      const typedArray = array as unknown as Uint8Array;
      for (let i = 0; i < typedArray.length; i++) {
        typedArray[i] = Math.floor(Math.random() * 256);
      }
    }
    return array;
  }),
  /* crypto.subtle encrypt/decrypt pass through unchanged and digest returns a fixed 32-byte buffer */
  subtle: {
    generateKey: vi.fn(async () => ({
      type: 'secret',
      extractable: true,
      algorithm: { name: 'AES-CTR', length: 256 },
      usages: ['encrypt', 'decrypt'],
    })),
    exportKey: vi.fn(async () => ({
      kty: 'oct',
      k: 'mockKeyData',
      alg: 'A256CTR',
      ext: true,
    })),
    importKey: vi.fn(async () => ({
      type: 'secret',
      extractable: false,
      algorithm: { name: 'AES-CTR' },
      usages: ['encrypt', 'decrypt'],
    })),
    encrypt: vi.fn(async (_algorithm, _key, data) => data),
    decrypt: vi.fn(async (_algorithm, _key, data) => data),
    digest: vi.fn(async (_algorithm, _data) => new ArrayBuffer(32)),
  },
  randomUUID: vi.fn(() => '12345678-1234-1234-1234-123456789abc'),
};

Object.defineProperty(window, 'crypto', {
  value: cryptoMock,
  writable: true,
});

Object.defineProperty(global, 'crypto', {
  value: cryptoMock,
  writable: true,
});

vi.stubGlobal('fetch', vi.fn());

vi.mock('next/navigation', () => ({
  useRouter: vi.fn(() => ({
    push: vi.fn(),
    replace: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    refresh: vi.fn(),
    prefetch: vi.fn(),
  })),
  usePathname: vi.fn(() => '/'),
  useSearchParams: vi.fn(() => new URLSearchParams()),
}));

vi.mock('next/dynamic', () => ({
  default: vi.fn(() => () => null),
}));

vi.mock('next-themes', () => ({
  useTheme: vi.fn(() => ({
    theme: 'light',
    setTheme: vi.fn(),
    resolvedTheme: 'light',
  })),
  ThemeProvider: ({ children }: { children: any }) => children,
}));

vi.mock('react-hot-toast', () => ({
  default: {
    success: vi.fn(),
    error: vi.fn(),
    loading: vi.fn(),
    dismiss: vi.fn(),
  },
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    loading: vi.fn(),
    dismiss: vi.fn(),
  },
  Toaster: () => null,
}));

/* deleteDatabase fires onsuccess on the next tick so callers don't hang */
class MockIndexedDB {
  private _databaseStore: Map<string, any> = new Map();

  deleteDatabase(name: string) {
    this._databaseStore.delete(name);
    const req = {
      onsuccess: null as (() => void) | null,
      onerror: null as (() => void) | null,
      onblocked: null as (() => void) | null,
    };

    setTimeout(() => req.onsuccess?.(), 0);
    return req;
  }

  async databases() {
    return Array.from(this._databaseStore.keys()).map((name) => ({ name }));
  }
}

Object.defineProperty(window, 'indexedDB', {
  value: new MockIndexedDB(),
  writable: true,
});

class MockBroadcastChannel {
  name: string;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onmessageerror: ((event: MessageEvent) => void) | null = null;

  constructor(name: string) {
    this.name = name;
  }

  postMessage(_message: any) {}
  close() {}
  addEventListener(_type: string, _listener: EventListener) {}
  removeEventListener(_type: string, _listener: EventListener) {}
  dispatchEvent(_event: Event): boolean {
    return true;
  }
}

Object.defineProperty(window, 'BroadcastChannel', {
  value: MockBroadcastChannel,
  writable: true,
});

(URL as any).createObjectURL = vi.fn(() => 'blob:mock-url');
(URL as any).revokeObjectURL = vi.fn();

beforeEach(() => {
  /* Reset between every test so state never bleeds across tests */
  vi.clearAllMocks();
  localStorageMock.clear();
  sessionStorageMock.clear();

  window.__matrix_ready = false;
  window.__cryptoReady = false;
  (window as any).global = window;
});

afterEach(() => {
  vi.restoreAllMocks();
});

export { localStorageMock, sessionStorageMock, cryptoMock };