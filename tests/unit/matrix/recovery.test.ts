import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  setRecoveryKey,
  validateRecoveryKey,
  ensureKeyBackupEnabled,
  restoreEncryptedHistoryFromBackup,
  createRecoveryKey,
} from '@/app/utils/matrix/recovery';
import { state } from '@/app/utils/matrix/state';

vi.mock('matrix-js-sdk/lib/crypto-api', () => ({
  decodeRecoveryKey: vi.fn((key: string) => {
    if (!key || key.trim().length < 10) {
      throw new Error('Invalid recovery key');
    }
    return new Uint8Array(32).fill(1);
  }),
  encodeRecoveryKey: vi.fn((key: Uint8Array) => {
    if (!key || key.length !== 32) {
      throw new Error('Invalid key length');
    }
    return 'EsT2 AbCd EfGh IjKl MnOp QrSt UvWx YzAb CdEf GhIj';
  }),
}));

vi.mock('@/app/utils/matrix/storage', () => ({
  ensureCachedKeyLoaded: vi.fn(),
  persistSecretStorageKey: vi.fn(),
}));

vi.mock('@/app/utils/matrix/state', () => ({
  state: {
    cachedSecretStorageKey: null as Uint8Array | null,
    matrixClient: null as any,
  },
  getMatrixClientOrThrow: vi.fn(() => {
    if (!state.matrixClient) {
      throw new Error('Matrix client is not initialized');
    }
    return state.matrixClient;
  }),
}));

vi.mock('@/app/utils/matrix/crypto', () => ({
  getCryptoModule: vi.fn((client: any) => client?.getCrypto?.() || client?.crypto),
}));

describe('Matrix Recovery Utilities', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.cachedSecretStorageKey = null;
    state.matrixClient = null;
  });

  describe('setRecoveryKey', () => {
    it('decodes and caches recovery key', async () => {
      const { persistSecretStorageKey } = await import('@/app/utils/matrix/storage');
      
      setRecoveryKey('EsT2 AbCd EfGh IjKl MnOp QrSt UvWx YzAb CdEf GhIj');

      expect(state.cachedSecretStorageKey).toBeInstanceOf(Uint8Array);
      expect(persistSecretStorageKey).toHaveBeenCalled();
    });

    it('trims whitespace from key', async () => {
      const { decodeRecoveryKey } = await import('matrix-js-sdk/lib/crypto-api');

      setRecoveryKey('  EsT2 AbCd EfGh IjKl MnOp QrSt UvWx YzAb CdEf GhIj  ');

      expect(decodeRecoveryKey).toHaveBeenCalledWith('EsT2 AbCd EfGh IjKl MnOp QrSt UvWx YzAb CdEf GhIj');
    });

    it('throws for invalid recovery key', async () => {
      const { decodeRecoveryKey } = await import('matrix-js-sdk/lib/crypto-api');
      (decodeRecoveryKey as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
        throw new Error('Invalid recovery key');
      });

      expect(() => setRecoveryKey('invalid')).toThrow('Invalid recovery key');
    });
  });

  describe('validateRecoveryKey', () => {
    beforeEach(() => {
      state.matrixClient = {
        getAccountData: vi.fn(() => ({
          getContent: () => ({ algorithm: 'm.secret_storage.v1.aes-hmac-sha2' }),
        })),
        secretStorage: {
          getDefaultKeyId: vi.fn(async () => 'default_key_id'),
          checkKey: vi.fn(async () => true),
        },
      } as any;
    });

    it('returns true for valid key', async () => {
      const result = await validateRecoveryKey('EsT2 AbCd EfGh IjKl MnOp QrSt UvWx YzAb CdEf GhIj');
      expect(result).toBe(true);
    });

    it('returns false for invalid format', async () => {
      const { decodeRecoveryKey } = await import('matrix-js-sdk/lib/crypto-api');
      (decodeRecoveryKey as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
        throw new Error('Invalid recovery key');
      });

      const result = await validateRecoveryKey('short');
      expect(result).toBe(false);
    });

    it('returns true when no key info available', async () => {
      state.matrixClient = {
        getAccountData: vi.fn(() => null),
        secretStorage: {
          getDefaultKeyId: vi.fn(async () => null),
        },
      } as any;

      const result = await validateRecoveryKey('EsT2 AbCd EfGh IjKl MnOp QrSt UvWx YzAb CdEf GhIj');
      expect(result).toBe(true);
    });

    it('returns false when checkKey fails', async () => {
      state.matrixClient = {
        getAccountData: vi.fn(() => ({
          getContent: () => ({}),
        })),
        secretStorage: {
          getDefaultKeyId: vi.fn(async () => 'key_id'),
          checkKey: vi.fn(async () => false),
        },
      } as any;

      const result = await validateRecoveryKey('EsT2 AbCd EfGh IjKl MnOp QrSt UvWx YzAb CdEf GhIj');
      expect(result).toBe(false);
    });

    it('handles secret storage errors', async () => {
      state.matrixClient = {
        getAccountData: vi.fn(() => ({
          getContent: () => ({}),
        })),
        secretStorage: {
          getDefaultKeyId: vi.fn(async () => {
            throw new Error('Network error');
          }),
        },
      } as any;

      const result = await validateRecoveryKey('EsT2 AbCd EfGh IjKl MnOp QrSt UvWx YzAb CdEf GhIj');
      expect(result).toBe(false);
    });

    it('throws when client not initialized', async () => {
      const { getMatrixClientOrThrow } = await import('@/app/utils/matrix/state');
      (getMatrixClientOrThrow as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
        throw new Error('Matrix client is not initialized');
      });

      await expect(validateRecoveryKey('valid_key')).rejects.toThrow('Matrix client is not initialized');
    });
  });

  describe('ensureKeyBackupEnabled', () => {
    it('calls loadSessionBackupPrivateKeyFromSecretStorage', async () => {
      const loadBackup = vi.fn(async () => {});
      const checkBackup = vi.fn(async () => {});

      state.matrixClient = {
        getCrypto: () => ({
          loadSessionBackupPrivateKeyFromSecretStorage: loadBackup,
          checkKeyBackupAndEnable: checkBackup,
        }),
      } as any;

      await ensureKeyBackupEnabled();

      expect(loadBackup).toHaveBeenCalled();
    });

    it('calls checkKeyBackupAndEnable', async () => {
      const checkBackup = vi.fn(async () => {});

      state.matrixClient = {
        getCrypto: () => ({
          checkKeyBackupAndEnable: checkBackup,
        }),
      } as any;

      await ensureKeyBackupEnabled();

      expect(checkBackup).toHaveBeenCalled();
    });

    it('throws when no crypto module', async () => {
      state.matrixClient = {
        getCrypto: () => null,
      } as any;

      await expect(ensureKeyBackupEnabled()).rejects.toThrow('Crypto is not initialised');
    });

    it('handles missing methods gracefully', async () => {
      state.matrixClient = {
        getCrypto: () => ({}),
      } as any;

      await expect(ensureKeyBackupEnabled()).resolves.not.toThrow();
    });

    it('ensures cached key is loaded first', async () => {
      const { ensureCachedKeyLoaded } = await import('@/app/utils/matrix/storage');

      state.matrixClient = {
        getCrypto: () => ({}),
      } as any;

      await ensureKeyBackupEnabled();

      expect(ensureCachedKeyLoaded).toHaveBeenCalled();
    });
  });

  describe('restoreEncryptedHistoryFromBackup', () => {
    beforeEach(() => {
      state.cachedSecretStorageKey = new Uint8Array(32).fill(1);
      state.matrixClient = {
        getCrypto: () => ({
          loadSessionBackupPrivateKeyFromSecretStorage: vi.fn(async () => {}),
          checkKeyBackupAndEnable: vi.fn(async () => {}),
          restoreKeyBackup: vi.fn(async () => {}),
        }),
      } as any;
    });

    it('restores from backup successfully', async () => {
      const restoreKeyBackup = vi.fn(async () => {});
      state.matrixClient = {
        getCrypto: () => ({
          loadSessionBackupPrivateKeyFromSecretStorage: vi.fn(),
          checkKeyBackupAndEnable: vi.fn(),
          restoreKeyBackup,
        }),
      } as any;

      await restoreEncryptedHistoryFromBackup();

      expect(restoreKeyBackup).toHaveBeenCalledWith({});
    });

    it('throws when no recovery key cached', async () => {
      state.cachedSecretStorageKey = null;

      await expect(restoreEncryptedHistoryFromBackup()).rejects.toThrow(
        'No Recovery Key set for this session'
      );
    });

    it('throws when recovery key is empty', async () => {
      state.cachedSecretStorageKey = new Uint8Array(0);

      await expect(restoreEncryptedHistoryFromBackup()).rejects.toThrow(
        'No Recovery Key set for this session'
      );
    });

    it('throws when no crypto module', async () => {
      state.matrixClient = {
        getCrypto: () => null,
      } as any;

      await expect(restoreEncryptedHistoryFromBackup()).rejects.toThrow('Crypto is not initialised');
    });

    it('throws when restoreKeyBackup not supported', async () => {
      state.matrixClient = {
        getCrypto: () => ({
          loadSessionBackupPrivateKeyFromSecretStorage: vi.fn(),
          checkKeyBackupAndEnable: vi.fn(),
        }),
      } as any;

      await expect(restoreEncryptedHistoryFromBackup()).rejects.toThrow(
        'Key backup restore not supported'
      );
    });
  });

  describe('createRecoveryKey', () => {
    const mockCrypto = {
      bootstrapSecretStorage: vi.fn(async (opts: any) => {
        if (opts?.createSecretStorageKey) {
          await opts.createSecretStorageKey();
        }
      }),
      createRecoveryKeyFromPassphrase: vi.fn(async () => ({
        privateKey: new Uint8Array(32).fill(2),
        encodedPrivateKey: 'NewKey AbCd EfGh IjKl MnOp QrSt UvWx YzAb',
      })),
      loadSessionBackupPrivateKeyFromSecretStorage: vi.fn(),
      checkKeyBackupAndEnable: vi.fn(),
    };

    beforeEach(() => {
      state.matrixClient = {
        getCrypto: () => mockCrypto,
      } as any;

      mockCrypto.bootstrapSecretStorage.mockClear();
      mockCrypto.createRecoveryKeyFromPassphrase.mockClear();
    });

    it('creates and returns encoded recovery key', async () => {
      const key = await createRecoveryKey();

      expect(typeof key).toBe('string');
      expect(key.length).toBeGreaterThan(0);
    });

    it('calls bootstrapSecretStorage', async () => {
      await createRecoveryKey();

      expect(mockCrypto.bootstrapSecretStorage).toHaveBeenCalledWith(
        expect.objectContaining({
          setupNewSecretStorage: true,
          setupNewKeyBackup: true,
        })
      );
    });

    it('caches the generated key', async () => {
      const { persistSecretStorageKey } = await import('@/app/utils/matrix/storage');

      await createRecoveryKey();

      expect(state.cachedSecretStorageKey).not.toBeNull();
      expect(persistSecretStorageKey).toHaveBeenCalled();
    });

    it('throws when no crypto module', async () => {
      state.matrixClient = {
        getCrypto: () => null,
      } as any;

      await expect(createRecoveryKey()).rejects.toThrow('Crypto is not initialised');
    });

    it('throws when bootstrapSecretStorage not available', async () => {
      state.matrixClient = {
        getCrypto: () => ({
          createRecoveryKeyFromPassphrase: mockCrypto.createRecoveryKeyFromPassphrase,
        }),
      } as any;

      await expect(createRecoveryKey()).rejects.toThrow(
        'Secret storage bootstrap not supported'
      );
    });

    it('throws when createRecoveryKeyFromPassphrase not available', async () => {
      state.matrixClient = {
        getCrypto: () => ({
          bootstrapSecretStorage: mockCrypto.bootstrapSecretStorage,
        }),
      } as any;

      await expect(createRecoveryKey()).rejects.toThrow(
        'Recovery key generation not supported'
      );
    });

    it('uses encodedPrivateKey from result if available', async () => {
      mockCrypto.createRecoveryKeyFromPassphrase.mockResolvedValueOnce({
        privateKey: new Uint8Array(32),
        encodedPrivateKey: 'Custom Encoded Key Here',
      });

      const key = await createRecoveryKey();

      expect(key).toBe('Custom Encoded Key Here');
    });

    it('falls back to encoding privateKey if no encodedPrivateKey', async () => {
      mockCrypto.createRecoveryKeyFromPassphrase.mockResolvedValueOnce({
        privateKey: new Uint8Array(32).fill(3),
      } as any);

      const key = await createRecoveryKey();

      expect(typeof key).toBe('string');
      expect(key.length).toBeGreaterThan(0);
    });

    it('enables key backup after creation', async () => {
      await createRecoveryKey();

      expect(mockCrypto.checkKeyBackupAndEnable).toHaveBeenCalled();
    });

    it('throws when key generation returns empty result', async () => {
      mockCrypto.createRecoveryKeyFromPassphrase.mockResolvedValueOnce({} as any);
      state.cachedSecretStorageKey = null;

      await expect(createRecoveryKey()).rejects.toThrow('Failed to generate Recovery Key');
    });
  });
});