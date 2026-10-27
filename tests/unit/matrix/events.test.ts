import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  emitMatrixNotReady,
  emitMatrixReady,
  emitMatrixStartupStatus,
  emitVerificationSnapshot,
  getMatrixStartupStatus,
} from '@/app/utils/matrix/events';
import type { MatrixStartupStatus, VerificationSnapshot } from '@/app/utils/matrix/types';

let listening: AbortController;

/* Listens on window until the test ends */
const listen = (type: string, listener: (event: Event) => void) => window.addEventListener(type, listener, { signal: listening.signal });

beforeEach(() => {
  listening = new AbortController();
});

afterEach(() => {
  listening.abort();
  delete window.__matrix_startup;
});

describe('emitMatrixReady', () => {
  it('raises window.__matrix_ready before matrix-ready reaches its listeners', () => {
    const flagWhenHeard: unknown[] = [];
    listen('matrix-ready', () => flagWhenHeard.push(window.__matrix_ready));

    emitMatrixReady();

    expect(flagWhenHeard).toEqual([true]);
  });
});

describe('emitMatrixNotReady', () => {
  it('lowers window.__matrix_ready before matrix-not-ready reaches its listeners', () => {
    window.__matrix_ready = true;
    const flagWhenHeard: unknown[] = [];
    listen('matrix-not-ready', () => flagWhenHeard.push(window.__matrix_ready));

    emitMatrixNotReady();

    expect(flagWhenHeard).toEqual([false]);
  });
});

describe('start-up status', () => {
  const failed: MatrixStartupStatus = { state: 'failed', message: "Encryption couldn't be set up in this browser." };

  it('reads as connecting until a status has been published', () => {
    expect(getMatrixStartupStatus()).toEqual({ state: 'connecting' });
  });

  it('reaches matrix-startup-status listeners as the event detail', () => {
    const heard: unknown[] = [];
    listen('matrix-startup-status', (event) => heard.push((event as CustomEvent).detail));

    emitMatrixStartupStatus(failed);

    expect(heard).toEqual([failed]);
  });

  it('is already readable when its listeners hear of it', () => {
    const readWhenHeard: MatrixStartupStatus[] = [];
    listen('matrix-startup-status', () => readWhenHeard.push(getMatrixStartupStatus()));

    emitMatrixStartupStatus(failed);

    expect(readWhenHeard).toEqual([failed]);
  });

  it('gives a screen that mounts later the latest status published', () => {
    emitMatrixStartupStatus({ state: 'reconnecting', message: "The homeserver can't be reached. Check your connection." });
    emitMatrixStartupStatus(failed);

    expect(getMatrixStartupStatus()).toEqual(failed);
  });
});

describe('emitVerificationSnapshot', () => {
  it('hands the whole snapshot to matrix-verification-request listeners as the event detail', () => {
    const snapshot: VerificationSnapshot = {
      id: 'txn1',
      txnId: 'txn1',
      fromUserId: '@bob:hs.test',
      fromDeviceId: 'BOBDEVICE',
      createdAt: 1_780_000_000_000,
      phase: 'showing_sas',
      sasEmojis: ['🐶', '🐱', '🦁'],
      sasDecimals: [1234, 5678, 9012],
    };
    const heard: unknown[] = [];
    listen('matrix-verification-request', (event) => heard.push((event as CustomEvent).detail));

    emitVerificationSnapshot(snapshot);

    expect(heard).toEqual([snapshot]);
  });
});