import { generateKeyPairSync, sign, type KeyObject } from 'crypto';
import type { Page, Route, Request } from '@playwright/test';

/* A stand-in Matrix homeserver answered inside the browser, so the real SDK and Rust crypto run end to end without a server */

export const SERVER_NAME = 'hs.nexus.test';
export const HS_URL = `https://${SERVER_NAME}`;
export const ME = `@alice:${SERVER_NAME}`;
export const BOB = `@bob:${SERVER_NAME}`;
export const CAROL = `@carol:${SERVER_NAME}`;
export const ACCESS_TOKEN = 'alice-access-token';
export const BOB_ACCESS_TOKEN = 'bob-access-token';
export const DEVICE_ID = 'ALICEDEVICE';
export const PASSWORD = 'correct horse battery staple';

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export interface MatrixEvent {
  event_id: string;
  type: string;
  sender: string;
  origin_server_ts: number;
  content: Json;
  state_key?: string;
  redacts?: string;
  unsigned?: Json;
}

export interface RecordedRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  body: Json | null;
}

interface StoredEvent {
  event: MatrixEvent;
  pos: number;
}

interface Fault {
  method?: string;
  path: RegExp;
  status: number;
  body: Json;
  times: number;
}

interface RoomOptions {
  name?: string;
  encrypted?: boolean;
  isPublic?: boolean;
  members?: string[];
  alias?: string;
  publishToDirectory?: boolean;
  powerLevels?: Json;
  roomVersion?: string;
  /* Extra m.room.create content, such as a space's type or an upgraded room's predecessor */
  creationContent?: Json;
}

const DEFAULT_TIMELINE_LIMIT = 20;

/* Incremental syncs are held briefly rather than for the 30 seconds a real server allows, which keeps each spec quick without busy-polling */
const DEFAULT_SYNC_HOLD_MS = 800;

const stateKeyOf = (ev: MatrixEvent) => `${ev.type}|${ev.state_key}`;

const localpart = (userId: string) => userId.replace(/^@/, '').split(':')[0];

/* Matrix canonical JSON (sorted keys, no whitespace), the exact bytes a device signature covers */
const canonicalJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Json)[key])}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
};

/* Matrix encodes keys and signatures as standard base64 without padding */
const unpaddedBase64 = (bytes: Buffer) => bytes.toString('base64').replace(/=+$/, '');

const rawPublicKey = (key: KeyObject) => unpaddedBase64(Buffer.from(key.export({ format: 'jwk' }).x ?? '', 'base64url'));

class FakeRoom {
  readonly events: StoredEvent[] = [];

  constructor(readonly roomId: string, readonly roomVersion: string) {}

  /* Replays the state events up to an index, which is how a server derives the state at any point in a timeline */
  stateAt(index = this.events.length): Map<string, MatrixEvent> {
    const state = new Map<string, MatrixEvent>();
    for (const { event } of this.events.slice(0, index)) {
      if (event.state_key !== undefined) state.set(stateKeyOf(event), event);
    }
    return state;
  }

  stateEvent(type: string, stateKey = ''): MatrixEvent | undefined {
    return this.stateAt().get(`${type}|${stateKey}`);
  }

  membership(userId: string): string | undefined {
    return this.stateEvent('m.room.member', userId)?.content.membership;
  }

  /* Position of the latest membership change for a user, which tells an incremental sync when that user joined or left */
  membershipPos(userId: string): number {
    for (let i = this.events.length - 1; i >= 0; i--) {
      const { event, pos } = this.events[i];
      if (event.type === 'm.room.member' && event.state_key === userId) return pos;
    }
    return -1;
  }

  get name(): string | undefined {
    return this.stateEvent('m.room.name')?.content.name;
  }
}

/* Device keys self-signed with a fresh ed25519 key, as a real client uploads them, so the Rust crypto trusts they belong to that device */
const signedDeviceKeys = (userId: string, deviceId: string): Json => {
  const ed25519 = generateKeyPairSync('ed25519');
  const curve25519 = generateKeyPairSync('x25519');
  const deviceKeys: Json = {
    algorithms: ['m.olm.v1.curve25519-aes-sha2', 'm.megolm.v1.aes-sha2'],
    device_id: deviceId,
    keys: {
      [`curve25519:${deviceId}`]: rawPublicKey(curve25519.publicKey),
      [`ed25519:${deviceId}`]: rawPublicKey(ed25519.publicKey),
    },
    user_id: userId,
  };
  const signature = unpaddedBase64(sign(null, Buffer.from(canonicalJson(deviceKeys)), ed25519.privateKey));
  return { ...deviceKeys, signatures: { [userId]: { [`ed25519:${deviceId}`]: signature } } };
};

/* One fake homeserver per test, holding rooms, a sync stream, uploaded keys and media, and a log of every request the app made */
export class FakeHomeserver {
  readonly requests: RecordedRequest[] = [];
  readonly escapedRequests: string[] = [];

  syncHoldMs = DEFAULT_SYNC_HOLD_MS;
  timelineLimit = DEFAULT_TIMELINE_LIMIT;

  private pos = 0;
  private eventCounter = 0;
  private roomCounter = 0;
  private mediaCounter = 0;
  private backupCounter = 0;
  private readonly acceptedTokens = new Set<string>([ACCESS_TOKEN]);
  private clock = Date.now() - 60 * 60 * 1000;
  private readonly rooms = new Map<string, FakeRoom>();
  private readonly aliases = new Map<string, string>();
  private readonly directory = new Set<string>();
  private readonly displayNames = new Map<string, string>();
  private readonly accountData = new Map<string, { content: Json; pos: number }>();
  private readonly filters = new Map<string, Json>();
  private readonly media = new Map<string, { body: Buffer; contentType: string }>();
  private readonly faults: Fault[] = [];
  private readonly sentByApp = new Set<string>();
  private readonly delays: { path: RegExp; ms: number }[] = [];
  private waiters: (() => void)[] = [];
  private deviceKeys: Json | null = null;
  /* Devices of other users published with addDevice, keyed by user ID and then device ID */
  private readonly otherDeviceKeys = new Map<string, Json>();
  private oneTimeKeyCount = 0;
  private backupVersion: Json | null = null;
  private closed = false;
  /* Refresh-token support is off unless a spec turns it on, so access tokens never expire by default */
  private refreshTokens: { lifetimeMs: number; rotate: boolean; valid: Set<string>; expiry: Map<string, number>; counter: number } | null = null;
  /* While false every homeserver request fails at the network level, as when the server is down or the device is offline */
  private reachable = true;
  /* Other devices of the signed-in user that key queries report, so the Rust crypto accepts to-device messages from them */
  private readonly ownDevices = new Map<string, Json>();
  /* To-device messages queued by specs, each delivered by the first sync that starts before it was queued */
  private readonly toDeviceMessages: { event: Json; pos: number }[] = [];

  constructor() {
    this.displayNames.set(ME, 'Alice');
    this.displayNames.set(BOB, 'Bob');
    this.displayNames.set(CAROL, 'Carol');
  }

  /* Routes every homeserver URL to this fake and blocks any request that leaves the app's own origin, so no spec can reach a real server */
  async install(page: Page, appOrigin = 'http://localhost:3000'): Promise<void> {
    await page.route(
      (url) => url.origin !== appOrigin && !url.href.startsWith('data:') && !url.href.startsWith('blob:'),
      (route) => {
        this.escapedRequests.push(`${route.request().method()} ${route.request().url()}`);
        return route.abort().catch(() => {});
      }
    );
    await page.route((url) => url.pathname.startsWith('/_matrix/'), (route) => this.handle(route));
  }

  /* Stands in for the app's /api/login and /api/logout routes, which call the homeserver from the Next.js server where a browser route cannot reach, and answers the way those routes do */
  async mockAppApi(page: Page): Promise<void> {
    const accounts: Record<string, { userId: string; token: string; deviceId: string }> = {
      alice: { userId: ME, token: ACCESS_TOKEN, deviceId: DEVICE_ID },
      bob: { userId: BOB, token: BOB_ACCESS_TOKEN, deviceId: 'BOBDEVICE' },
    };

    await page.route('**/api/login', async (route) => {
      const body = route.request().postDataJSON() ?? {};
      this.requests.push({ method: 'POST', path: '/api/login', query: new URLSearchParams(), body });
      const user = String(body.user ?? '').trim();
      const account = accounts[localpart(user)];
      const reply = (status: number, json: Json) =>
        route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(json) }).catch(() => {});

      if (!user || !body.password) return reply(400, { success: false, message: 'Username and password are required' });
      if (!account || body.password !== PASSWORD) {
        return reply(403, { success: false, message: 'Invalid username or password' });
      }
      this.acceptedTokens.add(account.token);
      return reply(200, {
        success: true,
        accessToken: account.token,
        userId: account.userId,
        deviceId: body.deviceId ?? account.deviceId,
        /* The real route reports the homeserver base URL it signed in against */
        baseUrl: HS_URL,
      });
    });

    await page.route('**/api/logout', async (route) => {
      this.requests.push({ method: 'POST', path: '/api/logout', query: new URLSearchParams(), body: route.request().postDataJSON() ?? {} });
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true }) }).catch(() => {});
    });
  }

  close(): void {
    this.closed = true;
    this.wake();
  }

  /* ── Test-facing setup ─────────────────────────────────────────── */

  setDisplayName(userId: string, name: string): void {
    this.displayNames.set(userId, name);
  }

  /* Advances the server clock, so events added afterwards carry later timestamps */
  advanceClock(ms: number): void {
    this.clock += ms;
  }

  setClock(ts: number): void {
    this.clock = ts;
  }

  addRoom(opts: RoomOptions = {}): string {
    const roomId = `!room${++this.roomCounter}:${SERVER_NAME}`;
    const room = new FakeRoom(roomId, opts.roomVersion ?? '10');
    this.rooms.set(roomId, room);

    const creator = ME;
    const members = opts.members ?? [];
    this.append(room, this.stateEv('m.room.create', creator, '', { creator, room_version: room.roomVersion, ...(opts.creationContent ?? {}) }));
    this.append(room, this.memberEv(creator, creator, 'join'));
    this.append(
      room,
      this.stateEv('m.room.power_levels', creator, '', opts.powerLevels ?? this.defaultPowerLevels(creator))
    );
    this.append(room, this.stateEv('m.room.join_rules', creator, '', { join_rule: opts.isPublic ? 'public' : 'invite' }));
    this.append(room, this.stateEv('m.room.history_visibility', creator, '', { history_visibility: 'shared' }));
    if (opts.name) this.append(room, this.stateEv('m.room.name', creator, '', { name: opts.name }));
    if (opts.encrypted) {
      this.append(room, this.stateEv('m.room.encryption', creator, '', { algorithm: 'm.megolm.v1.aes-sha2' }));
    }
    for (const member of members) this.append(room, this.memberEv(member, member, 'join'));
    if (opts.alias) this.aliases.set(opts.alias, roomId);
    if (opts.publishToDirectory) this.directory.add(roomId);
    this.wake();
    return roomId;
  }

  /* A room the user is not in yet, reachable by alias or ID and optionally listed in the public directory */
  addRemoteRoom(opts: RoomOptions & { creator?: string } = {}): string {
    const roomId = `!remote${++this.roomCounter}:${SERVER_NAME}`;
    const room = new FakeRoom(roomId, opts.roomVersion ?? '10');
    this.rooms.set(roomId, room);
    const creator = opts.creator ?? BOB;
    this.append(room, this.stateEv('m.room.create', creator, '', { creator, room_version: room.roomVersion, ...(opts.creationContent ?? {}) }));
    this.append(room, this.memberEv(creator, creator, 'join'));
    this.append(room, this.stateEv('m.room.power_levels', creator, '', this.defaultPowerLevels(creator)));
    this.append(room, this.stateEv('m.room.join_rules', creator, '', { join_rule: opts.isPublic === false ? 'invite' : 'public' }));
    this.append(room, this.stateEv('m.room.history_visibility', creator, '', { history_visibility: 'shared' }));
    if (opts.name) this.append(room, this.stateEv('m.room.name', creator, '', { name: opts.name }));
    if (opts.encrypted) {
      this.append(room, this.stateEv('m.room.encryption', creator, '', { algorithm: 'm.megolm.v1.aes-sha2' }));
    }
    for (const member of opts.members ?? []) this.append(room, this.memberEv(member, member, 'join'));
    if (opts.alias) this.aliases.set(opts.alias, roomId);
    if (opts.publishToDirectory) this.directory.add(roomId);
    this.wake();
    return roomId;
  }

  /* Another user invites Alice into a fresh room, which arrives through the sync stream like a real invite */
  inviteMe(opts: { from: string; name?: string; encrypted?: boolean }): string {
    const roomId = this.addRemoteRoom({ creator: opts.from, name: opts.name, encrypted: opts.encrypted, isPublic: false });
    this.append(this.rooms.get(roomId)!, this.memberEv(opts.from, ME, 'invite'));
    this.wake();
    return roomId;
  }

  /* Another member posts into a room, delivered to Alice on the next sync */
  say(roomId: string, sender: string, body: string, extra: Json = {}): string {
    return this.post(roomId, sender, 'm.room.message', { msgtype: 'm.text', body, ...extra });
  }

  post(roomId: string, sender: string, type: string, content: Json, unsigned?: Json): string {
    const ev = this.ev(type, sender, content);
    if (unsigned) ev.unsigned = { ...(ev.unsigned ?? {}), ...unsigned };
    this.append(this.room(roomId), ev);
    this.wake();
    return ev.event_id;
  }

  setState(roomId: string, sender: string, type: string, stateKey: string, content: Json): string {
    const ev = this.stateEv(type, sender, stateKey, content);
    this.append(this.room(roomId), ev);
    this.wake();
    return ev.event_id;
  }

  join(roomId: string, userId: string): void {
    this.append(this.room(roomId), this.memberEv(userId, userId, 'join'));
    this.wake();
  }

  /* Another member deletes an event, which strips the stored copy the way a server does and delivers the redaction */
  redact(roomId: string, sender: string, eventId: string): string {
    const ev = this.applyRedaction(this.room(roomId), sender, eventId);
    this.wake();
    return ev.event_id;
  }

  /* Stores media as another user's upload would, returning the mxc URI an event can point at */
  uploadMedia(body: Buffer, contentType: string): string {
    const id = `media${++this.mediaCounter}`;
    this.media.set(id, { body, contentType });
    return `mxc://${SERVER_NAME}/${id}`;
  }

  /* Publishes a device of another user with real curve25519 and ed25519 keys and a valid self-signature, so the Rust crypto machine accepts it as an unverified device */
  addDevice(userId: string, deviceId: string): void {
    this.otherDeviceKeys.set(userId, { ...(this.otherDeviceKeys.get(userId) ?? {}), [deviceId]: signedDeviceKeys(userId, deviceId) });
    this.wake();
  }

  /* A key backup made earlier on another device, which holds room keys this browser has never seen */
  addKeyBackup(): string {
    const version = String(++this.backupCounter);
    this.backupVersion = {
      algorithm: 'm.megolm_backup.v1.curve25519-aes-sha2',
      auth_data: { public_key: 'hSDwCYkwp1R0i33ctD73Wg2/Og0mOBr066SpjqqbTmo', signatures: {} },
      version,
      count: 42,
      etag: '1',
    };
    return version;
  }

  /* Makes the next matching requests fail with a Matrix error, to exercise the app's error handling */
  failNext(path: RegExp, status: number, body: Json, opts: { method?: string; times?: number } = {}): void {
    this.faults.push({ path, status, body, method: opts.method, times: opts.times ?? 1 });
  }

  delay(path: RegExp, ms: number): void {
    this.delays.push({ path, ms });
  }

  /* Signs every session out on the server side, as if the devices were removed from another client */
  revokeAccessToken(): void {
    this.acceptedTokens.clear();
    /* Refresh tokens die with their sessions, so a revoked session cannot be refreshed back to life */
    this.refreshTokens?.valid.clear();
    this.wake();
  }

  /* Issues expiring access tokens from now on and returns a refresh token for the seeded session, whose access token expires after the same lifetime */
  enableRefreshTokens(opts: { accessTokenLifetimeMs: number; rotateRefreshTokens?: boolean }): string {
    const refreshToken = 'alice-refresh-token-0';
    this.refreshTokens = {
      lifetimeMs: opts.accessTokenLifetimeMs,
      rotate: opts.rotateRefreshTokens ?? true,
      valid: new Set([refreshToken]),
      expiry: new Map([[ACCESS_TOKEN, Date.now() + opts.accessTokenLifetimeMs]]),
      counter: 0,
    };
    return refreshToken;
  }

  /* Makes every homeserver request fail as a network error until called again with true */
  setReachable(reachable: boolean): void {
    this.reachable = reachable;
    this.wake();
  }

  /* Adds another device of the signed-in user with properly signed keys; call it before the app starts so its first key query sees it */
  addOwnDevice(deviceId: string): void {
    this.ownDevices.set(deviceId, signedDeviceKeys(ME, deviceId));
  }

  /* Delivers a to-device message to this session in the next sync, as another device of `sender` sending it would */
  sendToDevice(sender: string, type: string, content: Json): void {
    this.toDeviceMessages.push({ event: { sender, type, content }, pos: ++this.pos });
    this.wake();
  }

  /* True while the server would still accept this access token */
  acceptsAccessToken(token: string): boolean {
    const expiresAt = this.refreshTokens?.expiry.get(token);
    return this.acceptedTokens.has(token) && (expiresAt === undefined || expiresAt > Date.now());
  }

  /* Deletes the server's key backup, as another client resetting or turning off backup would */
  removeKeyBackup(): void {
    this.backupVersion = null;
  }

  /* Expires every access token issued so far while refresh tokens stay valid, as when a short-lived access token runs out */
  expireAccessTokens(): void {
    this.acceptedTokens.clear();
  }

  /* The key backup the server holds, or null when there is none */
  currentKeyBackup(): Json | null {
    return this.backupVersion;
  }

  /* ── Test-facing inspection ─────────────────────────────────────── */

  requestsTo(path: RegExp, method?: string): RecordedRequest[] {
    return this.requests.filter((r) => path.test(r.path) && (!method || r.method === method));
  }

  /* Events the app sent to a room, in the order the server received them */
  sentEvents(roomId?: string, type?: string): MatrixEvent[] {
    return [...this.rooms.values()]
      .filter((room) => !roomId || room.roomId === roomId)
      .flatMap((room) => room.events.map((s) => ({ ...s.event, room_id: room.roomId })))
      .filter((ev) => this.sentByApp.has(ev.event_id) && (!type || ev.type === type));
  }

  roomState(roomId: string, type: string, stateKey = ''): Json | undefined {
    return this.room(roomId).stateEvent(type, stateKey)?.content;
  }

  membership(roomId: string, userId: string): string | undefined {
    return this.room(roomId).membership(userId);
  }

  roomIdByName(name: string): string | undefined {
    return [...this.rooms.values()].find((r) => r.name === name)?.roomId;
  }

  eventById(roomId: string, eventId: string): MatrixEvent | undefined {
    return this.room(roomId).events.find((s) => s.event.event_id === eventId)?.event;
  }

  uploadedMedia(): { body: Buffer; contentType: string }[] {
    return [...this.media.values()];
  }

  /* ── Internals ─────────────────────────────────────────────────── */

  private room(roomId: string): FakeRoom {
    const room = this.rooms.get(roomId);
    if (!room) throw new Error(`Unknown room ${roomId}`);
    return room;
  }

  private defaultPowerLevels(creator: string): Json {
    return {
      users: { [creator]: 100 },
      users_default: 0,
      events: {},
      events_default: 0,
      state_default: 50,
      ban: 50,
      kick: 50,
      redact: 50,
      invite: 0,
    };
  }

  private nextTs(): number {
    this.clock += 1000;
    return this.clock;
  }

  private ev(type: string, sender: string, content: Json): MatrixEvent {
    return { event_id: `$ev${++this.eventCounter}`, type, sender, origin_server_ts: this.nextTs(), content };
  }

  private stateEv(type: string, sender: string, stateKey: string, content: Json): MatrixEvent {
    return { ...this.ev(type, sender, content), state_key: stateKey };
  }

  private memberEv(sender: string, target: string, membership: string, reason?: string): MatrixEvent {
    const content: Json = { membership, displayname: this.displayNames.get(target) ?? localpart(target) };
    if (reason) content.reason = reason;
    return this.stateEv('m.room.member', sender, target, content);
  }

  private append(room: FakeRoom, event: MatrixEvent): void {
    room.events.push({ event, pos: ++this.pos });
  }

  /* Strips the target's content and records the redaction on it, so later syncs and history pages serve the redacted copy */
  private applyRedaction(room: FakeRoom, sender: string, targetId: string, body: Json = {}, txnId?: string): MatrixEvent {
    const target = room.events.find((s) => s.event.event_id === targetId)?.event;
    const ev = this.ev('m.room.redaction', sender, { ...body, redacts: targetId });
    ev.redacts = targetId;
    if (txnId) ev.unsigned = { transaction_id: txnId };
    if (target) {
      target.content = {};
      target.unsigned = { ...(target.unsigned ?? {}), redacted_because: ev };
    }
    this.append(room, ev);
    return ev;
  }

  private wake(): void {
    const waiters = this.waiters;
    this.waiters = [];
    waiters.forEach((w) => w());
  }

  private async handle(route: Route): Promise<void> {
    const request = route.request();
    const url = new URL(request.url());
    const recorded: RecordedRequest = {
      method: request.method(),
      path: decodeURIComponent(url.pathname),
      query: url.searchParams,
      body: this.parseBody(request),
    };
    this.requests.push(recorded);

    const respond = (status: number, body: Json | Buffer, contentType = 'application/json') =>
      route
        .fulfill({
          status,
          contentType,
          headers: { 'access-control-allow-origin': '*' },
          body: Buffer.isBuffer(body) ? body : JSON.stringify(body),
        })
        .catch(() => {});

    if (request.method() === 'OPTIONS') return respond(204, {});

    if (!this.reachable) return route.abort('connectionrefused').catch(() => {});

    const delay = this.delays.find((d) => d.path.test(recorded.path));
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay.ms));

    const fault = this.faults.find((f) => f.path.test(recorded.path) && (!f.method || f.method === recorded.method));
    if (fault) {
      fault.times -= 1;
      if (fault.times <= 0) this.faults.splice(this.faults.indexOf(fault), 1);
      return respond(fault.status, fault.body);
    }

    if (!this.isPublicEndpoint(recorded.path)) {
      const auth = request.headers()['authorization'] ?? '';
      const token = auth.replace(/^Bearer\s+/i, '') || url.searchParams.get('access_token') || '';
      if (!this.acceptedTokens.has(token)) {
        return respond(401, { errcode: 'M_UNKNOWN_TOKEN', error: 'Invalid access token passed.', soft_logout: false });
      }
      /* An expired access token is a soft logout, which the client fixes by refreshing */
      if (!this.acceptsAccessToken(token)) {
        return respond(401, { errcode: 'M_UNKNOWN_TOKEN', error: 'Access token has expired', soft_logout: true });
      }
    }

    try {
      const [status, body, contentType] = await this.dispatch(recorded, request);
      return respond(status, body, contentType);
    } catch (e) {
      return respond(500, { errcode: 'M_UNKNOWN', error: e instanceof Error ? e.message : String(e) });
    }
  }

  private parseBody(request: Request): Json | null {
    const raw = request.postDataBuffer();
    if (!raw?.length) return null;
    try {
      return JSON.parse(raw.toString('utf8'));
    } catch {
      return { __binary: raw };
    }
  }

  private isPublicEndpoint(path: string): boolean {
    if (this.refreshTokens && /\/v3\/refresh$/.test(path)) return true;
    return path === '/_matrix/client/versions' || path.endsWith('/login') || /\/_matrix\/media\/v3\/(download|thumbnail)\//.test(path);
  }

  /* The access token a request carries, from its Authorization header or the deprecated query parameter */
  private tokenOf(request: Request): string {
    const auth = request.headers()['authorization'] ?? '';
    return auth.replace(/^Bearer\s+/i, '') || new URL(request.url()).searchParams.get('access_token') || '';
  }

  /* Swaps a valid refresh token for a new access token, rotating the refresh token unless the spec asked the server not to */
  private refresh(body: Json): [number, Json] {
    const tokens = this.refreshTokens!;
    const used = String(body.refresh_token ?? '');
    if (!tokens.valid.has(used)) {
      return [401, { errcode: 'M_UNKNOWN_TOKEN', error: 'Unknown refresh token', soft_logout: false }];
    }
    const n = ++tokens.counter;
    const accessToken = `alice-access-token-${n}`;
    this.acceptedTokens.add(accessToken);
    tokens.expiry.set(accessToken, Date.now() + tokens.lifetimeMs);
    const res: Json = { access_token: accessToken, expires_in_ms: tokens.lifetimeMs };
    if (tokens.rotate) {
      const refreshToken = `alice-refresh-token-${n}`;
      tokens.valid.delete(used);
      tokens.valid.add(refreshToken);
      res.refresh_token = refreshToken;
    }
    return [200, res];
  }

  /* Maps each client-server API path the app uses onto the fake's state, answering anything else with the error a real server gives */
  private async dispatch(req: RecordedRequest, request: Request): Promise<[number, Json | Buffer, string?]> {
    const { method, path } = req;
    const body = req.body ?? {};
    const match = (re: RegExp) => path.match(re);
    let m: RegExpMatchArray | null;

    if (path === '/_matrix/client/versions') {
      return [200, { versions: ['v1.1', 'v1.2', 'v1.3', 'v1.4', 'v1.5', 'v1.6', 'v1.7', 'v1.8', 'v1.9', 'v1.10', 'v1.11'], unstable_features: {} }];
    }
    if (/\/v3\/capabilities$/.test(path)) {
      return [200, { capabilities: { 'm.room_versions': { default: '10', available: { '10': 'stable', '11': 'stable' } } } }];
    }
    if (/\/v3\/pushrules\/?$/.test(path)) {
      return [200, { global: { override: [], content: [], room: [], sender: [], underride: [] } }];
    }
    if ((m = match(/\/v3\/user\/[^/]+\/filter$/)) && method === 'POST') {
      const id = String(this.filters.size + 1);
      this.filters.set(id, body);
      return [200, { filter_id: id }];
    }
    if ((m = match(/\/v3\/user\/[^/]+\/filter\/([^/]+)$/))) {
      return this.filters.has(m[1]) ? [200, this.filters.get(m[1])!] : [404, { errcode: 'M_NOT_FOUND', error: 'No such filter' }];
    }
    if (/\/v3\/sync$/.test(path)) return [200, await this.sync(req)];
    if (/\/v3\/voip\/turnServer$/.test(path)) return [200, {}];
    if (/\/v3\/thirdparty\/protocols$/.test(path)) return [200, {}];
    /* Logging out revokes the calling token (or every token for /logout/all) and the session's refresh token, as a real server does */
    if ((m = match(/\/v3\/logout(\/all)?$/))) {
      if (m[1]) this.acceptedTokens.clear();
      else this.acceptedTokens.delete(this.tokenOf(request));
      this.refreshTokens?.valid.clear();
      this.wake();
      return [200, {}];
    }
    if (/\/v3\/refresh$/.test(path) && this.refreshTokens && method === 'POST') return this.refresh(body);
    if (/\/v3\/account\/whoami$/.test(path)) return [200, { user_id: ME, device_id: DEVICE_ID }];

    if ((m = match(/\/v3\/user\/([^/]+)\/account_data\/([^/]+)$/))) {
      const key = m[2];
      if (method === 'PUT') {
        this.accountData.set(key, { content: body, pos: ++this.pos });
        this.wake();
        return [200, {}];
      }
      const stored = this.accountData.get(key);
      return stored ? [200, stored.content] : [404, { errcode: 'M_NOT_FOUND', error: 'Account data not found' }];
    }
    if ((m = match(/\/v3\/user\/[^/]+\/rooms\/[^/]+\/account_data\/[^/]+$/))) return [200, {}];

    if ((m = match(/\/v3\/profile\/([^/]+)(\/(displayname|avatar_url))?$/))) {
      const name = this.displayNames.get(m[1]) ?? localpart(m[1]);
      if (m[3] === 'avatar_url') return [404, { errcode: 'M_NOT_FOUND', error: 'No avatar' }];
      return [200, { displayname: name }];
    }

    /* End-to-end encryption plumbing, enough for the Rust crypto machine to upload its keys and find its own device */
    if (/\/v3\/keys\/upload$/.test(path)) {
      if (body.device_keys) this.deviceKeys = body.device_keys;
      this.oneTimeKeyCount += Object.keys(body.one_time_keys ?? {}).length;
      return [200, { one_time_key_counts: { signed_curve25519: this.oneTimeKeyCount } }];
    }
    if (/\/v3\/keys\/query$/.test(path)) {
      const deviceKeys: Json = {};
      for (const userId of Object.keys(body.device_keys ?? {})) {
        const own = userId === ME
          ? { ...(this.deviceKeys ? { [this.deviceKeys.device_id]: this.deviceKeys } : {}), ...Object.fromEntries(this.ownDevices) }
          : {};
        deviceKeys[userId] = { ...(this.otherDeviceKeys.get(userId) ?? {}), ...own };
      }
      return [200, { device_keys: deviceKeys, failures: {}, master_keys: {}, self_signing_keys: {}, user_signing_keys: {} }];
    }
    if (/\/v3\/keys\/claim$/.test(path)) return [200, { one_time_keys: {}, failures: {} }];
    if (/\/v3\/keys\/changes$/.test(path)) return [200, { changed: [], left: [] }];
    if (/\/v3\/keys\/signatures\/upload$/.test(path)) return [200, { failures: {} }];
    if (/\/v3\/keys\/device_signing\/upload$/.test(path)) return [200, {}];
    if (/\/v3\/sendToDevice\//.test(path)) return [200, {}];

    if (/\/v3\/room_keys\/version$/.test(path)) {
      if (method === 'POST') {
        const version = String(++this.backupCounter);
        this.backupVersion = { ...body, version, count: 0, etag: '0' };
        return [200, { version }];
      }
      return this.backupVersion ? [200, this.backupVersion] : [404, { errcode: 'M_NOT_FOUND', error: 'No current backup version' }];
    }
    if ((m = match(/\/v3\/room_keys\/version\/([^/]+)$/))) {
      const known = this.backupVersion?.version === m[1];
      if (method === 'DELETE') {
        if (known) this.backupVersion = null;
        return known ? [200, {}] : [404, { errcode: 'M_NOT_FOUND', error: 'Unknown backup version' }];
      }
      return known ? [200, this.backupVersion!] : [404, { errcode: 'M_NOT_FOUND', error: 'Unknown backup version' }];
    }
    if (/\/v3\/room_keys\/keys/.test(path)) {
      return method === 'GET' ? [200, { rooms: {} }] : [200, { etag: '1', count: 0 }];
    }

    if (/\/v3\/createRoom$/.test(path)) return [200, this.createRoom(body)];
    if ((m = match(/\/v3\/(?:join|rooms)\/([^/]+?)(?:\/join)?$/)) && method === 'POST' && /\/join/.test(path)) {
      return this.joinRoom(m[1]);
    }
    /* Publishing a room to the directory, which is what publicRooms lists, and reading that setting back */
    if ((m = match(/\/v3\/directory\/list\/room\/([^/]+)$/))) {
      if (!this.rooms.has(m[1])) return [404, { errcode: 'M_NOT_FOUND', error: 'Unknown room' }];
      if (method === 'PUT') {
        if (body.visibility === 'public') this.directory.add(m[1]);
        else this.directory.delete(m[1]);
        return [200, {}];
      }
      return [200, { visibility: this.directory.has(m[1]) ? 'public' : 'private' }];
    }
    if ((m = match(/\/v3\/directory\/room\/(.+)$/))) {
      const roomId = this.aliases.get(m[1]);
      return roomId ? [200, { room_id: roomId, servers: [SERVER_NAME] }] : [404, { errcode: 'M_NOT_FOUND', error: 'Room alias not found' }];
    }
    if (/\/v3\/publicRooms$/.test(path)) {
      const term = String(body?.filter?.generic_search_term ?? req.query.get('generic_search_term') ?? '').toLowerCase();
      const chunk = [...this.directory]
        .map((roomId) => this.room(roomId))
        .filter((room) => !term || (room.name ?? '').toLowerCase().includes(term))
        .map((room) => ({
          room_id: room.roomId,
          name: room.name,
          num_joined_members: [...room.stateAt().values()].filter((e) => e.type === 'm.room.member' && e.content.membership === 'join').length,
          world_readable: false,
          guest_can_join: false,
          join_rule: room.stateEvent('m.room.join_rules')?.content.join_rule,
        }));
      return [200, { chunk, total_room_count_estimate: chunk.length }];
    }

    if ((m = match(/\/v3\/rooms\/([^/]+)\/(.+)$/))) {
      const roomId = m[1];
      const rest = m[2];
      if (!this.rooms.has(roomId)) return [404, { errcode: 'M_NOT_FOUND', error: 'Unknown room' }];
      return this.roomRequest(this.room(roomId), rest, method, body, req);
    }

    /* Media: uploads keep the bytes so a later download, or a spec, can read them back */
    if (/\/_matrix\/media\/v3\/upload$/.test(path) || /\/_matrix\/client\/v1\/media\/upload$/.test(path)) {
      const id = `media${++this.mediaCounter}`;
      const buffer = request.postDataBuffer() ?? Buffer.alloc(0);
      this.media.set(id, { body: buffer, contentType: request.headers()['content-type'] ?? 'application/octet-stream' });
      return [200, { content_uri: `mxc://${SERVER_NAME}/${id}` }];
    }
    if (/\/media\/(v3|v1)\/config$/.test(path)) return [200, { 'm.upload.size': 50 * 1024 * 1024 }];
    /* Both the legacy /_matrix/media/v3 path and the authenticated /_matrix/client/v1/media path serve a stored upload */
    if ((m = match(/\/(?:media\/v3|client\/v1\/media)\/(?:download|thumbnail)\/[^/]+\/([^/]+)/))) {
      const stored = this.media.get(m[1]);
      return stored ? [200, stored.body, stored.contentType] : [404, { errcode: 'M_NOT_FOUND', error: 'Not found' }];
    }

    return [404, { errcode: 'M_UNRECOGNIZED', error: `Unrecognized request: ${method} ${path}` }];
  }

  private roomRequest(room: FakeRoom, rest: string, method: string, body: Json, req: RecordedRequest): [number, Json] {
    let m: RegExpMatchArray | null;

    if ((m = rest.match(/^send\/([^/]+)\/([^/]+)$/))) {
      const ev = this.ev(m[1], ME, body);
      ev.unsigned = { transaction_id: m[2] };
      this.sentByApp.add(ev.event_id);
      this.append(room, ev);
      this.wake();
      return [200, { event_id: ev.event_id }];
    }
    if ((m = rest.match(/^state\/([^/]+)(?:\/(.*))?$/))) {
      const type = m[1];
      const stateKey = m[2] ?? '';
      if (method === 'GET') {
        const ev = room.stateEvent(type, stateKey);
        return ev ? [200, ev.content] : [404, { errcode: 'M_NOT_FOUND', error: 'Event not found' }];
      }
      const ev = this.stateEv(type, ME, stateKey, body);
      this.sentByApp.add(ev.event_id);
      this.append(room, ev);
      this.wake();
      return [200, { event_id: ev.event_id }];
    }
    if (rest === 'state') return [200, [...room.stateAt().values()] as unknown as Json];
    if ((m = rest.match(/^redact\/([^/]+)\/([^/]+)$/))) {
      const ev = this.applyRedaction(room, ME, m[1], body, m[2]);
      this.sentByApp.add(ev.event_id);
      this.wake();
      return [200, { event_id: ev.event_id }];
    }
    if (rest === 'leave' || rest === 'forget') {
      if (rest === 'leave') {
        this.append(room, this.memberEv(ME, ME, 'leave'));
        this.wake();
      }
      return [200, {}];
    }
    if (rest === 'invite') {
      this.append(room, this.memberEv(ME, body.user_id, 'invite'));
      this.wake();
      return [200, {}];
    }
    if (rest === 'kick' || rest === 'ban') {
      this.append(room, this.memberEv(ME, body.user_id, rest === 'kick' ? 'leave' : 'ban', body.reason));
      this.wake();
      return [200, {}];
    }
    if (rest === 'members') {
      const chunk = [...room.stateAt().values()].filter((e) => e.type === 'm.room.member');
      return [200, { chunk }];
    }
    if (rest === 'joined_members') {
      const joined: Json = {};
      for (const e of room.stateAt().values()) {
        if (e.type === 'm.room.member' && e.content.membership === 'join') joined[e.state_key!] = { display_name: e.content.displayname };
      }
      return [200, { joined }];
    }
    if (rest === 'messages') return [200, this.messages(room, req)];
    if (/^(receipt|read_markers|typing)/.test(rest)) return [200, {}];
    if ((m = rest.match(/^event\/(.+)$/))) {
      const ev = room.events.find((s) => s.event.event_id === m![1])?.event;
      return ev ? [200, { ...ev, room_id: room.roomId }] : [404, { errcode: 'M_NOT_FOUND', error: 'Event not found' }];
    }
    if (/^(relations|context|threads)/.test(rest)) return [200, { chunk: [] }];
    return [404, { errcode: 'M_UNRECOGNIZED', error: `Unrecognized room request: ${method} ${rest}` }];
  }

  private createRoom(body: Json): Json {
    const roomId = `!room${++this.roomCounter}:${SERVER_NAME}`;
    const room = new FakeRoom(roomId, body.room_version ?? '10');
    this.rooms.set(roomId, room);
    const preset = body.preset ?? (body.visibility === 'public' ? 'public_chat' : 'private_chat');

    this.append(room, this.stateEv('m.room.create', ME, '', { creator: ME, room_version: room.roomVersion, ...(body.creation_content ?? {}) }));
    this.append(room, this.memberEv(ME, ME, 'join'));
    this.append(room, this.stateEv('m.room.power_levels', ME, '', { ...this.defaultPowerLevels(ME), ...(body.power_level_content_override ?? {}) }));
    this.append(room, this.stateEv('m.room.join_rules', ME, '', { join_rule: preset === 'public_chat' ? 'public' : 'invite' }));
    this.append(room, this.stateEv('m.room.history_visibility', ME, '', { history_visibility: 'shared' }));
    if (body.name) this.append(room, this.stateEv('m.room.name', ME, '', { name: body.name }));
    if (body.topic) this.append(room, this.stateEv('m.room.topic', ME, '', { topic: body.topic }));
    for (const s of body.initial_state ?? []) this.append(room, this.stateEv(s.type, ME, s.state_key ?? '', s.content));
    for (const invitee of body.invite ?? []) this.append(room, this.memberEv(ME, invitee, 'invite'));
    if (body.room_alias_name) this.aliases.set(`#${body.room_alias_name}:${SERVER_NAME}`, roomId);
    if (body.visibility === 'public') this.directory.add(roomId);
    this.wake();
    return { room_id: roomId };
  }

  private joinRoom(idOrAlias: string): [number, Json] {
    const roomId = idOrAlias.startsWith('#') ? this.aliases.get(idOrAlias) : idOrAlias;
    const room = roomId ? this.rooms.get(roomId) : undefined;
    if (!room) return [404, { errcode: 'M_NOT_FOUND', error: 'No known servers' }];
    const joinRule = room.stateEvent('m.room.join_rules')?.content.join_rule;
    const invited = room.membership(ME) === 'invite';
    if (joinRule !== 'public' && !invited) return [403, { errcode: 'M_FORBIDDEN', error: 'You are not invited to this room.' }];
    this.append(room, this.memberEv(ME, ME, 'join'));
    this.wake();
    return [200, { room_id: room.roomId }];
  }

  /* Pagination tokens name an index into the room's event list, so older history can be served in pages */
  private messages(room: FakeRoom, req: RecordedRequest): Json {
    const from = req.query.get('from');
    const limit = Number(req.query.get('limit') ?? 20);
    const dir = req.query.get('dir') ?? 'b';
    const index = from && from.startsWith('t') ? Number(from.slice(1)) : room.events.length;
    if (dir !== 'b') return { chunk: [], start: from ?? `t${index}` };

    const startIndex = Math.max(0, index - limit);
    const chunk = room.events.slice(startIndex, index).reverse().map((s) => ({ ...s.event, room_id: room.roomId }));
    const res: Json = { chunk, start: `t${index}` };
    if (startIndex > 0) res.end = `t${startIndex}`;
    return res;
  }

  private waitForChange(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      this.waiters.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  private timelineLimitFor(req: RecordedRequest): number {
    const filterParam = req.query.get('filter');
    let filter: Json | undefined;
    if (filterParam?.startsWith('{')) {
      try { filter = JSON.parse(filterParam); } catch { filter = undefined; }
    } else if (filterParam) {
      filter = this.filters.get(filterParam);
    }
    return Number(filter?.room?.timeline?.limit ?? this.timelineLimit);
  }

  private async sync(req: RecordedRequest): Promise<Json> {
    const since = req.query.get('since');
    const sincePos = since ? Number(since.slice(1)) : -1;
    const timeout = Number(req.query.get('timeout') ?? 0);

    if (since && this.pos <= sincePos && timeout > 0 && !this.closed) {
      await this.waitForChange(Math.min(timeout, this.syncHoldMs));
    }

    const limit = this.timelineLimitFor(req);
    const join: Json = {};
    const invite: Json = {};
    const leave: Json = {};

    for (const room of this.rooms.values()) {
      const membership = room.membership(ME);
      const changedAt = room.membershipPos(ME);

      if (membership === 'join') {
        const fresh = sincePos < 0 || changedAt > sincePos;
        const newEvents = room.events.filter((s) => s.pos > sincePos);
        if (!fresh && !newEvents.length) continue;

        if (fresh) {
          const startIndex = Math.max(0, room.events.length - limit);
          join[room.roomId] = {
            state: { events: [...room.stateAt(startIndex).values()] },
            timeline: {
              events: room.events.slice(startIndex).map((s) => s.event),
              limited: startIndex > 0,
              prev_batch: `t${startIndex}`,
            },
            ephemeral: { events: [] },
            account_data: { events: [] },
            unread_notifications: { notification_count: 0, highlight_count: 0 },
          };
        } else {
          /* More new events than the timeline limit makes a gappy sync that carries only the newest ones, as after a long sleep */
          const firstNew = room.events.findIndex((s) => s.pos > sincePos);
          const startIndex = Math.max(firstNew, room.events.length - limit);
          const limited = startIndex > firstNew;
          join[room.roomId] = {
            state: { events: limited ? [...room.stateAt(startIndex).values()] : [] },
            timeline: { events: room.events.slice(startIndex).map((s) => s.event), limited, prev_batch: `t${startIndex}` },
            ephemeral: { events: [] },
            account_data: { events: [] },
            unread_notifications: { notification_count: 0, highlight_count: 0 },
          };
        }
      } else if (membership === 'invite' && changedAt > sincePos) {
        const stripped = ['m.room.create', 'm.room.name', 'm.room.join_rules', 'm.room.encryption']
          .map((type) => room.stateEvent(type))
          .filter((e): e is MatrixEvent => !!e)
          .map(({ type, sender, state_key, content }) => ({ type, sender, state_key, content }));
        const inviteEvent = room.stateEvent('m.room.member', ME)!;
        const inviterEvent = room.stateEvent('m.room.member', inviteEvent.sender);
        const strippedMembers = [inviteEvent, inviterEvent]
          .filter((e): e is MatrixEvent => !!e)
          .map(({ type, sender, state_key, content }) => ({ type, sender, state_key, content }));
        invite[room.roomId] = { invite_state: { events: [...stripped, ...strippedMembers] } };
      } else if ((membership === 'leave' || membership === 'ban') && sincePos >= 0 && changedAt > sincePos) {
        const leaveEvent = room.stateEvent('m.room.member', ME)!;
        leave[room.roomId] = { state: { events: [] }, timeline: { events: [leaveEvent], limited: false } };
      }
    }

    const accountData = [...this.accountData.entries()]
      .filter(([, v]) => v.pos > sincePos)
      .map(([type, v]) => ({ type, content: v.content }));

    return {
      next_batch: `s${this.pos}`,
      rooms: { join, invite, leave },
      account_data: { events: accountData },
      presence: { events: [] },
      to_device: { events: this.toDeviceMessages.filter((m) => m.pos > sincePos).map((m) => m.event) },
      device_lists: { changed: [], left: [] },
      device_one_time_keys_count: { signed_curve25519: this.oneTimeKeyCount },
    };
  }
}