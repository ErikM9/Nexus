import { describe, it, expect, vi } from 'vitest';
import {
  getUnverifiedDevices,
  checkRoomDevices,
  reshareRoomKeys,
} from '@/app/utils/matrix/devices';

describe('Matrix Devices Utilities', () => {
  describe('getUnverifiedDevices', () => {
    it('returns empty array when no crypto module', () => {
      const client = {
        getCrypto: () => null,
      } as any;

      const result = getUnverifiedDevices(client);
      expect(result).toEqual([]);
    });

    it('returns empty array when no device list', () => {
      const client = {
        getCrypto: () => ({
          deviceList: null,
        }),
      } as any;

      const result = getUnverifiedDevices(client);
      expect(result).toEqual([]);
    });

    it('returns empty array when getRawDeviceKeys returns undefined', () => {
      const client = {
        getCrypto: () => ({
          deviceList: {
            getRawDeviceKeys: () => undefined,
          },
        }),
      } as any;

      const result = getUnverifiedDevices(client);
      expect(result).toEqual([]);
    });

    it('identifies unverified devices', () => {
      const client = {
        getCrypto: () => ({
          deviceList: {
            getRawDeviceKeys: () => ({
              '@user1:matrix.org': {
                DEVICE_A: { verified: 'VERIFIED' },
                DEVICE_B: { verified: 'UNVERIFIED' },
              },
              '@user2:matrix.org': {
                DEVICE_C: { verified: 'UNVERIFIED' },
              },
            }),
          },
        }),
      } as any;

      const result = getUnverifiedDevices(client);
      expect(result).toContain('@user1:matrix.org:DEVICE_B');
      expect(result).toContain('@user2:matrix.org:DEVICE_C');
      expect(result).not.toContain('@user1:matrix.org:DEVICE_A');
    });

    it('returns all devices when none are verified', () => {
      const client = {
        getCrypto: () => ({
          deviceList: {
            getRawDeviceKeys: () => ({
              '@user:matrix.org': {
                DEVICE_1: { verified: null },
                DEVICE_2: { verified: '' },
                DEVICE_3: {},
              },
            }),
          },
        }),
      } as any;

      const result = getUnverifiedDevices(client);
      expect(result).toHaveLength(3);
    });

    it('returns empty when all devices verified', () => {
      const client = {
        getCrypto: () => ({
          deviceList: {
            getRawDeviceKeys: () => ({
              '@user:matrix.org': {
                DEVICE_1: { verified: 'VERIFIED' },
                DEVICE_2: { verified: 'VERIFIED' },
              },
            }),
          },
        }),
      } as any;

      const result = getUnverifiedDevices(client);
      expect(result).toEqual([]);
    });

    it('handles users with no devices', () => {
      const client = {
        getCrypto: () => ({
          deviceList: {
            getRawDeviceKeys: () => ({
              '@user:matrix.org': {},
            }),
          },
        }),
      } as any;

      const result = getUnverifiedDevices(client);
      expect(result).toEqual([]);
    });

    it('uses crypto property as fallback', () => {
      const client = {
        crypto: {
          deviceList: {
            getRawDeviceKeys: () => ({
              '@user:matrix.org': {
                DEVICE: { verified: 'UNVERIFIED' },
              },
            }),
          },
        },
      } as any;

      const result = getUnverifiedDevices(client);
      expect(result).toContain('@user:matrix.org:DEVICE');
    });
  });

  describe('checkRoomDevices', () => {
    it('returns empty array when room not found', async () => {
      const client = {
        getRoom: () => null,
      } as any;

      const result = await checkRoomDevices(client, '!room:matrix.org');
      expect(result).toEqual([]);
    });

    it('returns empty array when no crypto module', async () => {
      const client = {
        getRoom: () => ({
          getJoinedMembers: () => [{ userId: '@user:matrix.org' }],
        }),
        getCrypto: () => null,
      } as any;

      const result = await checkRoomDevices(client, '!room:matrix.org');
      expect(result).toEqual([]);
    });

    it('returns empty array when getUserDeviceInfo not available', async () => {
      const client = {
        getRoom: () => ({
          getJoinedMembers: () => [{ userId: '@user:matrix.org' }],
        }),
        getCrypto: () => ({}),
      } as any;

      const result = await checkRoomDevices(client, '!room:matrix.org');
      expect(result).toEqual([]);
    });

    it('identifies unverified devices in room members', async () => {
      const mockDeviceMap = new Map();
      mockDeviceMap.set('@user:matrix.org', {
        DEVICE_1: { isVerified: () => true },
        DEVICE_2: { isVerified: () => false },
      });

      const client = {
        getRoom: () => ({
          getJoinedMembers: () => [{ userId: '@user:matrix.org' }],
        }),
        getCrypto: () => ({
          getUserDeviceInfo: vi.fn(async () => mockDeviceMap),
        }),
      } as any;

      const result = await checkRoomDevices(client, '!room:matrix.org');
      expect(result).toContain('@user:matrix.org:DEVICE_2');
      expect(result).not.toContain('@user:matrix.org:DEVICE_1');
    });

    it('handles multiple members', async () => {
      const getUserDeviceInfo = vi.fn(async (userIds: string[]) => {
        const map = new Map();
        for (const userId of userIds) {
          if (userId === '@user1:matrix.org') {
            map.set(userId, {
              DEV_A: { isVerified: () => false },
            });
          }
          if (userId === '@user2:matrix.org') {
            map.set(userId, {
              DEV_B: { isVerified: () => false },
            });
          }
        }
        return map;
      });

      const client = {
        getRoom: () => ({
          getJoinedMembers: () => [
            { userId: '@user1:matrix.org' },
            { userId: '@user2:matrix.org' },
          ],
        }),
        getCrypto: () => ({
          getUserDeviceInfo,
        }),
      } as any;

      const result = await checkRoomDevices(client, '!room:matrix.org');
      expect(result).toContain('@user1:matrix.org:DEV_A');
      expect(result).toContain('@user2:matrix.org:DEV_B');
    });

    it('handles errors in getUserDeviceInfo gracefully', async () => {
      const client = {
        getRoom: () => ({
          getJoinedMembers: () => [
            { userId: '@user1:matrix.org' },
            { userId: '@user2:matrix.org' },
          ],
        }),
        getCrypto: () => ({
          getUserDeviceInfo: vi.fn(async () => {
            throw new Error('Network error');
          }),
        }),
      } as any;

      const result = await checkRoomDevices(client, '!room:matrix.org');
      expect(result).toEqual([]);
    });

    it('handles device map returned as object instead of Map', async () => {
      const client = {
        getRoom: () => ({
          getJoinedMembers: () => [{ userId: '@user:matrix.org' }],
        }),
        getCrypto: () => ({
          getUserDeviceInfo: vi.fn(async () => ({
            '@user:matrix.org': {
              DEVICE: { isVerified: () => false },
            },
          })),
        }),
      } as any;

      const result = await checkRoomDevices(client, '!room:matrix.org');
      expect(result).toContain('@user:matrix.org:DEVICE');
    });
  });

  describe('reshareRoomKeys', () => {
    it('does nothing when no crypto module', async () => {
      const client = {
        getCrypto: () => null,
      } as any;
      const room = {} as any;

      await expect(reshareRoomKeys(client, room)).resolves.not.toThrow();
    });

    it('calls reshareRoomKey when available', async () => {
      const reshareRoomKey = vi.fn(async () => {});
      const client = {
        getCrypto: () => ({
          reshareRoomKey,
        }),
      } as any;
      const room = { roomId: '!room:matrix.org' } as any;

      await reshareRoomKeys(client, room);

      expect(reshareRoomKey).toHaveBeenCalledWith(room);
    });

    it('falls back to sendSharedHistoryKey', async () => {
      const sendSharedHistoryKey = vi.fn(async () => {});
      const client = {
        getCrypto: () => ({
          sendSharedHistoryKey,
        }),
      } as any;
      const room = { roomId: '!room:matrix.org' } as any;

      await reshareRoomKeys(client, room);

      expect(sendSharedHistoryKey).toHaveBeenCalledWith(room);
    });

    it('prefers reshareRoomKey over sendSharedHistoryKey', async () => {
      const reshareRoomKey = vi.fn(async () => {});
      const sendSharedHistoryKey = vi.fn(async () => {});
      const client = {
        getCrypto: () => ({
          reshareRoomKey,
          sendSharedHistoryKey,
        }),
      } as any;
      const room = {} as any;

      await reshareRoomKeys(client, room);

      expect(reshareRoomKey).toHaveBeenCalled();
      expect(sendSharedHistoryKey).not.toHaveBeenCalled();
    });

    it('retries on failure with exponential backoff', async () => {
      let attempts = 0;
      const reshareRoomKey = vi.fn(async () => {
        attempts++;
        if (attempts < 3) {
          throw new Error('Temporary failure');
        }
      });

      const client = {
        getCrypto: () => ({
          reshareRoomKey,
        }),
      } as any;
      const room = {} as any;

      await reshareRoomKeys(client, room, 3, 10, 100);

      expect(reshareRoomKey).toHaveBeenCalledTimes(3);
    });

    it('stops retrying after max retries', async () => {
      const reshareRoomKey = vi.fn(async () => {
        throw new Error('Persistent failure');
      });

      const client = {
        getCrypto: () => ({
          reshareRoomKey,
        }),
      } as any;
      const room = {} as any;

      await reshareRoomKeys(client, room, 2, 10, 50);

      expect(reshareRoomKey).toHaveBeenCalledTimes(3);
    });

    it('succeeds immediately without retries', async () => {
      const reshareRoomKey = vi.fn(async () => {});
      const client = {
        getCrypto: () => ({
          reshareRoomKey,
        }),
      } as any;
      const room = {} as any;

      await reshareRoomKeys(client, room);

      expect(reshareRoomKey).toHaveBeenCalledTimes(1);
    });

    it('handles missing both methods gracefully', async () => {
      const client = {
        getCrypto: () => ({}),
      } as any;
      const room = {} as any;

      await expect(reshareRoomKeys(client, room)).resolves.not.toThrow();
    });
  });
});