/* eslint-disable @typescript-eslint/no-explicit-any */
'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { getMatrixClient, logoutMatrixClient } from '../utils/matrix';
import { isUnknownToken, formatBytes, encryptAttachment } from '../utils/helpers';
import { isImeComposing } from '../utils/keyboard';
import { ATTACHABLE_IMAGE_TYPES, isAttachableImageType } from '../utils/media';
import { prepareImageForUpload } from '../utils/image-upload';
import { uploadWithSessionRefresh } from '../utils/upload';
import { MsgType, EventType, KnownMembership, MatrixClient, ClientEvent, RoomEvent, Room, type UploadResponse } from 'matrix-js-sdk';
import type { RoomMessageEventContent } from 'matrix-js-sdk/lib/types';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Smile, ImageIcon, Reply, X } from 'lucide-react';

interface MessageInputProps {
  roomId: string;
}

/* Reads the mxc URI of an upload, which the homeserver must return for the message to point at */
const contentUriOf = (upload: UploadResponse): string => {
  if (!upload?.content_uri) throw new Error('Upload failed (no content_uri)');
  return upload.content_uri;
};

/* Wraps a promise with a hard timeout so a stalled upload or send can't block the UI */
const withTimeout = async <T,>(p: Promise<T>, ms: number) => {
  let t: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      p,
      new Promise<T>((_, reject) => {
        t = setTimeout(() => reject(new Error('Timed out sending message')), ms);
      }),
    ]);
  } finally {
    if (t) clearTimeout(t);
  }
};

const EMOJIS = ['😀', '😂', '😍', '😭', '😡', '👍', '🙏', '🔥', '🎉', '💯', '✅', '❌', '❤️', '🧠', '✨'];

const MessageInput: React.FC<MessageInputProps> = ({ roomId }) => {
  const [message, setMessage] = useState<string>('');
  const [sending, setSending] = useState<boolean>(false);
  const [canSend, setCanSend] = useState<boolean>(false);
  const [placeholder, setPlaceholder] = useState<string>('Connecting…');
  const [showEmojis, setShowEmojis] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);
  const [pickedFile, setPickedFile] = useState<File | null>(null);
  const [replyTo, setReplyTo] = useState<{ eventId: string; sender: string; body: string } | null>(null);
  const mountedRef = useRef(true);
  const clientRef = useRef<MatrixClient | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const emojiRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    /* Populates the reply banner when a nexus-reply-to event fires */
    const onReplyTo = (e: Event) => {
      const detail = (e as CustomEvent<{ eventId: string; sender: string; body: string }>).detail;
      setReplyTo(detail);
      requestAnimationFrame(() => inputRef.current?.focus());
    };
    window.addEventListener('nexus-reply-to', onReplyTo);
    return () => window.removeEventListener('nexus-reply-to', onReplyTo);
  }, []);

  useEffect(() => {
    /* Keeps the reply banner body in sync when the quoted message is edited */
    const onUpdate = (e: Event) => {
      const { eventId, body } = (e as CustomEvent<{ eventId: string; body: string }>).detail;
      setReplyTo(prev => prev?.eventId === eventId ? { ...prev, body } : prev);
    };
    window.addEventListener('nexus-reply-body-update', onUpdate);
    return () => window.removeEventListener('nexus-reply-body-update', onUpdate);
  }, []);

  useEffect(() => {
    if (!showEmojis) return;
    const onDocClick = (e: MouseEvent) => {
      if (emojiRef.current && !emojiRef.current.contains(e.target as Node)) {
        setShowEmojis(false);
      }
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [showEmojis]);

  /* Derives send permission from membership, room existence, and message power level, plus placeholder text */
  const computeCanSend = useCallback(
    (client: MatrixClient | null): { canSend: boolean; placeholder: string } => {
      if (!client) return { canSend: false, placeholder: 'Connecting…' };

      const room: Room | null = client.getRoom(roomId) || null;
      if (!room) return { canSend: false, placeholder: 'Loading room…' };

      const membership = room.getMyMembership?.();
      if (membership !== KnownMembership.Join) return { canSend: false, placeholder: 'You are not joined to this room' };

      const userId = client.getUserId?.() || '';
      const maySend =
        typeof room.currentState?.maySendEvent === 'function'
          ? !!room.currentState.maySendEvent(EventType.RoomMessage, userId)
          : true;

      if (!maySend) return { canSend: false, placeholder: 'You cannot send messages in this room' };

      return { canSend: true, placeholder: 'Type a message' };
    },
    [roomId]
  );

  const applyPermissionState = useCallback(
    (client: MatrixClient | null) => {
      if (!mountedRef.current) return;

      const next = computeCanSend(client);
      setCanSend(next.canSend);
      setPlaceholder(next.placeholder);

      if (!next.canSend) {
        setSending(false);
        setMessage('');
        setPickedFile(null);
        setFileError(null);
        setShowEmojis(false);
      }
    },
    [computeCanSend]
  );

  useEffect(() => {
    if (typeof window === 'undefined') return;

    const onSync = () => applyPermissionState(clientRef.current);

    const onMyMembership = (room: Room) => {
      if (room.roomId !== roomId) return;
      applyPermissionState(clientRef.current);
    };

    const attach = () => {
      try {
        clientRef.current = getMatrixClient();
      } catch {
        clientRef.current = null;
      }

      applyPermissionState(clientRef.current);

      const c = clientRef.current as any;
      if (c?.on) {
        try { c.on(ClientEvent.Sync, onSync); } catch {}
        try { c.on(RoomEvent.MyMembership, onMyMembership); } catch {}
      }
    };

    const detach = () => {
      const c = clientRef.current as any;
      if (c?.removeListener) {
        try { c.removeListener(ClientEvent.Sync, onSync); } catch {}
        try { c.removeListener(RoomEvent.MyMembership, onMyMembership); } catch {}
      }

      clientRef.current = null;

      if (!mountedRef.current) return;
      setCanSend(false);
      setSending(false);
      setMessage('');
      setPickedFile(null);
      setFileError(null);
      setShowEmojis(false);
      setReplyTo(null);
      setPlaceholder('Connecting…');
    };

    if (window.__matrix_ready) attach();
    else detach();

    window.addEventListener('matrix-ready', attach);
    window.addEventListener('matrix-not-ready', detach);

    return () => {
      window.removeEventListener('matrix-ready', attach);
      window.removeEventListener('matrix-not-ready', detach);
      detach();
    };
  }, [applyPermissionState, roomId]);

  useEffect(() => {
    applyPermissionState(clientRef.current);
  }, [roomId, applyPermissionState]);

  const handleAuthInvalid = () => {
    logoutMatrixClient();
    if (!mountedRef.current) return;
    setCanSend(false);
    setSending(false);
    setMessage('');
    setPickedFile(null);
    setShowEmojis(false);
    setPlaceholder('Session expired. Please sign in again.');
  };

  const isRoomEncrypted = (c: MatrixClient) => {
    const anyC = c as any;
    if (typeof anyC.isRoomEncrypted === 'function') {
      try { return !!anyC.isRoomEncrypted(roomId); } catch {}
    }
    const r = c.getRoom(roomId) || null;
    const anyR = r as any;
    if (typeof anyR?.hasEncryptionStateEvent === 'function') {
      try { return !!anyR.hasEncryptionStateEvent(); } catch {}
    }
    return false;
  };

  /* Uploads the picked image, encrypting it first in an encrypted room, and returns the content of the message that shows it */
  const uploadImage = async (matrixClient: MatrixClient, file: File, caption: string): Promise<Record<string, unknown>> => {
    const { blob, mimetype, filename, width, height } = await prepareImageForUpload(file);
    const content = { msgtype: MsgType.Image, body: caption || filename, filename, info: { mimetype, size: blob.size, w: width, h: height } };

    if (isRoomEncrypted(matrixClient)) {
      const enc = await encryptAttachment(await blob.arrayBuffer());
      /* The file name of an encrypted attachment belongs only inside the encrypted event, so the upload URL must not carry it */
      const upload = await withTimeout(
        uploadWithSessionRefresh(matrixClient, enc.data, { type: 'application/octet-stream', includeFilename: false }),
        30000
      );
      return { ...content, file: { ...enc.info, url: contentUriOf(upload) } };
    }

    const upload = await withTimeout(uploadWithSessionRefresh(matrixClient, blob, { type: mimetype, name: filename }), 30000);
    return { ...content, url: contentUriOf(upload) };
  };

  const handleSendError = (err: any) => {
    const errcode = err?.errcode ?? err?.data?.errcode;

    if (isUnknownToken(err)) {
      handleAuthInvalid();
      return;
    }

    if (errcode === 'M_FORBIDDEN' || errcode === 'M_NOT_FOUND') {
      setCanSend(false);
      setPlaceholder(errcode === 'M_FORBIDDEN' ? 'You cannot send messages in this room' : 'Room not found or you are not joined');
      setMessage('');
      setPickedFile(null);
      setShowEmojis(false);
      return;
    }

    if (errcode === 'M_LIMIT_EXCEEDED') {
      const ms = err?.data?.retry_after_ms ?? err?.retry_after_ms;
      setPlaceholder(ms ? `Rate limited. Try again in ${Math.ceil(ms / 1000)}s.` : 'Rate limited. Please wait.');
      return;
    }

    setPlaceholder(err?.message === 'Timed out sending message' ? 'Sending timed out. Please try again.' : 'Failed to send');
  };

  const sendMessage = async () => {
    /* Re-check permissions at send time in case room state changed while the input was focused */
    const body = message.trim();
    if ((body.length === 0 && !pickedFile) || sending || !canSend) return;

    let matrixClient: MatrixClient;
    try {
      matrixClient = getMatrixClient();
      clientRef.current = matrixClient;
    } catch {
      if (!mountedRef.current) return;
      setCanSend(false);
      setPlaceholder('Not connected. Please sign in again.');
      return;
    }

    const next = computeCanSend(matrixClient);
    if (!next.canSend) {
      if (!mountedRef.current) return;
      setCanSend(false);
      setPlaceholder(next.placeholder);
      setMessage('');
      setPickedFile(null);
      setShowEmojis(false);
      return;
    }

    const reply = replyTo;
    let content: Record<string, unknown> = { msgtype: MsgType.Text, body };
    if (pickedFile) {
      setSending(true);
      try {
        content = await uploadImage(matrixClient, pickedFile, body);
      } catch (err) {
        if (!mountedRef.current) return;
        setSending(false);
        handleSendError(err);
        return;
      }
      if (!mountedRef.current) return;
    }
    if (reply) content['m.relates_to'] = { 'm.in_reply_to': { event_id: reply.eventId } };

    /* sendEvent puts the message in the timeline at once, where a failed send offers Retry and Delete, so the draft is cleared now instead of lingering as a second copy */
    let sent: Promise<unknown>;
    try {
      sent = matrixClient.sendEvent(roomId, EventType.RoomMessage, content as unknown as RoomMessageEventContent);
    } catch (err) {
      setSending(false);
      handleSendError(err);
      return;
    }
    setMessage('');
    setPickedFile(null);
    setReplyTo(null);
    setShowEmojis(false);
    setSending(false);
    requestAnimationFrame(() => {
      inputRef.current?.focus();
    });

    try {
      await sent;
      if (mountedRef.current) setPlaceholder('Type a message');
    } catch (err) {
      if (mountedRef.current) handleSendError(err);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Enter' || isImeComposing(e)) return;
    e.preventDefault();
    sendMessage();
  };

  const insertEmoji = (e: string) => {
    setMessage((m) => (m ? `${m}${e}` : e));
    setShowEmojis(false);
  };

  const disabled = !canSend || sending;

  return (
    <div className="bg-transparent relative" data-testid="composer">
      {replyTo && (
        <div className="absolute bottom-full left-0 right-0 px-2 pb-1">
          <div className="flex items-center justify-between gap-2 rounded-xl border border-border/60 bg-card px-3 py-1.5" data-testid="reply-banner">
            <div className="flex items-start gap-1.5 min-w-0">
              <Reply className="h-3.5 w-3.5 text-muted-foreground shrink-0 mt-0.5" />
              <div className="text-xs text-muted-foreground min-w-0 truncate">
                <span className="font-medium text-foreground mr-1">{replyTo.sender}</span>
                <span>{replyTo.body}</span>
              </div>
            </div>
            <button
              type="button"
              className="shrink-0 text-muted-foreground hover:text-foreground transition-colors"
              aria-label="Cancel reply"
              onClick={() => setReplyTo(null)}
              data-testid="reply-cancel"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      )}
      <div className="glass-flush-left rounded-none no-border-top no-border-left no-border-right no-border-bottom glass-opaque px-1 py-3">
        <div className="flex items-center gap-[4px]">

          <div ref={emojiRef} className="relative shrink-0">
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={() => setShowEmojis((v) => !v)}
              disabled={disabled}
              aria-label="Emoji"
              className="header-icon-btn hover:bg-accent/60 dark:hover:bg-muted/50"
            >
              <Smile className="h-5 w-5 text-muted-foreground" />
            </Button>

            {showEmojis && (
              <div className="absolute bottom-12 left-0 z-50 bg-background rounded-2xl border border-border/60 p-2 shadow-none w-[196px]">
                <div className="grid grid-cols-5 gap-1">
                  {EMOJIS.map((e) => (
                    <button
                      key={e}
                      type="button"
                      className="h-8 w-8 rounded-xl text-base hover:bg-accent/60 dark:hover:bg-muted/50 transition-colors flex items-center justify-center"
                      onClick={() => insertEmoji(e)}
                    >
                      {e}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>

          <input
            ref={fileInputRef}
            type="file"
            accept={ATTACHABLE_IMAGE_TYPES.join(',')}
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0] || null;
              if (fileInputRef.current) fileInputRef.current.value = '';
              if (!f) return;
              if (!isAttachableImageType(f.type)) {
                setFileError('Only images can be attached. Please pick a JPG, PNG, GIF, or WebP file.');
                setPickedFile(null);
                return;
              }
              setFileError(null);
              setPickedFile(f);
            }}
          />

          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={() => fileInputRef.current?.click()}
            disabled={disabled}
            aria-label="Attach image"
            className="header-icon-btn hover:bg-accent/60 dark:hover:bg-muted/50 shrink-0"
          >
            <ImageIcon className="h-5 w-5 text-muted-foreground" />
          </Button>

          <Input
            ref={inputRef}
            type="text"
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={placeholder}
            disabled={disabled}
            autoComplete="off"
            className="flex-1"
          />

          <Button onClick={sendMessage} disabled={disabled} className="shrink-0 mr-1">
            Send
          </Button>
        </div>

        {fileError && (
          <div className="mt-2 flex items-center gap-2 text-xs text-destructive">
            <span>{fileError}</span>
            <button type="button" className="underline" onClick={() => setFileError(null)}>
              dismiss
            </button>
          </div>
        )}

        {pickedFile && (
          <div className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
            <span className="truncate max-w-[70%]">
              Attached: {pickedFile.name}
              {pickedFile.size ? ` (${formatBytes(pickedFile.size)})` : ''}
            </span>
            <button type="button" className="underline" onClick={() => { setPickedFile(null); setFileError(null); }} disabled={disabled}>
              remove
            </button>
          </div>
        )}
      </div>
    </div>
  );
};

export default MessageInput;