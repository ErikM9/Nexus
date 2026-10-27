import React from 'react';
import { onTestFinished, vi } from 'vitest';
import { render } from '@testing-library/react';
import { Direction, type IContent, type MatrixClient, type MatrixEvent, type Room } from 'matrix-js-sdk';
import ChatWindow from '@/app/app-components/ChatWindow';
import { getMatrixClient } from '@/app/utils/matrix';
import { addLive, makeClient, makeRoom, ME, ROOM_ID, stateEvent } from '../timeline/sdk-fixtures';

/* Test files using this harness mock @/app/utils/matrix, so getMatrixClient is that mock, handing over a real SDK client */

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

/* Answers every media download with the given bytes and content type, as the homeserver's media endpoint would */
export const serveMedia = (bytes: Uint8Array, contentType: string) =>
  vi.mocked(fetch).mockImplementation(async () => new Response(bytes as BodyInit, { status: 200, headers: { 'content-type': contentType } }));

/* The row around a message, which holds the message's action bar and thread count beside the message itself */
export const rowOf = (message: HTMLElement): HTMLElement => message.closest('[data-message-id]') as HTMLElement;

/* Collects the details of a window event, the channel through which the timeline talks to the composer */
export const captureWindowEvents = <T,>(type: string): T[] => {
  const details: T[] = [];
  const listener = (event: Event) => details.push((event as CustomEvent<T>).detail);
  window.addEventListener(type, listener);
  onTestFinished(() => window.removeEventListener(type, listener));
  return details;
};

/* A promise the test settles by hand, standing in for a request that is still on its way */
export const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};