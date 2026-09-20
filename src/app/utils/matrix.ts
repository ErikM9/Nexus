/* Public API for the Matrix subsystem, imported from here rather than reaching into subdirectories */
export type { VerificationSnapshot, InitMatrixOptions } from './matrix/types';

export {
  initMatrixClient,
  getMatrixClient,
  getCryptoReady,
  refreshAccessToken,
  logoutMatrixClient,
  resetMatrixCryptoStores
} from './matrix/client';

export {
  attachVerificationListeners,
  refreshVerificationRequest,
  confirmVerificationRequest,
  declineVerificationRequest,
  cancelVerificationRequest,
  startEmojiVerification,
  requestVerificationToUser,
  requestVerificationForMyOtherSessions,
  isOutgoingVerificationRequest,
} from './matrix/verification';

export {
  setRecoveryKey,
  validateRecoveryKey,
  ensureKeyBackupEnabled,
  restoreEncryptedHistoryFromBackup,
  createRecoveryKey
} from './matrix/recovery';

export {
  hasCachedRecoveryKey,
  clearCachedRecoveryKey
} from './matrix/storage';

export {
  getUnverifiedDevices,
  checkRoomDevices,
  reshareRoomKeys
} from './matrix/devices';