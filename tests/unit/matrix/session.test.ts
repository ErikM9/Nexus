import { describe, it, expect } from 'vitest';
import {
  SESSION_STORAGE_KEYS,
  clearAccountStorage,
  clearAllMatrixStorage,
  clearStoredSession,
  loadOrCreateCryptoStoreKey,
  readStoredSession,
  reusableDeviceIdFor,
  updateStoredSession,
  writeStoredSession,
  type StoredSession,
} from '@/app/utils/matrix/session';

const ALICE = '@alice:hs.example';
const BOB = '@bob:hs.example';

const aliceSession = (): StoredSession => ({
  accessToken: 'alice-token',
  refreshToken: 'alice-refresh',
  userId: ALICE,
  deviceId: 'ALICEDEVICE',
  baseUrl: 'https://hs.example',
  cryptoStorePrefix: 'nexus-alice',
});

describe('stored session', () => {
  it('reads back the session it wrote', () => {
    writeStoredSession(aliceSession());

    expect(readStoredSession()).toEqual(aliceSession());
  });

  it('mirrors the tokens, user and device into the individual keys older builds read', () => {
    writeStoredSession(aliceSession());

    expect(localStorage.getItem('mx_access_token')).toBe('alice-token');
    expect(localStorage.getItem('mx_refresh_token')).toBe('alice-refresh');
    expect(localStorage.getItem('mx_user_id')).toBe(ALICE);
    expect(localStorage.getItem('mx_device_id')).toBe('ALICEDEVICE');
  });

  it.each([
    ['no access token', { accessToken: '' }],
    ['no user', { userId: undefined }],
    ['no homeserver', { baseUrl: '' }],
  ])('treats a record with %s as no session', (_label, patch) => {
    localStorage.setItem('mx_session', JSON.stringify({ ...aliceSession(), ...patch }));

    expect(readStoredSession()).toBeNull();
  });

  it('treats unreadable JSON as no session', () => {
    localStorage.setItem('mx_session', '{not json');

    expect(readStoredSession()).toBeNull();
  });

  it('merges an update into the session of the same user and device', () => {
    writeStoredSession(aliceSession());

    const written = updateStoredSession({ userId: ALICE, deviceId: 'ALICEDEVICE' }, { accessToken: 'alice-token-2' });

    expect(written).toBe(true);
    expect(readStoredSession()?.accessToken).toBe('alice-token-2');
  });

  it('ignores an update from a session that is no longer the stored one', () => {
    writeStoredSession({ ...aliceSession(), deviceId: 'NEWDEVICE' });

    const written = updateStoredSession({ userId: ALICE, deviceId: 'ALICEDEVICE' }, { accessToken: 'stale-token' });

    expect(written).toBe(false);
    expect(readStoredSession()?.accessToken).toBe('alice-token');
  });

  it('ignores an update once the session has been cleared', () => {
    writeStoredSession(aliceSession());
    clearStoredSession();

    updateStoredSession({ userId: ALICE, deviceId: 'ALICEDEVICE' }, { accessToken: 'late-token' });

    expect(readStoredSession()).toBeNull();
    expect(localStorage.getItem('mx_access_token')).toBeNull();
  });

  it('clears every session key, including the device ID', () => {
    writeStoredSession(aliceSession());

    clearStoredSession();

    for (const key of SESSION_STORAGE_KEYS) expect(localStorage.getItem(key), key).toBeNull();
  });
});

describe('clearing account data', () => {
  it("removes one account's crypto-store key and SDK caches only", () => {
    localStorage.setItem(`mx_rust_crypto_key_${ALICE}`, 'YWxpY2U=');
    localStorage.setItem(`mxjssdk_memory_filter_FILTER_SYNC_${ALICE}`, 'f1');
    localStorage.setItem(`mx_rust_crypto_key_${BOB}`, 'Ym9i');
    localStorage.setItem(`mxjssdk_memory_filter_FILTER_SYNC_${BOB}`, 'f2');

    clearAccountStorage(ALICE);

    expect(localStorage.getItem(`mx_rust_crypto_key_${ALICE}`)).toBeNull();
    expect(localStorage.getItem(`mxjssdk_memory_filter_FILTER_SYNC_${ALICE}`)).toBeNull();
    expect(localStorage.getItem(`mx_rust_crypto_key_${BOB}`)).toBe('Ym9i');
    expect(localStorage.getItem(`mxjssdk_memory_filter_FILTER_SYNC_${BOB}`)).toBe('f2');
  });

  it('removes every Matrix key of every account and nothing else', () => {
    writeStoredSession(aliceSession());
    localStorage.setItem('mx_ssk_private_key_b64', 'a2V5');
    localStorage.setItem(`mx_rust_crypto_key_${BOB}`, 'Ym9i');
    localStorage.setItem(`mxjssdk_memory_filter_FILTER_SYNC_${BOB}`, 'f2');
    localStorage.setItem('nexus_dismissed_verifications', '[]');
    localStorage.setItem('theme', 'dark');

    clearAllMatrixStorage();

    expect(Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i))).toEqual(['theme']);
  });
});

describe('reusableDeviceIdFor', () => {
  const leaveDevice = (deviceId: string, owner: string) => {
    localStorage.setItem('mx_device_id', deviceId);
    localStorage.setItem('mx_user_id', owner);
  };

  it.each([['alice'], ['  Alice '], [ALICE]])('offers the device back to its own account typed as "%s"', (typed) => {
    leaveDevice('ALICEDEVICE', ALICE);

    expect(reusableDeviceIdFor(typed)).toBe('ALICEDEVICE');
  });

  it("never offers another account's device", () => {
    leaveDevice('ALICEDEVICE', ALICE);

    expect(reusableDeviceIdFor('bob')).toBeUndefined();
  });

  it('never offers a device of the same name on another homeserver', () => {
    leaveDevice('ALICEDEVICE', ALICE);

    expect(reusableDeviceIdFor('@alice:elsewhere.example')).toBeUndefined();
  });

  it('never offers a device whose owner is unknown', () => {
    localStorage.setItem('mx_device_id', 'ORPHANDEVICE');

    expect(reusableDeviceIdFor('alice')).toBeUndefined();
  });
});

describe('loadOrCreateCryptoStoreKey', () => {
  it('keeps one stable 32-byte key per account', () => {
    const first = loadOrCreateCryptoStoreKey(ALICE);

    expect(first).toHaveLength(32);
    expect(loadOrCreateCryptoStoreKey(ALICE)).toEqual(first);
    expect(localStorage.getItem(`mx_rust_crypto_key_${BOB}`)).toBeNull();
  });
});