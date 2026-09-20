import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  attachVerificationListeners,
  refreshVerificationRequest,
  confirmVerificationRequest,
  declineVerificationRequest,
  cancelVerificationRequest,
  startEmojiVerification,
  isOutgoingVerificationRequest,
} from '@/app/utils/matrix/verification';
import { state } from '@/app/utils/matrix/state';

vi.mock('@/app/utils/matrix/events', () => ({
  emitVerificationSnapshot: vi.fn(),
}));

vi.mock('@/app/utils/matrix/crypto', () => ({
  getCryptoModule: vi.fn((client) => client?.getCrypto?.()),
}));

describe('Matrix Verification Utilities', () => {
  const createMockClient = (overrides?: any) => ({
    getUserId: vi.fn(() => '@testuser:matrix.org'),
    getDeviceId: vi.fn(() => 'TESTDEVICE'),
    on: vi.fn().mockReturnThis(),
    off: vi.fn().mockReturnThis(),
    removeListener: vi.fn().mockReturnThis(),
    getCrypto: vi.fn(() => ({
      on: vi.fn(),
      off: vi.fn(),
      requestOwnUserVerification: vi.fn(async () => ({
        transactionId: 'out_txn_123',
        phase: 'requested',
        otherUserId: '@testuser:matrix.org',
        accept: vi.fn(),
        cancel: vi.fn(),
        startVerification: vi.fn(),
      })),
      requestDeviceVerification: vi.fn(async () => ({
        transactionId: 'device_txn_123',
        phase: 'requested',
      })),
      getUserDeviceInfo: vi.fn(async () => new Map()),
      getVerificationRequest: vi.fn(() => null),
      getVerificationRequests: vi.fn(() => []),
    })),
    ...overrides,
  });

  const createMockRequest = (overrides?: any) => ({
    transactionId: 'test_txn_123',
    requestId: 'test_req_123',
    phase: 'requested',
    otherUserId: '@other:matrix.org',
    otherDeviceId: 'OTHERDEVICE',
    initiatedByMe: false,
    isSelfVerification: false,
    methods: ['m.sas.v1'],
    verifier: null,
    on: vi.fn(),
    off: vi.fn(),
    accept: vi.fn(async () => {}),
    cancel: vi.fn(async () => {}),
    reject: vi.fn(async () => {}),
    startVerification: vi.fn(async () => ({
      verify: vi.fn(async () => {}),
      cancel: vi.fn(async () => {}),
      getShowSasCallbacks: vi.fn(() => null),
      on: vi.fn(),
      off: vi.fn(),
    })),
    getPhase: vi.fn(() => 'requested'),
    ...overrides,
  });

  beforeEach(() => {
    vi.clearAllMocks();
    state.matrixClient = null;
    state.cryptoReady = false;
    state.verificationReqMap.clear();
    state.verificationSnapMap.clear();
    state.verifierMap.clear();
    state.verificationListenersAttached = false;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('attachVerificationListeners', () => {
    it('does nothing when already attached', () => {
      state.verificationListenersAttached = true;
      const mockClient = createMockClient();
      attachVerificationListeners(mockClient as any);
      expect(mockClient.on).not.toHaveBeenCalled();
    });

    it('attaches listeners when not already attached', () => {
      const mockClient = createMockClient();
      state.verificationListenersAttached = false;
      attachVerificationListeners(mockClient as any);
      expect(mockClient.on).toHaveBeenCalled();
      expect(state.verificationListenersAttached).toBe(true);
    });

    it('handles missing crypto module gracefully', () => {
      const mockClient = createMockClient({ getCrypto: () => null });
      state.verificationListenersAttached = false;
      expect(() => attachVerificationListeners(mockClient as any)).not.toThrow();
      expect(state.verificationListenersAttached).toBe(true);
    });
  });

  describe('refreshVerificationRequest', () => {
    it('returns false for unknown request without client', () => {
      state.matrixClient = null;
      expect(refreshVerificationRequest('unknown_id')).toBe(false);
    });

    it('returns false for unknown request with client', () => {
      state.matrixClient = createMockClient() as any;
      expect(refreshVerificationRequest('unknown_id')).toBe(false);
    });

    it('returns true for known request in map', () => {
      state.matrixClient = createMockClient() as any;
      state.verificationReqMap.set('test_txn_123', createMockRequest());
      expect(refreshVerificationRequest('test_txn_123')).toBe(true);
    });
  });

  describe('confirmVerificationRequest', () => {
    it('returns false for unknown request', async () => {
      state.matrixClient = createMockClient() as any;
      expect(await confirmVerificationRequest('unknown_id')).toBe(false);
    });

    it('accepts verification for known request', async () => {
      state.matrixClient = createMockClient() as any;

      /* phase 'ready' makes the readiness wait resolve immediately so the test doesn't hit the timeout */
      const mockReq = createMockRequest({ phase: 'ready', getPhase: vi.fn(() => 'ready') });
      state.verificationReqMap.set('test_txn_123', mockReq);
      state.verificationSnapMap.set('test_txn_123', {
        id: 'test_txn_123',
        txnId: 'test_txn_123',
        fromUserId: '@other:matrix.org',
        createdAt: Date.now(),
        phase: 'ready',
      });

      const result = await confirmVerificationRequest('test_txn_123');
      expect(result).toBe(true);
      expect(mockReq.accept).toHaveBeenCalled();
    });
  });

  describe('declineVerificationRequest', () => {
    it('returns false for unknown request', async () => {
      state.matrixClient = createMockClient() as any;
      expect(await declineVerificationRequest('unknown_id')).toBe(false);
    });

    it('cancels request when known', async () => {
      state.matrixClient = createMockClient() as any;
      const mockReq = createMockRequest();
      state.verificationReqMap.set('test_txn_123', mockReq);
      state.verificationSnapMap.set('test_txn_123', {
        id: 'test_txn_123', txnId: 'test_txn_123',
        fromUserId: '@other:matrix.org', createdAt: Date.now(), phase: 'requested',
      });
      const result = await declineVerificationRequest('test_txn_123');
      expect(result).toBe(true);
      expect(mockReq.cancel).toHaveBeenCalled();
    });
  });

  describe('cancelVerificationRequest', () => {
    it('returns false for unknown request', async () => {
      state.matrixClient = createMockClient() as any;
      expect(await cancelVerificationRequest('unknown_id')).toBe(false);
    });

    it('cancels request when known', async () => {
      state.matrixClient = createMockClient() as any;
      const mockReq = createMockRequest();
      state.verificationReqMap.set('test_txn_123', mockReq);
      state.verificationSnapMap.set('test_txn_123', {
        id: 'test_txn_123', txnId: 'test_txn_123',
        fromUserId: '@other:matrix.org', createdAt: Date.now(), phase: 'ready',
      });
      const result = await cancelVerificationRequest('test_txn_123');
      expect(result).toBe(true);
      expect(mockReq.cancel).toHaveBeenCalled();
    });
  });

  describe('startEmojiVerification', () => {
    it('is an alias for confirmVerificationRequest', () => {
      expect(startEmojiVerification).toBe(confirmVerificationRequest);
    });
  });

  describe('isOutgoingVerificationRequest', () => {
    it('returns false for unknown request', () => {
      expect(isOutgoingVerificationRequest('unknown_id')).toBe(false);
    });

    it('returns false for incoming request', () => {
      state.verificationReqMap.set('test_txn_123', createMockRequest());
      expect(isOutgoingVerificationRequest('test_txn_123')).toBe(false);
    });
  });

  describe('Snapshot phases', () => {
    const phases = ['requested', 'ready', 'showing_sas', 'done', 'cancelled'] as const;

    phases.forEach(phase => {
      it(`tracks ${phase} phase`, () => {
        const snapshot = { id: 'test_id', fromUserId: '@other:matrix.org', createdAt: Date.now(), phase };
        state.verificationSnapMap.set('test_id', snapshot);
        expect(state.verificationSnapMap.get('test_id')?.phase).toBe(phase);
      });
    });

    it('tracks showing_sas phase with emojis', () => {
      const snapshot = {
        id: 'test_id', fromUserId: '@other:matrix.org', createdAt: Date.now(),
        phase: 'showing_sas' as const,
        sasEmojis: ['🐶', '🐱', '🐭'],
        sasDecimals: [1234, 5678, 9012],
      };
      state.verificationSnapMap.set('test_id', snapshot);
      const stored = state.verificationSnapMap.get('test_id');
      expect(stored?.sasEmojis).toEqual(['🐶', '🐱', '🐭']);
      expect(stored?.sasDecimals).toEqual([1234, 5678, 9012]);
    });
  });

  describe('Request method fallback', () => {
    it('uses cancel method when available', async () => {
      state.matrixClient = createMockClient() as any;
      const cancelFn = vi.fn(async () => {});
      const mockReq = createMockRequest({ cancel: cancelFn });
      state.verificationReqMap.set('test_txn_123', mockReq);
      state.verificationSnapMap.set('test_txn_123', {
        id: 'test_txn_123', txnId: 'test_txn_123',
        fromUserId: '@other:matrix.org', createdAt: Date.now(), phase: 'requested',
      });
      await declineVerificationRequest('test_txn_123');
      expect(cancelFn).toHaveBeenCalled();
    });

    it('falls back to reject when cancel not available', async () => {
      state.matrixClient = createMockClient() as any;
      const rejectFn = vi.fn(async () => {});
      const mockReq = createMockRequest({ cancel: undefined, reject: rejectFn });
      state.verificationReqMap.set('test_txn_123', mockReq);
      state.verificationSnapMap.set('test_txn_123', {
        id: 'test_txn_123', txnId: 'test_txn_123',
        fromUserId: '@other:matrix.org', createdAt: Date.now(), phase: 'requested',
      });
      await declineVerificationRequest('test_txn_123');
      expect(rejectFn).toHaveBeenCalled();
    });
  });
});