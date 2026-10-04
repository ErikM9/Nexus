/* eslint-disable @typescript-eslint/no-explicit-any */
import type { MatrixClient } from 'matrix-js-sdk';
import type { VerificationSnapshot } from './types';
import { setCryptoReady as setCryptoReadyGlobal } from '../global';

/* Identity and crypto store of the session a client runs for */
export type ClientSession = {
  userId: string;
  deviceId?: string;
  baseUrl: string;
  cryptoStorePrefix: string;
};

/* A client that has been created but has not finished its first sync yet */
export type ClientStartup = {
  client: MatrixClient;
  session: ClientSession;
  controller: AbortController;
};

/* Module-level singletons so Matrix state survives React re-renders without React state */
let matrixClient: MatrixClient | null = null;
let activeSession: ClientSession | null = null;
let startup: ClientStartup | null = null;
let cryptoReady = false;
let initPromise: Promise<MatrixClient> | null = null;
let sessionVersion = 0;
let cachedSecretStorageKey: Uint8Array | null = null;
let pendingSecretStorageKey: Uint8Array | null = null;

const verificationReqMap = new Map<string, any>();
const verificationSnapMap = new Map<string, VerificationSnapshot>();

export const state = {
  get matrixClient() { return matrixClient; },
  set matrixClient(v: MatrixClient | null) { matrixClient = v; },

  get activeSession() { return activeSession; },
  set activeSession(v: ClientSession | null) { activeSession = v; },

  get startup() { return startup; },
  set startup(v: ClientStartup | null) { startup = v; },

  get cryptoReady() { return cryptoReady; },
  /* Mirror onto window.__cryptoReady so non-React code can check crypto status */
  set cryptoReady(v: boolean) {
    cryptoReady = v;
    setCryptoReadyGlobal(v);
  },

  get initPromise() { return initPromise; },
  set initPromise(v: Promise<MatrixClient> | null) { initPromise = v; },

  get sessionVersion() { return sessionVersion; },
  /* Bumping the version lets an in-flight start-up detect that it has been superseded */
  bumpSessionVersion() { sessionVersion += 1; },

  get cachedSecretStorageKey() { return cachedSecretStorageKey; },
  set cachedSecretStorageKey(v: Uint8Array | null) { cachedSecretStorageKey = v; },

  /* A key being set up or checked, offered to the SDK before it is known to work so a failure never replaces the cached key */
  get pendingSecretStorageKey() { return pendingSecretStorageKey; },
  set pendingSecretStorageKey(v: Uint8Array | null) { pendingSecretStorageKey = v; },

  verificationReqMap,
  verificationSnapMap,

  resetVerificationState() {
    verificationReqMap.clear();
    verificationSnapMap.clear();
  },
};

export const getMatrixClientOrThrow = (): MatrixClient => {
  if (!state.matrixClient) throw new Error('Matrix client is not initialized');
  return state.matrixClient;
};