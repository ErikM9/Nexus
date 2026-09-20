import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  emitMatrixReady,
  emitMatrixNotReady,
  emitVerificationSnapshot,
} from '@/app/utils/matrix/events';
import type { VerificationSnapshot } from '@/app/utils/matrix/types';

describe('Matrix Events Utilities', () => {
  let eventListeners: Map<string, Set<EventListener>>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let dispatchEventSpy: any;

  beforeEach(() => {
    eventListeners = new Map();
    
    dispatchEventSpy = vi.spyOn(window, 'dispatchEvent').mockImplementation((event: Event) => {
      const listeners = eventListeners.get(event.type);
      if (listeners) {
        listeners.forEach((listener) => listener(event));
      }
      return true;
    });

    vi.spyOn(window, 'addEventListener').mockImplementation((type: string, listener: EventListenerOrEventListenerObject) => {
      if (!eventListeners.has(type)) {
        eventListeners.set(type, new Set());
      }
      eventListeners.get(type)!.add(listener as EventListener);
    });

    vi.spyOn(window, 'removeEventListener').mockImplementation((type: string, listener: EventListenerOrEventListenerObject) => {
      eventListeners.get(type)?.delete(listener as EventListener);
    });

    window.__matrix_ready = undefined;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    eventListeners.clear();
  });

  describe('emitMatrixReady', () => {
    it('sets __matrix_ready to true', () => {
      emitMatrixReady();
      expect((window as any).__matrix_ready).toBe(true);
    });

    it('dispatches matrix-ready event', () => {
      emitMatrixReady();

      expect(dispatchEventSpy).toHaveBeenCalledWith(expect.any(Event));
      const dispatchedEvent = dispatchEventSpy.mock.calls[0][0] as Event;
      expect(dispatchedEvent.type).toBe('matrix-ready');
    });

    it('allows listeners to receive the event', () => {
      const listener = vi.fn();
      window.addEventListener('matrix-ready', listener);

      emitMatrixReady();

      expect(listener).toHaveBeenCalledTimes(1);
    });

    it('can be called multiple times', () => {
      emitMatrixReady();
      emitMatrixReady();
      emitMatrixReady();

      expect((window as any).__matrix_ready).toBe(true);
      expect(dispatchEventSpy).toHaveBeenCalledTimes(3);
    });

    it('sets flag before dispatching event', () => {
      let flagValueDuringEvent: boolean | undefined;
      
      window.addEventListener('matrix-ready', () => {
        flagValueDuringEvent = (window as any).__matrix_ready;
      });

      emitMatrixReady();

      expect(flagValueDuringEvent).toBe(true);
    });
  });

  describe('emitMatrixNotReady', () => {
    it('sets __matrix_ready to false', () => {
      (window as any).__matrix_ready = true;
      emitMatrixNotReady();
      expect((window as any).__matrix_ready).toBe(false);
    });

    it('dispatches matrix-not-ready event', () => {
      emitMatrixNotReady();

      expect(dispatchEventSpy).toHaveBeenCalledWith(expect.any(Event));
      const dispatchedEvent = dispatchEventSpy.mock.calls[0][0] as Event;
      expect(dispatchedEvent.type).toBe('matrix-not-ready');
    });

    it('allows listeners to receive the event', () => {
      const listener = vi.fn();
      window.addEventListener('matrix-not-ready', listener);

      emitMatrixNotReady();

      expect(listener).toHaveBeenCalledTimes(1);
    });

    it('transitions from ready to not ready', () => {
      emitMatrixReady();
      expect((window as any).__matrix_ready).toBe(true);

      emitMatrixNotReady();
      expect((window as any).__matrix_ready).toBe(false);
    });
  });

  describe('emitVerificationSnapshot', () => {
    const createSnapshot = (overrides?: Partial<VerificationSnapshot>): VerificationSnapshot => ({
      id: 'test_verification_id',
      txnId: 'test_txn_id',
      fromUserId: '@user:matrix.org',
      fromDeviceId: 'DEVICE123',
      createdAt: Date.now(),
      phase: 'requested',
      ...overrides,
    });

    it('dispatches matrix-verification-request event', () => {
      const snapshot = createSnapshot();
      emitVerificationSnapshot(snapshot);

      expect(dispatchEventSpy).toHaveBeenCalledWith(expect.any(CustomEvent));
      const dispatchedEvent = dispatchEventSpy.mock.calls[0][0] as CustomEvent;
      expect(dispatchedEvent.type).toBe('matrix-verification-request');
    });

    it('includes snapshot in event detail', () => {
      const snapshot = createSnapshot();
      emitVerificationSnapshot(snapshot);

      const dispatchedEvent = dispatchEventSpy.mock.calls[0][0] as CustomEvent;
      expect(dispatchedEvent.detail).toEqual(snapshot);
    });

    it('passes snapshot to listeners', () => {
      const snapshot = createSnapshot({
        id: 'unique_id',
        phase: 'showing_sas',
        sasEmojis: ['🐶', '🐱', '🐭'],
      });

      let receivedSnapshot: VerificationSnapshot | undefined;
      window.addEventListener('matrix-verification-request', ((event: CustomEvent) => {
        receivedSnapshot = event.detail;
      }) as EventListener);

      emitVerificationSnapshot(snapshot);

      expect(receivedSnapshot).toEqual(snapshot);
      expect(receivedSnapshot?.sasEmojis).toEqual(['🐶', '🐱', '🐭']);
    });

    it('handles all verification phases', () => {
      const phases: VerificationSnapshot['phase'][] = [
        'requested',
        'ready',
        'showing_sas',
        'done',
        'cancelled',
      ];

      phases.forEach((phase) => {
        const snapshot = createSnapshot({ phase });
        emitVerificationSnapshot(snapshot);

        const lastCall = dispatchEventSpy.mock.calls[dispatchEventSpy.mock.calls.length - 1];
        const event = lastCall[0] as CustomEvent;
        expect(event.detail.phase).toBe(phase);
      });
    });

    it('handles snapshot with SAS emojis', () => {
      const snapshot = createSnapshot({
        phase: 'showing_sas',
        sasEmojis: ['🦊', '🐻', '🐼', '🐨', '🐯', '🦁', '🐸'],
      });

      emitVerificationSnapshot(snapshot);

      const event = dispatchEventSpy.mock.calls[0][0] as CustomEvent;
      expect(event.detail.sasEmojis).toHaveLength(7);
    });

    it('handles snapshot with SAS decimals', () => {
      const snapshot = createSnapshot({
        phase: 'showing_sas',
        sasDecimals: [1234, 5678, 9012],
      });

      emitVerificationSnapshot(snapshot);

      const event = dispatchEventSpy.mock.calls[0][0] as CustomEvent;
      expect(event.detail.sasDecimals).toEqual([1234, 5678, 9012]);
    });

    it('handles snapshot without optional fields', () => {
      const minimalSnapshot: VerificationSnapshot = {
        id: 'minimal_id',
        fromUserId: '@user:matrix.org',
        createdAt: Date.now(),
        phase: 'requested',
      };

      emitVerificationSnapshot(minimalSnapshot);

      const event = dispatchEventSpy.mock.calls[0][0] as CustomEvent;
      expect(event.detail.txnId).toBeUndefined();
      expect(event.detail.fromDeviceId).toBeUndefined();
      expect(event.detail.sasEmojis).toBeUndefined();
    });
  });

  describe('Event sequencing', () => {
    it('can emit ready then not ready in sequence', () => {
      const readyListener = vi.fn();
      const notReadyListener = vi.fn();

      window.addEventListener('matrix-ready', readyListener);
      window.addEventListener('matrix-not-ready', notReadyListener);

      emitMatrixReady();
      emitMatrixNotReady();

      expect(readyListener).toHaveBeenCalledTimes(1);
      expect(notReadyListener).toHaveBeenCalledTimes(1);
      expect((window as any).__matrix_ready).toBe(false);
    });

    it('verification events work alongside ready events', () => {
      const readyListener = vi.fn();
      const verificationListener = vi.fn();

      window.addEventListener('matrix-ready', readyListener);
      window.addEventListener('matrix-verification-request', verificationListener);

      emitMatrixReady();
      emitVerificationSnapshot({
        id: 'test',
        fromUserId: '@user:matrix.org',
        createdAt: Date.now(),
        phase: 'requested',
      });

      expect(readyListener).toHaveBeenCalledTimes(1);
      expect(verificationListener).toHaveBeenCalledTimes(1);
    });
  });

  describe('Error handling', () => {
    it('handles dispatchEvent throwing', () => {
      dispatchEventSpy.mockImplementation(() => {
        throw new Error('Event dispatch failed');
      });

      expect(() => emitMatrixReady()).not.toThrow();
    });

    it('handles setting window property throwing', () => {
      const originalDescriptor = Object.getOwnPropertyDescriptor(window, '__matrix_ready');
      
      Object.defineProperty(window, '__matrix_ready', {
        set: () => {
          throw new Error('Cannot set property');
        },
        get: () => false,
        configurable: true,
      });

      expect(() => emitMatrixReady()).not.toThrow();

      if (originalDescriptor) {
        Object.defineProperty(window, '__matrix_ready', originalDescriptor);
      } else {
        delete (window as any).__matrix_ready;
      }
    });
  });
});