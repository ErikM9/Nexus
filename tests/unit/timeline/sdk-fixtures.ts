import {
  createClient,
  EventStatus,
  EventType,
  KnownMembership,
  MatrixEvent,
  MatrixEventEvent,
  PendingEventOrdering,
  Room,
  RoomEvent,
  type IContent,
  type IEvent,
  type IEventRelation,
  type MatrixClient,
} from 'matrix-js-sdk';

/* Real SDK objects without a network, so tests see the SDK's own relation, redaction and send-status behaviour instead of a stand-in */

export const ME = '@alice:hs.test';
export const BOB = '@bob:hs.test';
export const CAROL = '@carol:hs.test';
export const ROOM_ID = '!room:hs.test';

let counter = 0;

export const makeClient = (): MatrixClient =>
  createClient({ baseUrl: 'https://hs.test', userId: ME, accessToken: 'test-token', deviceId: 'TESTDEVICE' });

/* A joined room stored in the client, re-emitting on the client the room events the SDK's sync code forwards, with chronological local echoes as the app uses */
export const makeRoom = (client: MatrixClient = makeClient(), roomId = ROOM_ID): Room => {
  const room = new Room(roomId, client, ME, { pendingEventOrdering: PendingEventOrdering.Chronological });
  client.reEmitter.reEmit(room, [
    RoomEvent.Redaction,
    RoomEvent.LocalEchoUpdated,
    RoomEvent.MyMembership,
    RoomEvent.Timeline,
    RoomEvent.TimelineReset,
  ]);
  /* A create event from a user outside the tests gives the room a version, which the SDK reads for power levels, without making any test user its creator */
  room.currentState.setStateEvents([stateEvent(EventType.RoomCreate, '', { room_version: '10' }, '@creator:hs.test')]);
  room.updateMyMembership(KnownMembership.Join);
  client.store.storeRoom(room);
  return room;
};

/* Builds an event the way the SDK maps one from the server, with increasing timestamps in creation order */
export const event = (fields: Partial<IEvent> & { content?: IContent }): MatrixEvent => {
  counter += 1;
  return new MatrixEvent({
    event_id: `$event${counter}`,
    room_id: ROOM_ID,
    sender: BOB,
    origin_server_ts: 1_780_000_000_000 + counter * 1000,
    type: 'm.room.message',
    content: {},
    ...fields,
  });
};

export const textEvent = (body: string, fields: Partial<IEvent> = {}, extraContent: IContent = {}): MatrixEvent =>
  event({ ...fields, content: { msgtype: 'm.text', body, ...extraContent } });

export const editOf = (target: MatrixEvent, body: string, fields: Partial<IEvent> = {}): MatrixEvent =>
  event({
    ...fields,
    content: {
      msgtype: 'm.text',
      body: `* ${body}`,
      'm.new_content': { msgtype: 'm.text', body },
      'm.relates_to': { rel_type: 'm.replace', event_id: target.getId() },
    },
  });

export const reactionTo = (target: MatrixEvent, key: string, fields: Partial<IEvent> = {}): MatrixEvent =>
  event({ ...fields, type: 'm.reaction', content: { 'm.relates_to': { rel_type: 'm.annotation', event_id: target.getId(), key } } });

export const redactionOf = (target: MatrixEvent, fields: Partial<IEvent> = {}): MatrixEvent =>
  event({ ...fields, type: 'm.room.redaction', redacts: target.getId(), content: {} });

export const stateEvent = (type: string, stateKey: string, content: IContent, sender = ME): MatrixEvent =>
  event({ type, state_key: stateKey, sender, content });

/* An encrypted event as received from the server, whose relation stays in the clear as the SDK's encryption leaves it */
export const encryptedEvent = (fields: Partial<IEvent> = {}, relation?: IEventRelation): MatrixEvent =>
  event({
    ...fields,
    type: 'm.room.encrypted',
    content: { algorithm: 'm.megolm.v1.aes-sha2', ciphertext: 'opaque', ...(relation ? { 'm.relates_to': relation } : {}) },
  });

type CryptoBackendLike = Parameters<MatrixEvent['attemptDecryption']>[0];

/* Runs the SDK's real decryption path with a stand-in crypto backend that yields the given clear event or fails */
export const decrypt = (target: MatrixEvent, clear: { type: string; content: IContent } | Error): Promise<void> =>
  target.attemptDecryption({
    decryptEvent: async () => {
      if (clear instanceof Error) throw clear;
      return { clearEvent: clear };
    },
  } as unknown as CryptoBackendLike);

/* A local echo exactly as MatrixClient.sendEvent creates one, with a temporary ID and a transaction ID */
export const localEcho = (body: string, txnId: string, status: EventStatus = EventStatus.SENDING): MatrixEvent => {
  const echo = new MatrixEvent({
    event_id: `~${ROOM_ID}:${txnId}`,
    room_id: ROOM_ID,
    sender: ME,
    origin_server_ts: Date.now(),
    type: 'm.room.message',
    content: { msgtype: 'm.text', body },
  });
  echo.setTxnId(txnId);
  echo.setStatus(status);
  return echo;
};

/* Adds events as sync does, first re-emitting their decryption and replacement on the client as the SDK's event mapper arranges */
export const addLive = (room: Room, events: MatrixEvent[], addToState = false): Promise<void> => {
  for (const ev of events) room.client.reEmitter.reEmit(ev, [MatrixEventEvent.Decrypted, MatrixEventEvent.Replaced]);
  return room.addLiveEvents(events, { addToState });
};

/* Lets the SDK finish the asynchronous part of relation aggregation, which applies edits after a microtask */
export const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));