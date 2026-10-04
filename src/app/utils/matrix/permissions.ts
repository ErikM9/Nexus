import { EventType, type Room } from 'matrix-js-sdk';

/* What the signed-in user may change in a room, read from the SDK's view of the current power levels */
export interface RoomPermissions {
  canRename: boolean;
  canChangeJoinRule: boolean;
  canEnableEncryption: boolean;
  canChangeRoles: boolean;
  canInvite: boolean;
}

export const NO_PERMISSIONS: RoomPermissions = {
  canRename: false,
  canChangeJoinRule: false,
  canEnableEncryption: false,
  canChangeRoles: false,
  canInvite: false,
};

/* A member's power level as the SDK computes it, which is Infinity for the creators of a room version 12 room */
export const getPowerLevel = (room: Room, userId: string): number => room.getMember(userId)?.powerLevel ?? 0;

export const getRoomPermissions = (room: Room, userId: string): RoomPermissions => {
  const state = room.currentState;
  return {
    canRename: state.maySendStateEvent(EventType.RoomName, userId),
    canChangeJoinRule: state.maySendStateEvent(EventType.RoomJoinRules, userId),
    canEnableEncryption: !room.hasEncryptionStateEvent() && state.maySendStateEvent(EventType.RoomEncryption, userId),
    canChangeRoles: state.maySendStateEvent(EventType.RoomPowerLevels, userId),
    canInvite: room.canInvite(userId),
  };
};

/* Kicking or banning needs the room's kick or ban level and a power level strictly above the target's */
const mayRemove = (room: Room, userId: string, targetId: string, action: 'kick' | 'ban'): boolean => {
  if (userId === targetId) return false;
  const mine = getPowerLevel(room, userId);
  return room.currentState.hasSufficientPowerLevelFor(action, mine) && mine > getPowerLevel(room, targetId);
};

export const canKick = (room: Room, userId: string, targetId: string): boolean => mayRemove(room, userId, targetId, 'kick');

export const canBan = (room: Room, userId: string, targetId: string): boolean => mayRemove(room, userId, targetId, 'ban');

/* Follows the power-level authorisation rules: another member must be below the sender and may be raised no higher than the sender, while senders may only lower themselves */
export const canSetPowerLevel = (room: Room, userId: string, targetId: string, level: number): boolean => {
  if (!Number.isFinite(level)) return false;
  if (!room.currentState.maySendStateEvent(EventType.RoomPowerLevels, userId)) return false;

  const mine = getPowerLevel(room, userId);
  if (targetId === userId) return Number.isFinite(mine) && level < mine;
  return getPowerLevel(room, targetId) < mine && level <= mine;
};