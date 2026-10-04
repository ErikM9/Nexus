import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ConnectionError, MatrixError } from 'matrix-js-sdk';
import {
  ensureKeyBackupEnabled,
  restoreWithRecoveryKey,
  RecoveryKeyError,
  createRecoveryKey,
  BackupReplaceConfirmationError,
  RecoveryKeyIncompleteError,
} from '@/app/utils/matrix/recovery';
import { state } from '@/app/utils/matrix/state';
import { cacheSecretStorageKey, secretStorageKeyMatches } from '@/app/utils/matrix/storage';
import type { CreateSecretStorageOpts, GeneratedSecretStorageKey, KeyBackupInfo } from 'matrix-js-sdk/lib/crypto-api';

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

/* Defaults to a matching key so restore tests only override it where a mismatch is the point */
vi.mock('@/app/utils/matrix/storage', () => ({
  ensureCachedKeyLoaded: vi.fn(),
  persistSecretStorageKey: vi.fn(),
  cacheSecretStorageKey: vi.fn(),
  secretStorageKeyMatches: vi.fn(async () => true),
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

/* A well-formed key the mocked decodeRecoveryKey above accepts */
const VALID_KEY = 'EsT2 AbCd EfGh IjKl MnOp QrSt UvWx YzAb CdEf GhIj';

describe('Matrix Recovery Utilities', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.cachedSecretStorageKey = null;
    state.matrixClient = null;
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
          loadSessionBackupPrivateKeyFromSecretStorage: vi.fn(async () => {}),
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

    /* Both calls are required CryptoApi methods, so the real failure mode is one of them rejecting, not being absent */
    it('swallows a failure from either backup call so start-up is never blocked on it', async () => {
      state.matrixClient = {
        getCrypto: () => ({
          loadSessionBackupPrivateKeyFromSecretStorage: vi.fn(async () => {
            throw new Error('getSecretStorageKey callback returned invalid data');
          }),
          checkKeyBackupAndEnable: vi.fn(async () => {
            throw new Error('M_UNKNOWN: Internal error');
          }),
        }),
      } as any;

      await expect(ensureKeyBackupEnabled()).resolves.not.toThrow();
    });

    it('ensures cached key is loaded first', async () => {
      const { ensureCachedKeyLoaded } = await import('@/app/utils/matrix/storage');

      state.matrixClient = {
        getCrypto: () => ({
          loadSessionBackupPrivateKeyFromSecretStorage: vi.fn(async () => {}),
          checkKeyBackupAndEnable: vi.fn(async () => {}),
        }),
      } as any;

      await ensureKeyBackupEnabled();

      expect(ensureCachedKeyLoaded).toHaveBeenCalled();
    });
  });

  describe('restoreWithRecoveryKey', () => {
    const BACKUP: KeyBackupInfo = {
      algorithm: 'm.megolm_backup.v1.curve25519-aes-sha2',
      auth_data: { public_key: 'hSDwCYkwp1R0i33ctD73Wg2/Og0mOBr066SpjqqbTmo', signatures: {} },
      version: '3',
    };
    /* The shape client.http.authedRequest(Method.Get, '/room_keys/version') gets on a 404, the SDK's "no backup" answer */
    const notFound = () => Promise.reject(new MatrixError({ errcode: 'M_NOT_FOUND', error: 'Not found' }, 404));

    /* A client double shaped like the SDK: the secret-storage lookup the key is checked against, the raw backup-version
       request fetchServerKeyBackup makes over client.http, and the crypto calls the rest of the restore walks through */
    const useClient = (
      opts: {
        defaultKeyId?: string | null;
        backupRequest?: () => Promise<KeyBackupInfo>;
        isStored?: Record<string, unknown> | null;
        loadBackupKey?: () => Promise<void>;
        restoreKeyBackup?: () => Promise<{ imported: number; total: number }>;
      } = {}
    ) => {
      const crypto = {
        checkKeyBackupAndEnable: vi.fn(async () => null),
        loadSessionBackupPrivateKeyFromSecretStorage: vi.fn(opts.loadBackupKey ?? (async () => {})),
        restoreKeyBackup: vi.fn(opts.restoreKeyBackup ?? (async () => ({ imported: 4, total: 4 }))),
      };
      state.matrixClient = {
        getCrypto: () => crypto,
        secretStorage: {
          getDefaultKeyId: vi.fn(async () => (opts.defaultKeyId === undefined ? 'KEYID' : opts.defaultKeyId)),
          getKey: vi.fn(async (keyId: string) => [keyId, { algorithm: 'm.secret_storage.v1.aes-hmac-sha2' }]),
          isStored: vi.fn(async () => (opts.isStored === undefined ? { KEYID: {} } : opts.isStored)),
        },
        http: { authedRequest: vi.fn(opts.backupRequest ?? (async () => BACKUP)) },
      } as any;
      return crypto;
    };

    it('reports the numbers restoreKeyBackup returns on success', async () => {
      useClient({ restoreKeyBackup: async () => ({ imported: 4, total: 10 }) });

      const result = await restoreWithRecoveryKey(VALID_KEY);

      expect(result).toEqual({ imported: 4, total: 10 });
      expect(cacheSecretStorageKey).toHaveBeenCalled();
    });

    it("rejects a key that isn't the SDK's Recovery Key format, without touching the account", async () => {
      useClient({});
      const { decodeRecoveryKey } = await import('matrix-js-sdk/lib/crypto-api');
      (decodeRecoveryKey as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
        throw new Error('bad format');
      });

      await expect(restoreWithRecoveryKey('not a key')).rejects.toMatchObject({ problem: 'invalid-key' });
      expect(cacheSecretStorageKey).not.toHaveBeenCalled();
    });

    it('says there is no Recovery Key yet when the account has no secret storage', async () => {
      useClient({ defaultKeyId: null });

      await expect(restoreWithRecoveryKey(VALID_KEY)).rejects.toMatchObject({ problem: 'no-secret-storage' });
      expect(cacheSecretStorageKey).not.toHaveBeenCalled();
    });

    it("says the key doesn't belong to the account when it fails the secret-storage check, and never caches it", async () => {
      useClient({});
      vi.mocked(secretStorageKeyMatches).mockResolvedValueOnce(false);

      await expect(restoreWithRecoveryKey(VALID_KEY)).rejects.toMatchObject({ problem: 'wrong-key' });
      expect(cacheSecretStorageKey).not.toHaveBeenCalled();
    });

    it('says there is no backup once a matched key finds none on the server, but still remembers the key', async () => {
      useClient({ backupRequest: notFound });

      await expect(restoreWithRecoveryKey(VALID_KEY)).rejects.toMatchObject({ problem: 'no-backup' });
      expect(cacheSecretStorageKey).toHaveBeenCalled();
    });

    it("says the backup isn't stored with this key when secret storage holds no backup secret", async () => {
      useClient({ isStored: null });

      await expect(restoreWithRecoveryKey(VALID_KEY)).rejects.toMatchObject({ problem: 'backup-key-missing' });
      expect(cacheSecretStorageKey).toHaveBeenCalled();
    });

    it('reports a backup replaced on another device when the stored secret no longer opens it', async () => {
      useClient({
        loadBackupKey: async () => {
          throw new Error('no matching backup found');
        },
      });

      await expect(restoreWithRecoveryKey(VALID_KEY)).rejects.toMatchObject({ problem: 'backup-replaced' });
    });

    it('reports an unreachable homeserver as a connection problem, not an invalid key', async () => {
      useClient({ backupRequest: () => Promise.reject(new ConnectionError('fetch failed')) });

      await expect(restoreWithRecoveryKey(VALID_KEY)).rejects.toMatchObject({ problem: 'unreachable' });
    });

    it('reports a homeserver error with its status instead of a generic failure', async () => {
      useClient({
        restoreKeyBackup: () => Promise.reject(new MatrixError({ errcode: 'M_UNKNOWN', error: 'Bad gateway' }, 502)),
      });

      const attempt = restoreWithRecoveryKey(VALID_KEY);

      await expect(attempt).rejects.toMatchObject({ problem: 'server-error' });
      await expect(attempt).rejects.toThrow('error 502');
    });
  });

  describe('createRecoveryKey', () => {
    const NEW_KEY = new Uint8Array(32).fill(7);
    const generated: GeneratedSecretStorageKey = { privateKey: NEW_KEY, encodedPrivateKey: 'EsTn ewKe y000 0000' };
    const serverBackup: KeyBackupInfo = {
      algorithm: 'm.megolm_backup.v1.curve25519-aes-sha2',
      auth_data: { public_key: 'hSDwCYkwp1R0i33ctD73Wg2/Og0mOBr066SpjqqbTmo', signatures: {} },
      version: '3',
      count: 42,
    };

    /* A client double shaped like the SDK: bootstrap asks for the new key the way the SDK does and records what it was
       told to do with the backup, while fetchServerKeyBackup's request over client.http sees whatever server
       backup this test sets up, a 404 standing for no backup at all */
    const setup = (opts: {
      backup?: KeyBackupInfo | null;
      deviceHasBackupKey?: boolean;
      keyInSecretStorage?: boolean;
      defaultKeyId?: string | null;
    }) => {
      let hasKey = !!opts.deviceHasBackupKey;
      const crypto = {
        isKeyBackupTrusted: vi.fn(async () => ({ trusted: true, matchesDecryptionKey: hasKey })),
        loadSessionBackupPrivateKeyFromSecretStorage: vi.fn(async () => {
          if (!opts.keyInSecretStorage) throw new Error('getSecretStorageKey callback returned invalid data');
          hasKey = true;
        }),
        createRecoveryKeyFromPassphrase: vi.fn(async () => generated),
        bootstrapSecretStorage: vi.fn(async (bootstrap: CreateSecretStorageOpts) => {
          if (bootstrap.setupNewSecretStorage) await bootstrap.createSecretStorageKey?.();
        }),
        checkKeyBackupAndEnable: vi.fn(async () => null),
      };
      state.matrixClient = {
        getCrypto: () => crypto,
        secretStorage: {
          getDefaultKeyId: vi.fn(async () => (opts.defaultKeyId === undefined ? 'OLDKEY' : opts.defaultKeyId)),
          getKey: vi.fn(async (keyId: string) => [keyId, { algorithm: 'm.secret_storage.v1.aes-hmac-sha2' }]),
        },
        http: {
          authedRequest: vi.fn(async () => {
            if (!opts.backup?.version) throw new MatrixError({ errcode: 'M_NOT_FOUND', error: 'Not found' }, 404);
            return opts.backup;
          }),
        },
      } as any;
      return crypto;
    };

    beforeEach(() => {
      state.pendingSecretStorageKey = null;
    });

    it('creates a new key backup when the account has none', async () => {
      const crypto = setup({ backup: null });

      const created = await createRecoveryKey();

      expect(crypto.bootstrapSecretStorage).toHaveBeenCalledWith(
        expect.objectContaining({ setupNewSecretStorage: true, setupNewKeyBackup: true })
      );
      expect(created).toEqual({ recoveryKey: 'EsTn ewKe y000 0000', backup: 'created' });
    });

    it('keeps an existing backup whose key this device holds', async () => {
      const crypto = setup({ backup: serverBackup, deviceHasBackupKey: true });

      const created = await createRecoveryKey();

      expect(crypto.bootstrapSecretStorage).toHaveBeenCalledWith(
        expect.objectContaining({ setupNewSecretStorage: true, setupNewKeyBackup: false })
      );
      expect(created.backup).toBe('kept');
    });

    it('keeps a backup whose key can be loaded from secret storage', async () => {
      const crypto = setup({ backup: serverBackup, keyInSecretStorage: true });

      const created = await createRecoveryKey();

      expect(crypto.loadSessionBackupPrivateKeyFromSecretStorage).toHaveBeenCalled();
      expect(crypto.bootstrapSecretStorage).toHaveBeenCalledWith(expect.objectContaining({ setupNewKeyBackup: false }));
      expect(created.backup).toBe('kept');
    });

    it('asks for confirmation instead of deleting a backup this device cannot read', async () => {
      const crypto = setup({ backup: serverBackup });

      const attempt = createRecoveryKey();

      await expect(attempt).rejects.toBeInstanceOf(BackupReplaceConfirmationError);
      await expect(attempt).rejects.toMatchObject({ backup: { kind: 'unreadable', version: '3', keyCount: 42 } });
      expect(crypto.createRecoveryKeyFromPassphrase).not.toHaveBeenCalled();
      expect(crypto.bootstrapSecretStorage).not.toHaveBeenCalled();
    });

    it('replaces a backup this device cannot read once the user confirmed', async () => {
      const crypto = setup({ backup: serverBackup });

      const created = await createRecoveryKey({ replaceUnreadableBackup: true });

      expect(crypto.bootstrapSecretStorage).toHaveBeenCalledWith(expect.objectContaining({ setupNewKeyBackup: true }));
      expect(created.backup).toBe('replaced');
    });

    it('offers the new key to the SDK only while setup runs, then caches it', async () => {
      const crypto = setup({ backup: null });
      let pendingDuringSetup: Uint8Array | null = null;
      crypto.bootstrapSecretStorage.mockImplementation(async (bootstrap: CreateSecretStorageOpts) => {
        await bootstrap.createSecretStorageKey?.();
        pendingDuringSetup = state.pendingSecretStorageKey;
        expect(cacheSecretStorageKey).not.toHaveBeenCalled();
      });

      await createRecoveryKey();

      expect(pendingDuringSetup).toBe(NEW_KEY);
      expect(state.pendingSecretStorageKey).toBeNull();
      expect(cacheSecretStorageKey).toHaveBeenCalledWith(NEW_KEY);
    });

    it('keeps the saved key when setup fails before the new key is in use', async () => {
      const crypto = setup({ backup: null });
      crypto.bootstrapSecretStorage.mockRejectedValueOnce(new Error('M_UNKNOWN: Internal error'));
      vi.mocked(secretStorageKeyMatches).mockResolvedValueOnce(false);

      await expect(createRecoveryKey()).rejects.toThrow('Internal error');

      expect(cacheSecretStorageKey).not.toHaveBeenCalled();
      expect(state.pendingSecretStorageKey).toBeNull();
    });

    it('hands the new key over when setup fails after it became the account key', async () => {
      const crypto = setup({ backup: null, defaultKeyId: 'NEWKEY' });
      crypto.bootstrapSecretStorage.mockRejectedValueOnce(new Error('M_UNKNOWN: Internal error'));
      vi.mocked(secretStorageKeyMatches).mockResolvedValueOnce(true);

      const attempt = createRecoveryKey();

      await expect(attempt).rejects.toBeInstanceOf(RecoveryKeyIncompleteError);
      await expect(attempt).rejects.toMatchObject({ recoveryKey: 'EsTn ewKe y000 0000' });
      expect(cacheSecretStorageKey).toHaveBeenCalledWith(NEW_KEY);
    });
  });
});