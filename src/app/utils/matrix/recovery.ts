import { ConnectionError, MatrixError, Method, type MatrixClient } from 'matrix-js-sdk';
import { decodeRecoveryKey, encodeRecoveryKey, type CryptoApi, type KeyBackupInfo } from 'matrix-js-sdk/lib/crypto-api';
import { getMatrixClientOrThrow, state } from './state';
import { cacheSecretStorageKey, ensureCachedKeyLoaded, secretStorageKeyMatches } from './storage';

const requireCrypto = (client: MatrixClient): CryptoApi => {
  const crypto = client.getCrypto();
  if (!crypto) throw new Error('Crypto is not initialised');
  return crypto;
};

/* Reads the server's current key backup, telling "none" (404) apart from a failed request, which the crypto API's cached check does not */
const fetchServerKeyBackup = async (client: MatrixClient): Promise<KeyBackupInfo | null> => {
  try {
    const info = await client.http.authedRequest<KeyBackupInfo>(Method.Get, '/room_keys/version');
    return info?.version ? info : null;
  } catch (e) {
    if (e instanceof MatrixError && e.errcode === 'M_NOT_FOUND') return null;
    throw e;
  }
};

/* Loads the backup key from secret storage with a remembered recovery key and turns the backup on, both optional for a working client */
export const ensureKeyBackupEnabled = async (clientArg?: MatrixClient) => {
  const crypto = requireCrypto(clientArg ?? getMatrixClientOrThrow());
  ensureCachedKeyLoaded();
  await crypto.loadSessionBackupPrivateKeyFromSecretStorage().catch(() => {});
  await crypto.checkKeyBackupAndEnable().catch(() => {});
};

/* Why a restore with a recovery key could not complete */
export type RecoveryProblem =
  | 'invalid-key'
  | 'no-secret-storage'
  | 'wrong-key'
  | 'no-backup'
  | 'backup-key-missing'
  | 'backup-replaced'
  | 'unreachable'
  | 'server-error';

/* A restore that could not complete, with a message saying what happened and what the user can do */
export class RecoveryKeyError extends Error {
  constructor(readonly problem: RecoveryProblem, message: string) {
    super(message);
    this.name = 'RecoveryKeyError';
  }
}

export type RestoredBackup = { imported: number; total: number };

const serverProblem = (e: unknown): RecoveryKeyError | null => {
  if (e instanceof ConnectionError) {
    return new RecoveryKeyError('unreachable', "Couldn't reach the homeserver. Check your connection and try again.");
  }
  const status = e instanceof MatrixError ? e.httpStatus : undefined;
  if (typeof status === 'number') {
    return new RecoveryKeyError('server-error', `The homeserver couldn't complete the restore (error ${status}). Try again later.`);
  }
  return null;
};

/* Checks the key against the account's secret storage, remembers it only once it matched, then restores the key backup step by step so each failure is reported for what it is */
export const restoreWithRecoveryKey = async (recoveryKey: string): Promise<RestoredBackup> => {
  const client = getMatrixClientOrThrow();
  const crypto = requireCrypto(client);

  let key: Uint8Array;
  try {
    key = decodeRecoveryKey(recoveryKey.trim());
  } catch {
    throw new RecoveryKeyError('invalid-key', "That isn't a valid Recovery Key. Check it and try again.");
  }

  try {
    const keyId = await client.secretStorage.getDefaultKeyId();
    const described = keyId ? await client.secretStorage.getKey(keyId) : null;
    if (!described) {
      throw new RecoveryKeyError('no-secret-storage', "Your account doesn't have a Recovery Key yet. Use Get Recovery Key to set one up.");
    }
    if (!(await secretStorageKeyMatches(key, described[1]))) {
      throw new RecoveryKeyError('wrong-key', "This Recovery Key doesn't belong to your account. Check it and try again.");
    }
    cacheSecretStorageKey(key);

    if (!(await fetchServerKeyBackup(client))) {
      throw new RecoveryKeyError('no-backup', 'Your Recovery Key is correct, but there is no key backup on the server to restore from.');
    }
    /* Refreshes the SDK's cached backup version, which loading the key from secret storage checks against */
    await crypto.checkKeyBackupAndEnable();
    if (!(await client.secretStorage.isStored('m.megolm_backup.v1'))) {
      throw new RecoveryKeyError('backup-key-missing', "Your Recovery Key is correct, but your key backup isn't stored with it, so it can't be restored here.");
    }
    try {
      await crypto.loadSessionBackupPrivateKeyFromSecretStorage();
    } catch (e) {
      /* With the key and the backup secret both present, the one remaining failure is a backup another device replaced */
      throw serverProblem(e) ?? new RecoveryKeyError('backup-replaced', "Your Recovery Key is correct, but the key backup on the server was replaced on another device and can't be opened with it.");
    }

    await crypto.checkKeyBackupAndEnable();
    const { imported, total } = await crypto.restoreKeyBackup();
    return { imported, total };
  } catch (e) {
    if (e instanceof RecoveryKeyError) throw e;
    const problem = serverProblem(e);
    if (problem) throw problem;
    console.warn('Restoring the key backup failed', e);
    throw new RecoveryKeyError('server-error', 'The restore failed. Try again later.');
  }
};

/* What creating a recovery key does to the account's server-side key backup */
export type KeyBackupPlan =
  | { kind: 'none' }
  | { kind: 'keep'; version: string }
  | { kind: 'unreadable'; version: string; keyCount?: number };

export type UnreadableBackup = Extract<KeyBackupPlan, { kind: 'unreadable' }>;

/* Thrown instead of deleting a backup this device can't read, until the user has agreed to replace it */
export class BackupReplaceConfirmationError extends Error {
  constructor(readonly backup: UnreadableBackup) {
    super('Creating a Recovery Key would delete the existing key backup');
    this.name = 'BackupReplaceConfirmationError';
  }
}

/* Thrown when setup failed after the new key had become the account's secret-storage key, so the user must still save it */
export class RecoveryKeyIncompleteError extends Error {
  constructor(readonly recoveryKey: string, cause: unknown) {
    super('The Recovery Key was created but the key backup could not be set up');
    this.name = 'RecoveryKeyIncompleteError';
    this.cause = cause;
  }
}

export type CreatedRecoveryKey = {
  recoveryKey: string;
  backup: 'created' | 'kept' | 'replaced';
};

/* Finds out whether the server holds a key backup and whether this device has the key that reads it */
export const inspectKeyBackup = async (clientArg?: MatrixClient): Promise<KeyBackupPlan> => {
  const client = clientArg ?? getMatrixClientOrThrow();
  const crypto = requireCrypto(client);
  const info = await fetchServerKeyBackup(client);
  if (!info?.version) return { kind: 'none' };
  /* Refreshes the SDK's cached backup, which setup reads when it moves the backup key into the new secret storage */
  await crypto.checkKeyBackupAndEnable();

  if (!(await crypto.isKeyBackupTrusted(info)).matchesDecryptionKey) {
    /* The backup key may still be in secret storage, readable with a recovery key this browser remembers */
    ensureCachedKeyLoaded();
    await crypto.loadSessionBackupPrivateKeyFromSecretStorage().catch(() => {});
  }
  const { matchesDecryptionKey } = await crypto.isKeyBackupTrusted(info);
  return matchesDecryptionKey
    ? { kind: 'keep', version: info.version }
    : { kind: 'unreadable', version: info.version, keyCount: info.count };
};

const isDefaultSecretStorageKey = async (client: MatrixClient, key: Uint8Array): Promise<boolean> => {
  try {
    const keyId = await client.secretStorage.getDefaultKeyId();
    const described = keyId ? await client.secretStorage.getKey(keyId) : null;
    return !!described && (await secretStorageKeyMatches(key, described[1]));
  } catch {
    return false;
  }
};

/* Creates new secret storage with a new recovery key, keeping the existing key backup whenever this device can read it */
export const createRecoveryKey = async (
  opts: { replaceUnreadableBackup?: boolean } = {}
): Promise<CreatedRecoveryKey> => {
  const client = getMatrixClientOrThrow();
  const crypto = requireCrypto(client);

  const plan = await inspectKeyBackup(client);
  if (plan.kind === 'unreadable' && !opts.replaceUnreadableBackup) throw new BackupReplaceConfirmationError(plan);

  const generated = await crypto.createRecoveryKeyFromPassphrase();
  const recoveryKey = generated.encodedPrivateKey ?? encodeRecoveryKey(generated.privateKey);
  if (!recoveryKey) throw new Error('Failed to generate Recovery Key');

  /* The SDK reads secrets back with the new key during setup, so it is offered as pending until setup has worked */
  state.pendingSecretStorageKey = generated.privateKey;
  try {
    await crypto.bootstrapSecretStorage({
      setupNewSecretStorage: true,
      setupNewKeyBackup: plan.kind !== 'keep',
      createSecretStorageKey: async () => generated,
    });
  } catch (e) {
    if (await isDefaultSecretStorageKey(client, generated.privateKey)) {
      cacheSecretStorageKey(generated.privateKey);
      throw new RecoveryKeyIncompleteError(recoveryKey, e);
    }
    throw e;
  } finally {
    state.pendingSecretStorageKey = null;
  }

  cacheSecretStorageKey(generated.privateKey);
  if (plan.kind === 'keep') void crypto.checkKeyBackupAndEnable().catch(() => {});
  return { recoveryKey, backup: plan.kind === 'keep' ? 'kept' : plan.kind === 'none' ? 'created' : 'replaced' };
};