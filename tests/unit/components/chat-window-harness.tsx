import React from 'react';
import { vi } from 'vitest';
import { render } from '@testing-library/react';
import { Direction, type IContent, type MatrixClient, type MatrixEvent, type Room } from 'matrix-js-sdk';
import ChatWindow from '@/app/app-components/ChatWindow';
import { getMatrixClient } from '@/app/utils/matrix';
import { addLive, makeClient, makeRoom, ME, ROOM_ID, stateEvent } from '../timeline/sdk-fixtures';

/* Test files using this harness mock @/app/utils/matrix, so getMatrixClient here is that mock handing the component a real SDK client */

export interface RoomSetup {
  client: MatrixClient;
  room: Room;
}

export const DEFAULT_POWER_LEVELS: IContent = { users: { [ME]: 100 }, users_default: 0, events_default: 0, redact: 50 };

/* A real client and joined room holding the given events, at the start of history unless older pages are expected */
export const setupRoom = async (
  events: MatrixEvent[] = [],
  opts: { moreHistory?: boolean; powerLevels?: IContent; roomVersion?: string } = {}
): Promise<RoomSetup> => {
  const client = makeClient();
  const room = makeRoom(client);
  /* The create event goes first because the SDK works out creators' power levels from it when the power levels arrive */
  const create = opts.roomVersion ? [stateEvent('m.room.create', '', { room_version: opts.roomVersion })] : [];
  await addLive(
    room,
    [...create, stateEvent('m.room.member', ME, { membership: 'join' }), stateEvent('m.room.power_levels', '', opts.powerLevels ?? DEFAULT_POWER_LEVELS)],
    true
  );
  await addLive(room, events);
  room.getLiveTimeline().setPaginationToken(opts.moreHistory ? 't_older' : null, Direction.Backward);
  return { client, room };
};

export const renderChatWindow = (client: MatrixClient, roomId = ROOM_ID) => {
  vi.mocked(getMatrixClient).mockReturnValue(client);
  window.__matrix_ready = true;
  const onLeave = vi.fn();
  const utils = render(<ChatWindow roomId={roomId} onLeave={onLeave} />);
  return { onLeave, ...utils };
};

/* Stops real network calls from the SDK's send and redact paths while keeping their promises realistic */
export const stubSends = (client: MatrixClient) => ({
  sendEvent: vi.spyOn(client, 'sendEvent').mockResolvedValue({ event_id: '$sent' }),
  redactEvent: vi.spyOn(client, 'redactEvent').mockResolvedValue({ event_id: '$redaction' }),
});