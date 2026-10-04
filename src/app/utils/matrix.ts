/* Public API for the Matrix subsystem, imported from here rather than reaching into subdirectories */
export type { VerificationSnapshot, InitMatrixOptions, MatrixStartupStatus } from './matrix/types';

export {
  initMatrixClient,
  getMatrixClient,
  getCryptoReady,
  logoutMatrixClient,
  stopMatrixClient,
  startMatrixInThisTab,
  retryMatrixStartup,
  SessionEndedError,
  StartupCancelledError,
  type SignOutResult,
} from './matrix/client';

export { getMatrixStartupStatus } from './matrix/events';

export {
  readStoredSession,
  hasStoredSession,
  writeStoredSession,
  newCryptoStorePrefix,
  reusableDeviceIdFor,
  type StoredSession,
} from './matrix/session';

export {
  attachVerificationListeners,
  confirmVerificationRequest,
  declineVerificationRequest,
  cancelVerificationRequest,
  requestVerificationToUser,
  requestVerificationForMyOtherSessions,
} from './matrix/verification';

export {
  ensureKeyBackupEnabled,
  restoreWithRecoveryKey,
  RecoveryKeyError,
  type RestoredBackup,
  createRecoveryKey,
  BackupReplaceConfirmationError,
  RecoveryKeyIncompleteError,
  type UnreadableBackup,
} from './matrix/recovery';

export { clearCachedRecoveryKey } from './matrix/storage';

export { checkRoomDevices, type RoomDevice } from './matrix/devices';