'use client';

import React, { useId, useRef, useState } from 'react';
import ReactDOM from 'react-dom';
import type { MatrixClient } from 'matrix-js-sdk';
import toast from 'react-hot-toast';
import { X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { trapTabKey } from './dialogFocus';

/* A user ID is @localpart:server, where the localpart is printable ASCII other than a colon and the server may be an IPv6 literal or carry a port */
const USER_ID_PATTERN = /^@[\x21-\x39\x3b-\x7e]+:(?:\[[0-9a-fA-F:.]+\]|[a-zA-Z0-9.-]+)(?::\d{1,5})?$/;

export const isValidUserId = (value: string): boolean => value.length <= 255 && USER_ID_PATTERN.test(value);

interface InviteDialogProps {
  client: MatrixClient;
  roomId: string;
  returnFocusTo?: HTMLElement | null;
  onClose: () => void;
}

/* Modal that invites one user into a room, validating the ID first and allowing a single request at a time */
const InviteDialog: React.FC<InviteDialogProps> = ({ client, roomId, returnFocusTo, onClose }) => {
  const [userId, setUserId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const sendingRef = useRef(false);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const titleId = useId();
  const errorId = useId();

  const close = () => {
    onClose();
    if (returnFocusTo?.isConnected) returnFocusTo.focus();
  };

  const submit = async () => {
    const target = userId.trim();
    if (!target || sendingRef.current) return;
    if (!isValidUserId(target)) {
      setError('Enter a full Matrix ID, like @name:server');
      return;
    }

    sendingRef.current = true;
    setSending(true);
    setError(null);
    try {
      await client.invite(roomId, target);
      toast.success('Invited!');
      close();
    } catch {
      toast.error('Invite failed');
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  };

  const onDialogKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      close();
      return;
    }
    trapTabKey(e, dialogRef.current);
  };

  if (typeof document === 'undefined') return null;

  return ReactDOM.createPortal(
    <div className="fixed inset-0 z-[200] flex items-center justify-center">
      <div className="absolute inset-0 bg-background/40 backdrop-blur-[2px]" onClick={close} />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onKeyDown={onDialogKeyDown}
        className="relative w-[92vw] max-w-[320px] glass rounded-3xl p-5 border border-border/70 shadow-none"
      >
        <button type="button" aria-label="Close" onClick={close} className="absolute top-3 right-3 rounded-full p-2 hover:bg-muted/60 dark:hover:bg-muted/50 transition">
          <X className="h-5 w-5" />
        </button>

        <div className="text-center mb-4">
          <div id={titleId} className="text-base font-semibold text-foreground">Invite someone</div>
          <div className="text-xs text-muted-foreground mt-1">Enter their Matrix user ID and invite them</div>
        </div>

        <div className="flex flex-col items-center">
          <Input
            placeholder="@user:matrix.org"
            aria-label="Matrix user ID"
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? errorId : undefined}
            value={userId}
            onChange={(e) => {
              setUserId(e.target.value);
              setError(null);
            }}
            onKeyDown={(e) => {
              /* Enter that confirms an IME composition belongs to the composition, not to the form */
              if (e.key !== 'Enter' || e.nativeEvent.isComposing || e.keyCode === 229) return;
              e.preventDefault();
              void submit();
            }}
            autoFocus
            className="w-[210px]"
          />
          {error && (
            <p id={errorId} role="alert" className="mt-2 text-xs text-destructive text-center">
              {error}
            </p>
          )}
        </div>

        <div className="mt-4 flex justify-center">
          <Button
            variant="outline"
            onClick={() => void submit()}
            disabled={!userId.trim() || sending}
            className="px-4 border-border/70 hover:bg-muted/25"
          >
            Invite
          </Button>
        </div>
      </div>
    </div>,
    document.body
  );
};

export default InviteDialog;