import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ConnectionError, MatrixError, SecretStorage } from 'matrix-js-sdk';
import {
  ensureKeyBackupEnabled,
  restoreWithRecoveryKey,
  createRecoveryKey,
  BackupReplaceConfirmationError,
  RecoveryKeyIncompleteError,
} from '@/app/utils/matrix/recovery';
import { state } from '@/app/utils/matrix/state';
import {
  encodeRecoveryKey,
  type CreateSecretStorageOpts,
  type GeneratedSecretStorageKey,
  type KeyBackupInfo,
} from 'matrix-js-sdk/lib/crypto-api';

/* The account's secret-storage key and its Recovery Key as the SDK encodes it, so restoring runs the SDK's real decoder */
const ACCOUNT_KEY = new Uint8Array(32).fill(1);
const RECOVERY_KEY = encodeRecoveryKey(ACCOUNT_KEY)!;
const MISTYPED_KEY = `${RECOVERY_KEY.slice(0, -1)}a`;

/* The description the SDK stores for a secret-storage key, with the MAC that tells whether a candidate key opens it */
const describeKey = async (key: Uint8Array) => {
  const { iv, mac } = await SecretStorage.calculateKeyCheck(key);
  return { algorithm: SecretStorage.SECRET_STORAGE_ALGORITHM_V1_AES, iv, mac };
};

describe('Matrix Recovery Utilities', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.cachedSecretStorageKey = null;
    state.pendingSecretStorageKey = null;
    state.matrixClient = null;
  });

  describe('ensureKeyBackupEnabled', () => {
    it('loads the backup key from secret storage, then turns key backup on', async () => {
      const crypto = {
        loadSessionBackupPrivateKeyFromSecretStorage: vi.fn(async () => {}),
        checkKeyBackupAndEnable: vi.fn(async () => null),
      };
      state.matrixClient = { getCrypto: () => crypto } as any;

      await ensureKeyBackupEnabled();

      const [loaded] = crypto.loadSessionBackupPrivateKeyFromSecretStorage.mock.invocationCallOrder;
      const [enabled] = crypto.checkKeyBackupAndEnable.mock.invocationCallOrder;
      expect(loaded).toBeLessThan(enabled);
    });

    it('fails while encryption is not running', async () => {
      state.matrixClient = { getCrypto: () => undefined } as any;

      await expect(ensureKeyBackupEnabled()).rejects.toThrow('Crypto is not initialised');
    });

    it('swallows a failure from either backup call so start-up is never blocked on it', async () => {
      state.matrixClient = {
        getCrypto: () => ({
          loadSessionBackupPrivateKeyFromSecretStorage: vi.fn(async () => {
            throw new Error('getSecretStorageKey callback returned falsey');
          }),
          checkKeyBackupAndEnable: vi.fn(async () => {
            throw new MatrixError({ errcode: 'M_UNKNOWN', error: 'Internal server error' }, 500);
          }),
        }),
      } as any;

      await expect(ensureKeyBackupEnabled()).resolves.toBeUndefined();
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

    /* A client double with the secret-storage lookup, the backup-version request and the crypto calls a restore walks through */
    const useClient = (
      opts: {
        accountKey?: Uint8Array;
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
          getKey: vi.fn(async (keyId: string) => [keyId, await describeKey(opts.accountKey ?? ACCOUNT_KEY)]),
          isStored: vi.fn(async () => (opts.isStored === undefined ? { KEYID: {} } : opts.isStored)),
        },
        http: { authedRequest: vi.fn(opts.backupRequest ?? (async () => BACKUP)) },
      } as any;
      return crypto;
    };

    it('remembers the key and reports how many keys it restored', async () => {
      useClient({ restoreKeyBackup: async () => ({ imported: 4, total: 10 }) });

      const result = await restoreWithRecoveryKey(RECOVERY_KEY);

      expect(result).toEqual({ imported: 4, total: 10 });
      expect(state.cachedSecretStorageKey).toEqual(ACCOUNT_KEY);
    });

    it('accepts a key pasted with line breaks around it', async () => {
      useClient({});

      await expect(restoreWithRecoveryKey(`\n${RECOVERY_KEY}\n`)).resolves.toEqual({ imported: 4, total: 4 });
    });

    it('rejects a mistyped Recovery Key without touching the account', async () => {
      useClient({});

      await expect(restoreWithRecoveryKey(MISTYPED_KEY)).rejects.toMatchObject({ problem: 'invalid-key' });
      expect(state.matrixClient!.secretStorage.getDefaultKeyId).not.toHaveBeenCalled();
    });

    it('says there is no Recovery Key yet when the account has no secret storage', async () => {
      useClient({ defaultKeyId: null });

      await expect(restoreWithRecoveryKey(RECOVERY_KEY)).rejects.toMatchObject({ problem: 'no-secret-storage' });
      expect(state.cachedSecretStorageKey).toBeNull();
    });

    it("says the key doesn't belong to the account when it fails the secret-storage check, and never caches it", async () => {
      useClient({ accountKey: new Uint8Array(32).fill(9) });

      await expect(restoreWithRecoveryKey(RECOVERY_KEY)).rejects.toMatchObject({ problem: 'wrong-key' });
      expect(state.cachedSecretStorageKey).toBeNull();
    });

    it('says there is no backup once a matched key finds none on the server, but still remembers the key', async () => {
      useClient({ backupRequest: notFound });

      await expect(restoreWithRecoveryKey(RECOVERY_KEY)).rejects.toMatchObject({ problem: 'no-backup' });
      expect(state.cachedSecretStorageKey).toEqual(ACCOUNT_KEY);
    });

    it("says the backup isn't stored with this key when secret storage holds no backup secret", async () => {
      useClient({ isStored: null });

      await expect(restoreWithRecoveryKey(RECOVERY_KEY)).rejects.toMatchObject({ problem: 'backup-key-missing' });
      expect(state.cachedSecretStorageKey).toEqual(ACCOUNT_KEY);
    });

    it('reports a backup replaced on another device when the stored secret no longer opens it', async () => {
      useClient({
        loadBackupKey: async () => {
          throw new Error('loadSessionBackupPrivateKeyFromSecretStorage: decryption key does not match backup info');
        },
      });

      await expect(restoreWithRecoveryKey(RECOVERY_KEY)).rejects.toMatchObject({ problem: 'backup-replaced' });
    });

    it('reports an unreachable homeserver as a connection problem, not an invalid key', async () => {
      useClient({ backupRequest: () => Promise.reject(new ConnectionError('fetch failed')) });

      await expect(restoreWithRecoveryKey(RECOVERY_KEY)).rejects.toMatchObject({ problem: 'unreachable' });
    });

    it('reports a connection lost while opening the backup as a connection problem, not a replaced backup', async () => {
      useClient({ loadBackupKey: () => Promise.reject(new ConnectionError('fetch failed')) });

      await expect(restoreWithRecoveryKey(RECOVERY_KEY)).rejects.toMatchObject({ problem: 'unreachable' });
    });

    it('reports a homeserver error with its status instead of a generic failure', async () => {
      useClient({
        restoreKeyBackup: () => Promise.reject(new MatrixError({ errcode: 'M_UNKNOWN', error: 'Bad gateway' }, 502)),
      });

      const attempt = restoreWithRecoveryKey(RECOVERY_KEY);

      await expect(attempt).rejects.toMatchObject({ problem: 'server-error' });
      await expect(attempt).rejects.toThrow('error 502');
    });

    it('reports any other failure as a failed restore and keeps its details out of the message', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const failure = new Error('Rust store: database disk image is malformed');
      useClient({ restoreKeyBackup: () => Promise.reject(failure) });

      const attempt = restoreWithRecoveryKey(RECOVERY_KEY);

      await expect(attempt).rejects.toMatchObject({ problem: 'server-error', message: 'The restore failed. Try again later.' });
      expect(warn).toHaveBeenCalledWith('Restoring the key backup failed', failure);
    });
  });

  describe('createRecoveryKey', () => {
    const NEW_KEY = new Uint8Array(32).fill(7);
    const generated: GeneratedSecretStorageKey = { privateKey: NEW_KEY, encodedPrivateKey: encodeRecoveryKey(NEW_KEY) };
    const serverBackup: KeyBackupInfo = {
      algorithm: 'm.megolm_backup.v1.curve25519-aes-sha2',
      auth_data: { public_key: 'hSDwCYkwp1R0i33ctD73Wg2/Og0mOBr066SpjqqbTmo', signatures: {} },
      version: '3',
      count: 42,
    };

    /* A client double whose bootstrap asks for the new key as the SDK does, and whose backup request sees the test's backup */
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
          if (!opts.keyInSecretStorage) throw new Error('getSecretStorageKey callback returned falsey');
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
          getKey: vi.fn(async (keyId: string) => [keyId, await describeKey(keyId === 'NEWKEY' ? NEW_KEY : ACCOUNT_KEY)]),
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

    it('creates a new key backup when the account has none', async () => {
      const crypto = setup({ backup: null });

      const created = await createRecoveryKey();

      expect(crypto.bootstrapSecretStorage).toHaveBeenCalledWith(
        expect.objectContaining({ setupNewSecretStorage: true, setupNewKeyBackup: true })
      );
      expect(created).toEqual({ recoveryKey: generated.encodedPrivateKey, backup: 'created' });
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
      let cachedDuringSetup: Uint8Array | null = null;
      crypto.bootstrapSecretStorage.mockImplementation(async (bootstrap: CreateSecretStorageOpts) => {
        await bootstrap.createSecretStorageKey?.();
        pendingDuringSetup = state.pendingSecretStorageKey;
        cachedDuringSetup = state.cachedSecretStorageKey;
      });

      await createRecoveryKey();

      expect(pendingDuringSetup).toBe(NEW_KEY);
      expect(cachedDuringSetup).toBeNull();
      expect(state.pendingSecretStorageKey).toBeNull();
      expect(state.cachedSecretStorageKey).toBe(NEW_KEY);
    });

    it('keeps the saved key when setup fails before the new key is in use', async () => {
      const crypto = setup({ backup: null });
      state.cachedSecretStorageKey = ACCOUNT_KEY;
      crypto.bootstrapSecretStorage.mockRejectedValueOnce(new Error('M_UNKNOWN: Internal error'));

      await expect(createRecoveryKey()).rejects.toThrow('Internal error');

      expect(state.cachedSecretStorageKey).toBe(ACCOUNT_KEY);
      expect(state.pendingSecretStorageKey).toBeNull();
    });

    it('hands the new key over when setup fails after it became the account key', async () => {
      const crypto = setup({ backup: null, defaultKeyId: 'NEWKEY' });
      crypto.bootstrapSecretStorage.mockRejectedValueOnce(new Error('M_UNKNOWN: Internal error'));

      const attempt = createRecoveryKey();

      await expect(attempt).rejects.toBeInstanceOf(RecoveryKeyIncompleteError);
      await expect(attempt).rejects.toMatchObject({ recoveryKey: generated.encodedPrivateKey });
      expect(state.cachedSecretStorageKey).toBe(NEW_KEY);
    });
  });
});