/* Serialisable snapshot of a verification request, safe to pass across the React event boundary */
export type VerificationSnapshot = {
  id: string;
  txnId?: string;
  fromUserId: string;
  fromDeviceId?: string;
  createdAt: number;
  phase: 'requested' | 'ready' | 'showing_sas' | 'done' | 'cancelled';
  sasEmojis?: string[];
  sasDecimals?: number[];
  /* True when this client sent the request, so it is never offered back as an incoming one */
  outgoing?: boolean;
  /* Why the request ended, when the other side or a failure cancelled it */
  cancelReason?: string;
};

export interface InitMatrixOptions {
  baseUrl: string;
  accessToken: string;
  refreshToken?: string;
  userId: string;
  deviceId?: string;
  cryptoStorePrefix?: string;
}

/* How the client start-up is going, published while the loading screen is up */
export type MatrixStartupStatus =
  | { state: 'connecting' }
  | { state: 'reconnecting'; message: string }
  | { state: 'failed'; message: string }
  | { state: 'other-tab' };