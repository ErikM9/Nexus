import { DeviceVerification, type MatrixClient } from 'matrix-js-sdk';

/* One device of a room member, identified the way verification requests address it */
export interface RoomDevice {
  userId: string;
  deviceId: string;
}

/* Lists the devices of a room's joined members that this session has not verified, leaving out this session itself */
export const checkRoomDevices = async (client: MatrixClient, roomId: string): Promise<RoomDevice[]> => {
  const room = client.getRoom(roomId);
  const crypto = client.getCrypto();
  if (!room || !crypto) return [];

  const userIds = room.getJoinedMembers().map((member) => member.userId);
  if (userIds.length === 0) return [];

  const ownUserId = client.getUserId();
  const ownDeviceId = client.getDeviceId();
  const deviceMap = await crypto.getUserDeviceInfo(userIds, true);

  const unverified: RoomDevice[] = [];
  for (const [userId, devices] of deviceMap) {
    for (const device of devices.values()) {
      if (userId === ownUserId && device.deviceId === ownDeviceId) continue;
      /* A dehydrated device is an offline key store that can never answer a verification request */
      if (device.dehydrated) continue;
      if (device.verified !== DeviceVerification.Verified) unverified.push({ userId, deviceId: device.deviceId });
    }
  }
  return unverified;
};