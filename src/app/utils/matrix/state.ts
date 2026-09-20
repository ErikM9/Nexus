/* eslint-disable @typescript-eslint/no-explicit-any */
import type { MatrixClient } from 'matrix-js-sdk';
import type { VerificationSnapshot } from './types';
import { setCryptoReady as setCryptoReadyGlobal } from '../global';

/* Module-level singletons so Matrix state survives React re-renders without React state */
let matrixClient: MatrixClient | null = null;
let cryptoReady = false;
let initPromise: Promise<MatrixClient> | null = null;
let sessionVersion = 0;
let cachedSecretStorageKey: Uint8Array | null = null;

const verificationReqMap = new Map<string, any>();
const verificationSnapMap = new Map<string, VerificationSnapshot>();
const verifierMap = new Map<string, any>();
let verificationListenersAttached = false;

export const state = {
  get matrixClient() { return matrixClient; },
  set matrixClient(v: MatrixClient | null) { matrixClient = v; },

  get cryptoReady() { return cryptoReady; },
  /* Mirror onto window.__cryptoReady so non-React code can check crypto status */
  set cryptoReady(v: boolean) {
    cryptoReady = v;
    setCryptoReadyGlobal(v);
  },

  get initPromise() { return initPromise; },
  set initPromise(v: Promise<MatrixClient> | null) { initPromise = v; },

  get sessionVersion() { return sessionVersion; },
  /* Bumping the version lets in-flight init calls detect they've been superseded */
  bumpSessionVersion() { sessionVersion += 1; },

  get cachedSecretStorageKey() { return cachedSecretStorageKey; },
  set cachedSecretStorageKey(v: Uint8Array | null) { cachedSecretStorageKey = v; },

  verificationReqMap,
  verificationSnapMap,
  verifierMap,

  get verificationListenersAttached() { return verificationListenersAttached; },
  set verificationListenersAttached(v: boolean) { verificationListenersAttached = v; },

  resetVerificationState() {
    verificationReqMap.clear();
    verificationSnapMap.clear();
    verifierMap.clear();
    verificationListenersAttached = false;
  },
};

export const getMatrixClientOrThrow = (): MatrixClient => {
  if (!state.matrixClient) throw new Error('Matrix client is not initialized');
  return state.matrixClient;
};