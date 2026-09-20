/* eslint-disable @typescript-eslint/no-explicit-any */
import type { MatrixClient, Room } from 'matrix-js-sdk';
import { getCryptoModule } from './crypto';

export const getUnverifiedDevices = (client: MatrixClient): string[] => {
  const cryptoModule = getCryptoModule(client);
  const devices = cryptoModule?.deviceList?.getRawDeviceKeys?.() as Record<string, Record<string, any>> | undefined;
  if (!devices) return [];

  return Object.entries(devices).flatMap(([u, devs]) =>
    Object.entries(devs)
      .filter(([, info]) => info?.verified !== 'VERIFIED')
      .map(([deviceId]) => `${u}:${deviceId}`)
  );
};

/* Returns unverified devices across joined members of an encrypted room */
export const checkRoomDevices = async (client: MatrixClient, roomId: string): Promise<string[]> => {
  const room = client.getRoom(roomId);
  if (!room) return [];

  const crypto = getCryptoModule(client);
  if (!crypto?.getUserDeviceInfo) return [];

  const unverified: string[] = [];

  for (const member of room.getJoinedMembers()) {
    try {
      const devices = await crypto.getUserDeviceInfo([member.userId]);
      const map = devices?.get?.(member.userId) || (devices?.[member.userId] as any);
      if (map) {
        Object.entries(map).forEach(([deviceId, deviceInfo]) => {
          if (!(deviceInfo as any)?.isVerified?.()) {
            unverified.push(`${member.userId}:${deviceId}`);
          }
        });
      }
    } catch {}
  }

  return unverified;
};

/* Reshares room keys with a member, retrying with exponential backoff before giving up */
export const reshareRoomKeys = async (
  client: MatrixClient,
  room: Room,
  retries = 3,
  delay = 2000,
  maxDelay = 16000
): Promise<void> => {
  const crypto = getCryptoModule(client);
  if (!crypto) return;

  try {
    if (typeof crypto.reshareRoomKey === 'function') {
      await crypto.reshareRoomKey(room);
      return;
    }
    if (typeof crypto.sendSharedHistoryKey === 'function') {
      await crypto.sendSharedHistoryKey(room);
      return;
    }
  } catch {
    if (retries > 0) {
      await new Promise((resolve) => setTimeout(resolve, Math.min(delay, maxDelay)));
      return reshareRoomKeys(client, room, retries - 1, delay * 2, maxDelay);
    }
  }
};