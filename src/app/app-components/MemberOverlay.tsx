'use client';

import React, { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { X } from 'lucide-react';

/* Payload dispatched via nexus-member-action, with onConfirm holding the Matrix call to run */
export interface MemberActionDetail {
  type: 'kick' | 'ban' | 'leave' | 'role';
  targetUserId?: string;
  roomId: string;
  roomName?: string;
  roleLabel?: string;
  onConfirm: () => void | Promise<void>;
}

/* Per-type dialog config for title, confirm label, destructive flag, and description */
const DIALOG_CONFIG = {
  kick: {
    title: 'Kick member',
    confirmLabel: 'Kick',
    destructive: true,
    description: (d: MemberActionDetail) =>
      `Remove ${d.targetUserId ?? 'this member'} from the room? They can rejoin if the room is accessible.`,
  },
  ban: {
    title: 'Ban member',
    confirmLabel: 'Ban',
    destructive: true,
    description: (d: MemberActionDetail) =>
      `Permanently ban ${d.targetUserId ?? 'this member'}? They won't be able to rejoin unless a moderator removes the ban.`,
  },
  leave: {
    title: 'Leave room',
    confirmLabel: 'Leave',
    destructive: true,
    description: (d: MemberActionDetail) =>
      `Leave ${d.roomName || d.roomId}? You can rejoin later if the room is publicly accessible or you receive a new invite.`,
  },
  role: {
    title: 'Change role',
    confirmLabel: 'Confirm',
    destructive: false,
    description: (d: MemberActionDetail) =>
      `Change ${d.targetUserId ?? 'this member'}'s role to ${d.roleLabel ?? 'the selected role'}? This will update their permissions in the room.`,
  },
} as const;

/* Renders nothing until a nexus-member-action event fires, then shows a confirm dialog */
const MemberOverlay: React.FC = () => {
  const [action, setAction] = useState<MemberActionDetail | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const onAction = (e: Event) => {
      const detail = (e as CustomEvent<MemberActionDetail>).detail;
      if (detail?.type && typeof detail.onConfirm === 'function') {
        setBusy(false);
        setAction(detail);
      }
    };
    window.addEventListener('nexus-member-action', onAction);
    return () => window.removeEventListener('nexus-member-action', onAction);
  }, []);

  const close = () => {
    if (busy) return;
    setAction(null);
  };

  const handleConfirm = async () => {
    if (!action || busy) return;
    setBusy(true);
    try {
      await action.onConfirm();
    } catch {}
    setBusy(false);
    setAction(null);
  };

  if (!action) return null;

  const cfg = DIALOG_CONFIG[action.type];

  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center">
      <div
        className="absolute inset-0 bg-background/40 backdrop-blur-[2px]"
        onClick={close}
        data-testid="overlay-backdrop"
      />

      <div
        className="relative w-[92vw] max-w-[420px] glass rounded-3xl p-4 border border-border/70 shadow-none"
        role="dialog"
        aria-modal="true"
        aria-labelledby="member-overlay-title"
        data-testid="member-overlay"
      >
        <button
          type="button"
          aria-label="Close"
          onClick={close}
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
            className="mt-2 text-sm text-muted-foreground"
            data-testid="overlay-description"
          >
            {cfg.description(action)}
          </div>
        </div>

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
            variant="outline"
            disabled={busy}
            onClick={close}
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