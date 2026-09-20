/* eslint-disable @typescript-eslint/no-explicit-any */
'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { getMatrixClient, logoutMatrixClient } from '../utils/matrix';
import { isUnknownToken, formatBytes, encryptAttachment } from '../utils/helpers';
import { MsgType, EventType, KnownMembership, MatrixClient, ClientEvent, RoomEvent, Room } from 'matrix-js-sdk';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Smile, ImageIcon, Reply, X } from 'lucide-react';

interface MessageInputProps {
  roomId: string;
}

type UploadResp = { content_uri?: string; contentUri?: string };

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

  const getImageDims = (file: File) =>
    new Promise<{ w?: number; h?: number }>((resolve) => {
      const img = new Image();
      img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
      img.onerror = () => resolve({});
      const src = URL.createObjectURL(file);
      img.src = src;
      setTimeout(() => { try { URL.revokeObjectURL(src); } catch {} }, 0);
    });

  const MAX_UNCOMPRESSED_BYTES = 100 * 1024;
  const TARGET_COMPRESSED_BYTES = 400 * 1024;

  const compressImage = (file: File): Promise<{ blob: Blob; width: number; height: number }> =>
    new Promise((resolve, reject) => {
      const img = new Image();
      const srcUrl = URL.createObjectURL(file);

      img.onload = () => {
        URL.revokeObjectURL(srcUrl);
        let { naturalWidth: w, naturalHeight: h } = img;

        const MAX_DIM = 1920;
        if (w > MAX_DIM || h > MAX_DIM) {
          const scale = Math.min(MAX_DIM / w, MAX_DIM / h);
          w = Math.round(w * scale);
          h = Math.round(h * scale);
        }

        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        if (!ctx) { reject(new Error('Canvas not available')); return; }
        ctx.drawImage(img, 0, 0, w, h);

        const tryQuality = (q: number) => {
          canvas.toBlob((blob) => {
            if (!blob) { reject(new Error('Compression failed')); return; }
            if (blob.size <= TARGET_COMPRESSED_BYTES || q <= 0.4) {
              resolve({ blob, width: w, height: h });
            } else {
              tryQuality(Math.max(0.4, q - 0.1));
            }
          }, 'image/jpeg', q);
        };

        tryQuality(0.85);
      };

      img.onerror = () => { URL.revokeObjectURL(srcUrl); reject(new Error('Could not load image')); };
      img.src = srcUrl;
    });

  const sendFile = async (matrixClient: MatrixClient, file: File) => {
    const encryptedRoom = isRoomEncrypted(matrixClient);
    const caption = message.trim();

    let uploadBlob: Blob = file;
    let filename = file.name || 'image.jpg';
    let mimetype = 'image/jpeg';
    let imgWidth: number | undefined;
    let imgHeight: number | undefined;

    /* Compress oversized files before upload, scaling down anything past 1920px on either axis */
    if (file.size > MAX_UNCOMPRESSED_BYTES) {
      const compressed = await compressImage(file);
      uploadBlob = compressed.blob;
      imgWidth = compressed.width;
      imgHeight = compressed.height;
      filename = filename.replace(/\.[^.]+$/, '') + '.jpg';
    } else {
      const dims = await getImageDims(file);
      imgWidth = dims.w;
      imgHeight = dims.h;
      mimetype = file.type || 'image/jpeg';
    }

    const size = uploadBlob.size;
    const bodyLabel = caption || filename;

    /* Encrypt before upload, sending bytes as application/octet-stream with decryption info in the event */
    if (encryptedRoom) {
      const plaintext = await uploadBlob.arrayBuffer();
      const enc = await encryptAttachment(plaintext);

      const uploadResp = (await withTimeout(
        (matrixClient as any).uploadContent(enc.data, {
          type: 'application/octet-stream',
          name: filename,
          rawResponse: false,
          onlyContentUri: false,
        }),
        30000
      )) as UploadResp;

      const mxcUrl = uploadResp.content_uri || uploadResp.contentUri;
      if (!mxcUrl) throw new Error('Upload failed (no content_uri)');

      await withTimeout(
        (matrixClient as any).sendEvent(roomId, EventType.RoomMessage, {
          msgtype: MsgType.Image,
          body: bodyLabel,
          filename,
          info: { mimetype, size, w: imgWidth, h: imgHeight },
          file: { ...enc.info, url: mxcUrl },
          ...(replyTo ? { 'm.relates_to': { 'm.in_reply_to': { event_id: replyTo.eventId } } } : {}),
        }),
        30000
      );
      return;
    }

    const uploadResp = (await withTimeout(
      (matrixClient as any).uploadContent(uploadBlob, {
        type: mimetype,
        name: filename,
        rawResponse: false,
        onlyContentUri: false,
      }),
      30000
    )) as UploadResp;

    const mxcUrl = uploadResp.content_uri || uploadResp.contentUri;
    if (!mxcUrl) throw new Error('Upload failed (no content_uri)');

    await withTimeout(
      (matrixClient as any).sendEvent(roomId, EventType.RoomMessage, {
        msgtype: MsgType.Image,
        body: bodyLabel,
        filename,
        info: { mimetype, size, w: imgWidth, h: imgHeight },
        url: mxcUrl,
        ...(replyTo ? { 'm.relates_to': { 'm.in_reply_to': { event_id: replyTo.eventId } } } : {}),
      }),
      30000
    );
  };

  const sendText = async (matrixClient: MatrixClient, body: string) => {
    const content: any = { msgtype: MsgType.Text, body };
    if (replyTo) {
      content['m.relates_to'] = { 'm.in_reply_to': { event_id: replyTo.eventId } };
    }
    await withTimeout(
      (matrixClient as any).sendEvent(roomId, EventType.RoomMessage, content),
      12000
    );
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

    if (!mountedRef.current) return;
    setSending(true);

    try {
      if (pickedFile) {
        await sendFile(matrixClient, pickedFile);
        if (!mountedRef.current) return;
        setMessage('');
        setPickedFile(null);
        setReplyTo(null);
        setShowEmojis(false);
        setPlaceholder('Type a message');
        return;
      }

      await sendText(matrixClient, body);

      if (!mountedRef.current) return;
      setMessage('');
      setReplyTo(null);
      setShowEmojis(false);
      setPlaceholder('Type a message');
    } catch (err: any) {
      if (!mountedRef.current) return;

      const errcode = err?.errcode ?? err?.data?.errcode;

      if (isUnknownToken(err)) {
        handleAuthInvalid();
        return;
      }

      if (errcode === 'M_FORBIDDEN') {
        setCanSend(false);
        setPlaceholder('You cannot send messages in this room');
        setMessage('');
        setPickedFile(null);
        setShowEmojis(false);
        return;
      }

      if (errcode === 'M_NOT_FOUND') {
        setCanSend(false);
        setPlaceholder('Room not found or you are not joined');
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

      setPlaceholder(err?.message === 'Timed out sending message' ? 'Send timed out. Please sign in again.' : 'Failed to send');
    } finally {
      if (!mountedRef.current) return;
      setSending(false);
      requestAnimationFrame(() => {
        inputRef.current?.focus();
      });
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      sendMessage();
    }
  };

  const insertEmoji = (e: string) => {
    setMessage((m) => (m ? `${m}${e}` : e));
    setShowEmojis(false);
  };

  const disabled = !canSend || sending;

  return (
    <div className="bg-transparent relative">
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
            accept="image/*"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0] || null;
              if (fileInputRef.current) fileInputRef.current.value = '';
              if (!f) return;
              if (!f.type.startsWith('image/')) {
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