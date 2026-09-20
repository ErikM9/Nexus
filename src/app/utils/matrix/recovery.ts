/* eslint-disable @typescript-eslint/no-explicit-any */
import type { MatrixClient } from 'matrix-js-sdk';
import { decodeRecoveryKey, encodeRecoveryKey } from 'matrix-js-sdk/lib/crypto-api';
import { getCryptoModule } from './crypto';
import { getMatrixClientOrThrow, state } from './state';
import { ensureCachedKeyLoaded, persistSecretStorageKey } from './storage';

/* Decodes a recovery key string, caches it in memory, and persists it to localStorage */
export const setRecoveryKey = (recoveryKey: string) => {
  const key = decodeRecoveryKey(recoveryKey.trim());
  state.cachedSecretStorageKey = key;
  persistSecretStorageKey(key);
};

/* Validates a recovery key against secret storage */
export const validateRecoveryKey = async (recoveryKeyString: string): Promise<boolean> => {
  const client = getMatrixClientOrThrow();

  let decodedKey: Uint8Array;
  try {
    decodedKey = decodeRecoveryKey(recoveryKeyString.trim());
  } catch {
    return false;
  }

  try {
    const secretStorage = (client as any).secretStorage;
    if (!secretStorage) return true;

    const keyId = await secretStorage.getDefaultKeyId?.();
    if (!keyId) return true;

    const keyInfo = client.getAccountData?.(`m.secret_storage.key.${keyId}`)?.getContent?.();
    if (!keyInfo) return true;

    if (typeof secretStorage.checkKey === 'function') {
      const result = await secretStorage.checkKey(decodedKey, keyInfo);
      return !!result;
    }

    return true;
  } catch {
    return false;
  }
};

/* Loads the backup private key from secret storage and enables the key backup */
export const ensureKeyBackupEnabled = async (clientArg?: MatrixClient) => {
  const client = clientArg ?? getMatrixClientOrThrow();
  const crypto = getCryptoModule(client);
  if (!crypto) throw new Error('Crypto is not initialised');

  ensureCachedKeyLoaded();

  try {
    if (typeof crypto.loadSessionBackupPrivateKeyFromSecretStorage === 'function') {
      await crypto.loadSessionBackupPrivateKeyFromSecretStorage();
    }
  } catch {}

  try {
    if (typeof crypto.checkKeyBackupAndEnable === 'function') {
      await crypto.checkKeyBackupAndEnable();
    }
  } catch {}
};

export const restoreEncryptedHistoryFromBackup = async (): Promise<void> => {
  const client = getMatrixClientOrThrow();
  const crypto = getCryptoModule(client);
  if (!crypto) throw new Error('Crypto is not initialised');

  ensureCachedKeyLoaded();
  if (!state.cachedSecretStorageKey?.length) throw new Error('No Recovery Key set for this session');

  await ensureKeyBackupEnabled();

  if (typeof crypto.restoreKeyBackup === 'function') {
    await crypto.restoreKeyBackup({});
    return;
  }

  throw new Error('Key backup restore not supported');
};

/* Bootstraps secret storage and key backup, then returns the encoded recovery key to save */
export const createRecoveryKey = async (): Promise<string> => {
  const client = getMatrixClientOrThrow();
  const crypto = getCryptoModule(client);
  if (!crypto) throw new Error('Crypto is not initialised');

  if (typeof crypto.bootstrapSecretStorage !== 'function') {
    throw new Error('Secret storage bootstrap not supported by this crypto backend');
  }
  if (typeof crypto.createRecoveryKeyFromPassphrase !== 'function') {
    throw new Error('Recovery key generation not supported by this crypto backend');
  }

  let generated: any = null;

  /* Intercept the key creation so the private key can be held for the return value */
  const createSecretStorageKey = async () => {
    if (!generated) generated = await crypto.createRecoveryKeyFromPassphrase();
    return generated;
  };

  generated = await createSecretStorageKey();

  const privateKey: Uint8Array | null =
    generated?.privateKey instanceof Uint8Array ? generated.privateKey : null;

  if (privateKey?.length) {
    state.cachedSecretStorageKey = privateKey;
    persistSecretStorageKey(privateKey);
  }

  await crypto.bootstrapSecretStorage({
    setupNewSecretStorage: true,
    setupNewKeyBackup: true,
    createSecretStorageKey,
  });

  const encoded =
    typeof generated?.encodedPrivateKey === 'string' && generated.encodedPrivateKey.trim()
      ? generated.encodedPrivateKey.trim()
      : privateKey?.length
        ? encodeRecoveryKey(privateKey)
        : '';

  if (!encoded) throw new Error('Failed to generate Recovery Key');

  try { await ensureKeyBackupEnabled(); } catch {}

  return encoded;
};