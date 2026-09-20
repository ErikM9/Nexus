/* eslint-disable @typescript-eslint/no-explicit-any */
'use client';

import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { getMatrixClient } from '../utils/matrix';
import { formatBytes, decryptAttachment, getFileTypeIcon } from '../utils/helpers';
import { MatrixEvent, Room, RoomEvent, ClientEvent, KnownMembership, EventStatus, Direction } from 'matrix-js-sdk';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Reply, Smile, Pencil, Trash2, X, MessageSquare } from 'lucide-react';

interface ChatWindowProps {
  roomId: string;
  onLeave: () => void;
}

type MsgKind = 'text' | 'image' | 'file';

interface Message {
  id: string;
  eventId?: string;
  txnId?: string;
  sender: string;
  timestamp: number;
  encrypted: boolean;
  decrypted: boolean;
  decryptionFailure: boolean;
  sending: boolean;
  sendFailed: boolean;
  kind: MsgKind;
  body: string;
  filename?: string;
  url?: string;
  file?: any;
  info?: any;
  httpUrl?: string;
  objectUrl?: string;
  replyToEventId?: string;
  replyToSender?: string;
  replyToBody?: string;
  edited?: boolean;
  deleted?: boolean;
}

interface ReactionGroup {
  emoji: string;
  count: number;

  myEventId?: string;
}

type MessageMap = Record<string, Message>;
type ReactionsData = Record<string, Record<string, Record<string, string>>>;
type ReactionsDisplay = Record<string, ReactionGroup[]>;

/* Emoji set offered in the reaction picker */
const REACTION_EMOJIS = ['😀', '😂', '😍', '😭', '😡', '👍', '🙏', '🔥', '🎉', '💯', '✅', '❌', '❤️', '🧠', '✨'];

/* True when the event content is a real decrypted message */
const looksDecrypted = (content: any): boolean => {
  if (!content || typeof content !== 'object') return false;
  if (content.msgtype === 'm.bad.encrypted') return false;
  return typeof content.body === 'string' && typeof content.msgtype === 'string';
};

const isDecryptionFailure = (ev: any, content: any): boolean => {
  if (typeof ev?.isDecryptionFailure === 'function') return !!ev.isDecryptionFailure();
  if (content?.msgtype === 'm.bad.encrypted') return true;
  const body = typeof content?.body === 'string' ? content.body : '';
  return body.toLowerCase().includes('unable to decrypt') || body.toLowerCase().includes('decryptionerror');
};

const isMessageLikeEvent = (ev: MatrixEvent): boolean => {
  const t = ev.getType?.();
  return t === 'm.room.message' || t === 'm.room.encrypted';
};

const getTxnId = (ev: MatrixEvent): string | undefined => {
  const direct = (ev as any)?.getTxnId?.();
  if (typeof direct === 'string' && direct) return direct;

  const unsigned = (ev as any)?.getUnsigned?.() ?? (ev as any)?.event?.unsigned ?? (ev as any)?.unsigned;
  const uTxn = unsigned?.transaction_id;
  if (typeof uTxn === 'string' && uTxn) return uTxn;

  return undefined;
};

const getMessageKey = (ev: MatrixEvent): { key: string; eventId?: string; txnId?: string } | null => {
  const eventId = ev.getId?.();
  if (!eventId) return null;
  const txnId = getTxnId(ev);
  return { key: txnId || eventId, eventId, txnId };
};

const getSendState = (ev: MatrixEvent): { sending: boolean; sendFailed: boolean } => {
  const status = (ev as any)?.status as EventStatus | string | undefined;

  const sending =
    status === EventStatus.SENDING ||
    status === EventStatus.QUEUED ||
    status === 'sending' ||
    status === 'queued' ||
    (typeof (ev as any)?.isSending === 'function' ? !!(ev as any).isSending() : false);

  const sendFailed =
    status === EventStatus.NOT_SENT ||
    status === EventStatus.CANCELLED ||
    status === 'not_sent' ||
    status === 'cancelled';

  return { sending, sendFailed };
};

const getDateKey = (timestamp: number): string => {
  const d = new Date(timestamp);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

const formatDateSeparator = (timestamp: number): string => {
  const date = new Date(timestamp);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const messageDay = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const diffDays = Math.floor((today.getTime() - messageDay.getTime()) / (1000 * 60 * 60 * 24));

  if (diffDays === 0) return 'Today';
  if (diffDays === 1) return 'Yesterday';
  if (diffDays < 7) return date.toLocaleDateString(undefined, { weekday: 'long' });
  if (date.getFullYear() === now.getFullYear()) {
    return date.toLocaleDateString(undefined, { month: 'long', day: 'numeric' });
  }
  return date.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
};

const formatMessageTime = (timestamp: number): string => {
  return new Date(timestamp).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
};

const ChatWindow: React.FC<ChatWindowProps> = ({ roomId, onLeave }) => {
  const MAX_CACHED_OBJECT_URLS = 150;

  const [client, setClient] = useState<ReturnType<typeof getMatrixClient> | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [reactions, setReactions] = useState<ReactionsDisplay>({});
  const [lightboxUrl, setLightboxUrl] = useState<string | null>(null);
  const [initialLoadComplete, setInitialLoadComplete] = useState(false);
  const [isLoadingHistory, setIsLoadingHistory] = useState(false);
  const [hasMoreHistory, setHasMoreHistory] = useState(true);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState('');

  /* Only one reaction picker is open at a time across the timeline and thread panel */
  const [reactionPickerFor, setReactionPickerFor] = useState<string | null>(null);
  const [mainPickerPos, setMainPickerPos] = useState<{ top: number; left: number } | null>(null);
  const [confirmingDeleteId, setConfirmingDeleteId] = useState<string | null>(null);
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  const [threadDraft, setThreadDraft] = useState('');
  const [threadSending, setThreadSending] = useState(false);
  const [threadMessages, setThreadMessages] = useState<Record<string, Message[]>>({});
  const [editingThreadMsgId, setEditingThreadMsgId] = useState<string | null>(null);
  const [editThreadDraft, setEditThreadDraft] = useState('');
  const [confirmingDeleteThreadMsgId, setConfirmingDeleteThreadMsgId] = useState<string | null>(null);
  const [threadReplyTo, setThreadReplyTo] = useState<{ eventId: string; sender: string; body: string } | null>(null);
  const [threadPickerCoords, setThreadPickerCoords] = useState<{ top: number; right: number } | null>(null);

  /* Source of truth for rendered messages, keyed by txnId when available */
  const msgMapRef = useRef<MessageMap>({});
  const watchedDecryptRef = useRef<Record<string, boolean>>({});
  const didCloseRef = useRef(false);

  /* Blob URL cache to avoid re-fetching media on every render */
  const objectUrlRef = useRef<Record<string, string>>({});
  const objectUrlOrderRef = useRef<string[]>([]);
  const decryptingRef = useRef<Record<string, boolean>>({});
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const isNearBottomRef = useRef(true);
  const prevScrollHeightRef = useRef<number>(0);
  const prevMsgCountRef = useRef<number>(0);

  /* Captures scroll position before a history load so it can be restored after prepending */
  const scrollAnchorRef = useRef<{ scrollTop: number; scrollHeight: number } | null>(null);
  const isThreadNearBottomRef = useRef(true);
  const prevThreadMsgCountRef = useRef<number>(0);

  /* Raw reaction store keyed as [targetEventId][emoji][senderUserId] = reactionEventId */
  const reactionsDataRef = useRef<ReactionsData>({});
  const reactionPickerRef = useRef<HTMLDivElement | null>(null);
  const threadReactionPickerRef = useRef<HTMLDivElement | null>(null);
  const threadInputRef = useRef<HTMLInputElement | null>(null);

  /* Thread reply store mapping threadRootEventId to sorted reply messages */
  const threadDataRef = useRef<Record<string, Message[]>>({});
  const threadScrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!reactionPickerFor) return;
    const onOutside = (e: MouseEvent) => {
      const inMain = reactionPickerRef.current?.contains(e.target as Node);
      const inThread = threadReactionPickerRef.current?.contains(e.target as Node);
      if (!inMain && !inThread) {
        setReactionPickerFor(null);
        setMainPickerPos(null);
        setThreadPickerCoords(null);
      }
    };
    document.addEventListener('mousedown', onOutside);
    return () => document.removeEventListener('mousedown', onOutside);
  }, [reactionPickerFor]);

  /* Evicts the oldest blob URLs once the cache exceeds its limit to bound memory */
  const cleanupOldObjectUrls = useCallback(() => {
    while (objectUrlOrderRef.current.length > MAX_CACHED_OBJECT_URLS) {
      const oldestKey = objectUrlOrderRef.current.shift();
      if (oldestKey && objectUrlRef.current[oldestKey]) {
        try { URL.revokeObjectURL(objectUrlRef.current[oldestKey]); } catch {}
        delete objectUrlRef.current[oldestKey];
      }
    }
  }, []);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;

    /* Auto-scroll to bottom for new messages */
    const countIncreased = messages.length > prevMsgCountRef.current;
    prevMsgCountRef.current = messages.length;

    const newestMsg = messages[messages.length - 1];
    if (countIncreased && (isNearBottomRef.current || newestMsg?.sending)) {
      el.scrollTop = el.scrollHeight;
      scrollAnchorRef.current = null;
    } else if (countIncreased && scrollAnchorRef.current) {
      const { scrollTop, scrollHeight } = scrollAnchorRef.current;
      el.scrollTop = scrollTop + (el.scrollHeight - scrollHeight);
      scrollAnchorRef.current = null;
    }
    prevScrollHeightRef.current = el.scrollHeight;
  }, [messages]);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el || !isLoadingHistory || !scrollAnchorRef.current) return;
    /* Bump scrollTop by the spinner's added height so content stays in place before paint */
    const added = el.scrollHeight - scrollAnchorRef.current.scrollHeight;
    if (added > 0) el.scrollTop += added;
  }, [isLoadingHistory]);

  const resetLocalState = useCallback(() => {
    for (const url of Object.values(objectUrlRef.current)) {
      try { URL.revokeObjectURL(url); } catch {}
    }
    objectUrlRef.current = {};
    objectUrlOrderRef.current = [];
    decryptingRef.current = {};
    msgMapRef.current = {};
    watchedDecryptRef.current = {};
    reactionsDataRef.current = {};
    threadDataRef.current = {};
    setMessages([]);
    setReactions({});
    setThreadMessages({});
    setEditingId(null);
    setEditDraft('');
    setReactionPickerFor(null);
    setConfirmingDeleteId(null);
    setActiveThreadId(null);
    setThreadDraft('');
    setThreadSending(false);
    setEditingThreadMsgId(null);
    setEditThreadDraft('');
    setConfirmingDeleteThreadMsgId(null);
    setThreadReplyTo(null);
    setThreadPickerCoords(null);
    setInitialLoadComplete(false);
    setIsLoadingHistory(false);
    setHasMoreHistory(true);
    isNearBottomRef.current = true;
    prevScrollHeightRef.current = 0;
    prevMsgCountRef.current = 0;
    isThreadNearBottomRef.current = true;
    prevThreadMsgCountRef.current = 0;
  }, []);

  const closeRoomUi = useCallback(() => {
    if (didCloseRef.current) return;
    didCloseRef.current = true;
    resetLocalState();
    onLeave();
  }, [onLeave, resetLocalState]);

  useEffect(() => {
    didCloseRef.current = false;
  }, [roomId]);

  useEffect(() => {
    if (typeof window === 'undefined') return;

    const attach = () => {
      try {
        const c = getMatrixClient();
        setClient(c);
      } catch {
        setClient(null);
      }
    };

    const detach = () => {
      setClient(null);
      resetLocalState();
    };

    if (window.__matrix_ready) attach();
    else detach();

    window.addEventListener('matrix-ready', attach);
    window.addEventListener('matrix-not-ready', detach);

    return () => {
      window.removeEventListener('matrix-ready', attach);
      window.removeEventListener('matrix-not-ready', detach);
    };
  }, [resetLocalState]);

  const [room, setRoom] = useState<Room | null>(null);

  useEffect(() => {
    if (!client) {
      setRoom(null);
      return;
    }

    const updateRoom = () => {
      const r = client.getRoom(roomId) || null;
      setRoom(r);
    };

    updateRoom();
    client.on(ClientEvent.Sync, updateRoom);

    return () => {
      client.removeListener(ClientEvent.Sync, updateRoom);
    };
  }, [client, roomId]);

  useEffect(() => {
    if (!client) return;

    const checkMembership = () => {
      const r = client.getRoom(roomId) || null;
      if (!r) return;
      const membership = r.getMyMembership?.();
      /* Close the window immediately on a leave or ban rather than showing a room the user has left */
      if (membership === KnownMembership.Leave || membership === KnownMembership.Ban) {
        closeRoomUi();
      }
    };

    checkMembership();

    const onMyMembership = (r: Room) => {
      if (r?.roomId !== roomId) return;
      const membership = r.getMyMembership?.();
      if (membership === KnownMembership.Leave || membership === KnownMembership.Ban) {
        closeRoomUi();
      }
    };

    const onSync = () => checkMembership();

    try { client.on(RoomEvent.MyMembership, onMyMembership); } catch {}
    try { client.on(ClientEvent.Sync, onSync); } catch {}

    return () => {
      try { client.removeListener(RoomEvent.MyMembership, onMyMembership); } catch {}
      try { client.removeListener(ClientEvent.Sync, onSync); } catch {}
    };
  }, [client, roomId, closeRoomUi]);

  const flushMessages = useCallback(() => {
    const arr = Object.values(msgMapRef.current).sort((a, b) => a.timestamp - b.timestamp);
    setMessages(arr);
  }, []);

  /* Rebuilds the display-ready reactions map from the raw store */
  const flushReactions = useCallback(() => {
    const uid = client?.getUserId?.() || '';
    const result: ReactionsDisplay = {};
    for (const [targetId, emojis] of Object.entries(reactionsDataRef.current)) {
      const groups: ReactionGroup[] = [];
      for (const [emoji, senders] of Object.entries(emojis)) {
        const count = Object.keys(senders).length;
        if (count === 0) continue;
        groups.push({ emoji, count, myEventId: senders[uid] || undefined });
      }
      if (groups.length > 0) result[targetId] = groups;
    }
    setReactions(result);
  }, [client]);

  /* Records an m.annotation reaction in the raw store without flushing */
  const processReactionEvent = useCallback((ev: MatrixEvent) => {
    const content = ev.getContent?.() || {};
    const relatesTo = content['m.relates_to'];
    if (!relatesTo || relatesTo.rel_type !== 'm.annotation') return;
    const targetId = relatesTo.event_id;
    const emoji = relatesTo.key;
    const sender = ev.getSender?.() || '';
    const eventId = ev.getId?.() || '';
    if (!targetId || !emoji || !sender || !eventId) return;
    if (!reactionsDataRef.current[targetId]) reactionsDataRef.current[targetId] = {};
    if (!reactionsDataRef.current[targetId][emoji]) reactionsDataRef.current[targetId][emoji] = {};
    reactionsDataRef.current[targetId][emoji][sender] = eventId;
  }, []);

  /* Applies an m.replace edit to the original or its thread entry and refreshes open reply banners */
  const processEditEvent = useCallback((ev: MatrixEvent) => {
    const content = ev.getContent?.() || {};
    const relatesTo = content['m.relates_to'];
    if (!relatesTo || relatesTo.rel_type !== 'm.replace') return;
    const originalEventId = relatesTo.event_id;
    if (!originalEventId) return;
    const newContent = content['m.new_content'];
    if (!newContent || typeof newContent.body !== 'string') return;

    const original = Object.values(msgMapRef.current).find(m => m.eventId === originalEventId);
    if (original) {
      msgMapRef.current[original.id] = { ...original, body: newContent.body, edited: true };
      for (const m of Object.values(msgMapRef.current)) {
        if (m.replyToEventId === originalEventId) {
          msgMapRef.current[m.id] = { ...m, replyToBody: newContent.body };
        }
      }

      /* Refresh replyToBody for any thread messages that quote this message */
      for (const [tid, tMsgs] of Object.entries(threadDataRef.current)) {
        let changed = false;
        const refreshed = tMsgs.map(m => {
          if (m.replyToEventId !== originalEventId) return m;
          changed = true;
          return { ...m, replyToBody: newContent.body };
        });
        if (changed) threadDataRef.current[tid] = refreshed;
      }

      /* Keep an open reply banner in sync when this message was being quoted */
      window.dispatchEvent(new CustomEvent('nexus-reply-body-update', { detail: { eventId: originalEventId, body: newContent.body } }));
      setThreadReplyTo(prev => prev?.eventId === originalEventId ? { ...prev, body: newContent.body } : prev);
      return;
    }

    for (const [threadId, msgs] of Object.entries(threadDataRef.current)) {
      const idx = msgs.findIndex(m => m.eventId === originalEventId);
      if (idx !== -1) {
        /* Update the edited message and any thread siblings that quote it */
        threadDataRef.current[threadId] = msgs.map((m, i) =>
          i === idx
            ? { ...m, body: newContent.body, edited: true }
            : m.replyToEventId === originalEventId
              ? { ...m, replyToBody: newContent.body }
              : m
        );
        /* Keep the thread reply banner and listeners in sync */
        window.dispatchEvent(new CustomEvent('nexus-reply-body-update', { detail: { eventId: originalEventId, body: newContent.body } }));
        setThreadReplyTo(prev => prev?.eventId === originalEventId ? { ...prev, body: newContent.body } : prev);
        return;
      }
    }
  }, []);

  const flushThreadMessages = useCallback(() => {
    const allMain = Object.values(msgMapRef.current);
    const allThread = Object.values(threadDataRef.current).flat();
    const allMsgs = [...allMain, ...allThread];

    for (const [threadId, msgs] of Object.entries(threadDataRef.current)) {
      let changed = false;
      const resolved = msgs.map(m => {
        if (!m.replyToEventId) return m;
        const original = allMsgs.find(x => x.eventId === m.replyToEventId);
        if (!original) return m;
        changed = true;
        return { ...m, replyToSender: original.sender, replyToBody: original.deleted ? '(deleted)' : original.decryptionFailure ? '(encrypted)' : original.body };
      });
      if (changed) threadDataRef.current[threadId] = resolved;
    }

    setThreadMessages({ ...threadDataRef.current });
  }, []);

  const processThreadEvent = useCallback((ev: MatrixEvent) => {
    const content = ev.getContent?.() || {};
    const relatesTo = content['m.relates_to'];
    if (!relatesTo || relatesTo.rel_type !== 'm.thread') return;
    const threadId = relatesTo.event_id;
    if (!threadId) return;
    const keyInfo = getMessageKey(ev);
    if (!keyInfo) return;
    const existing = threadDataRef.current[threadId] || [];
    const { sending, sendFailed } = getSendState(ev);

    const unsigned = (ev as any).getUnsigned?.() ?? (ev as any).event?.unsigned ?? {};
    const isDeleted = !!(ev.isRedacted?.() || unsigned.redacted_because);
    const body = isDeleted ? 'Message deleted.' : (typeof content.body === 'string' ? content.body : '');

    let replyToEventId: string | undefined;
    let replyToSender: string | undefined;
    let replyToBody: string | undefined;
    const inReplyTo = relatesTo['m.in_reply_to'];
    const isFallingBack = relatesTo.is_falling_back === true;
    if (inReplyTo?.event_id && !isFallingBack) {
      replyToEventId = inReplyTo.event_id;
      const allThreadMsgs = Object.values(threadDataRef.current).flat();
      const mainMsgs = Object.values(msgMapRef.current);
      const original = [...allThreadMsgs, ...mainMsgs].find(m => m.eventId === replyToEventId);
      if (original) {
        replyToSender = original.sender;
        replyToBody = original.deleted ? '(deleted)' : original.decryptionFailure ? '(encrypted)' : original.body;
      }
    }

    /* Update an existing entry's send state instead of duplicating, moving it from pending to confirmed */
    const existingIdx = existing.findIndex(m => m.id === keyInfo.key);
    if (existingIdx !== -1) {
      const old = existing[existingIdx];
      const changed =
        old.sending !== sending ||
        old.sendFailed !== sendFailed ||
        old.eventId !== keyInfo.eventId;
      if (changed) {
        threadDataRef.current[threadId] = existing.map((m, i) =>
          i === existingIdx ? { ...m, sending, sendFailed, eventId: keyInfo.eventId, txnId: keyInfo.txnId } : m
        );
      }
      return;
    }

    const threadMsg: Message = {
      id: keyInfo.key,
      eventId: keyInfo.eventId,
      txnId: keyInfo.txnId,
      sender: ev.getSender?.() || 'Unknown',
      timestamp: ev.getTs?.() || Date.now(),
      encrypted: false,
      decrypted: true,
      decryptionFailure: false,
      sending,
      sendFailed,
      kind: 'text',
      body,
      deleted: isDeleted || undefined,
      replyToEventId,
      replyToSender,
      replyToBody,
    };
    threadDataRef.current[threadId] = [...existing, threadMsg].sort((a, b) => a.timestamp - b.timestamp);
  }, []);

  const mapEventToMessage = useCallback(
    (ev: MatrixEvent): Message | null => {
      const keyInfo = getMessageKey(ev);
      if (!keyInfo) return null;

      const encrypted = !!ev.isEncrypted?.() || ev.getType?.() === 'm.room.encrypted';
      const contentFromGetContent = ev.getContent?.() || {};

      /* Edit events and thread replies are handled elsewhere and must not appear as standalone timeline messages */
      const relatesTo = contentFromGetContent['m.relates_to'];
      if (relatesTo?.rel_type === 'm.replace' || relatesTo?.rel_type === 'm.thread') return null;

      const unsigned = (ev as any).getUnsigned?.() ?? (ev as any).event?.unsigned ?? {};
      if (ev.isRedacted?.() || unsigned.redacted_because) {
        return {
          id: keyInfo.key, eventId: keyInfo.eventId, txnId: keyInfo.txnId,
          sender: ev.getSender?.() || 'Unknown',
          timestamp: ev.getTs?.() || Date.now(),
          encrypted: false, decrypted: true, decryptionFailure: false,
          sending: false, sendFailed: false,
          kind: 'text', body: 'Message deleted.', deleted: true,
        };
      }

      const decryptedViaGetContent = encrypted ? looksDecrypted(contentFromGetContent) : true;

      let content: any = contentFromGetContent;
      let decrypted = decryptedViaGetContent;

      if (encrypted && !decrypted) {
        const dec = (ev as any).getDecryptedContent?.();
        if (dec && typeof dec === 'object') {
          content = dec;
          decrypted = looksDecrypted(dec);
        }
      }

      const failure = encrypted ? isDecryptionFailure(ev as any, content) : false;
      const { sending, sendFailed } = getSendState(ev);
      const msgtype = String(content?.msgtype || '').toLowerCase().trim();
      const mimetype = typeof content?.info?.mimetype === 'string' ? content.info.mimetype.toLowerCase() : '';
      const isImage = msgtype === 'm.image' || (msgtype === 'm.file' && mimetype.startsWith('image/'));
      const isFile = msgtype === 'm.file' && !mimetype.startsWith('image/');
      const kind: MsgKind = isImage ? 'image' : isFile ? 'file' : 'text';
      const fallbackBody = sendFailed ? '⚠️ Failed to send' : sending ? '⏳ Sending…' : '🔒 Unable to decrypt';
      const body = typeof content?.body === 'string' ? content.body : encrypted ? fallbackBody : '';
      const filename = typeof content?.filename === 'string' ? content.filename : undefined;
      const url = typeof content?.url === 'string' ? content.url : undefined;
      const file = content?.file && typeof content.file === 'object' ? content.file : undefined;
      const info = content?.info && typeof content.info === 'object' ? content.info : undefined;

      let httpUrl: string | undefined;
      /* Build an authenticated download URL from the mxc URI via the authenticated media endpoint */
      const mxc = url || file?.url;
      if (client && typeof mxc === 'string' && mxc.startsWith('mxc://')) {
        try {
          const baseUrl = (client as any).getHomeserverUrl?.() || (client as any).baseUrl;
          if (baseUrl) {
            const [serverName, mediaId] = mxc.slice(6).split('/');
            if (serverName && mediaId) {
              httpUrl = `${baseUrl.replace(/\/+$/, '')}/_matrix/client/v1/media/download/${serverName}/${mediaId}`;
            }
          }
        } catch {}
      }

      /* Resolve reply-to context from the message map to render a quote */
      const inReplyToId = relatesTo?.['m.in_reply_to']?.event_id;
      let replyToSender: string | undefined;
      let replyToBody: string | undefined;
      if (inReplyToId) {
        const original = Object.values(msgMapRef.current).find(m => m.eventId === inReplyToId);
        if (original) {
          replyToSender = original.sender;
          replyToBody = original.deleted ? '(deleted)' : original.decryptionFailure ? '(encrypted)' : original.body;
        }
      }

      const prev = msgMapRef.current[keyInfo.key];
      const objectUrl = objectUrlRef.current[keyInfo.key] || prev?.objectUrl;

      return {
        id: keyInfo.key,
        eventId: keyInfo.eventId,
        txnId: keyInfo.txnId,
        sender: ev.getSender?.() || 'Unknown',
        body,
        filename,
        timestamp: ev.getTs?.() || Date.now(),
        encrypted,
        decrypted: encrypted ? (failure ? false : decrypted) : true,
        decryptionFailure: failure,
        sending,
        sendFailed,
        kind,
        url,
        file,
        info,
        httpUrl,
        objectUrl,
        replyToEventId: inReplyToId || undefined,
        replyToSender,
        replyToBody,
        edited: prev?.edited,
      };
    },
    [client]
  );

  const upsertMessageFromEvent = useCallback(
    (ev: MatrixEvent) => {
      const msg = mapEventToMessage(ev);
      if (!msg) return;

      const existing = msgMapRef.current[msg.id];
      const changed =
        !existing ||
        existing.body !== msg.body ||
        existing.filename !== msg.filename ||
        existing.decrypted !== msg.decrypted ||
        existing.encrypted !== msg.encrypted ||
        existing.timestamp !== msg.timestamp ||
        existing.sender !== msg.sender ||
        existing.decryptionFailure !== msg.decryptionFailure ||
        existing.sending !== msg.sending ||
        existing.sendFailed !== msg.sendFailed ||
        existing.eventId !== msg.eventId ||
        existing.kind !== msg.kind ||
        existing.httpUrl !== msg.httpUrl ||
        existing.objectUrl !== msg.objectUrl ||
        existing.replyToEventId !== msg.replyToEventId ||
        JSON.stringify(existing.file) !== JSON.stringify(msg.file) ||
        JSON.stringify(existing.info) !== JSON.stringify(msg.info);

      if (!changed) return;

      msgMapRef.current[msg.id] = msg;

      if (msg.eventId) {
        const freshBody = msg.deleted ? '(deleted)' : msg.decryptionFailure ? '(encrypted)' : msg.body;
        for (const m of Object.values(msgMapRef.current)) {
          if (m.replyToEventId === msg.eventId && m.replyToBody !== freshBody) {
            msgMapRef.current[m.id] = { ...m, replyToBody: freshBody };
          }
        }
      }

      flushMessages();

      /* Update the message in place once the SDK decrypts it, clearing the decrypt placeholder */
      if (msg.encrypted && !msg.decrypted && !watchedDecryptRef.current[msg.id]) {
        watchedDecryptRef.current[msg.id] = true;

        const onDecrypted = () => {
          const updated = mapEventToMessage(ev);
          if (!updated) return;
          msgMapRef.current[updated.id] = updated;
          if (updated.eventId) {
            const freshBody = updated.decryptionFailure ? '(encrypted)' : updated.body;
            for (const m of Object.values(msgMapRef.current)) {
              if (m.replyToEventId === updated.eventId && m.replyToBody !== freshBody) {
                msgMapRef.current[m.id] = { ...m, replyToBody: freshBody };
              }
            }
          }
          flushMessages();
          try { (ev as any).removeListener?.('Event.decrypted', onDecrypted); } catch {}
        };

        try { (ev as any).on?.('Event.decrypted', onDecrypted); } catch {}
      }
    },
    [flushMessages, mapEventToMessage]
  );

  const loadMoreHistory = useCallback(async () => {
    if (!client || !room || isLoadingHistory || !hasMoreHistory) return;

    /* Snapshot position before the loading spinner changes the layout */
    if (scrollRef.current) {
      scrollAnchorRef.current = {
        scrollTop: scrollRef.current.scrollTop,
        scrollHeight: scrollRef.current.scrollHeight,
      };
    }

    setIsLoadingHistory(true);
    isNearBottomRef.current = false;

    try {
      const timeline = room.getLiveTimeline();

      /* A null pagination token means the server has no more history */
      const paginationToken = timeline.getPaginationToken?.(Direction.Backward);
      if (paginationToken === null) {
        setHasMoreHistory(false);
        setIsLoadingHistory(false);
        scrollAnchorRef.current = null;
        return;
      }

      const result = await (client as any).paginateEventTimeline(timeline, {
        backwards: true,
        limit: 30,
      });

      if (!result) {
        setHasMoreHistory(false);
        scrollAnchorRef.current = null;
      } else {
        const events = timeline.getEvents();
        let hadExtras = false;
        for (const ev of events) {
          const type = ev.getType?.();
          const id = (ev as any).getId?.();
          if (!id) continue;
          if (type === 'm.reaction') { processReactionEvent(ev as MatrixEvent); hadExtras = true; continue; }
          if (type === 'm.room.message') {
            const c = ev.getContent?.() || {};
            const relType = c['m.relates_to']?.rel_type;
            if (relType === 'm.replace') { processEditEvent(ev as MatrixEvent); hadExtras = true; continue; }
            if (relType === 'm.thread') { processThreadEvent(ev as MatrixEvent); hadExtras = true; continue; }
          }
          if ((type === 'm.room.message' || type === 'm.room.encrypted') && !msgMapRef.current[id]) {
            const msg = mapEventToMessage(ev as MatrixEvent);
            if (msg && !msgMapRef.current[msg.id]) msgMapRef.current[msg.id] = msg;
          }
        }
        flushMessages();
        if (hadExtras) { flushReactions(); flushThreadMessages(); }
        const canPaginateMore = timeline.getPaginationToken?.(Direction.Backward) !== null;
        setHasMoreHistory(canPaginateMore);
      }
    } catch {
    } finally {
      setIsLoadingHistory(false);
    }
  }, [client, room, isLoadingHistory, hasMoreHistory, flushMessages, flushReactions, flushThreadMessages, mapEventToMessage, processReactionEvent, processEditEvent, processThreadEvent]);

  useEffect(() => {
    resetLocalState();

    if (!client) return;

    /* Mark the load complete after 2s so the spinner never runs forever */
    const loadTimeout = setTimeout(() => {
      setInitialLoadComplete(true);
    }, 2000);

    const loadFromLiveTimeline = (roomToLoad: Room) => {
      /* Process messages first so later passes for edits and reactions have targets to apply to */
      for (const ev of roomToLoad.getLiveTimeline().getEvents()) {
        const type = ev.getType?.();
        if (type !== 'm.room.message' && type !== 'm.room.encrypted') continue;
        if (!(ev as any).getId?.()) continue;
        const relType = ev.getContent?.()?.['m.relates_to']?.rel_type;
        if (relType === 'm.replace' || relType === 'm.thread') continue;
        upsertMessageFromEvent(ev as MatrixEvent);
      }
      for (const ev of roomToLoad.getLiveTimeline().getEvents()) {
        if (ev.getType?.() === 'm.reaction') processReactionEvent(ev as MatrixEvent);
      }
      for (const ev of roomToLoad.getLiveTimeline().getEvents()) {
        if (ev.getType?.() === 'm.room.message' && ev.getContent?.()?.['m.relates_to']?.rel_type === 'm.replace') {
          processEditEvent(ev as MatrixEvent);
        }
      }
      for (const ev of roomToLoad.getLiveTimeline().getEvents()) {
        if (ev.getType?.() === 'm.room.message' && ev.getContent?.()?.['m.relates_to']?.rel_type === 'm.thread') {
          processThreadEvent(ev as MatrixEvent);
        }
      }
      flushReactions();
      flushThreadMessages();

      const paginationToken = roomToLoad.getLiveTimeline().getPaginationToken?.(Direction.Backward);
      setHasMoreHistory(paginationToken !== null);
    };

    const onSync = (syncState: string) => {
      if (syncState === 'SYNCING' || syncState === 'PREPARED') {
        const currentRoom = client.getRoom(roomId);
        if (currentRoom) loadFromLiveTimeline(currentRoom);
        setInitialLoadComplete(true);
      }
    };

    client.on(ClientEvent.Sync, onSync);

    const r = client.getRoom(roomId) || null;

    if (!r) {
      return () => {
        clearTimeout(loadTimeout);
        client.removeListener(ClientEvent.Sync, onSync);
      };
    }

    loadFromLiveTimeline(r);

    const syncState = (client as any).getSyncState?.();
    if (syncState === 'SYNCING' || syncState === 'PREPARED' || syncState === 'CATCHUP') {
      setInitialLoadComplete(true);
    }

    const onTimeline = (ev: MatrixEvent, timelineRoom: Room | undefined) => {
      const rId = ev.getRoomId?.() || timelineRoom?.roomId;
      if (rId !== roomId) return;
      const type = ev.getType?.();

      if (type === 'm.reaction') { processReactionEvent(ev); flushReactions(); return; }

      if (type === 'm.room.redaction') {
        const redactedId = (ev as any).event?.redacts || (ev as any).getAssociatedId?.();
        if (redactedId) {
          const toMark = Object.values(msgMapRef.current).find(m => m.eventId === redactedId);
          if (toMark) {
            msgMapRef.current[toMark.id] = { ...toMark, deleted: true, body: 'Message deleted.', edited: false };
            flushMessages();
          }
          for (const [threadId, msgs] of Object.entries(threadDataRef.current)) {
            const idx = msgs.findIndex(m => m.eventId === redactedId);
            if (idx !== -1) {
              threadDataRef.current[threadId] = msgs.map((m, i) =>
                i === idx ? { ...m, deleted: true, body: 'Message deleted.', edited: false } : m
              );
              flushThreadMessages();
              break;
            }
          }
          let changed = false;
          for (const emojis of Object.values(reactionsDataRef.current)) {
            for (const senders of Object.values(emojis)) {
              for (const [uid, eid] of Object.entries(senders)) {
                if (eid === redactedId) { delete senders[uid]; changed = true; }
              }
            }
          }
          if (changed) flushReactions();
        }
        return;
      }

      if (type === 'm.room.message' && ev.getContent?.()?.['m.relates_to']?.rel_type === 'm.replace') {
        processEditEvent(ev); flushMessages(); flushThreadMessages(); return;
      }

      if (type === 'm.room.message' && ev.getContent?.()?.['m.relates_to']?.rel_type === 'm.thread') {
        processThreadEvent(ev); flushThreadMessages(); return;
      }

      if (!isMessageLikeEvent(ev)) return;
      upsertMessageFromEvent(ev);
      setInitialLoadComplete(true);
    };

    const onLocalEchoUpdated = (ev: MatrixEvent, echoRoom: Room | undefined) => {
      const rId = ev.getRoomId?.() || echoRoom?.roomId;
      if (rId !== roomId) return;
      if (!isMessageLikeEvent(ev)) return;
      upsertMessageFromEvent(ev);
    };

    const onTimelineReset = (timelineRoom: Room | undefined) => {
      if (!timelineRoom) return;
      if (timelineRoom.roomId !== roomId) return;
      resetLocalState();
      loadFromLiveTimeline(timelineRoom);
    };

    r.on(RoomEvent.Timeline, onTimeline as any);
    r.on(RoomEvent.TimelineReset, onTimelineReset as any);
    r.on(RoomEvent.LocalEchoUpdated as any, onLocalEchoUpdated as any);

    return () => {
      clearTimeout(loadTimeout);
      client.removeListener(ClientEvent.Sync, onSync);
      r.removeListener(RoomEvent.Timeline, onTimeline as any);
      r.removeListener(RoomEvent.TimelineReset, onTimelineReset as any);
      r.removeListener(RoomEvent.LocalEchoUpdated as any, onLocalEchoUpdated as any);
    };
  }, [client, roomId, resetLocalState, upsertMessageFromEvent, processReactionEvent, processEditEvent, processThreadEvent, flushMessages, flushReactions, flushThreadMessages]);

  useEffect(() => {
    if (!client) return;

    const ensureMediaLoaded = async (m: Message) => {
      if (m.kind !== 'image' && m.kind !== 'file') return;
      if (objectUrlRef.current[m.id]) return;
      if (decryptingRef.current[m.id]) return;
      if (!m.httpUrl) return;

      const token = typeof (client as any).getAccessToken === 'function' ? (client as any).getAccessToken() : undefined;
      if (!token) return;

      decryptingRef.current[m.id] = true;
      const isEncryptedAttachment = !!m.file?.key && !!m.file?.iv && !!m.file?.hashes?.sha256;

      try {
        const res = await fetch(m.httpUrl, { headers: { Authorization: `Bearer ${token}` } });
        if (!res.ok) {
          decryptingRef.current[m.id] = false;
          return;
        }

        let blob: Blob;
        if (isEncryptedAttachment) {
          const ciphertext = await res.arrayBuffer();
          const plaintext = await decryptAttachment(ciphertext, m.file);
          const mime = m.info?.mimetype || 'application/octet-stream';
          blob = new Blob([plaintext], { type: mime });
        } else {
          blob = await res.blob();
        }

        const url = URL.createObjectURL(blob);
        objectUrlRef.current[m.id] = url;
        objectUrlOrderRef.current.push(m.id);
        cleanupOldObjectUrls();

        const cur = msgMapRef.current[m.id];
        if (!cur) return;
        msgMapRef.current[m.id] = { ...cur, objectUrl: url };
        flushMessages();
      } catch {
        decryptingRef.current[m.id] = false;
      }
    };

    for (const m of Object.values(msgMapRef.current)) {
      void ensureMediaLoaded(m);
    }
  }, [client, messages, flushMessages, cleanupOldObjectUrls]);

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;

    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    isNearBottomRef.current = distanceFromBottom < 100;

    if (el.scrollTop < 20 && !isLoadingHistory && hasMoreHistory && messages.length > 0) {
      loadMoreHistory();
    }
  }, [isLoadingHistory, hasMoreHistory, messages.length, loadMoreHistory]);

  useEffect(() => {
    if (!initialLoadComplete || isLoadingHistory || !hasMoreHistory || messages.length === 0) return;

    const el = scrollRef.current;
    if (!el) return;

    if (el.scrollHeight <= el.clientHeight) {
      loadMoreHistory();
    }
  }, [initialLoadComplete, isLoadingHistory, hasMoreHistory, messages.length, loadMoreHistory]);

  useEffect(() => {
    if (!threadScrollRef.current || !activeThreadId) return;
    const el = threadScrollRef.current;
    const activeCount = threadMessages[activeThreadId]?.length || 0;
    const countIncreased = activeCount > prevThreadMsgCountRef.current;
    prevThreadMsgCountRef.current = activeCount;
    if (countIncreased && isThreadNearBottomRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [threadMessages, activeThreadId]);

  useEffect(() => {
    if (!activeThreadId) return;
    isThreadNearBottomRef.current = true;
    prevThreadMsgCountRef.current = 0;
    requestAnimationFrame(() => {
      if (threadScrollRef.current) {
        threadScrollRef.current.scrollTop = threadScrollRef.current.scrollHeight;
      }
    });
  }, [activeThreadId]);

  const handleReply = useCallback((msg: Message) => {
    if (!msg.eventId) return;
    window.dispatchEvent(new CustomEvent('nexus-reply-to', {
      detail: { eventId: msg.eventId, sender: msg.sender, body: msg.body },
    }));
  }, []);

  const handleReact = useCallback(async (targetEventId: string, emoji: string) => {
    if (!client || !targetEventId) return;
    const uid = client.getUserId?.();
    if (!uid) return;
    const existing = reactionsDataRef.current[targetEventId]?.[emoji]?.[uid];
    if (existing) {
      try {
        await (client as any).redactEvent(roomId, existing);
        delete reactionsDataRef.current[targetEventId][emoji][uid];
        flushReactions();
      } catch {}
    } else {
      try {
        const result = await (client as any).sendEvent(roomId, 'm.reaction', {
          'm.relates_to': { rel_type: 'm.annotation', event_id: targetEventId, key: emoji },
        });
        if (!reactionsDataRef.current[targetEventId]) reactionsDataRef.current[targetEventId] = {};
        if (!reactionsDataRef.current[targetEventId][emoji]) reactionsDataRef.current[targetEventId][emoji] = {};
        reactionsDataRef.current[targetEventId][emoji][uid] = result?.event_id || `pending_${Date.now()}`;
        flushReactions();
      } catch {}
    }
    setReactionPickerFor(null);
  }, [client, roomId, flushReactions]);

  const startEdit = useCallback((msg: Message) => {
    setConfirmingDeleteId(null);
    setEditingId(prev => {
      if (prev === msg.id) { setEditDraft(''); return null; }
      setEditDraft(msg.body);
      return msg.id;
    });
  }, []);

  const submitEdit = useCallback(async (msg: Message) => {
    if (!client || !msg.eventId) return;
    const trimmed = editDraft.trim();
    if (!trimmed || trimmed === msg.body) { setEditingId(null); setEditDraft(''); return; }
    try {
      await (client as any).sendEvent(roomId, 'm.room.message', {
        msgtype: 'm.text',
        body: `* ${trimmed}`,
        'm.new_content': { msgtype: 'm.text', body: trimmed },
        'm.relates_to': { rel_type: 'm.replace', event_id: msg.eventId },
      });
      if (msgMapRef.current[msg.id]) {
        msgMapRef.current[msg.id] = { ...msgMapRef.current[msg.id], body: trimmed, edited: true };
        flushMessages();
      }
    } catch {}
    setEditingId(null);
    setEditDraft('');
  }, [client, roomId, editDraft, flushMessages]);

  const submitEditThread = useCallback(async (msg: Message, threadId: string) => {
    if (!client || !msg.eventId) return;
    const trimmed = editThreadDraft.trim();
    if (!trimmed || trimmed === msg.body) { setEditingThreadMsgId(null); setEditThreadDraft(''); return; }
    try {
      await (client as any).sendEvent(roomId, 'm.room.message', {
        msgtype: 'm.text',
        body: `* ${trimmed}`,
        'm.new_content': msg.eventId !== threadId
          ? { msgtype: 'm.text', body: trimmed, 'm.relates_to': { rel_type: 'm.thread', event_id: threadId } }
          : { msgtype: 'm.text', body: trimmed },
        'm.relates_to': { rel_type: 'm.replace', event_id: msg.eventId },
      });
      const bucket = threadDataRef.current[threadId];
      if (bucket) {
        threadDataRef.current[threadId] = bucket.map(m =>
          m.id === msg.id ? { ...m, body: trimmed, edited: true } : m
        );
        flushThreadMessages();
      }
    } catch {}
    setEditingThreadMsgId(null);
    setEditThreadDraft('');
  }, [client, roomId, editThreadDraft, flushThreadMessages]);

  const handleDelete = useCallback(async (msg: Message) => {
    if (!client || !msg.eventId) return;
    if (msgMapRef.current[msg.id]) {
      msgMapRef.current[msg.id] = { ...msgMapRef.current[msg.id], deleted: true, body: 'Message deleted.', edited: false };
      flushMessages();
    }
    setConfirmingDeleteId(null);
    try {
      await (client as any).redactEvent(roomId, msg.eventId);
    } catch {}
  }, [client, roomId, flushMessages]);

  const handleDeleteThreadMsg = useCallback(async (msg: Message, threadId: string) => {
    if (!client || !msg.eventId) return;
    const bucket = threadDataRef.current[threadId];
    if (bucket) {
      threadDataRef.current[threadId] = bucket.map(m =>
        m.id === msg.id ? { ...m, deleted: true, body: 'Message deleted.', edited: false } : m
      );
      flushThreadMessages();
    }
    setConfirmingDeleteThreadMsgId(null);
    try {
      await (client as any).redactEvent(roomId, msg.eventId);
    } catch {}
  }, [client, roomId, flushThreadMessages]);

  const canDeleteMsg = useCallback((msg: Message): boolean => {
    if (!client) return false;
    const uid = client.getUserId?.();
    if (!uid) return false;
    if (msg.sender === uid) return true;
    if (!room) return false;
    const plEv = room.currentState?.getStateEvents?.('m.room.power_levels', '');
    const pl = (plEv as any)?.getContent?.() || {};
    const redactPL = Number.isFinite(pl.redact) ? pl.redact : 50;
    const users = pl.users && typeof pl.users === 'object' ? pl.users : {};
    const fromUsersMap = users[uid];
    const fromMember = Number.isFinite(fromUsersMap) ? fromUsersMap : room?.getMember?.(uid)?.powerLevel;
    const myPL = Number.isFinite(fromMember) ? fromMember : (Number.isFinite(pl.users_default) ? pl.users_default : 0);
    return myPL >= redactPL;
  }, [client, room]);

  const sendThreadReply = useCallback(async () => {
    if (!client || !activeThreadId || !threadDraft.trim() || threadSending) return;
    const body = threadDraft.trim();
    const replyTarget = threadReplyTo;
    setThreadSending(true);
    setThreadDraft('');
    setThreadReplyTo(null);
    isThreadNearBottomRef.current = true;
    try {
      const relatesTo: any = { rel_type: 'm.thread', event_id: activeThreadId, is_falling_back: true };
      if (replyTarget) {
        relatesTo['m.in_reply_to'] = { event_id: replyTarget.eventId };
        relatesTo.is_falling_back = false;
      }
      await (client as any).sendEvent(roomId, 'm.room.message', {
        msgtype: 'm.text',
        body,
        'm.relates_to': relatesTo,
      });
    } catch {}
    setThreadSending(false);
    requestAnimationFrame(() => threadInputRef.current?.focus());
  }, [client, roomId, activeThreadId, threadDraft, threadSending, threadReplyTo]);

  if (!client) {
    return (
      <div className="flex flex-col flex-1 min-h-0 h-full overflow-hidden">
        <div className="flex items-center justify-center h-full">
          <div className="flex flex-col items-center gap-3">
            <div className="h-6 w-6 rounded-full border-2 border-border/60 border-t-muted-foreground animate-spin" aria-hidden="true" />
            <p className="text-muted-foreground text-center text-sm">Connecting…</p>
          </div>
        </div>
      </div>
    );
  }

  if (!room) {
    return (
      <div className="flex flex-col flex-1 min-h-0 h-full overflow-hidden">
        <div className="flex items-center justify-center h-full">
          <div className="flex flex-col items-center gap-3">
            <div className="h-6 w-6 rounded-full border-2 border-border/60 border-t-muted-foreground animate-spin" aria-hidden="true" />
            <p className="text-muted-foreground text-center text-sm">Loading room…</p>
          </div>
        </div>
      </div>
    );
  }

  const myUserId = client.getUserId?.() || null;
  const bubbleClass = 'bg-sky-100/90 dark:bg-slate-900';

  return (
    <div className="flex flex-col flex-1 min-h-0 h-full overflow-hidden relative [contain:paint]" data-testid="chat-window">
      <ScrollArea
        viewportRef={scrollRef}
        className="flex-1 min-h-0 h-full"
        viewportClassName="h-full w-full p-4 overflow-auto [overflow-anchor:none]"
        role="log"
        aria-live="polite"
        aria-label="Chat messages"
        onScroll={handleScroll}
      >
        {messages.length > 0 && (
          <div className="flex justify-center py-2 mb-2">
            {isLoadingHistory ? (
              <div className="flex items-center gap-2 text-muted-foreground text-sm">
                <div className="h-4 w-4 rounded-full border-2 border-border/60 border-t-muted-foreground animate-spin" aria-hidden="true" />
                <span>Loading message history…</span>
              </div>
            ) : !hasMoreHistory ? (
              <div className="text-muted-foreground text-xs">Beginning of conversation</div>
            ) : null}
          </div>
        )}

        {messages.length === 0 ? (
          <div className="flex items-center justify-center h-full">
            {!initialLoadComplete ? (
              <div className="flex flex-col items-center gap-3">
                <div className="h-6 w-6 rounded-full border-2 border-border/60 border-t-muted-foreground animate-spin" aria-hidden="true" />
                <p className="text-muted-foreground text-center text-sm">Loading messages…</p>
              </div>
            ) : (
              <p className="text-muted-foreground text-center">No messages yet. Start the conversation!</p>
            )}
          </div>
        ) : (
          messages.map((msg, index) => {
            const isEncryptedAttachment = !!msg.file?.key && !!msg.file?.iv && !!msg.file?.hashes?.sha256;
            const mediaUrl = msg.objectUrl;
            const displayName = msg.filename || msg.body || 'file';
            const mimetype = typeof msg.info?.mimetype === 'string' ? msg.info.mimetype : undefined;
            const sizeText = formatBytes(typeof msg.info?.size === 'number' ? msg.info.size : undefined);
            const icon = getFileTypeIcon(mimetype, displayName);
            const currentDateKey = getDateKey(msg.timestamp);
            const prevMsg = index > 0 ? messages[index - 1] : null;
            const showDateSeparator = currentDateKey !== (prevMsg ? getDateKey(prevMsg.timestamp) : null);
            const isOwnMessage = msg.sender === myUserId;
            const canEdit = isOwnMessage && msg.kind === 'text' && !msg.sending && !msg.sendFailed && !msg.deleted;
            const canDelete = canDeleteMsg(msg) && !msg.sending && !msg.deleted;
            const hasEventId = !!msg.eventId;
            const msgReactions = msg.eventId ? reactions[msg.eventId] : undefined;

            return (
              <React.Fragment key={msg.id}>
                {showDateSeparator && (
                  <div className="flex items-center justify-center my-4" role="separator">
                    <div className="flex-1 h-px bg-border/50" />
                    <span className="px-3 text-xs font-medium text-muted-foreground">
                      {formatDateSeparator(msg.timestamp)}
                    </span>
                    <div className="flex-1 h-px bg-border/50" />
                  </div>
                )}

                <div data-message-id={msg.id} className="group relative mb-2" onMouseLeave={(e) => {
                  if (reactionPickerFor === msg.id && !reactionPickerRef.current?.contains(e.relatedTarget as Node)) {
                    setReactionPickerFor(null);
                    setMainPickerPos(null);
                  }
                }}>

                  {hasEventId && !msg.deleted && (
                    <div
                      className={`absolute -top-5 right-0 z-10 flex items-center gap-px bg-card border border-border/60 rounded-xl px-1 py-0.5 opacity-0 group-hover:opacity-100 transition-opacity duration-100${reactionPickerFor === msg.id ? ' !opacity-100' : ''}`}
                      data-testid="message-actions"
                    >
                      <div className="relative group/react">
                        <button
                          className={`h-6 w-6 flex items-center justify-center rounded-lg transition-colors ${reactionPickerFor === msg.id ? 'bg-accent/60 text-foreground' : 'text-muted-foreground hover:text-foreground hover:bg-accent/60'}`}
                          aria-label="Add reaction"
                          onMouseDown={(e) => {
                            e.stopPropagation();
                            if (reactionPickerFor !== msg.id) {
                              const rect = e.currentTarget.getBoundingClientRect();
                              setMainPickerPos({ top: rect.bottom + 4, left: Math.max(8, rect.right - 196) });
                            } else {
                              setMainPickerPos(null);
                            }
                            setThreadPickerCoords(null);
                            setReactionPickerFor(prev => prev === msg.id ? null : msg.id);
                            (e.currentTarget as HTMLButtonElement).blur();
                          }}
                          data-testid="action-react"
                        >
                          <Smile className="h-3.5 w-3.5" />
                        </button>
                        <span className="pointer-events-none absolute top-full left-1/2 -translate-x-1/2 mt-1.5 px-1.5 py-0.5 rounded-md bg-card border border-border/60 text-[10px] leading-none whitespace-nowrap text-foreground opacity-0 group-hover/react:opacity-100 transition-opacity z-30">
                          Emojis
                        </span>
                      </div>

                      <div className="relative group/reply">
                        <button
                          className="h-6 w-6 flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-accent/60 rounded-lg transition-colors"
                          aria-label="Reply"
                          onClick={() => { setReactionPickerFor(null); handleReply(msg); }}
                          data-testid="action-reply"
                        >
                          <Reply className="h-3.5 w-3.5" />
                        </button>
                        <span className="pointer-events-none absolute top-full left-1/2 -translate-x-1/2 mt-1.5 px-1.5 py-0.5 rounded-md bg-card border border-border/60 text-[10px] leading-none whitespace-nowrap text-foreground opacity-0 group-hover/reply:opacity-100 transition-opacity z-30">
                          Reply
                        </span>
                      </div>

                      {hasEventId && (
                        <div className="relative group/thread">
                          <button
                            className="h-6 w-6 flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-accent/60 rounded-lg transition-colors"
                            aria-label="Reply in thread"
                            onClick={() => { setReactionPickerFor(null); setActiveThreadId(msg.eventId || null); }}
                            data-testid="action-thread"
                          >
                            <MessageSquare className="h-3.5 w-3.5" />
                          </button>
                          <span className="pointer-events-none absolute top-full left-1/2 -translate-x-1/2 mt-1.5 px-1.5 py-0.5 rounded-md bg-card border border-border/60 text-[10px] leading-none whitespace-nowrap text-foreground opacity-0 group-hover/thread:opacity-100 transition-opacity z-30">
                            Thread
                          </span>
                        </div>
                      )}

                      {canEdit && (
                        <div className="relative group/edit">
                          <button
                            className="h-6 w-6 flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-accent/60 rounded-lg transition-colors"
                            aria-label="Edit message"
                            onMouseDown={e => e.preventDefault()}
                            onClick={() => { setReactionPickerFor(null); startEdit(msg); }}
                            data-testid="action-edit"
                          >
                            <Pencil className="h-3.5 w-3.5" />
                          </button>
                          <span className="pointer-events-none absolute top-full left-1/2 -translate-x-1/2 mt-1.5 px-1.5 py-0.5 rounded-md bg-card border border-border/60 text-[10px] leading-none whitespace-nowrap text-foreground opacity-0 group-hover/edit:opacity-100 transition-opacity z-30">
                            Edit
                          </span>
                        </div>
                      )}

                      {canDelete && (
                        <div className="relative group/delete">
                          <button
                            className="h-6 w-6 flex items-center justify-center text-muted-foreground hover:text-destructive hover:bg-destructive/10 rounded-lg transition-colors"
                            aria-label="Delete message"
                            onClick={(e) => { setReactionPickerFor(null); setEditingId(null); setEditDraft(''); setConfirmingDeleteId(prev => prev === msg.id ? null : msg.id); (e.currentTarget as HTMLButtonElement).blur(); }}
                            data-testid="action-delete"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                          <span className="pointer-events-none absolute top-full left-1/2 -translate-x-1/2 mt-1.5 px-1.5 py-0.5 rounded-md bg-card border border-border/60 text-[10px] leading-none whitespace-nowrap text-destructive opacity-0 group-hover/delete:opacity-100 transition-opacity z-30">
                            Delete
                          </span>
                        </div>
                      )}
                    </div>
                  )}

                  <div
                    className={['p-3 rounded-xl overflow-hidden break-words', bubbleClass, msg.sendFailed ? 'opacity-70' : '', msg.sending ? 'opacity-80' : ''].join(' ')}
                    role="article"
                    aria-label={`Message from ${msg.sender}`}
                  >
                    <div className="text-sm text-muted-foreground flex items-center gap-2">
                      <span>{msg.sender}</span>
                      {msg.sending && <span className="text-xs" role="status">⏳ Sending…</span>}
                      {msg.sendFailed && <span className="text-destructive text-xs" role="alert">⚠️ Failed</span>}
                      {msg.encrypted && msg.decryptionFailure && <span className="text-destructive text-xs" role="alert">🔒 Cannot decrypt</span>}
                    </div>

                    {msg.replyToEventId && (
                      <div
                        className="mt-1 mb-2 pl-3 border-l-2 border-muted-foreground/30 text-xs text-muted-foreground line-clamp-2"
                        data-testid="reply-context"
                      >
                        {msg.replyToSender && <span className="font-medium mr-1">{msg.replyToSender}</span>}
                        {msg.replyToBody && <span className="opacity-80">{msg.replyToBody}</span>}
                      </div>
                    )}

                    {msg.kind === 'image' ? (
                      mediaUrl ? (
                        <div className="mt-2">
                          <img
                            src={mediaUrl}
                            alt={msg.body || 'image'}
                            className="max-w-[min(320px,70vw)] max-h-[280px] w-auto h-auto object-contain rounded-lg border border-border/40 cursor-pointer hover:opacity-90 transition-opacity"
                            onClick={() => setLightboxUrl(mediaUrl)}
                            role="button"
                            tabIndex={0}
                            onKeyDown={(e) => e.key === 'Enter' && setLightboxUrl(mediaUrl)}
                            aria-label="Click to view full size image"
                          />
                          {msg.body && msg.body !== msg.filename && (
                            <div className="text-foreground mt-2">{msg.body}</div>
                          )}
                        </div>
                      ) : msg.httpUrl ? (
                        <div className="mt-2 text-sm text-muted-foreground" role="status">
                          {isEncryptedAttachment ? 'Decrypting image…' : 'Loading image…'}
                        </div>
                      ) : (
                        <div className="mt-2 text-sm text-muted-foreground">Image unavailable</div>
                      )
                    ) : msg.kind === 'file' ? (
                      mediaUrl ? (
                        <div className="mt-2">
                          <a href={mediaUrl} download={displayName} className="block w-full rounded-lg border border-border/40 px-3 py-2 hover:bg-muted/40 transition-colors" aria-label={`Download ${displayName}`}>
                            <div className="flex items-start justify-between gap-3">
                              <div className="flex items-start gap-2 min-w-0">
                                <span className="text-lg leading-none mt-[1px]">{icon}</span>
                                <div className="flex flex-col min-w-0">
                                  <span className="text-sm text-foreground truncate max-w-[min(560px,72vw)]">{displayName}</span>
                                  <span className="text-xs text-muted-foreground">{sizeText || mimetype || 'File'}</span>
                                </div>
                              </div>
                              <div className="shrink-0 text-xs text-muted-foreground flex items-center gap-1 mt-[2px]">
                                <span className="hidden sm:inline">Download</span>
                                <span aria-hidden>⬇</span>
                              </div>
                            </div>
                          </a>
                        </div>
                      ) : msg.httpUrl ? (
                        <div className="mt-2 text-sm text-muted-foreground">
                          {isEncryptedAttachment ? 'Decrypting file…' : 'Loading file…'}
                        </div>
                      ) : (
                        <div className="mt-2 text-sm text-muted-foreground">File unavailable</div>
                      )
                    ) : msg.deleted ? (
                      <div className="text-sm italic text-muted-foreground/60" data-testid="deleted-message">
                        Message deleted.
                      </div>
                    ) : editingId === msg.id ? (
                      <div className="mt-2 space-y-2" data-testid="edit-form">
                        <Input
                          value={editDraft}
                          onChange={(e) => setEditDraft(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submitEdit(msg); }
                            if (e.key === 'Escape') { setEditingId(null); setEditDraft(''); }
                          }}
                          className="h-8 text-sm"
                          autoFocus
                          data-testid="edit-input"
                        />
                        <div className="flex gap-1.5">
                          <Button size="sm" variant="ghost" className="h-6 text-xs px-2" onClick={() => submitEdit(msg)} disabled={!editDraft.trim()} data-testid="edit-save">
                            Save
                          </Button>
                          <Button size="sm" variant="ghost" className="h-6 text-xs px-2" onClick={() => { setEditingId(null); setEditDraft(''); }} data-testid="edit-cancel">
                            Cancel
                          </Button>
                        </div>
                      </div>
                    ) : (
                      <div className="text-foreground break-words">
                        {msg.body}
                        {msg.edited && (
                          <span className="ml-1.5 text-[11px] text-muted-foreground/60" data-testid="edited-label">(edited)</span>
                        )}

                        {confirmingDeleteId === msg.id && (
                          <div className="mt-2" data-testid="delete-confirm">
                            <div className="text-xs text-muted-foreground/70 mb-1.5">Delete this message?</div>
                            <div className="flex gap-1.5">
                              <Button
                                size="sm"
                                variant="ghost"
                                className="h-6 text-xs px-2 text-destructive hover:text-destructive hover:bg-destructive/10"
                                onClick={() => handleDelete(msg)}
                                data-testid="delete-confirm-yes"
                              >
                                Delete
                              </Button>
                              <Button
                                size="sm"
                                variant="ghost"
                                className="h-6 text-xs px-2"
                                onClick={() => setConfirmingDeleteId(null)}
                                data-testid="delete-cancel"
                              >
                                Cancel
                              </Button>
                            </div>
                          </div>
                        )}
                      </div>
                    )}

                    <div className="text-xs text-muted-foreground/80 mt-1">{formatMessageTime(msg.timestamp)}</div>

                    {!msg.deleted && msgReactions && msgReactions.length > 0 && (
                      <div className="flex flex-wrap gap-1 mt-2" data-testid="reaction-list">
                        {msgReactions.map((r) => (
                          <button
                            key={r.emoji}
                            className={[
                              'inline-flex items-center gap-1 text-xs rounded-full px-2 py-0.5 border transition-colors',
                              r.myEventId
                                ? 'bg-sky-500/20 border-sky-500/40 text-foreground hover:bg-sky-500/30'
                                : 'bg-muted/40 border-border/40 hover:bg-accent/60',
                            ].join(' ')}
                            aria-label={`${r.emoji} reaction, ${r.count} ${r.count === 1 ? 'person' : 'people'}${r.myEventId ? ', you reacted' : ''}`}
                            onClick={() => msg.eventId && handleReact(msg.eventId, r.emoji)}
                            data-testid="reaction-badge"
                          >
                            <span>{r.emoji}</span>
                            <span>{r.count}</span>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>

                  {msg.eventId && (threadMessages[msg.eventId]?.length || 0) > 0 && (
                    <button
                      className="mt-1 flex items-center gap-1 text-xs text-sky-600 dark:text-sky-400 hover:text-sky-500 dark:hover:text-sky-300 transition-colors"
                      onClick={() => setActiveThreadId(msg.eventId || null)}
                      data-testid="thread-count"
                    >
                      <MessageSquare className="h-3 w-3" />
                      {threadMessages[msg.eventId!].length} {threadMessages[msg.eventId!].length === 1 ? 'reply' : 'replies'}
                    </button>
                  )}
                </div>
              </React.Fragment>
            );
          })
        )}
      </ScrollArea>

      {activeThreadId && (
        <div
          className="absolute inset-y-0 right-0 z-20 w-[300px] flex flex-col glass border-l border-border"
          data-testid="thread-panel"
        >
          <div className="flex items-center justify-between px-3 py-2 border-b border-border shrink-0">
            <div className="flex items-center gap-1.5 text-sm font-semibold">
              <MessageSquare className="h-4 w-4 text-muted-foreground" />
              Thread
            </div>
            <button
              className="h-7 w-7 flex items-center justify-center text-muted-foreground hover:text-foreground rounded-lg hover:bg-accent/60 transition-colors"
              aria-label="Close thread"
              onClick={() => { setActiveThreadId(null); setThreadDraft(''); }}
              data-testid="thread-close"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          <ScrollArea
            viewportRef={threadScrollRef}
            className="flex-1 min-h-0"
            viewportClassName="h-full w-full overflow-y-auto pt-6 pb-3 px-3 space-y-3"
            onScroll={() => {
              const el = threadScrollRef.current;
              if (!el) return;
              isThreadNearBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
            }}
          >
            {(() => {
              const root = Object.values(msgMapRef.current).find(m => m.eventId === activeThreadId) || null;
              const replies = threadMessages[activeThreadId] || [];
              const allMessages: Array<{ msg: Message; isRoot: boolean }> = [
                ...(root ? [{ msg: root, isRoot: true }] : []),
                ...replies.map(m => ({ msg: m, isRoot: false })),
              ];
              if (allMessages.length === 0) {
                return <div className="text-xs text-muted-foreground text-center py-6">No messages yet.</div>;
              }
              return allMessages.map(({ msg: m, isRoot }) => {
                const tmCanEdit = m.sender === myUserId && !m.sending && !m.sendFailed && !m.deleted;
                const tmCanDelete = canDeleteMsg(m) && !m.sending && !m.deleted;
                return (
                  <div key={m.id} role="article" aria-label={`Thread message from ${m.sender}`} data-testid="thread-message" data-message-id={m.id} className="group relative break-words"
                    onMouseLeave={(e) => {
                      if (reactionPickerFor === m.id && !threadReactionPickerRef.current?.contains(e.relatedTarget as Node)) {
                        setReactionPickerFor(null);
                        setThreadPickerCoords(null);
                      }
                    }}
                  >
                    <div className="text-xs text-muted-foreground font-medium">{m.sender}</div>

                    {m.eventId && !m.deleted && (
                      <div className={`absolute -top-5 right-0 z-10 flex items-center gap-px bg-card border border-border/60 rounded-xl px-1 py-0.5 opacity-0 group-hover:opacity-100 transition-opacity duration-100${reactionPickerFor === m.id ? ' !opacity-100' : ''}`}>
                        <button
                          className={`h-6 w-6 flex items-center justify-center rounded-lg transition-colors ${reactionPickerFor === m.id ? 'bg-accent/60 text-foreground' : 'text-muted-foreground hover:text-foreground hover:bg-accent/60'}`}
                          aria-label="Add reaction"
                          onMouseDown={(e) => {
                            e.stopPropagation();
                            if (reactionPickerFor === m.id) {
                              setReactionPickerFor(null);
                              setThreadPickerCoords(null);
                            } else {
                              const btnRect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                              const panelEl = (e.currentTarget as HTMLElement).closest('[data-testid="thread-panel"]');
                              const panelTop = panelEl?.getBoundingClientRect().top ?? 0;
                              setMainPickerPos(null);
                              setThreadPickerCoords({ top: btnRect.bottom + 4 - panelTop, right: window.innerWidth - btnRect.right - 5 });
                              setReactionPickerFor(m.id);
                            }
                            (e.currentTarget as HTMLButtonElement).blur();
                          }}
                        >
                          <Smile className="h-3.5 w-3.5" />
                        </button>
                        <button
                          className="h-6 w-6 flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-accent/60 rounded-lg transition-colors"
                          aria-label="Reply"
                          onClick={(e) => {
                            if (!m.eventId) return;
                            setReactionPickerFor(null);
                            setThreadReplyTo({ eventId: m.eventId, sender: m.sender, body: m.body });
                            (e.currentTarget as HTMLButtonElement).blur();
                            requestAnimationFrame(() => threadInputRef.current?.focus());
                          }}
                          data-testid="thread-action-reply"
                        >
                          <Reply className="h-3.5 w-3.5" />
                        </button>
                        {tmCanEdit && (
                          <button
                            className="h-6 w-6 flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-accent/60 rounded-lg transition-colors"
                            aria-label="Edit message"
                            onClick={() => {
                              setReactionPickerFor(null);
                              setConfirmingDeleteThreadMsgId(null);
                              if (editingThreadMsgId === m.id) { setEditingThreadMsgId(null); setEditThreadDraft(''); }
                              else { setEditingThreadMsgId(m.id); setEditThreadDraft(m.body); }
                            }}
                            data-testid="thread-action-edit"
                          >
                            <Pencil className="h-3.5 w-3.5" />
                          </button>
                        )}
                        {tmCanDelete && (
                          <button
                            className="h-6 w-6 flex items-center justify-center text-muted-foreground hover:text-destructive hover:bg-destructive/10 rounded-lg transition-colors"
                            aria-label="Delete message"
                            onClick={(e) => { setReactionPickerFor(null); setEditingThreadMsgId(null); setEditThreadDraft(''); setConfirmingDeleteThreadMsgId(prev => prev === m.id ? null : m.id); (e.currentTarget as HTMLButtonElement).blur(); }}
                            data-testid="thread-action-delete"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        )}
                      </div>
                    )}

                    {m.deleted ? (
                      <div className="text-sm italic text-muted-foreground/60 mt-0.5">Message deleted.</div>
                    ) : editingThreadMsgId === m.id ? (
                      <div className="mt-1 space-y-1.5">
                        <Input
                          value={editThreadDraft}
                          onChange={(e) => setEditThreadDraft(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submitEditThread(m, activeThreadId); }
                            if (e.key === 'Escape') { setEditingThreadMsgId(null); setEditThreadDraft(''); }
                          }}
                          className="h-7 text-xs"
                          autoFocus
                          data-testid="thread-edit-input"
                        />
                        <div className="flex gap-1">
                          <Button size="sm" variant="ghost" className="h-5 text-[11px] px-1.5" onClick={() => submitEditThread(m, activeThreadId)} disabled={!editThreadDraft.trim()} data-testid="thread-edit-save">Save</Button>
                          <Button size="sm" variant="ghost" className="h-5 text-[11px] px-1.5" onClick={() => { setEditingThreadMsgId(null); setEditThreadDraft(''); }} data-testid="thread-edit-cancel">Cancel</Button>
                        </div>
                      </div>
                    ) : (
                      <div className="text-sm text-foreground mt-0.5 break-words">
                        {m.replyToEventId && (
                          <div className="mb-1.5 pl-3 border-l-2 border-muted-foreground/30 text-xs text-muted-foreground line-clamp-2">
                            {m.replyToSender && <span className="font-medium mr-1">{m.replyToSender}</span>}
                            {m.replyToBody && <span className="opacity-80">{m.replyToBody}</span>}
                          </div>
                        )}
                        {m.body}
                        {m.edited && <span className="ml-1 text-[10px] text-muted-foreground/60">(edited)</span>}
                        {confirmingDeleteThreadMsgId === m.id && (
                          <div className="mt-1.5" data-testid="thread-delete-confirm">
                            <div className="text-xs text-muted-foreground/70 mb-1">Delete this message?</div>
                            <div className="flex gap-1">
                              <Button size="sm" variant="ghost" className="h-5 text-[11px] px-1.5 text-destructive hover:text-destructive hover:bg-destructive/10" onClick={() => { isRoot ? handleDelete(m) : handleDeleteThreadMsg(m, activeThreadId); }} data-testid="thread-delete-confirm-yes">Delete</Button>
                              <Button size="sm" variant="ghost" className="h-5 text-[11px] px-1.5" onClick={() => setConfirmingDeleteThreadMsgId(null)} data-testid="thread-delete-cancel">Cancel</Button>
                            </div>
                          </div>
                        )}
                      </div>
                    )}

                    {!m.deleted && m.eventId && reactions[m.eventId]?.length > 0 && (
                      <div className="flex flex-wrap gap-1 mt-1.5">
                        {reactions[m.eventId].map((r) => (
                          <button
                            key={r.emoji}
                            className={[
                              'inline-flex items-center gap-1 text-xs rounded-full px-1.5 py-0.5 border transition-colors',
                              r.myEventId
                                ? 'bg-sky-500/20 border-sky-500/40 text-foreground hover:bg-sky-500/30'
                                : 'bg-muted/40 border-border/40 hover:bg-accent/60',
                            ].join(' ')}
                            onClick={() => m.eventId && handleReact(m.eventId, r.emoji)}
                          >
                            <span>{r.emoji}</span>
                            <span>{r.count}</span>
                          </button>
                        ))}
                      </div>
                    )}

                    <div className="text-[10px] text-muted-foreground/60 mt-0.5">{formatMessageTime(m.timestamp)}</div>
                  </div>
                );
              });
            })()}
          </ScrollArea>

          {reactionPickerFor && threadPickerCoords && (() => {
            const allMsgs = [...(threadMessages[activeThreadId] || []),
              ...Object.values(msgMapRef.current).filter(mm => mm.eventId === activeThreadId)];
            const target = allMsgs.find(mm => mm.id === reactionPickerFor);
            return (
              <div
                ref={threadReactionPickerRef}
                className="absolute z-[100] bg-card border border-border/60 rounded-xl p-1.5 w-[160px]"
                style={{ top: threadPickerCoords.top, right: threadPickerCoords.right }}
                onMouseLeave={(e) => {
                  const rt = e.relatedTarget as Element | null;
                  if (rt?.closest?.('[data-message-id]')?.getAttribute('data-message-id') === reactionPickerFor) return;
                  setReactionPickerFor(null);
                  setThreadPickerCoords(null);
                }}
              >
                <div className="grid grid-cols-5 gap-0.5">
                  {REACTION_EMOJIS.map((emoji) => (
                    <button
                      key={emoji}
                      className="h-7 w-7 rounded-lg text-sm hover:bg-accent/60 dark:hover:bg-muted/50 transition-colors flex items-center justify-center"
                      aria-label={`React with ${emoji}`}
                      onClick={() => target?.eventId && handleReact(target.eventId, emoji)}
                    >
                      {emoji}
                    </button>
                  ))}
                </div>
              </div>
            );
          })()}

          <div className="shrink-0 border-t border-border px-3 py-2 relative">
            {threadReplyTo && (
              <div className="absolute bottom-full left-0 right-0 px-3 pb-1">
                <div className="flex items-center justify-between gap-2 rounded-xl border border-border/60 bg-card px-3 py-1.5">
                  <div className="flex items-start gap-1.5 min-w-0">
                    <Reply className="h-3 w-3 text-muted-foreground shrink-0 mt-0.5" />
                    <div className="text-xs text-muted-foreground min-w-0 truncate">
                      <span className="font-medium text-foreground mr-1">{threadReplyTo.sender}</span>
                      <span>{threadReplyTo.body}</span>
                    </div>
                  </div>
                  <button className="shrink-0 text-muted-foreground hover:text-foreground" onClick={() => setThreadReplyTo(null)}>
                    <X className="h-3 w-3" />
                  </button>
                </div>
              </div>
            )}
            <div className="flex items-center gap-2">
              <Input
                ref={threadInputRef}
                value={threadDraft}
                onChange={(e) => setThreadDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendThreadReply(); }
                }}
                placeholder="Reply in thread…"
                className="flex-1 h-8 text-sm"
                disabled={threadSending}
                data-testid="thread-input"
              />
              <Button
                size="sm"
                onClick={sendThreadReply}
                disabled={!threadDraft.trim() || threadSending}
                className="h-8 shrink-0 px-3"
                data-testid="thread-send"
              >
                Send
              </Button>
            </div>
          </div>
        </div>
      )}

      {reactionPickerFor && mainPickerPos && (() => {
        const target = Object.values(msgMapRef.current).find(m => m.id === reactionPickerFor);
        if (!target?.eventId) return null;
        return (
          <div
            ref={reactionPickerRef}
            style={{ position: 'fixed', top: mainPickerPos.top, left: mainPickerPos.left }}
            className="z-50 bg-card border border-border/60 rounded-xl p-2 w-[196px]"
            data-testid="reaction-picker"
            onMouseLeave={(e) => {
              const rt = e.relatedTarget as Element | null;
              if (rt?.closest?.('[data-message-id]')?.getAttribute('data-message-id') === reactionPickerFor) return;
              setReactionPickerFor(null);
              setMainPickerPos(null);
            }}
          >
            <div className="grid grid-cols-5 gap-1">
              {REACTION_EMOJIS.map((emoji) => (
                <button
                  key={emoji}
                  className="h-8 w-8 rounded-xl text-base hover:bg-accent/60 dark:hover:bg-muted/50 transition-colors flex items-center justify-center"
                  aria-label={`React with ${emoji}`}
                  onClick={() => handleReact(target.eventId!, emoji)}
                >
                  {emoji}
                </button>
              ))}
            </div>
          </div>
        );
      })()}

      {lightboxUrl && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm"
          onClick={() => setLightboxUrl(null)}
        >
          <button
            onClick={() => setLightboxUrl(null)}
            className="absolute top-4 right-4 text-white/60 hover:text-white hover:scale-110 transition-all duration-150 text-3xl font-light leading-none p-2"
            aria-label="Close"
          >
            ×
          </button>
          <img
            src={lightboxUrl}
            alt="Full size"
            className="max-w-[90vw] max-h-[90vh] object-contain rounded-lg"
            onClick={(e) => e.stopPropagation()}
          />
        </div>
      )}
    </div>
  );
};

export default ChatWindow;