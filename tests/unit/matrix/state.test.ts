import { describe, it, expect, vi, beforeEach } from 'vitest';
import { state, getMatrixClientOrThrow } from '@/app/utils/matrix/state';

vi.mock('@/app/utils/global', () => ({
  setCryptoReady: vi.fn(),
}));

describe('Matrix State Management', () => {
  beforeEach(() => {
    state.matrixClient = null;
    state.cryptoReady = false;
    state.initPromise = null;
    state.cachedSecretStorageKey = null;
    state.resetVerificationState();
    vi.clearAllMocks();
  });

  describe('state.matrixClient', () => {
    it('starts as null', () => {
      expect(state.matrixClient).toBeNull();
    });

    it('can be set to a client object', () => {
      const mockClient = { getUserId: () => '@test:matrix.org' } as any;
      state.matrixClient = mockClient;
      expect(state.matrixClient).toBe(mockClient);
    });

    it('can be reset to null', () => {
      state.matrixClient = { getUserId: () => '@test:matrix.org' } as any;
      state.matrixClient = null;
      expect(state.matrixClient).toBeNull();
    });
  });

  describe('state.cryptoReady', () => {
    it('starts as false', () => {
      expect(state.cryptoReady).toBe(false);
    });

    it('can be set to true', () => {
      state.cryptoReady = true;
      expect(state.cryptoReady).toBe(true);
    });

    it('calls setCryptoReady global when changed', async () => {
      const { setCryptoReady } = await import('@/app/utils/global');
      
      state.cryptoReady = true;
      expect(setCryptoReady).toHaveBeenCalledWith(true);

      state.cryptoReady = false;
      expect(setCryptoReady).toHaveBeenCalledWith(false);
    });
  });

  describe('state.initPromise', () => {
    it('starts as null', () => {
      expect(state.initPromise).toBeNull();
    });

    it('can hold a promise', () => {
      const promise = Promise.resolve({} as any);
      state.initPromise = promise;
      expect(state.initPromise).toBe(promise);
    });

    it('can be reset to null', () => {
      state.initPromise = Promise.resolve({} as any);
      state.initPromise = null;
      expect(state.initPromise).toBeNull();
    });
  });

  describe('state.sessionVersion', () => {
    it('starts at a number', () => {
      expect(typeof state.sessionVersion).toBe('number');
    });

    it('increments when bumped', () => {
      const initial = state.sessionVersion;
      state.bumpSessionVersion();
      expect(state.sessionVersion).toBe(initial + 1);
    });

    it('can be bumped multiple times', () => {
      const initial = state.sessionVersion;
      state.bumpSessionVersion();
      state.bumpSessionVersion();
      state.bumpSessionVersion();
      expect(state.sessionVersion).toBe(initial + 3);
    });
  });

  describe('state.cachedSecretStorageKey', () => {
    it('starts as null', () => {
      expect(state.cachedSecretStorageKey).toBeNull();
    });

    it('can hold a Uint8Array', () => {
      const key = new Uint8Array([1, 2, 3, 4]);
      state.cachedSecretStorageKey = key;
      expect(state.cachedSecretStorageKey).toBe(key);
    });

    it('can be reset to null', () => {
      state.cachedSecretStorageKey = new Uint8Array([1, 2, 3]);
      state.cachedSecretStorageKey = null;
      expect(state.cachedSecretStorageKey).toBeNull();
    });
  });

  describe('Verification state maps', () => {
    describe('state.verificationReqMap', () => {
      it('is a Map', () => {
        expect(state.verificationReqMap).toBeInstanceOf(Map);
      });

      it('can store verification requests', () => {
        const mockReq = { transactionId: 'test_txn' };
        state.verificationReqMap.set('test_id', mockReq);
        expect(state.verificationReqMap.get('test_id')).toBe(mockReq);
      });

      it('is cleared on resetVerificationState', () => {
        state.verificationReqMap.set('test', { id: 'test' });
        state.resetVerificationState();
        expect(state.verificationReqMap.size).toBe(0);
      });
    });

    describe('state.verificationSnapMap', () => {
      it('is a Map', () => {
        expect(state.verificationSnapMap).toBeInstanceOf(Map);
      });

      it('can store verification snapshots', () => {
        const snapshot = {
          id: 'test_id',
          fromUserId: '@user:matrix.org',
          createdAt: Date.now(),
          phase: 'requested' as const,
        };
        state.verificationSnapMap.set('test_id', snapshot);
        expect(state.verificationSnapMap.get('test_id')).toEqual(snapshot);
      });

      it('is cleared on resetVerificationState', () => {
        state.verificationSnapMap.set('test', {
          id: 'test',
          fromUserId: '@user:matrix.org',
          createdAt: Date.now(),
          phase: 'requested',
        });
        state.resetVerificationState();
        expect(state.verificationSnapMap.size).toBe(0);
      });
    });

    describe('state.verifierMap', () => {
      it('is a Map', () => {
        expect(state.verifierMap).toBeInstanceOf(Map);
      });

      it('can store verifiers', () => {
        const mockVerifier = { verify: vi.fn() };
        state.verifierMap.set('test_id', mockVerifier);
        expect(state.verifierMap.get('test_id')).toBe(mockVerifier);
      });

      it('is cleared on resetVerificationState', () => {
        state.verifierMap.set('test', { verify: vi.fn() });
        state.resetVerificationState();
        expect(state.verifierMap.size).toBe(0);
      });
    });
  });

  describe('state.verificationListenersAttached', () => {
    it('starts as false', () => {
      expect(state.verificationListenersAttached).toBe(false);
    });

    it('can be set to true', () => {
      state.verificationListenersAttached = true;
      expect(state.verificationListenersAttached).toBe(true);
    });

    it('is reset to false on resetVerificationState', () => {
      state.verificationListenersAttached = true;
      state.resetVerificationState();
      expect(state.verificationListenersAttached).toBe(false);
    });
  });

  describe('state.resetVerificationState', () => {
    it('clears all verification maps', () => {
      state.verificationReqMap.set('req1', {});
      state.verificationReqMap.set('req2', {});
      state.verificationSnapMap.set('snap1', {
        id: 'snap1',
        fromUserId: '@user:matrix.org',
        createdAt: Date.now(),
        phase: 'requested',
      });
      state.verifierMap.set('ver1', {});

      state.resetVerificationState();

      expect(state.verificationReqMap.size).toBe(0);
      expect(state.verificationSnapMap.size).toBe(0);
      expect(state.verifierMap.size).toBe(0);
    });

    it('resets verificationListenersAttached flag', () => {
      state.verificationListenersAttached = true;
      state.resetVerificationState();
      expect(state.verificationListenersAttached).toBe(false);
    });

    it('can be called multiple times safely', () => {
      state.resetVerificationState();
      state.resetVerificationState();
      state.resetVerificationState();

      expect(state.verificationReqMap.size).toBe(0);
      expect(state.verificationListenersAttached).toBe(false);
    });
  });

  describe('getMatrixClientOrThrow', () => {
    it('throws when client is null', () => {
      state.matrixClient = null;
      expect(() => getMatrixClientOrThrow()).toThrow('Matrix client is not initialized');
    });

    it('returns client when initialized', () => {
      const mockClient = { getUserId: () => '@test:matrix.org' } as any;
      state.matrixClient = mockClient;
      expect(getMatrixClientOrThrow()).toBe(mockClient);
    });

  });

  describe('State isolation', () => {
    it('different state properties are independent', () => {
      const mockClient = {} as any;
      const mockKey = new Uint8Array([1, 2, 3]);
      const mockPromise = Promise.resolve({} as any);

      state.matrixClient = mockClient;
      state.cachedSecretStorageKey = mockKey;
      state.initPromise = mockPromise;
      state.cryptoReady = true;

      state.matrixClient = null;

      expect(state.cachedSecretStorageKey).toBe(mockKey);
      expect(state.initPromise).toBe(mockPromise);
      expect(state.cryptoReady).toBe(true);
    });

    it('resetVerificationState does not affect other state', () => {
      const mockClient = {} as any;
      const mockKey = new Uint8Array([1, 2, 3]);

      state.matrixClient = mockClient;
      state.cachedSecretStorageKey = mockKey;
      state.cryptoReady = true;

      state.resetVerificationState();

      expect(state.matrixClient).toBe(mockClient);
      expect(state.cachedSecretStorageKey).toBe(mockKey);
      expect(state.cryptoReady).toBe(true);
    });
  });

  describe('Type safety', () => {
    it('verificationSnapMap stores correct type', () => {
      const snapshot = {
        id: 'type_test',
        txnId: 'txn_123',
        fromUserId: '@user:matrix.org',
        fromDeviceId: 'DEVICE',
        createdAt: 1234567890,
        phase: 'showing_sas' as const,
        sasEmojis: ['🐶', '🐱'],
        sasDecimals: [1234, 5678, 9012],
      };

      state.verificationSnapMap.set(snapshot.id, snapshot);
      const retrieved = state.verificationSnapMap.get(snapshot.id);

      expect(retrieved?.id).toBe('type_test');
      expect(retrieved?.phase).toBe('showing_sas');
      expect(retrieved?.sasEmojis).toEqual(['🐶', '🐱']);
    });
  });
});