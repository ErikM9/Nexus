import { describe, it, expect, vi, afterAll } from 'vitest';
import { setCryptoReady } from '@/app/utils/global';

/* The filter wraps the console methods it finds when the module loads, so recording ones go in before the import runs */
const { printed, original } = vi.hoisted(() => {
  const original = { error: console.error, log: console.log };
  const printed = { error: vi.fn(), log: vi.fn() };
  console.error = printed.error;
  console.log = printed.log;
  return { printed, original };
});

afterAll(() => {
  console.error = original.error;
  console.log = original.log;
});

describe('setCryptoReady', () => {
  it.each([true, false])('mirrors %s onto window.__cryptoReady', (ready) => {
    window.__cryptoReady = !ready;

    setCryptoReady(ready);

    expect(window.__cryptoReady).toBe(ready);
  });
});

describe.each(['error', 'log'] as const)('console.%s', (method) => {
  it.each([
    ['a one-time key the server already has', 'Failed to upload keys: One time key signed_curve25519:AAAAHQ already exists. Old key: {}'],
    ['the 400 answer to a key upload', 'POST https://hs.example/_matrix/client/v3/keys/upload 400 (Bad Request)'],
  ])('drops the message about %s', (_label, message) => {
    console[method](message);

    expect(printed[method]).not.toHaveBeenCalled();
  });

  it('passes every other call on with its arguments untouched, whatever their type', () => {
    const failure = new Error('fetch failed');

    console[method](failure, 'while syncing', { attempt: 2 });

    expect(printed[method]).toHaveBeenCalledWith(failure, 'while syncing', { attempt: 2 });
  });
});

describe('key-upload noise', () => {
  it.each([
    ['a one-time key message of another kind', 'One time key count on the server: 50'],
    ['something else that already exists', 'Room alias #lobby:hs.example already exists'],
    ['a key upload that failed for another reason', 'POST https://hs.example/_matrix/client/v3/keys/upload 500 (Internal Server Error)'],
    ['a 400 from another endpoint', 'PUT https://hs.example/_matrix/client/v3/rooms/!a:hs.example/send/m.room.message/1 400 (Bad Request)'],
  ])('does not include %s', (_label, message) => {
    console.error(message);

    expect(printed.error).toHaveBeenCalledWith(message);
  });
});