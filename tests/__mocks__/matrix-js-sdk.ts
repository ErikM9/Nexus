import { vi } from 'vitest';

/* Re-export SDK constants so tests can import them without the real SDK bundle */
export const ClientEvent = {
  Sync: 'sync',
  ToDeviceEvent: 'toDeviceEvent',
  AccountData: 'accountData',
  Room: 'room',
  RoomState: 'roomState',
};

export const RoomEvent = {
  Timeline: 'Room.timeline',
  TimelineReset: 'Room.timelineReset',
  LocalEchoUpdated: 'Room.localEchoUpdated',
  MyMembership: 'Room.myMembership',
  Name: 'Room.name',
  Tags: 'Room.tags',
};

export const RoomStateEvent = {
  Events: 'RoomState.events',
  Members: 'RoomState.members',
  NewMember: 'RoomState.newMember',
  Update: 'RoomState.update',
};

export const KnownMembership = {
  Join: 'join',
  Leave: 'leave',
  Invite: 'invite',
  Ban: 'ban',
  Knock: 'knock',
};

export const EventStatus = {
  NOT_SENT: 'not_sent',
  ENCRYPTING: 'encrypting',
  SENDING: 'sending',
  QUEUED: 'queued',
  SENT: 'sent',
  CANCELLED: 'cancelled',
};

export const Direction = {
  Backward: 'b',
  Forward: 'f',
};

export const EventType = {
  RoomMessage: 'm.room.message',
  RoomEncrypted: 'm.room.encrypted',
  RoomMember: 'm.room.member',
  RoomCreate: 'm.room.create',
  RoomJoinRules: 'm.room.join_rules',
  RoomPowerLevels: 'm.room.power_levels',
  RoomName: 'm.room.name',
  RoomTopic: 'm.room.topic',
  RoomEncryption: 'm.room.encryption',
  KeyVerificationRequest: 'm.key.verification.request',
};

export const MsgType = {
  Text: 'm.text',
  Image: 'm.image',
  File: 'm.file',
  Audio: 'm.audio',
  Video: 'm.video',
  Notice: 'm.notice',
  Emote: 'm.emote',
};

/* MockRoom with currentState defaults for power levels, join rules, and encryption */
export class MockRoom {
  roomId: string;
  name: string;
  private membership: string = KnownMembership.Join;
  private lastActiveTimestamp: number = Date.now();
  private timeline: any[] = [];
  private members: Map<string, any> = new Map();
  private eventListeners: Map<string, Set<Function>> = new Map();
  currentState: any;

  constructor(roomId: string, name?: string) {
    this.roomId = roomId;
    this.name = name || roomId;
    this.currentState = {
      getStateEvents: vi.fn((type: string, stateKey?: string) => {
        if (type === 'm.room.encryption') {
          return { getContent: () => ({ algorithm: 'm.megolm.v1.aes-sha2' }) };
        }
        if (type === 'm.room.power_levels') {
          return {
            getContent: () => ({
              users: {},
              users_default: 0,
              events: {},
              events_default: 0,
              state_default: 50,
              ban: 50,
              kick: 50,
              redact: 50,
              invite: 0,
            }),
          };
        }
        if (type === 'm.room.join_rules') {
          return { getContent: () => ({ join_rule: 'invite' }) };
        }
        return null;
      }),
      maySendEvent: vi.fn(() => true),
      maySendStateEvent: vi.fn(() => true),
      getMembers: vi.fn(() => Array.from(this.members.values())),
    };
  }

  getMyMembership() {
    return this.membership;
  }

  setMyMembership(membership: string) {
    this.membership = membership;
  }

  getLastActiveTimestamp() {
    return this.lastActiveTimestamp;
  }

  private liveTimeline = {
    getEvents: () => this.timeline,

    /* null signals no more history to paginate */
    getPaginationToken: vi.fn().mockReturnValue(null),
  };

  getLiveTimeline() {
    return this.liveTimeline;
  }

  getJoinedMembers() {
    return Array.from(this.members.values()).filter(
      (m) => m.membership === KnownMembership.Join
    );
  }

  getMember(userId: string) {
    return this.members.get(userId);
  }

  addMember(userId: string, membership: string = KnownMembership.Join, powerLevel: number = 0) {
    this.members.set(userId, {
      userId,
      membership,
      powerLevel,
      name: userId,
    });
  }

  addEvent(event: any) {
    this.timeline.push(event);
  }

  on(event: string, handler: Function) {
    if (!this.eventListeners.has(event)) {
      this.eventListeners.set(event, new Set());
    }
    this.eventListeners.get(event)!.add(handler);
  }

  removeListener(event: string, handler: Function) {
    this.eventListeners.get(event)?.delete(handler);
  }

  emit(event: string, ...args: any[]) {
    this.eventListeners.get(event)?.forEach((handler) => handler(...args));
  }
}

export class MockMatrixEvent {
  private id: string;
  private type: string;
  private content: any;
  private sender: string;
  private timestamp: number;
  private txnId?: string;

  constructor(opts: {
    id?: string;
    type: string;
    content: any;
    sender?: string;
    timestamp?: number;
    txnId?: string;
  }) {
    this.id = opts.id || `$event_${Math.random().toString(36).slice(2)}`;
    this.type = opts.type;
    this.content = opts.content;
    this.sender = opts.sender || '@user:matrix.org';
    this.timestamp = opts.timestamp || Date.now();
    this.txnId = opts.txnId;
  }

  getId() { return this.id; }
  getType() { return this.type; }
  getContent() { return this.content; }
  getSender() { return this.sender; }
  getTs() { return this.timestamp; }
  getTxnId() { return this.txnId; }
  getUnsigned() { return { transaction_id: this.txnId }; }
  isDecryptionFailure() { return this.content?.msgtype === 'm.bad.encrypted'; }

  get event() {
    return {
      event_id: this.id,
      type: this.type,
      content: this.content,
      sender: this.sender,
      origin_server_ts: this.timestamp,
      unsigned: { transaction_id: this.txnId },
    };
  }
}

/* Central SDK client test double, mostly vi.fn stubs with light bookkeeping for stateful methods */
export class MockMatrixClient {
  private userId: string = '@testuser:matrix.org';
  private deviceId: string = 'TESTDEVICE';
  private accessToken: string = 'test_access_token';
  private baseUrl: string = 'https://matrix.org';
  private rooms: Map<string, MockRoom> = new Map();
  private eventListeners: Map<string, Set<Function>> = new Map();
  private syncState: string = 'PREPARED';
  private cryptoEnabled: boolean = true;

  constructor(opts?: {
    baseUrl?: string;
    accessToken?: string;
    userId?: string;
    deviceId?: string;
  }) {
    if (opts?.baseUrl) this.baseUrl = opts.baseUrl;
    if (opts?.accessToken) this.accessToken = opts.accessToken;
    if (opts?.userId) this.userId = opts.userId;
    if (opts?.deviceId) this.deviceId = opts.deviceId;
  }

  getUserId() { return this.userId; }
  getDeviceId() { return this.deviceId; }
  getAccessToken() { return this.accessToken; }
  setAccessToken(token: string) { this.accessToken = token; }
  getHomeserverUrl() { return this.baseUrl; }
  getSyncState() { return this.syncState; }
  setSyncState(state: string) { this.syncState = state; }
  getRooms() { return Array.from(this.rooms.values()); }
  getRoom(roomId: string) { return this.rooms.get(roomId) || null; }
  addRoom(room: MockRoom) { this.rooms.set(room.roomId, room); }

  createRoom = vi.fn(async (opts: any) => {
    const roomId = `!${Math.random().toString(36).slice(2)}:matrix.org`;
    const room = new MockRoom(roomId, opts?.name);
    this.rooms.set(roomId, room);
    return { room_id: roomId };
  });

  joinRoom = vi.fn(async (roomIdOrAlias: string) => {
    const roomId = roomIdOrAlias.startsWith('#')
      ? `!${Math.random().toString(36).slice(2)}:matrix.org`
      : roomIdOrAlias;
    if (!this.rooms.has(roomId)) {
      this.rooms.set(roomId, new MockRoom(roomId));
    }
    return { room_id: roomId };
  });

  leave = vi.fn(async (roomId: string) => {
    const room = this.rooms.get(roomId);
    if (room) room.setMyMembership(KnownMembership.Leave);
  });

  invite = vi.fn(async (_roomId: string, _userId: string) => {});
  kick = vi.fn(async (_roomId: string, _userId: string, _reason?: string) => {});
  ban = vi.fn(async (_roomId: string, _userId: string, _reason?: string) => {});
  setRoomName = vi.fn(async (_roomId: string, _name: string) => {});

  sendEvent = vi.fn(async (roomId: string, eventType: string, content: any, txnId?: string) => {
    const eventId = `$${Math.random().toString(36).slice(2)}:matrix.org`;
    const event = new MockMatrixEvent({ id: eventId, type: eventType, content, sender: this.userId, txnId });
    const room = this.rooms.get(roomId);
    if (room) room.addEvent(event);
    return { event_id: eventId };
  });

  paginateEventTimeline = vi.fn(async (_timeline: any, _opts?: { backwards?: boolean; limit?: number }) => true);

  uploadContent = vi.fn(async (_file: Blob, _opts?: any) => ({
    content_uri: 'mxc://matrix.org/testfile',
  }));

  mxcUrlToHttp = vi.fn((mxcUrl: string) => {
    if (!mxcUrl?.startsWith('mxc://')) return null;
    const [, serverName, mediaId] = mxcUrl.match(/^mxc:\/\/([^/]+)\/(.+)$/) || [];
    if (!serverName || !mediaId) return null;
    return `${this.baseUrl}/_matrix/media/v3/download/${serverName}/${mediaId}`;
  });

  publicRooms = vi.fn(async (_opts?: any) => ({
    chunk: [],
    total_room_count_estimate: 0,
  }));

  setPowerLevel = vi.fn(async (_roomId: string, _userId: string, _level: number) => {});

  /* sendStateEvent and redactEvent are stubbed so the as-any call sites get a no-op instead of a TypeError */
  sendStateEvent = vi.fn(async (_roomId: string, _type: string, _content: any, _stateKey: string) => (
    { event_id: `$state_${Math.random().toString(36).slice(2)}:matrix.org` }
  ));
  redactEvent = vi.fn(async (_roomId: string, _eventId: string, _reason?: string) => (
    { event_id: `$redact_${Math.random().toString(36).slice(2)}:matrix.org` }
  ));
  getAccountData = vi.fn((_type: string) => null);

  isRoomEncrypted = vi.fn((roomId: string) => {
    const room = this.rooms.get(roomId);
    if (!room) return false;
    const encEvent = room.currentState.getStateEvents('m.room.encryption', '');
    return !!encEvent;
  });

  getCrypto = vi.fn(() => {
    if (!this.cryptoEnabled) return null;
    return {
      getUserDeviceInfo: vi.fn(async () => new Map()),
      requestOwnUserVerification: vi.fn(async () => ({
        transactionId: 'test_txn_id',
        phase: 'requested',
        otherUserId: this.userId,
      })),
      requestDeviceVerification: vi.fn(async () => ({
        transactionId: 'test_txn_id',
        phase: 'requested',
      })),
      checkKeyBackupAndEnable: vi.fn(async () => {}),
      loadSessionBackupPrivateKeyFromSecretStorage: vi.fn(async () => {}),
      restoreKeyBackup: vi.fn(async () => {}),
      bootstrapSecretStorage: vi.fn(async () => {}),
      createRecoveryKeyFromPassphrase: vi.fn(async () => ({
        privateKey: new Uint8Array(32),
        encodedPrivateKey: 'test_encoded_key',
      })),
    };
  });

  initRustCrypto = vi.fn(async () => { this.cryptoEnabled = true; });
  initCrypto = vi.fn(async () => { this.cryptoEnabled = true; });

  /* Emits PREPARED after 10ms so sync waits resolve quickly */
  startClient = vi.fn(async () => {
    this.syncState = 'SYNCING';
    setTimeout(() => {
      this.emit(ClientEvent.Sync, 'PREPARED', null, {});
    }, 10);
  });

  stopClient = vi.fn(() => { this.syncState = 'STOPPED'; });

  on(event: string, handler: Function) {
    if (!this.eventListeners.has(event)) {
      this.eventListeners.set(event, new Set());
    }
    this.eventListeners.get(event)!.add(handler);
    return this;
  }

  removeListener(event: string, handler: Function) {
    this.eventListeners.get(event)?.delete(handler);
    return this;
  }

  removeAllListeners() {
    this.eventListeners.clear();
    return this;
  }

  emit(event: string, ...args: any[]) {
    this.eventListeners.get(event)?.forEach((handler) => handler(...args));
  }

  get http() {
    return {
      opts: { accessToken: this.accessToken },
      authedRequest: vi.fn(),
    };
  }

  get secretStorage() {
    return {
      getDefaultKeyId: vi.fn(async () => 'default_key_id'),
      checkKey: vi.fn(async () => true),
    };
  }
}

export const createClient = vi.fn((opts: any) => new MockMatrixClient(opts));

export const decodeRecoveryKey = vi.fn((key: string) => {
  if (!key || key.length < 10) throw new Error('Invalid recovery key');
  return new Uint8Array(32).fill(1);
});

export const encodeRecoveryKey = vi.fn((key: Uint8Array) => {
  if (!key || key.length !== 32) throw new Error('Invalid key length');
  return 'EsT2 AbCd EfGh IjKl MnOp QrSt UvWx YzAb CdEf GhIj';
});

export { MockMatrixClient as MatrixClient };
export { MockRoom as Room };
export { MockMatrixEvent as MatrixEvent };