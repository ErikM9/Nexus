import { describe, it, expect, vi, beforeEach } from 'vitest';

describe('Global Utilities', () => {
  let setCryptoReady: typeof import('@/app/utils/global').setCryptoReady;

  beforeEach(async () => {
    vi.resetModules();
    window.__cryptoReady = undefined;
    (window as any).global = window;
    
    const module = await import('@/app/utils/global');
    setCryptoReady = module.setCryptoReady;
  });

  describe('setCryptoReady', () => {
    it('sets window.__cryptoReady to true', () => {
      setCryptoReady(true);
      expect(window.__cryptoReady).toBe(true);
    });

    it('sets window.__cryptoReady to false', () => {
      setCryptoReady(false);
      expect(window.__cryptoReady).toBe(false);
    });

    it('can toggle between states', () => {
      setCryptoReady(true);
      expect(window.__cryptoReady).toBe(true);

      setCryptoReady(false);
      expect(window.__cryptoReady).toBe(false);

      setCryptoReady(true);
      expect(window.__cryptoReady).toBe(true);
    });
  });
});

describe('Console noise filter', () => {
  it('suppresses "One time key already exists" from console.error', async () => {
    vi.resetModules();

    const logged: string[] = [];
    const saved = console.error;
    console.error = (...args: unknown[]) => { logged.push(String(args[0])); };

    try {
      await import('@/app/utils/global');

      console.error('Failed: One time key AAAA already exists. Old key: {}');
      console.error('Normal error that should pass through');

      expect(logged.some(m => m.includes('One time key') && m.includes('already exists'))).toBe(false);
      expect(logged).toContain('Normal error that should pass through');
    } finally {
      console.error = saved;
    }
  });

  it('suppresses "keys/upload 400" from console.log', async () => {
    vi.resetModules();

    const logged: string[] = [];
    const saved = console.log;
    console.log = (...args: unknown[]) => { logged.push(String(args[0])); };

    try {
      await import('@/app/utils/global');

      console.log('POST https://matrix.org/_matrix/client/v3/keys/upload 400 (Bad Request)');
      console.log('Normal log that should pass through');

      expect(logged.some(m => m.includes('keys/upload') && m.includes('400'))).toBe(false);
      expect(logged).toContain('Normal log that should pass through');
    } finally {
      console.log = saved;
    }
  });
});