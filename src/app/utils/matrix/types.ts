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
};

export interface InitMatrixOptions {
  baseUrl: string;
  accessToken: string;
  refreshToken?: string;
  userId: string;
  deviceId?: string;
}