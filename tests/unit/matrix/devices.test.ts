import { describe, it, expect, vi } from 'vitest';
import { Device, DeviceVerification, type DeviceMap, type MatrixClient } from 'matrix-js-sdk';
import type { CryptoApi } from 'matrix-js-sdk/lib/crypto-api';
import { checkRoomDevices } from '@/app/utils/matrix/devices';
import { BOB, CAROL, ME, makeClient, makeRoom } from '../support/matrixRoom';

/* Builds a Device the way the Rust crypto backend does, with a numeric verified state and no isVerified method */
const makeDevice = (userId: string, deviceId: string, verified: DeviceVerification, dehydrated = false): Device =>
  new Device({
    userId,
    deviceId,
    algorithms: ['m.olm.v1.curve25519-aes-sha2', 'm.megolm.v1.aes-sha2'],
    keys: new Map([
      [`curve25519:${deviceId}`, `curve25519-key-${deviceId}`],
      [`ed25519:${deviceId}`, `ed25519-key-${deviceId}`],
    ]),
    verified,
    dehydrated,
  });

/* Answers like CryptoApi.getUserDeviceInfo, resolving a Map of user ID to a Map of device ID to Device for the requested users */
const deviceInfoFrom = (devices: Device[]) =>
  vi.fn<CryptoApi['getUserDeviceInfo']>(async (userIds) => {
    const result: DeviceMap = new Map();
    for (const device of devices) {
      if (!userIds.includes(device.userId)) continue;
      if (!result.has(device.userId)) result.set(device.userId, new Map());
      result.get(device.userId)!.set(device.deviceId, device);
    }
    return result;
  });

/* A real client, signed in as MYDEVICE, with an encrypted room of the given members and a crypto API offering getUserDeviceInfo */
const setup = async (members: string[], getUserDeviceInfo: CryptoApi['getUserDeviceInfo']) => {
  const client = makeClient();
  const room = await makeRoom(client, { members, encrypted: true });
  vi.spyOn(client, 'getCrypto').mockReturnValue({ getUserDeviceInfo } as unknown as CryptoApi);
  return { client, room };
};

describe('checkRoomDevices', () => {
  it('lists an unverified device of another member', async () => {
    const getUserDeviceInfo = deviceInfoFrom([
      makeDevice(ME, 'MYDEVICE', DeviceVerification.Verified),
      makeDevice(BOB, 'BOBLAPTOP', DeviceVerification.Verified),
      makeDevice(BOB, 'BOBPHONE', DeviceVerification.Unverified),
    ]);
    const { client, room } = await setup([BOB], getUserDeviceInfo);

    const result = await checkRoomDevices(client, room.roomId);

    expect(result).toEqual([{ userId: BOB, deviceId: 'BOBPHONE' }]);
  });

  it('asks about every joined member at once and downloads lists the SDK does not track yet', async () => {
    const getUserDeviceInfo = deviceInfoFrom([]);
    const { client, room } = await setup([BOB, CAROL], getUserDeviceInfo);

    await checkRoomDevices(client, room.roomId);

    expect(getUserDeviceInfo).toHaveBeenCalledTimes(1);
    expect(getUserDeviceInfo.mock.calls[0][0]).toEqual(expect.arrayContaining([ME, BOB, CAROL]));
    expect(getUserDeviceInfo.mock.calls[0][1]).toBe(true);
  });

  it('lists my other unverified sessions but never this session itself', async () => {
    const getUserDeviceInfo = deviceInfoFrom([
      makeDevice(ME, 'MYDEVICE', DeviceVerification.Unverified),
      makeDevice(ME, 'MYTABLET', DeviceVerification.Unverified),
    ]);
    const { client, room } = await setup([], getUserDeviceInfo);

    const result = await checkRoomDevices(client, room.roomId);

    expect(result).toEqual([{ userId: ME, deviceId: 'MYTABLET' }]);
  });

  it('treats blocked devices as unverified and leaves out dehydrated ones', async () => {
    const getUserDeviceInfo = deviceInfoFrom([
      makeDevice(BOB, 'BOBOLD', DeviceVerification.Blocked),
      makeDevice(BOB, 'BOBDEHYDRATED', DeviceVerification.Unverified, true),
    ]);
    const { client, room } = await setup([BOB], getUserDeviceInfo);

    const result = await checkRoomDevices(client, room.roomId);

    expect(result).toEqual([{ userId: BOB, deviceId: 'BOBOLD' }]);
  });

  it('lists nothing when every device is verified', async () => {
    const getUserDeviceInfo = deviceInfoFrom([
      makeDevice(BOB, 'BOBPHONE', DeviceVerification.Verified),
      makeDevice(CAROL, 'CAROLTABLET', DeviceVerification.Verified),
    ]);
    const { client, room } = await setup([BOB, CAROL], getUserDeviceInfo);

    const result = await checkRoomDevices(client, room.roomId);

    expect(result).toEqual([]);
  });

  it('lists nothing for a room the client does not know', async () => {
    const getUserDeviceInfo = deviceInfoFrom([makeDevice(BOB, 'BOBPHONE', DeviceVerification.Unverified)]);
    const { client } = await setup([BOB], getUserDeviceInfo);

    const result = await checkRoomDevices(client, '!unknown:hs.test');

    expect(result).toEqual([]);
    expect(getUserDeviceInfo).not.toHaveBeenCalled();
  });

  it('lists nothing when crypto is not running', async () => {
    const client = makeClient();
    const room = await makeRoom(client, { members: [BOB], encrypted: true });

    const result = await checkRoomDevices(client as MatrixClient, room.roomId);

    expect(result).toEqual([]);
  });

  it('passes a failed device query on to the caller', async () => {
    const getUserDeviceInfo = vi.fn(async () => {
      throw new Error('Network error');
    });
    const { client, room } = await setup([BOB], getUserDeviceInfo);

    await expect(checkRoomDevices(client, room.roomId)).rejects.toThrow('Network error');
  });
});