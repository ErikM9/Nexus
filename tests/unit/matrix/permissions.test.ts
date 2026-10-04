import { describe, it, expect } from 'vitest';
import { EventType } from 'matrix-js-sdk';
import {
  canBan,
  canKick,
  canSetPowerLevel,
  getPowerLevel,
  getRoomPermissions,
} from '@/app/utils/matrix/permissions';
import { BOB, CAROL, ME, makeClient, makeRoom, setState } from '../support/matrixRoom';

/* Me as admin, Bob as moderator and Carol as a plain member, with the usual homeserver defaults */
const staffedRoom = (powerLevels: Record<string, unknown> = {}) =>
  makeRoom(makeClient(), {
    members: [BOB, CAROL],
    powerLevels: { users: { [ME]: 100, [BOB]: 50 }, users_default: 0, state_default: 50, kick: 50, ban: 50, ...powerLevels },
  });

describe('canSetPowerLevel', () => {
  it('lets an admin give another member their own power level', async () => {
    const room = await staffedRoom();

    expect(canSetPowerLevel(room, ME, CAROL, 100)).toBe(true);
  });

  it('lets a moderator raise a member up to, but not above, their own level', async () => {
    const room = await staffedRoom();

    expect(canSetPowerLevel(room, BOB, CAROL, 50)).toBe(true);
    expect(canSetPowerLevel(room, BOB, CAROL, 100)).toBe(false);
  });

  it('refuses to change a member whose level equals or exceeds the sender', async () => {
    const room = await staffedRoom({ users: { [ME]: 100, [BOB]: 100 } });

    expect(canSetPowerLevel(room, ME, BOB, 0)).toBe(false);
  });

  it('lets a member lower their own level but not raise it', async () => {
    const room = await staffedRoom();

    expect(canSetPowerLevel(room, BOB, BOB, 0)).toBe(true);
    expect(canSetPowerLevel(room, BOB, BOB, 100)).toBe(false);
  });

  it('refuses every change without the level to send power levels', async () => {
    const room = await staffedRoom({ events: { [EventType.RoomPowerLevels]: 100 } });

    expect(canSetPowerLevel(room, BOB, CAROL, 0)).toBe(false);
  });

  it('treats the creators of a room version 12 room as above every level', async () => {
    const room = await makeRoom(makeClient(), {
      roomVersion: '12',
      creator: BOB,
      members: [ME],
      powerLevels: { users: { [ME]: 100 }, users_default: 0, state_default: 50 },
    });

    expect(getPowerLevel(room, BOB)).toBe(Infinity);
    expect(canSetPowerLevel(room, ME, BOB, 0)).toBe(false);
    expect(canSetPowerLevel(room, BOB, ME, 100)).toBe(true);
    expect(canSetPowerLevel(room, BOB, BOB, 50)).toBe(false);
    expect(canKick(room, ME, BOB)).toBe(false);
    expect(canKick(room, BOB, ME)).toBe(true);
  });
});

describe('canKick and canBan', () => {
  it('needs the kick level and a level above the target', async () => {
    const room = await staffedRoom();

    expect(canKick(room, BOB, CAROL)).toBe(true);
    expect(canKick(room, BOB, ME)).toBe(false);
    expect(canKick(room, CAROL, BOB)).toBe(false);
  });

  it('follows a ban level that differs from the kick level', async () => {
    const room = await staffedRoom({ ban: 100 });

    expect(canKick(room, BOB, CAROL)).toBe(true);
    expect(canBan(room, BOB, CAROL)).toBe(false);
    expect(canBan(room, ME, CAROL)).toBe(true);
  });

  it('never offers to remove yourself', async () => {
    const room = await staffedRoom();

    expect(canKick(room, ME, ME)).toBe(false);
    expect(canBan(room, ME, ME)).toBe(false);
  });
});

describe('getRoomPermissions', () => {
  it('lets a plain member invite when the room sets no invite level', async () => {
    const room = await makeRoom(makeClient(), {
      creator: BOB,
      members: [ME],
      powerLevels: { users: { [BOB]: 100 }, users_default: 0, state_default: 50 },
    });

    expect(getRoomPermissions(room, ME).canInvite).toBe(true);
  });

  it('follows an invite level above the member', async () => {
    const room = await makeRoom(makeClient(), {
      creator: BOB,
      members: [ME],
      powerLevels: { users: { [BOB]: 100 }, users_default: 0, invite: 50 },
    });

    expect(getRoomPermissions(room, ME).canInvite).toBe(false);
  });

  it('lets anyone change state in a room without a power levels event', async () => {
    const room = await makeRoom(makeClient(), { creator: BOB, members: [ME], powerLevels: null });

    expect(getRoomPermissions(room, ME)).toMatchObject({ canRename: true, canChangeJoinRule: true, canChangeRoles: true });
  });

  it('follows per-event levels over the state default', async () => {
    const room = await staffedRoom({ events: { [EventType.RoomName]: 0, [EventType.RoomJoinRules]: 100 } });

    expect(getRoomPermissions(room, CAROL)).toMatchObject({ canRename: true, canChangeJoinRule: false });
    expect(getRoomPermissions(room, BOB)).toMatchObject({ canRename: true, canChangeJoinRule: false, canChangeRoles: true });
  });

  it('offers encryption only while the room is unencrypted', async () => {
    const room = await staffedRoom();
    expect(getRoomPermissions(room, ME).canEnableEncryption).toBe(true);

    await setState(room, EventType.RoomEncryption, { algorithm: 'm.megolm.v1.aes-sha2' });

    expect(getRoomPermissions(room, ME).canEnableEncryption).toBe(false);
  });

  it('reflects a power level change as soon as the room state has it', async () => {
    const room = await staffedRoom();
    expect(getRoomPermissions(room, CAROL).canRename).toBe(false);

    await setState(room, EventType.RoomPowerLevels, { users: { [ME]: 100, [BOB]: 50, [CAROL]: 50 }, users_default: 0, state_default: 50 });

    expect(getRoomPermissions(room, CAROL).canRename).toBe(true);
  });
});