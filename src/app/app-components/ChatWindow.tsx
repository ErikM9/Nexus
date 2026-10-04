'use client';

import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  ClientEvent,
  EventStatus,
  EventType,
  KnownMembership,
  MatrixEventEvent,
  MsgType,
  RelationType,
  RoomEvent,
  type MatrixClient,
  type MatrixEvent,
  type Room,
} from 'matrix-js-sdk';
import type { RoomMessageEventContent } from 'matrix-js-sdk/lib/types';
import { getMatrixClient } from '../utils/matrix';
import { formatBytes, getFileTypeIcon } from '../utils/helpers';
import { formatDateSeparator, formatMessageTime, getDateKey } from '../utils/dates';
import { isPlayableAs } from '../utils/media';
import { isImeComposing } from '../utils/keyboard';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Reply, Smile, Pencil, Trash2, X, MessageSquare } from 'lucide-react';
import { hasServerEventId, quoteText, type TimelineMessage } from './timeline/model';
import { useRoomTimeline } from './timeline/useRoomTimeline';
import { useMediaCache, type MediaSource } from './timeline/useMediaCache';
import { ReactionPicker } from './timeline/ReactionPicker';

interface ChatWindowProps {
  roomId: string;
  onLeave: (roomId: string) => void;
}

/* Kinds whose attachment is downloaded and shown, while other kinds show their text only */
const MEDIA_KINDS: ReadonlySet<TimelineMessage['kind']> = new Set(['image', 'file', 'audio', 'video']);

const mediaKeyOf = (message: TimelineMessage): string => `${message.key}|${message.mxcUrl}`;

const isNearBottom = (el: HTMLElement): boolean => el.scrollHeight - el.scrollTop - el.clientHeight < 100;

/* Sends message content assembled here, whose edit and thread shapes the SDK's message content union does not describe */
const sendMessageEvent = (client: MatrixClient, roomId: string, content: Record<string, unknown>) =>
  client.sendEvent(roomId, EventType.RoomMessage, content as unknown as RoomMessageEventContent);

/* Resolves with the server's event ID once a local echo is sent, or null when the send fails or is cancelled */
const waitForServerId = (event: MatrixEvent): Promise<string | null> =>
  new Promise((resolve) => {
    const finish = (id: string | null) => {
      event.off(MatrixEventEvent.LocalEventIdReplaced, onIdReplaced);
      event.off(MatrixEventEvent.Status, onStatus);
      resolve(id);
    };
    const onIdReplaced = () => {
      const id = event.getId();
      if (id && hasServerEventId(id)) finish(id);
    };
    const onStatus = (_event: MatrixEvent, status: EventStatus | null) => {
      if (status === EventStatus.NOT_SENT || status === EventStatus.CANCELLED) finish(null);
    };
    event.on(MatrixEventEvent.LocalEventIdReplaced, onIdReplaced);
    event.on(MatrixEventEvent.Status, onStatus);
  });

/* Shows a message's send state, with Retry and Delete once the server has rejected it */
const SendState: React.FC<{ message: TimelineMessage; onRetry: () => void; onDiscard: () => void }> = ({ message, onRetry, onDiscard }) => {
  if (message.sendState === 'sending') return <span className="text-xs" role="status">⏳ Sending…</span>;
  if (message.sendState !== 'failed') return null;
  return (
    <>
      <span className="text-destructive text-xs" role="alert">⚠️ Failed</span>
      <Button size="sm" variant="ghost" className="h-6 text-xs px-2" onClick={onRetry}>
        Retry
      </Button>
      <Button size="sm" variant="ghost" className="h-6 text-xs px-2 text-destructive hover:bg-destructive/10" onClick={onDiscard}>
        Delete
      </Button>
    </>
  );
};

const ChatWindow: React.FC<ChatWindowProps> = ({ roomId, onLeave }) => {
  const [client, setClient] = useState<MatrixClient | null>(null);
  const [room, setRoom] = useState<Room | null>(null);
  const [lightboxKey, setLightboxKey] = useState<string | null>(null);
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState('');

  /* Only one reaction picker is open at a time across the timeline and thread panel */
  const [reactionPickerFor, setReactionPickerFor] = useState<string | null>(null);
  const [mainPickerPos, setMainPickerPos] = useState<{ top: number; left: number } | null>(null);
  const [confirmingDeleteKey, setConfirmingDeleteKey] = useState<string | null>(null);
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  const [threadDraft, setThreadDraft] = useState('');
  const [threadSending, setThreadSending] = useState(false);
  const [editingThreadKey, setEditingThreadKey] = useState<string | null>(null);
  const [editThreadDraft, setEditThreadDraft] = useState('');
  const [confirmingDeleteThreadKey, setConfirmingDeleteThreadKey] = useState<string | null>(null);
  const [threadReplyToId, setThreadReplyToId] = useState<string | null>(null);
  const [threadPickerCoords, setThreadPickerCoords] = useState<{ top: number; right: number } | null>(null);

  const aliveRef = useRef(true);
  const didCloseRef = useRef(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const isNearBottomRef = useRef(true);
  const prevNewestKeyRef = useRef<string | undefined>(undefined);

  /* Captures scroll position before a history load so it can be restored after prepending */
  const scrollAnchorRef = useRef<{ scrollTop: number; scrollHeight: number } | null>(null);
  const isThreadNearBottomRef = useRef(true);
  const prevThreadMsgCountRef = useRef<number>(0);
  const reactionPickerRef = useRef<HTMLDivElement | null>(null);
  /* The button that opened the reaction picker and whether a key press opened it, so closing can hand focus back to a keyboard user */
  const pickerTriggerRef = useRef<HTMLButtonElement | null>(null);
  const pickerByKeyboardRef = useRef(false);
  const threadReactionPickerRef = useRef<HTMLDivElement | null>(null);
  const threadInputRef = useRef<HTMLInputElement | null>(null);
  const threadScrollRef = useRef<HTMLDivElement | null>(null);
  const quotesRef = useRef(new Map<string, string>());

  const { view, ready, hasMoreHistory, isLoadingHistory, historyFailed, resets, loadOlder } = useRoomTimeline(client, room);
  const messages = view.messages;
  const myUserId = client?.getUserId() ?? null;

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

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

  const closeReactionPicker = useCallback((restoreFocus: boolean) => {
    setReactionPickerFor(null);
    setMainPickerPos(null);
    setThreadPickerCoords(null);
    if (restoreFocus) pickerTriggerRef.current?.focus();
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return;

    const attach = () => {
      try {
        setClient(getMatrixClient());
      } catch {
        setClient(null);
      }
    };
    const detach = () => setClient(null);

    if (window.__matrix_ready) attach();
    else detach();

    window.addEventListener('matrix-ready', attach);
    window.addEventListener('matrix-not-ready', detach);
    return () => {
      window.removeEventListener('matrix-ready', attach);
      window.removeEventListener('matrix-not-ready', detach);
    };
  }, []);

  useEffect(() => {
    if (!client) {
      setRoom(null);
      return;
    }
    const updateRoom = () => setRoom(client.getRoom(roomId));
    updateRoom();
    /* A room joined moments ago can reach the store on a later sync, so the window picks it up as soon as it appears */
    client.on(ClientEvent.Room, updateRoom);
    client.on(ClientEvent.Sync, updateRoom);
    return () => {
      client.off(ClientEvent.Room, updateRoom);
      client.off(ClientEvent.Sync, updateRoom);
    };
  }, [client, roomId]);

  const closeRoomUi = useCallback(() => {
    if (didCloseRef.current) return;
    didCloseRef.current = true;
    onLeave(roomId);
  }, [onLeave, roomId]);

  useEffect(() => {
    if (!client) return;

    /* Close the window immediately on a leave or ban rather than showing a room the user has left */
    const checkMembership = () => {
      const membership = client.getRoom(roomId)?.getMyMembership();
      if (membership === KnownMembership.Leave || membership === KnownMembership.Ban) closeRoomUi();
    };
    const onMyMembership = (r: Room) => {
      if (r.roomId === roomId) checkMembership();
    };

    checkMembership();
    client.on(ClientEvent.Sync, checkMembership);
    client.on(RoomEvent.MyMembership, onMyMembership);
    return () => {
      client.off(ClientEvent.Sync, checkMembership);
      client.off(RoomEvent.MyMembership, onMyMembership);
    };
  }, [client, roomId, closeRoomUi]);

  const mediaSources = useMemo<MediaSource[]>(
    () =>
      messages
        .filter((m) => !m.deleted && m.mxcUrl && MEDIA_KINDS.has(m.kind))
        .map((m) => ({ key: mediaKeyOf(m), mxcUrl: m.mxcUrl!, encryptedFile: m.encryptedFile, declaredType: m.mimetype })),
    [messages]
  );
  const pinnedMedia = useMemo(() => (lightboxKey ? [lightboxKey] : []), [lightboxKey]);
  const mediaEntry = useMediaCache(client, mediaSources, pinnedMedia);

  /* Tells an open reply banner when the message it quotes is edited, deleted or decrypted */
  useEffect(() => {
    const next = new Map<string, string>();
    for (const m of [...messages, ...Object.values(view.threads).flat()]) next.set(m.eventId, quoteText(m));
    for (const [eventId, body] of next) {
      const before = quotesRef.current.get(eventId);
      if (before !== undefined && before !== body) {
        window.dispatchEvent(new CustomEvent('nexus-reply-body-update', { detail: { eventId, body } }));
      }
    }
    quotesRef.current = next;
  }, [messages, view.threads]);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const newest = messages[messages.length - 1];
    const appended = !!newest && newest.key !== prevNewestKeyRef.current;
    prevNewestKeyRef.current = newest?.key;

    const anchor = scrollAnchorRef.current;
    if (anchor) {
      /* While a history page loads the view keeps its distance from the bottom, so the messages being read stay put as older ones are prepended */
      el.scrollTop = anchor.scrollTop + (el.scrollHeight - anchor.scrollHeight);
      if (!isLoadingHistory) {
        scrollAnchorRef.current = null;
        /* Measured again from the real position, so a history that fits on screen counts as at the bottom and keeps following new messages */
        isNearBottomRef.current = isNearBottom(el);
      }
      return;
    }

    /* A reader at the bottom stays there both when a message is added and when one already shown grows, as when a reaction or a reply quote appears */
    if (isNearBottomRef.current || (appended && newest.sender === myUserId && newest.sendState === 'sending')) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages, isLoadingHistory, myUserId]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    /* Images and videos that finish loading make the timeline taller without any message changing, and their load events only reach an ancestor in the capture phase */
    const keepReaderAtBottom = () => {
      if (isNearBottomRef.current && !scrollAnchorRef.current) el.scrollTop = el.scrollHeight;
    };
    el.addEventListener('load', keepReaderAtBottom, true);
    el.addEventListener('loadedmetadata', keepReaderAtBottom, true);
    return () => {
      el.removeEventListener('load', keepReaderAtBottom, true);
      el.removeEventListener('loadedmetadata', keepReaderAtBottom, true);
    };
  }, [room]);

  useLayoutEffect(() => {
    if (resets === 0) return;
    /* A reset replaces every message, so the old position means nothing and the view follows the newest messages again */
    scrollAnchorRef.current = null;
    isNearBottomRef.current = true;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [resets]);

  const loadMoreHistory = useCallback(() => {
    const el = scrollRef.current;
    const anchor = el ? { scrollTop: el.scrollTop, scrollHeight: el.scrollHeight } : null;
    if (!loadOlder()) return;
    scrollAnchorRef.current = anchor;
    isNearBottomRef.current = false;
  }, [loadOlder]);

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;

    isNearBottomRef.current = isNearBottom(el);

    if (el.scrollTop < 20 && !isLoadingHistory && hasMoreHistory && messages.length > 0) {
      loadMoreHistory();
    }
  }, [isLoadingHistory, hasMoreHistory, messages.length, loadMoreHistory]);

  useEffect(() => {
    if (!ready || isLoadingHistory || !hasMoreHistory || historyFailed) return;
    const el = scrollRef.current;
    if (!el) return;
    /* Older pages load until the view can scroll, even when the newest events hold no messages at all, as after a gap made only of reactions */
    if (el.scrollHeight <= el.clientHeight) loadMoreHistory();
  }, [ready, isLoadingHistory, hasMoreHistory, historyFailed, messages.length, loadMoreHistory]);

  const threadReplies = useMemo(() => (activeThreadId ? view.threads[activeThreadId] ?? [] : []), [activeThreadId, view.threads]);

  useEffect(() => {
    if (!threadScrollRef.current || !activeThreadId) return;
    const el = threadScrollRef.current;
    const countIncreased = threadReplies.length > prevThreadMsgCountRef.current;
    prevThreadMsgCountRef.current = threadReplies.length;
    if (countIncreased && isThreadNearBottomRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [threadReplies, activeThreadId]);

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

  const handleReply = useCallback((msg: TimelineMessage) => {
    window.dispatchEvent(new CustomEvent('nexus-reply-to', {
      detail: { eventId: msg.eventId, sender: msg.sender, body: msg.body },
    }));
  }, []);

  /* Redacts the user's own event, waiting for a reaction that is still being sent to get its server ID first */
  const redactOwnEvent = useCallback(async (event: MatrixEvent) => {
    if (!client) return;
    const eventId = event.getId();
    if (eventId && hasServerEventId(eventId)) {
      await client.redactEvent(roomId, eventId);
      return;
    }
    if (event.status === EventStatus.NOT_SENT || event.status === EventStatus.QUEUED || event.status === EventStatus.ENCRYPTING) {
      client.cancelPendingEvent(event);
      return;
    }
    const serverId = await waitForServerId(event);
    if (serverId) await client.redactEvent(roomId, serverId);
  }, [client, roomId]);

  const toggleReaction = useCallback(async (target: TimelineMessage, emoji: string) => {
    setReactionPickerFor(null);
    setMainPickerPos(null);
    setThreadPickerCoords(null);
    if (!client || !target.hasServerId) return;
    const mine = view.reactions[target.eventId]?.find((group) => group.key === emoji)?.mine;
    try {
      if (mine) await redactOwnEvent(mine);
      else await client.sendEvent(roomId, EventType.Reaction, {
        'm.relates_to': { rel_type: RelationType.Annotation, event_id: target.eventId, key: emoji },
      });
    } catch {}
  }, [client, roomId, view.reactions, redactOwnEvent]);

  const startEdit = useCallback((msg: TimelineMessage) => {
    setConfirmingDeleteKey(null);
    if (editingKey === msg.key) {
      setEditingKey(null);
      setEditDraft('');
      return;
    }
    setEditingKey(msg.key);
    setEditDraft(msg.body);
  }, [editingKey]);

  /* Sends an m.replace edit, which the SDK applies to the original at once as a local echo */
  const sendEdit = useCallback(async (msg: TimelineMessage, text: string) => {
    if (!client || !msg.hasServerId) return;
    const msgtype = msg.textual ? msg.msgtype : MsgType.Text;
    try {
      await sendMessageEvent(client, roomId, {
        msgtype,
        body: `* ${text}`,
        'm.new_content': { msgtype, body: text },
        'm.relates_to': { rel_type: RelationType.Replace, event_id: msg.eventId },
      });
    } catch {}
  }, [client, roomId]);

  const submitEdit = useCallback((msg: TimelineMessage) => {
    const trimmed = editDraft.trim();
    setEditingKey(null);
    setEditDraft('');
    if (trimmed && trimmed !== msg.body) void sendEdit(msg, trimmed);
  }, [editDraft, sendEdit]);

  const submitEditThread = useCallback((msg: TimelineMessage) => {
    const trimmed = editThreadDraft.trim();
    setEditingThreadKey(null);
    setEditThreadDraft('');
    if (trimmed && trimmed !== msg.body) void sendEdit(msg, trimmed);
  }, [editThreadDraft, sendEdit]);

  const handleDelete = useCallback(async (msg: TimelineMessage) => {
    setConfirmingDeleteKey(null);
    setConfirmingDeleteThreadKey(null);
    if (!client || !msg.hasServerId) return;
    try {
      await client.redactEvent(roomId, msg.eventId);
    } catch {}
  }, [client, roomId]);

  /* Sends a rejected message again from its local echo, which keeps its place in the timeline */
  const retrySend = useCallback(async (msg: TimelineMessage) => {
    if (!client || !room) return;
    try {
      await client.resendEvent(msg.event, room);
    } catch {}
  }, [client, room]);

  /* Drops a message the server never accepted, which needs no redaction because nobody else ever saw it */
  const discardSend = useCallback((msg: TimelineMessage) => {
    try {
      client?.cancelPendingEvent(msg.event);
    } catch {}
  }, [client]);

  /* Asks the SDK's redaction rules, which read the room's power levels including the unlimited level of a room version 12 creator */
  const canDeleteMsg = useCallback((msg: TimelineMessage): boolean => {
    const userId = client?.getUserId();
    return !!userId && !!room && room.currentState.maySendRedactionForEvent(msg.event, userId);
  }, [client, room]);

  const sendThreadReply = useCallback(async () => {
    const body = threadDraft.trim();
    if (!client || !activeThreadId || !body || threadSending) return;
    const replyTarget = threadReplyToId;
    setThreadSending(true);
    setThreadDraft('');
    setThreadReplyToId(null);
    isThreadNearBottomRef.current = true;
    try {
      const relatesTo: Record<string, unknown> = { rel_type: RelationType.Thread, event_id: activeThreadId, is_falling_back: true };
      if (replyTarget) {
        relatesTo['m.in_reply_to'] = { event_id: replyTarget };
        relatesTo.is_falling_back = false;
      }
      await sendMessageEvent(client, roomId, { msgtype: MsgType.Text, body, 'm.relates_to': relatesTo });
    } catch {}
    /* The panel belongs to this room's window, so a reply finishing after the window closed has nothing left to update */
    if (!aliveRef.current) return;
    setThreadSending(false);
    requestAnimationFrame(() => threadInputRef.current?.focus());
  }, [client, roomId, activeThreadId, threadDraft, threadSending, threadReplyToId]);

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

  const bubbleClass = 'bg-sky-100/90 dark:bg-slate-900';
  const threadRoot = activeThreadId ? messages.find((m) => m.eventId === activeThreadId) ?? null : null;
  const threadReplyTarget = threadReplyToId
    ? [...threadReplies, ...(threadRoot ? [threadRoot] : [])].find((m) => m.eventId === threadReplyToId) ?? null
    : null;
  const lightboxEntry = lightboxKey ? mediaEntry(lightboxKey) : undefined;
  const lightboxUrl = lightboxEntry?.status === 'ready' ? lightboxEntry.url : null;
  const expectingHistory = isLoadingHistory || (hasMoreHistory && !historyFailed);

  const renderMedia = (msg: TimelineMessage) => {
    const entry = msg.mxcUrl ? mediaEntry(mediaKeyOf(msg)) : undefined;
    const isEncryptedAttachment = !!msg.encryptedFile;
    const displayName = msg.filename || msg.body || 'file';
    const sizeText = formatBytes(msg.size);
    const icon = getFileTypeIcon(msg.mimetype, displayName);
    const pending = !!msg.mxcUrl && entry?.status !== 'failed';

    const downloadLink = (url: string) => (
      <div className="mt-2">
        <a href={url} download={displayName} className="block w-full rounded-lg border border-border/40 px-3 py-2 hover:bg-muted/40 transition-colors" aria-label={`Download ${displayName}`}>
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-start gap-2 min-w-0">
              <span className="text-lg leading-none mt-[1px]">{icon}</span>
              <div className="flex flex-col min-w-0">
                <span className="text-sm text-foreground truncate max-w-[min(560px,72vw)]">{displayName}</span>
                <span className="text-xs text-muted-foreground">{sizeText || msg.mimetype || 'File'}</span>
              </div>
            </div>
            <div className="shrink-0 text-xs text-muted-foreground flex items-center gap-1 mt-[2px]">
              <span className="hidden sm:inline">Download</span>
              <span aria-hidden>⬇</span>
            </div>
          </div>
        </a>
      </div>
    );

    if (msg.kind === 'image') {
      if (entry?.status === 'ready') {
        if (!isPlayableAs(entry.blobType, 'image')) return downloadLink(entry.url);
        const key = mediaKeyOf(msg);
        return (
          <div className="mt-2">
            {/* eslint-disable-next-line @next/next/no-img-element -- blob URLs of decrypted media cannot go through next/image */}
            <img
              src={entry.url}
              alt={msg.body || 'image'}
              className="max-w-[min(320px,70vw)] max-h-[280px] w-auto h-auto object-contain rounded-lg border border-border/40 cursor-pointer hover:opacity-90 transition-opacity"
              onClick={() => setLightboxKey(key)}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => e.key === 'Enter' && setLightboxKey(key)}
              aria-label="Click to view full size image"
            />
            {msg.body && msg.body !== msg.filename && (
              <div className="text-foreground mt-2">{msg.body}</div>
            )}
          </div>
        );
      }
      if (pending) {
        return (
          <div className="mt-2 text-sm text-muted-foreground" role="status">
            {isEncryptedAttachment ? 'Decrypting image…' : 'Loading image…'}
          </div>
        );
      }
      return <div className="mt-2 text-sm text-muted-foreground">Image unavailable</div>;
    }

    if (msg.kind === 'audio' || msg.kind === 'video') {
      const kind = msg.kind;
      if (entry?.status === 'ready') {
        if (!isPlayableAs(entry.blobType, kind)) return downloadLink(entry.url);
        return (
          <div className="mt-2">
            {kind === 'audio' ? (
              <audio controls preload="metadata" src={entry.url} aria-label={`Audio: ${displayName}`} className="w-[min(320px,70vw)]" />
            ) : (
              <video controls preload="metadata" src={entry.url} aria-label={`Video: ${displayName}`} className="max-w-[min(320px,70vw)] max-h-[280px] rounded-lg border border-border/40" />
            )}
            {msg.body && msg.body !== msg.filename && msg.body !== displayName && (
              <div className="text-foreground mt-2">{msg.body}</div>
            )}
            {downloadLink(entry.url)}
          </div>
        );
      }
      if (pending) {
        return (
          <div className="mt-2 text-sm text-muted-foreground" role="status">
            {isEncryptedAttachment ? `Decrypting ${kind}…` : `Loading ${kind}…`}
          </div>
        );
      }
      return <div className="mt-2 text-sm text-muted-foreground">{kind === 'audio' ? 'Audio unavailable' : 'Video unavailable'}</div>;
    }

    if (entry?.status === 'ready') return downloadLink(entry.url);
    if (pending) {
      return (
        <div className="mt-2 text-sm text-muted-foreground">
          {isEncryptedAttachment ? 'Decrypting file…' : 'Loading file…'}
        </div>
      );
    }
    return <div className="mt-2 text-sm text-muted-foreground">File unavailable</div>;
  };

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
            {expectingHistory ? (
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
            const currentDateKey = getDateKey(msg.timestamp);
            const prevMsg = index > 0 ? messages[index - 1] : null;
            const showDateSeparator = currentDateKey !== (prevMsg ? getDateKey(prevMsg.timestamp) : null);
            const isOwnMessage = msg.sender === myUserId;
            const isSent = msg.sendState === 'sent';
            const canEdit = isOwnMessage && msg.textual && isSent && msg.hasServerId;
            const canDelete = canDeleteMsg(msg) && isSent && !msg.deleted;
            const msgReactions = view.reactions[msg.eventId];
            const threadCount = view.threads[msg.eventId]?.length ?? 0;

            return (
              <React.Fragment key={msg.key}>
                {showDateSeparator && (
                  <div className="flex items-center justify-center my-4" role="separator">
                    <div className="flex-1 h-px bg-border/50" />
                    <span className="px-3 text-xs font-medium text-muted-foreground">
                      {formatDateSeparator(msg.timestamp)}
                    </span>
                    <div className="flex-1 h-px bg-border/50" />
                  </div>
                )}

                {/* No mouse-leave close here: the picker is a fixed element rendered outside this wrapper, so moving the
                    cursor from the message into the picker leaves the wrapper and used to race a close that detached the
                    picker mid-interaction. It is dismissed instead by an outside press, Escape, or picking an emoji. */}
                <div data-message-id={msg.key} className="group relative mb-2">

                  {msg.hasServerId && !msg.deleted && (
                    <div
                      className={`absolute -top-5 right-0 z-10 flex items-center gap-px bg-card border border-border/60 rounded-xl px-1 py-0.5 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity duration-100${reactionPickerFor === msg.key ? ' !opacity-100' : ''}`}
                      data-testid="message-actions"
                    >
                      <div className="relative group/react">
                        <button
                          className={`h-6 w-6 flex items-center justify-center rounded-lg transition-colors ${reactionPickerFor === msg.key ? 'bg-accent/60 text-foreground' : 'text-muted-foreground hover:text-foreground hover:bg-accent/60'}`}
                          aria-label="Add reaction"
                          aria-expanded={reactionPickerFor === msg.key}
                          /* Stops the outside-press handler from closing the picker this very press is toggling */
                          onMouseDown={(e) => e.stopPropagation()}
                          onClick={(e) => {
                            if (reactionPickerFor === msg.key) {
                              closeReactionPicker(false);
                              return;
                            }
                            const rect = e.currentTarget.getBoundingClientRect();
                            pickerTriggerRef.current = e.currentTarget;
                            pickerByKeyboardRef.current = e.detail === 0;
                            setThreadPickerCoords(null);
                            setMainPickerPos({ top: rect.bottom + 4, left: Math.max(8, rect.right - 196) });
                            setReactionPickerFor(msg.key);
                          }}
                          data-testid="action-react"
                        >
                          <Smile className="h-3.5 w-3.5" />
                        </button>
                        <span className="pointer-events-none absolute top-full left-1/2 -translate-x-1/2 mt-1.5 px-1.5 py-0.5 rounded-md bg-card border border-border/60 text-[10px] leading-none whitespace-nowrap text-foreground opacity-0 group-hover/react:opacity-100 group-focus-within/react:opacity-100 transition-opacity z-30">
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
                        <span className="pointer-events-none absolute top-full left-1/2 -translate-x-1/2 mt-1.5 px-1.5 py-0.5 rounded-md bg-card border border-border/60 text-[10px] leading-none whitespace-nowrap text-foreground opacity-0 group-hover/reply:opacity-100 group-focus-within/reply:opacity-100 transition-opacity z-30">
                          Reply
                        </span>
                      </div>

                      <div className="relative group/thread">
                        <button
                          className="h-6 w-6 flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-accent/60 rounded-lg transition-colors"
                          aria-label="Reply in thread"
                          onClick={() => { setReactionPickerFor(null); setActiveThreadId(msg.eventId); }}
                          data-testid="action-thread"
                        >
                          <MessageSquare className="h-3.5 w-3.5" />
                        </button>
                        <span className="pointer-events-none absolute top-full left-1/2 -translate-x-1/2 mt-1.5 px-1.5 py-0.5 rounded-md bg-card border border-border/60 text-[10px] leading-none whitespace-nowrap text-foreground opacity-0 group-hover/thread:opacity-100 group-focus-within/thread:opacity-100 transition-opacity z-30">
                          Thread
                        </span>
                      </div>

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
                          <span className="pointer-events-none absolute top-full left-1/2 -translate-x-1/2 mt-1.5 px-1.5 py-0.5 rounded-md bg-card border border-border/60 text-[10px] leading-none whitespace-nowrap text-foreground opacity-0 group-hover/edit:opacity-100 group-focus-within/edit:opacity-100 transition-opacity z-30">
                            Edit
                          </span>
                        </div>
                      )}

                      {canDelete && (
                        <div className="relative group/delete">
                          <button
                            className="h-6 w-6 flex items-center justify-center text-muted-foreground hover:text-destructive hover:bg-destructive/10 rounded-lg transition-colors"
                            aria-label="Delete message"
                            onClick={(e) => { setReactionPickerFor(null); setEditingKey(null); setEditDraft(''); setConfirmingDeleteKey(prev => prev === msg.key ? null : msg.key); (e.currentTarget as HTMLButtonElement).blur(); }}
                            data-testid="action-delete"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                          <span className="pointer-events-none absolute top-full left-1/2 -translate-x-1/2 mt-1.5 px-1.5 py-0.5 rounded-md bg-card border border-border/60 text-[10px] leading-none whitespace-nowrap text-destructive opacity-0 group-hover/delete:opacity-100 group-focus-within/delete:opacity-100 transition-opacity z-30">
                            Delete
                          </span>
                        </div>
                      )}
                    </div>
                  )}

                  {/* Sending and failed messages are marked by their status labels rather than dimmed, since dimming a bubble drops its text below AA contrast */}
                  <div
                    className={['p-3 rounded-xl overflow-hidden break-words', bubbleClass, msg.sendState === 'failed' ? 'opacity-70' : '', msg.sendState === 'sending' ? 'opacity-80' : ''].join(' ')}
                    role="article"
                    aria-label={`Message from ${msg.sender}`}
                  >
                    <div className="text-sm text-muted-foreground flex items-center gap-2">
                      <span>{msg.sender}</span>
                      <SendState message={msg} onRetry={() => retrySend(msg)} onDiscard={() => discardSend(msg)} />
                      {msg.decryptionFailure && <span className="text-destructive text-xs" role="alert">🔒 Cannot decrypt</span>}
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

                    {!msg.deleted && MEDIA_KINDS.has(msg.kind) ? (
                      renderMedia(msg)
                    ) : msg.deleted ? (
                      <div className="text-sm italic text-muted-foreground/60" data-testid="deleted-message">
                        Message deleted.
                      </div>
                    ) : editingKey === msg.key ? (
                      <div className="mt-2 space-y-2" data-testid="edit-form">
                        <Input
                          value={editDraft}
                          onChange={(e) => setEditDraft(e.target.value)}
                          onKeyDown={(e) => {
                            if (isImeComposing(e)) return;
                            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submitEdit(msg); }
                            if (e.key === 'Escape') { setEditingKey(null); setEditDraft(''); }
                          }}
                          className="h-8 text-sm"
                          autoFocus
                          data-testid="edit-input"
                        />
                        <div className="flex gap-1.5">
                          <Button size="sm" variant="ghost" className="h-6 text-xs px-2" onClick={() => submitEdit(msg)} disabled={!editDraft.trim()} data-testid="edit-save">
                            Save
                          </Button>
                          <Button size="sm" variant="ghost" className="h-6 text-xs px-2" onClick={() => { setEditingKey(null); setEditDraft(''); }} data-testid="edit-cancel">
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
                      </div>
                    )}

                    {confirmingDeleteKey === msg.key && !msg.deleted && (
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
                            onClick={() => setConfirmingDeleteKey(null)}
                            data-testid="delete-cancel"
                          >
                            Cancel
                          </Button>
                        </div>
                      </div>
                    )}

                    <div className="text-xs text-muted-foreground/80 mt-1">{formatMessageTime(msg.timestamp)}</div>

                    {!msg.deleted && msgReactions && msgReactions.length > 0 && (
                      <div className="flex flex-wrap gap-1 mt-2" data-testid="reaction-list">
                        {msgReactions.map((r) => (
                          <button
                            key={r.key}
                            className={[
                              'inline-flex items-center gap-1 text-xs rounded-full px-2 py-0.5 border transition-colors',
                              r.mine
                                ? 'bg-sky-500/20 border-sky-500/40 text-foreground hover:bg-sky-500/30'
                                : 'bg-muted/40 border-border/40 hover:bg-accent/60',
                            ].join(' ')}
                            aria-label={`${r.key} reaction, ${r.count} ${r.count === 1 ? 'person' : 'people'}${r.mine ? ', you reacted' : ''}`}
                            onClick={() => toggleReaction(msg, r.key)}
                            data-testid="reaction-badge"
                          >
                            <span>{r.key}</span>
                            <span>{r.count}</span>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>

                  {threadCount > 0 && (
                    <button
                      className="mt-1 flex items-center gap-1 text-xs text-sky-600 dark:text-sky-400 hover:text-sky-500 dark:hover:text-sky-300 transition-colors"
                      onClick={() => setActiveThreadId(msg.eventId)}
                      data-testid="thread-count"
                    >
                      <MessageSquare className="h-3 w-3" />
                      {threadCount} {threadCount === 1 ? 'reply' : 'replies'}
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
              const allMessages = [...(threadRoot ? [threadRoot] : []), ...threadReplies];
              if (allMessages.length === 0) {
                return <div className="text-xs text-muted-foreground text-center py-6">No messages yet.</div>;
              }
              return allMessages.map((m) => {
                const tmSent = m.sendState === 'sent';
                const tmCanEdit = m.sender === myUserId && m.textual && tmSent && m.hasServerId;
                const tmCanDelete = canDeleteMsg(m) && tmSent && !m.deleted;
                const tmReactions = view.reactions[m.eventId];
                /* No mouse-leave close here (see the main timeline): it raced a close that detached the picker mid-interaction */
                return (
                  <div key={m.key} role="article" aria-label={`Thread message from ${m.sender}`} data-testid="thread-message" data-message-id={m.key} className="group relative break-words">
                    <div className="text-xs text-muted-foreground font-medium flex items-center gap-2">
                      <span>{m.sender}</span>
                      <SendState message={m} onRetry={() => retrySend(m)} onDiscard={() => discardSend(m)} />
                    </div>

                    {m.hasServerId && !m.deleted && (
                      <div className={`absolute -top-5 right-0 z-10 flex items-center gap-px bg-card border border-border/60 rounded-xl px-1 py-0.5 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity duration-100${reactionPickerFor === m.key ? ' !opacity-100' : ''}`}>
                        <button
                          className={`h-6 w-6 flex items-center justify-center rounded-lg transition-colors ${reactionPickerFor === m.key ? 'bg-accent/60 text-foreground' : 'text-muted-foreground hover:text-foreground hover:bg-accent/60'}`}
                          aria-label="Add reaction"
                          aria-expanded={reactionPickerFor === m.key}
                          onMouseDown={(e) => e.stopPropagation()}
                          onClick={(e) => {
                            if (reactionPickerFor === m.key) {
                              closeReactionPicker(false);
                              return;
                            }
                            const btnRect = e.currentTarget.getBoundingClientRect();
                            const panelTop = e.currentTarget.closest('[data-testid="thread-panel"]')?.getBoundingClientRect().top ?? 0;
                            pickerTriggerRef.current = e.currentTarget;
                            pickerByKeyboardRef.current = e.detail === 0;
                            setMainPickerPos(null);
                            setThreadPickerCoords({ top: btnRect.bottom + 4 - panelTop, right: window.innerWidth - btnRect.right - 5 });
                            setReactionPickerFor(m.key);
                          }}
                        >
                          <Smile className="h-3.5 w-3.5" />
                        </button>
                        <button
                          className="h-6 w-6 flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-accent/60 rounded-lg transition-colors"
                          aria-label="Reply"
                          onClick={(e) => {
                            setReactionPickerFor(null);
                            setThreadReplyToId(m.eventId);
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
                              setConfirmingDeleteThreadKey(null);
                              if (editingThreadKey === m.key) { setEditingThreadKey(null); setEditThreadDraft(''); }
                              else { setEditingThreadKey(m.key); setEditThreadDraft(m.body); }
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
                            onClick={(e) => { setReactionPickerFor(null); setEditingThreadKey(null); setEditThreadDraft(''); setConfirmingDeleteThreadKey(prev => prev === m.key ? null : m.key); (e.currentTarget as HTMLButtonElement).blur(); }}
                            data-testid="thread-action-delete"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        )}
                      </div>
                    )}

                    {m.deleted ? (
                      <div className="text-sm italic text-muted-foreground/60 mt-0.5">Message deleted.</div>
                    ) : editingThreadKey === m.key ? (
                      <div className="mt-1 space-y-1.5">
                        <Input
                          value={editThreadDraft}
                          onChange={(e) => setEditThreadDraft(e.target.value)}
                          onKeyDown={(e) => {
                            if (isImeComposing(e)) return;
                            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submitEditThread(m); }
                            if (e.key === 'Escape') { setEditingThreadKey(null); setEditThreadDraft(''); }
                          }}
                          className="h-7 text-xs"
                          autoFocus
                          data-testid="thread-edit-input"
                        />
                        <div className="flex gap-1">
                          <Button size="sm" variant="ghost" className="h-5 text-[11px] px-1.5" onClick={() => submitEditThread(m)} disabled={!editThreadDraft.trim()} data-testid="thread-edit-save">Save</Button>
                          <Button size="sm" variant="ghost" className="h-5 text-[11px] px-1.5" onClick={() => { setEditingThreadKey(null); setEditThreadDraft(''); }} data-testid="thread-edit-cancel">Cancel</Button>
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
                        {m.edited && <span className="ml-1 text-[10px] text-muted-foreground">(edited)</span>}
                        {confirmingDeleteThreadKey === m.key && (
                          <div className="mt-1.5" data-testid="thread-delete-confirm">
                            <div className="text-xs text-muted-foreground/70 mb-1">Delete this message?</div>
                            <div className="flex gap-1">
                              <Button size="sm" variant="ghost" className="h-5 text-[11px] px-1.5 text-destructive hover:text-destructive hover:bg-destructive/10" onClick={() => handleDelete(m)} data-testid="thread-delete-confirm-yes">Delete</Button>
                              <Button size="sm" variant="ghost" className="h-5 text-[11px] px-1.5" onClick={() => setConfirmingDeleteThreadKey(null)} data-testid="thread-delete-cancel">Cancel</Button>
                            </div>
                          </div>
                        )}
                      </div>
                    )}

                    {!m.deleted && tmReactions && tmReactions.length > 0 && (
                      <div className="flex flex-wrap gap-1 mt-1.5">
                        {tmReactions.map((r) => (
                          <button
                            key={r.key}
                            className={[
                              'inline-flex items-center gap-1 text-xs rounded-full px-1.5 py-0.5 border transition-colors',
                              r.mine
                                ? 'bg-sky-500/20 border-sky-500/40 text-foreground hover:bg-sky-500/30'
                                : 'bg-muted/40 border-border/40 hover:bg-accent/60',
                            ].join(' ')}
                            onClick={() => toggleReaction(m, r.key)}
                          >
                            <span>{r.key}</span>
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

          {reactionPickerFor && threadPickerCoords && (
            <ReactionPicker
              ref={threadReactionPickerRef}
              className="absolute z-[100] bg-card border border-border/60 rounded-xl p-1.5 w-[160px]"
              gridClassName="grid grid-cols-5 gap-0.5"
              buttonClassName="h-7 w-7 rounded-lg text-sm hover:bg-accent/60 dark:hover:bg-muted/50 transition-colors flex items-center justify-center"
              style={{ top: threadPickerCoords.top, right: threadPickerCoords.right }}
              onPick={(emoji) => {
                /* Looked up at pick time so a background thread update cannot unmount the open picker */
                const target = [...threadReplies, ...(threadRoot ? [threadRoot] : [])].find(mm => mm.key === reactionPickerFor);
                closeReactionPicker(pickerByKeyboardRef.current);
                if (target) void toggleReaction(target, emoji);
              }}
              onEscape={() => closeReactionPicker(true)}
              onMouseLeave={(e) => {
                const rt = e.relatedTarget as Element | null;
                if (rt?.closest?.('[data-message-id]')?.getAttribute('data-message-id') === reactionPickerFor) return;
                closeReactionPicker(false);
              }}
            />
          )}

          <div className="shrink-0 border-t border-border px-3 py-2 relative">
            {threadReplyTarget && (
              <div className="absolute bottom-full left-0 right-0 px-3 pb-1">
                <div className="flex items-center justify-between gap-2 rounded-xl border border-border/60 bg-card px-3 py-1.5">
                  <div className="flex items-start gap-1.5 min-w-0">
                    <Reply className="h-3 w-3 text-muted-foreground shrink-0 mt-0.5" />
                    <div className="text-xs text-muted-foreground min-w-0 truncate">
                      <span className="font-medium text-foreground mr-1">{threadReplyTarget.sender}</span>
                      <span>{quoteText(threadReplyTarget)}</span>
                    </div>
                  </div>
                  <button className="shrink-0 text-muted-foreground hover:text-foreground" onClick={() => setThreadReplyToId(null)}>
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
                  if (e.key === 'Enter' && !e.shiftKey && !isImeComposing(e)) { e.preventDefault(); sendThreadReply(); }
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

      {reactionPickerFor && mainPickerPos && (
        <ReactionPicker
          ref={reactionPickerRef}
          className="z-50 bg-card border border-border/60 rounded-xl p-2 w-[196px]"
          gridClassName="grid grid-cols-5 gap-1"
          buttonClassName="h-8 w-8 rounded-xl text-base hover:bg-accent/60 dark:hover:bg-muted/50 transition-colors flex items-center justify-center"
          style={{ position: 'fixed', top: mainPickerPos.top, left: mainPickerPos.left }}
          testId="reaction-picker"
          onPick={(emoji) => {
            /* The message is looked up at pick time rather than gating the render on it, so a background
               timeline update can never unmount the open picker and detach the button mid-click. The
               react trigger is already only shown for messages with a server id (msg.hasServerId). */
            const target = messages.find(m => m.key === reactionPickerFor);
            closeReactionPicker(pickerByKeyboardRef.current);
            if (target?.hasServerId) void toggleReaction(target, emoji);
          }}
          onEscape={() => closeReactionPicker(true)}
          onMouseLeave={(e) => {
            const rt = e.relatedTarget as Element | null;
            if (rt?.closest?.('[data-message-id]')?.getAttribute('data-message-id') === reactionPickerFor) return;
            closeReactionPicker(false);
          }}
        />
      )}

      {lightboxUrl && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm"
          onClick={() => setLightboxKey(null)}
        >
          <button
            onClick={() => setLightboxKey(null)}
            className="absolute top-4 right-4 text-white/60 hover:text-white hover:scale-110 transition-all duration-150 text-3xl font-light leading-none p-2"
            aria-label="Close"
          >
            ×
          </button>
          {/* eslint-disable-next-line @next/next/no-img-element -- blob URLs of decrypted media cannot go through next/image */}
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