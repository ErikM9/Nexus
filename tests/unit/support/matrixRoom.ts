import {
  ClientEvent,
  createClient,
  EventType,
  KnownMembership,
  MatrixEvent,
  MemoryStore,
  Room,
  RoomEvent,
  RoomStateEvent,
  type MatrixClient,
} from 'matrix-js-sdk';

/* Builders for real SDK clients and rooms, so unit tests exercise the SDK's own power-level, name and membership logic */

export const HS = 'hs.test';
export const ME = `@me:${HS}`;
export const BOB = `@bob:${HS}`;
export const CAROL = `@carol:${HS}`;

let counter = 0;

/* An unstarted client with an in-memory store, which makes no requests unless a test calls a network method */
export const makeClient = (userId = ME): MatrixClient =>
  createClient({
    baseUrl: `https://${HS}`,
    userId,
    deviceId: 'MYDEVICE',
    accessToken: 'test-token',
    store: new MemoryStore(),
  });

export const makeEvent = (
  roomId: string,
  type: string,
  sender: string,
  content: Record<string, unknown>,
  extra: { stateKey?: string; ts?: number } = {}
): MatrixEvent =>
  new MatrixEvent({
    type,
    sender,
    room_id: roomId,
    content,
    event_id: `$test${++counter}`,
    origin_server_ts: extra.ts ?? counter,
    ...(extra.stateKey !== undefined ? { state_key: extra.stateKey } : {}),
  });

export interface RoomSpec {
  roomId?: string;
  name?: string;
  roomVersion?: string;
  creator?: string;
  /* Users joined besides the creator, who is always joined */
  members?: string[];
  /* Content of m.room.power_levels, or null for a room without that event */
  powerLevels?: Record<string, unknown> | null;
  joinRule?: 'public' | 'invite';
  encrypted?: boolean;
  /* The m.room.create type, such as m.space */
  type?: string;
  createdAt?: number;
  /* This user's membership, recorded as a member event from the creator unless it is join, so give such rooms another creator */
  myMembership?: string;
}

/* A room whose state arrives the way sync delivers it, stored in the client so getRoom and getRooms find it */
export const makeRoom = async (client: MatrixClient, spec: RoomSpec = {}): Promise<Room> => {
  const roomId = spec.roomId ?? `!room${++counter}:${HS}`;
  const creator = spec.creator ?? client.getSafeUserId();
  const room = new Room(roomId, client, client.getSafeUserId());
  /* The same room events the SDK's sync re-emits on the client, which is where components listen */
  client.reEmitter.reEmit(room, [RoomEvent.Name, RoomEvent.MyMembership, RoomEvent.Timeline, RoomStateEvent.Events]);
  const state = (type: string, content: Record<string, unknown>, stateKey = '', sender = creator) =>
    makeEvent(roomId, type, sender, content, { stateKey, ts: spec.createdAt });

  const events = [
    state(EventType.RoomCreate, { room_version: spec.roomVersion ?? '10', ...(spec.type ? { type: spec.type } : {}) }),
    state(EventType.RoomMember, { membership: KnownMembership.Join }, creator),
  ];
  if (spec.powerLevels !== null) {
    events.push(state(EventType.RoomPowerLevels, spec.powerLevels ?? { users: { [creator]: 100 }, users_default: 0 }));
  }
  events.push(state(EventType.RoomJoinRules, { join_rule: spec.joinRule ?? 'invite' }));
  if (spec.name) events.push(state(EventType.RoomName, { name: spec.name }));
  if (spec.encrypted) events.push(state(EventType.RoomEncryption, { algorithm: 'm.megolm.v1.aes-sha2' }));
  for (const member of spec.members ?? []) {
    if (member !== creator) events.push(state(EventType.RoomMember, { membership: KnownMembership.Join }, member, member));
  }
  const me = client.getSafeUserId();
  if (spec.myMembership && spec.myMembership !== KnownMembership.Join && me !== creator) {
    events.push(state(EventType.RoomMember, { membership: spec.myMembership }, me, creator));
  }

  await room.addLiveEvents(events, { addToState: true });
  room.updateMyMembership(spec.myMembership ?? KnownMembership.Join);
  room.recalculate();
  client.store.storeRoom(room);
  client.emit(ClientEvent.Room, room);
  return room;
};

/* Adds a timeline event from another member as a live event, the way an incremental sync delivers it */
export const addMessage = async (
  room: Room,
  sender: string,
  content: Record<string, unknown>,
  opts: { type?: string; ts?: number } = {}
): Promise<MatrixEvent> => {
  const event = makeEvent(room.roomId, opts.type ?? EventType.RoomMessage, sender, content, { ts: opts.ts });
  await room.addLiveEvents([event], { addToState: false });
  return event;
};

/* Delivers a state change to a room as a live event, which fires the SDK's RoomState events like a sync would */
export const setState = async (
  room: Room,
  type: string,
  content: Record<string, unknown>,
  opts: { stateKey?: string; sender?: string; ts?: number } = {}
): Promise<void> => {
  const event = makeEvent(room.roomId, type, opts.sender ?? room.myUserId, content, { stateKey: opts.stateKey ?? '', ts: opts.ts });
  await room.addLiveEvents([event], { addToState: true });
  room.recalculate();
};