'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { MatrixError } from 'matrix-js-sdk';
import { Button } from '@/components/ui/button';
import { X } from 'lucide-react';
import { trapTabKey } from './dialogFocus';

/* Payload dispatched via nexus-member-action, with onConfirm holding the Matrix call to run */
export interface MemberActionDetail {
  type: 'kick' | 'ban' | 'leave' | 'role';
  targetUserId?: string;
  roomId: string;
  roomName?: string;
  roleLabel?: string;
  /* Extra caution shown above the buttons, such as a role change that cannot be undone */
  warning?: string;
  /* Element that gets focus back when the dialog closes, defaulting to whatever had focus when it opened */
  returnFocusTo?: HTMLElement | null;
  onConfirm: () => void | Promise<void>;
}

/* Per-type dialog config for title, confirm label, destructive flag, description and failure message */
const DIALOG_CONFIG = {
  kick: {
    title: 'Kick member',
    confirmLabel: 'Kick',
    destructive: true,
    description: (d: MemberActionDetail) =>
      `Remove ${d.targetUserId ?? 'this member'} from the room? They can rejoin if the room is accessible.`,
    failure: (d: MemberActionDetail) => `Failed to kick ${d.targetUserId ?? 'this member'}`,
  },
  ban: {
    title: 'Ban member',
    confirmLabel: 'Ban',
    destructive: true,
    description: (d: MemberActionDetail) =>
      `Permanently ban ${d.targetUserId ?? 'this member'}? They won't be able to rejoin unless a moderator removes the ban.`,
    failure: (d: MemberActionDetail) => `Failed to ban ${d.targetUserId ?? 'this member'}`,
  },
  leave: {
    title: 'Leave room',
    confirmLabel: 'Leave',
    destructive: true,
    description: (d: MemberActionDetail) =>
      `Leave ${d.roomName || d.roomId}? You can rejoin later if the room is publicly accessible or you receive a new invite.`,
    failure: (d: MemberActionDetail) => `Failed to leave ${d.roomName || d.roomId}`,
  },
  role: {
    title: 'Change role',
    confirmLabel: 'Confirm',
    destructive: false,
    description: (d: MemberActionDetail) =>
      `Change ${d.targetUserId ?? 'this member'}'s role to ${d.roleLabel ?? 'the selected role'}? This will update their permissions in the room.`,
    failure: (d: MemberActionDetail) => `Failed to change the role of ${d.targetUserId ?? 'this member'}`,
  },
} as const;

/* The homeserver's own explanation of a refusal, which is the most useful detail to show */
const reasonOf = (err: unknown): string | null => {
  if (err instanceof MatrixError) return err.data?.error || null;
  return null;
};

/* Renders nothing until a nexus-member-action event fires, then shows a modal confirm dialog */
const MemberOverlay: React.FC = () => {
  const [action, setAction] = useState<MemberActionDetail | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<{ message: string; reason: string | null } | null>(null);
  const actionRef = useRef<MemberActionDetail | null>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const cancelRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    const onAction = (e: Event) => {
      const detail = (e as CustomEvent<MemberActionDetail>).detail;
      if (!detail?.type || typeof detail.onConfirm !== 'function') return;
      /* A dialog replacing an open one keeps the original focus target instead of pointing at its own button */
      const opener = actionRef.current ? returnFocusRef.current : (document.activeElement as HTMLElement | null);
      returnFocusRef.current = detail.returnFocusTo ?? opener;
      actionRef.current = detail;
      setBusy(false);
      setFailure(null);
      setAction(detail);
    };
    window.addEventListener('nexus-member-action', onAction);
    return () => window.removeEventListener('nexus-member-action', onAction);
  }, []);

  /* Opening the dialog, and any failure, puts focus on Cancel so Enter never confirms a destructive action by accident */
  useEffect(() => {
    if (action) cancelRef.current?.focus();
  }, [action, failure]);

  /* While the request runs every button is disabled, so the dialog itself holds focus */
  useEffect(() => {
    if (busy) dialogRef.current?.focus();
  }, [busy]);

  const close = useCallback(() => {
    actionRef.current = null;
    setAction(null);
    setFailure(null);
    setBusy(false);
    const target = returnFocusRef.current;
    returnFocusRef.current = null;
    if (target?.isConnected) target.focus();
  }, []);

  const cancel = () => {
    if (!busy) close();
  };

  const handleConfirm = async () => {
    const current = actionRef.current;
    if (!current || busy) return;
    setBusy(true);
    setFailure(null);
    try {
      await current.onConfirm();
      if (actionRef.current === current) close();
    } catch (err) {
      if (actionRef.current !== current) return;
      setBusy(false);
      setFailure({ message: DIALOG_CONFIG[current.type].failure(current), reason: reasonOf(err) });
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      cancel();
      return;
    }
    trapTabKey(e, dialogRef.current);
  };

  if (!action) return null;

  const cfg = DIALOG_CONFIG[action.type];

  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center">
      <div
        className="absolute inset-0 bg-background/40 backdrop-blur-[2px]"
        onClick={cancel}
        data-testid="overlay-backdrop"
      />

      <div
        ref={dialogRef}
        className="relative w-[92vw] max-w-[420px] glass rounded-3xl p-4 border border-border/70 shadow-none outline-none"
        role="dialog"
        aria-modal="true"
        aria-labelledby="member-overlay-title"
        aria-describedby="member-overlay-description"
        aria-busy={busy}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        data-testid="member-overlay"
      >
        <button
          type="button"
          aria-label="Close"
          onClick={cancel}
          disabled={busy}
          className="absolute top-3 right-3 rounded-full p-2 hover:bg-muted/40 dark:hover:bg-muted/25 transition disabled:opacity-50"
          data-testid="overlay-close"
        >
          <X className="h-5 w-5" />
        </button>

        <div className="text-center px-8">
          <div
            id="member-overlay-title"
            className="text-base font-semibold text-foreground"
            data-testid="overlay-title"
          >
            {cfg.title}
          </div>
          <div
            id="member-overlay-description"
            className="mt-2 text-sm text-muted-foreground"
            data-testid="overlay-description"
          >
            {cfg.description(action)}
          </div>
          {action.warning && (
            <div className="mt-3 text-sm font-medium text-amber-800 dark:text-amber-400" data-testid="overlay-warning">
              {action.warning}
            </div>
          )}
        </div>

        {failure && (
          <div
            role="alert"
            className="mt-4 rounded-2xl border border-destructive/30 bg-destructive/5 px-3 py-2 text-center text-sm text-destructive"
            data-testid="overlay-error"
          >
            <div className="font-semibold">{failure.message}</div>
            {failure.reason && <div className="mt-0.5">{failure.reason}</div>}
          </div>
        )}

        <div className="mt-5 flex items-center justify-center gap-3">
          <Button
            variant="outline"
            disabled={busy}
            onClick={handleConfirm}
            className={`px-4 ${
              cfg.destructive
                ? 'border-border/50 text-destructive hover:text-destructive hover:bg-destructive/10'
                : 'border-border/70 hover:bg-muted/25'
            }`}
            data-testid="overlay-confirm"
          >
            {busy ? 'Please wait…' : cfg.confirmLabel}
          </Button>
          <Button
            ref={cancelRef}
            variant="outline"
            disabled={busy}
            onClick={cancel}
            className="px-4 border-border/70 hover:bg-muted/25"
            data-testid="overlay-cancel"
          >
            Cancel
          </Button>
        </div>
      </div>
    </div>
  );
};

export default MemberOverlay;