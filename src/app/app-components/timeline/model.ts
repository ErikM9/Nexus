import { EventStatus, EventType, MsgType, RelationType, type IEventRelation, type MatrixEvent } from 'matrix-js-sdk';

export type SendState = 'sent' | 'sending' | 'failed';

export type MessageKind = 'text' | 'image' | 'file' | 'audio' | 'video';

export interface EncryptedFileInfo {
  url: string;
  key: JsonWebKey;
  iv: string;
  hashes: { sha256: string };
  v?: string;
}

export interface TimelineMessage {
  /* Stable across the local echo being replaced by the server's copy, so React keeps the same row */
  key: string;
  eventId: string;
  /* False while the event only has the SDK's temporary local ID, which nothing may relate to or redact yet */
  hasServerId: boolean;
  sender: string;
  timestamp: number;
  sendState: SendState;
  encrypted: boolean;
  decryptionFailure: boolean;
  deleted: boolean;
  edited: boolean;
  /* True for text, notice and emote messages, the only ones an edit may replace */
  textual: boolean;
  kind: MessageKind;
  msgtype: string;
  body: string;
  filename?: string;
  mimetype?: string;
  size?: number;
  mxcUrl?: string;
  encryptedFile?: EncryptedFileInfo;
  replyToEventId?: string;
  replyToSender?: string;
  replyToBody?: string;
  threadRootId?: string;
  event: MatrixEvent;
}

export interface ReactionGroup {
  key: string;
  count: number;
  /* The signed-in user's own reaction event for this key, which is what removing the reaction redacts */
  mine?: MatrixEvent;
}

export interface TimelineView {
  messages: TimelineMessage[];
  threads: Record<string, TimelineMessage[]>;
  reactions: Record<string, ReactionGroup[]>;
}

/* Relations seen on events before they were redacted, because redaction strips m.relates_to and a deleted thread reply or edit would otherwise lose its place */
export type RelationMemory = Map<string, { relType: string; targetId: string }>;

export const EMPTY_VIEW: TimelineView = { messages: [], threads: {}, reactions: {} };

export const DELETED_BODY = 'Message deleted.';
export const UNDECRYPTABLE_BODY = '🔒 Unable to decrypt';

const TEXTUAL_MSGTYPES: ReadonlySet<string> = new Set([MsgType.Text, MsgType.Notice, MsgType.Emote]);

/* Relation types whose events are never messages of their own, even when their content cannot be decrypted */
const NON_MESSAGE_RELATIONS: ReadonlySet<string> = new Set([RelationType.Replace, RelationType.Annotation, RelationType.Reference]);

/* Maps the SDK's send status explicitly, because MatrixEvent.isSending() is true for every status including a failed or cancelled send */
export const sendStateOf = (event: MatrixEvent): SendState | 'cancelled' => {
  switch (event.status) {
    case EventStatus.ENCRYPTING:
    case EventStatus.QUEUED:
    case EventStatus.SENDING:
      return 'sending';
    case EventStatus.NOT_SENT:
      return 'failed';
    case EventStatus.CANCELLED:
      return 'cancelled';
    default:
      return 'sent';
  }
};

export const hasServerEventId = (eventId: string): boolean => !eventId.startsWith('~');

/* The text a reply shows for the message it quotes, which never repeats deleted or undecryptable content */
export const quoteText = (message: TimelineMessage): string =>
  message.deleted ? '(deleted)' : message.decryptionFailure ? '(encrypted)' : message.body;

const isEncryptedFileInfo = (value: unknown): value is EncryptedFileInfo => {
  const file = value as Partial<EncryptedFileInfo> | null;
  return (
    typeof file === 'object' &&
    file !== null &&
    typeof file.url === 'string' &&
    typeof file.iv === 'string' &&
    typeof file.key === 'object' &&
    typeof file.hashes?.sha256 === 'string'
  );
};

const kindOf = (msgtype: string, mimetype?: string): MessageKind => {
  switch (msgtype) {
    case MsgType.Image:
      return 'image';
    case MsgType.File:
      return mimetype?.startsWith('image/') ? 'image' : 'file';
    case MsgType.Audio:
      return 'audio';
    case MsgType.Video:
      return 'video';
    default:
      return 'text';
  }
};

/* Uses the transaction ID for the SDK's local echo and the server's copy of our own event alike, so both map to one row */
const keyOf = (event: MatrixEvent, eventId: string): string => {
  const txnId = event.getTxnId() ?? event.getUnsigned().transaction_id;
  return typeof txnId === 'string' && txnId ? txnId : eventId;
};

interface MessageContext {
  eventId: string;
  sendState: SendState;
  relation: IEventRelation | null;
  deleted: boolean;
  memory: RelationMemory;
}

const toMessage = (event: MatrixEvent, ctx: MessageContext): TimelineMessage | null => {
  const { eventId, sendState, relation, deleted, memory } = ctx;
  const type = event.getType();
  const base = {
    key: keyOf(event, eventId),
    eventId,
    hasServerId: hasServerEventId(eventId),
    sender: event.getSender() ?? 'Unknown',
    timestamp: event.getTs(),
    sendState,
    event,
  };

  if (deleted) {
    if (type !== EventType.RoomMessage && event.getWireType() !== EventType.RoomMessageEncrypted) return null;
    const remembered = relation?.rel_type && relation.event_id ? { relType: relation.rel_type, targetId: relation.event_id } : memory.get(eventId);
    if (remembered && NON_MESSAGE_RELATIONS.has(remembered.relType)) return null;
    return {
      ...base,
      encrypted: false,
      decryptionFailure: false,
      deleted: true,
      edited: false,
      textual: false,
      kind: 'text',
      msgtype: '',
      body: DELETED_BODY,
      threadRootId: remembered?.relType === RelationType.Thread ? remembered.targetId : undefined,
    };
  }

  /* Events still being decrypted report the m.room.encrypted type and wait for Event.decrypted, and other event types are not messages */
  if (type !== EventType.RoomMessage) return null;

  const decryptionFailure = event.isDecryptionFailure();
  if (relation?.rel_type === RelationType.Replace || relation?.rel_type === RelationType.Annotation) return null;
  if (decryptionFailure && relation?.rel_type && NON_MESSAGE_RELATIONS.has(relation.rel_type)) return null;

  const threadRootId = relation?.rel_type === RelationType.Thread ? relation.event_id : undefined;
  /* A thread reply's m.in_reply_to is only a fallback for clients without threads unless is_falling_back is false */
  const replyToEventId = threadRootId && relation?.is_falling_back === true ? undefined : event.replyEventId;

  if (decryptionFailure) {
    return {
      ...base,
      encrypted: true,
      decryptionFailure: true,
      deleted: false,
      edited: false,
      textual: false,
      kind: 'text',
      msgtype: 'm.bad.encrypted',
      body: UNDECRYPTABLE_BODY,
      replyToEventId,
      threadRootId,
    };
  }

  /* getContent() already carries the latest edit the SDK accepted, which it only takes from the original sender and never for a redacted event */
  const content = event.getContent();
  const msgtype = typeof content.msgtype === 'string' ? content.msgtype : '';
  const info = typeof content.info === 'object' && content.info !== null ? (content.info as Record<string, unknown>) : {};
  const mimetype = typeof info.mimetype === 'string' ? info.mimetype : undefined;
  const encryptedFile = isEncryptedFileInfo(content.file) ? content.file : undefined;
  const url = typeof content.url === 'string' ? content.url : undefined;

  return {
    ...base,
    encrypted: event.isEncrypted(),
    decryptionFailure: false,
    deleted: false,
    edited: event.replacingEvent() !== null,
    textual: TEXTUAL_MSGTYPES.has(msgtype),
    kind: kindOf(msgtype, mimetype),
    msgtype,
    body: typeof content.body === 'string' ? content.body : '',
    filename: typeof content.filename === 'string' ? content.filename : undefined,
    mimetype,
    size: typeof info.size === 'number' ? info.size : undefined,
    mxcUrl: encryptedFile?.url ?? url,
    encryptedFile,
    replyToEventId,
    threadRootId,
  };
};

const byTimestamp = (a: TimelineMessage, b: TimelineMessage) => a.timestamp - b.timestamp;

/* Builds everything the chat shows from the SDK's timeline, routing every event by its decrypted type and its relation as sent on the wire */
export const deriveTimeline = (events: readonly MatrixEvent[], memory: RelationMemory, myUserId: string | null): TimelineView => {
  /* Targets of redactions that are sent or on their way, so a deletion shows at once and comes back if the redaction fails */
  const redactedIds = new Set<string>();
  for (const event of events) {
    if (!event.isRedaction()) continue;
    const state = sendStateOf(event);
    const target = event.getAssociatedId();
    if (target && state !== 'failed' && state !== 'cancelled') redactedIds.add(target);
  }

  const messages: TimelineMessage[] = [];
  const threads: Record<string, TimelineMessage[]> = {};
  const reactionsByTarget = new Map<string, Map<string, Map<string, MatrixEvent>>>();
  const seenKeys = new Set<string>();

  for (const event of events) {
    const eventId = event.getId();
    if (!eventId || event.isRedaction()) continue;
    const sendState = sendStateOf(event);
    if (sendState === 'cancelled') continue;

    const relation = event.getRelation();
    if (relation?.rel_type && relation.event_id) memory.set(eventId, { relType: relation.rel_type, targetId: relation.event_id });
    const deleted = event.isRedacted() || redactedIds.has(eventId);

    if (event.getType() === EventType.Reaction) {
      if (deleted || sendState === 'failed') continue;
      if (relation?.rel_type !== RelationType.Annotation || !relation.event_id || !relation.key) continue;
      const byKey = reactionsByTarget.get(relation.event_id) ?? new Map<string, Map<string, MatrixEvent>>();
      reactionsByTarget.set(relation.event_id, byKey);
      const bySender = byKey.get(relation.key) ?? new Map<string, MatrixEvent>();
      byKey.set(relation.key, bySender);
      bySender.set(event.getSender() ?? '', event);
      continue;
    }

    const message = toMessage(event, { eventId, sendState, relation, deleted, memory });
    if (!message || seenKeys.has(message.key)) continue;
    seenKeys.add(message.key);
    if (message.threadRootId) (threads[message.threadRootId] ??= []).push(message);
    else messages.push(message);
  }

  messages.sort(byTimestamp);
  const byEventId = new Map<string, TimelineMessage>();
  for (const message of messages) byEventId.set(message.eventId, message);
  for (const replies of Object.values(threads)) {
    replies.sort(byTimestamp);
    for (const reply of replies) byEventId.set(reply.eventId, reply);
  }
  for (const message of byEventId.values()) {
    const quoted = message.replyToEventId ? byEventId.get(message.replyToEventId) : undefined;
    if (!quoted) continue;
    message.replyToSender = quoted.sender;
    message.replyToBody = quoteText(quoted);
  }

  const reactions: Record<string, ReactionGroup[]> = {};
  for (const [target, byKey] of reactionsByTarget) {
    reactions[target] = [...byKey].map(([key, bySender]) => ({
      key,
      count: bySender.size,
      mine: myUserId ? bySender.get(myUserId) : undefined,
    }));
  }

  return { messages, threads, reactions };
};