import { describe, it, expect, afterEach } from 'vitest';
import type { VerificationRequest } from 'matrix-js-sdk/lib/crypto-api';
import { getMatrixClientOrThrow, state } from '@/app/utils/matrix/state';
import type { VerificationSnapshot } from '@/app/utils/matrix/types';
import { makeClient } from '../support/matrixRoom';

afterEach(() => {
  state.matrixClient = null;
  state.cryptoReady = false;
  state.resetVerificationState();
});

describe('cryptoReady', () => {
  it.each([true, false])('keeps window.__cryptoReady in step when it becomes %s', (ready) => {
    state.cryptoReady = !ready;

    state.cryptoReady = ready;

    expect(state.cryptoReady).toBe(ready);
    expect(window.__cryptoReady).toBe(ready);
  });
});

describe('bumpSessionVersion', () => {
  it('moves the session version on by one, which tells a start-up still in flight that it has been superseded', () => {
    const before = state.sessionVersion;

    state.bumpSessionVersion();

    expect(state.sessionVersion).toBe(before + 1);
  });
});

describe('resetVerificationState', () => {
  it('forgets every verification request and every snapshot', () => {
    const snapshot: VerificationSnapshot = { id: 'txn1', fromUserId: '@bob:hs.test', createdAt: 1_780_000_000_000, phase: 'requested' };
    state.verificationReqMap.set(snapshot.id, {} as VerificationRequest);
    state.verificationSnapMap.set(snapshot.id, snapshot);

    state.resetVerificationState();

    expect(state.verificationReqMap.size).toBe(0);
    expect(state.verificationSnapMap.size).toBe(0);
  });
});

describe('getMatrixClientOrThrow', () => {
  it('throws while no client is running', () => {
    expect(() => getMatrixClientOrThrow()).toThrow('Matrix client is not initialized');
  });

  it('returns the running client', () => {
    const client = makeClient();
    state.matrixClient = client;

    expect(getMatrixClientOrThrow()).toBe(client);
  });
});