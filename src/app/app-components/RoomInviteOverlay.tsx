/* eslint-disable @typescript-eslint/no-explicit-any */
'use client';

import React, { useEffect, useMemo, useState } from 'react';
import { getMatrixClient } from '@/app/utils/matrix';
import { RoomEvent, KnownMembership } from 'matrix-js-sdk';
import { Button } from '@/components/ui/button';
import { X } from 'lucide-react';
import toast from 'react-hot-toast';
import { formatAge, isMatrixReady } from '@/app/utils/helpers';

interface RoomInvite {
  roomId: string;
  roomName: string;
  invitedBy: string;
  receivedAt: number;
  dismissed?: boolean;
}

const RoomInviteOverlay: React.FC = () => {
  const [invites, setInvites] = useState<Record<string, RoomInvite>>({});
  const [openId, setOpenId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [matrixReadyTick, setMatrixReadyTick] = useState(0);

  useEffect(() => {
    const onReady = () => setMatrixReadyTick((v) => v + 1);
    const onNotReady = () => setMatrixReadyTick((v) => v + 1);
    window.addEventListener('matrix-ready', onReady);
    window.addEventListener('matrix-not-ready', onNotReady);
    return () => {
      window.removeEventListener('matrix-ready', onReady);
      window.removeEventListener('matrix-not-ready', onNotReady);
    };
  }, []);

  useEffect(() => {
    if (!isMatrixReady()) return;

    let client: any;
    try {
      client = getMatrixClient();
    } catch {
      return;
    }

    /* Scan rooms already in invite state, needed when mounting after an invite arrived */
    const scanExisting = () => {
      try {
        const rooms = client.getRooms() || [];
        for (const room of rooms) {
          if (room.getMyMembership() === KnownMembership.Invite) {
            addInvite(room);
          }
        }
      } catch {}
    };

    const addInvite = (room: any) => {
      const roomId = room.roomId;
      const roomName = room.name || roomId;

      let invitedBy = 'Unknown';
      try {
        const myId = client.getUserId();
        const memberEvent = room.currentState?.getStateEvents?.('m.room.member', myId);
        const sender = memberEvent?.getSender?.();
        if (sender) invitedBy = sender;
      } catch {}

      setInvites((prev) => {
        if (prev[roomId]) return prev;
        return {
          ...prev,
          [roomId]: { roomId, roomName, invitedBy, receivedAt: Date.now() },
        };
      });
    };

    const removeInvite = (roomId: string) => {
      setInvites((prev) => {
        const next = { ...prev };
        delete next[roomId];
        return next;
      });
      setOpenId((cur) => (cur === roomId ? null : cur));
    };

    const onMyMembership = (room: any, membership: string) => {
      if (membership === KnownMembership.Invite) {
        addInvite(room);
      } else {
        removeInvite(room.roomId);
      }
    };

    scanExisting();
    client.on(RoomEvent.MyMembership, onMyMembership);

    return () => {
      try {
        client.removeListener(RoomEvent.MyMembership, onMyMembership);
      } catch {}
    };
  }, [matrixReadyTick]);

  /* Oldest invite first via stable ascending sort so millisecond ties stay deterministic */
  const active = useMemo(
    () =>
      Object.values(invites)
        .filter((i) => !i.dismissed)
        .sort((a, b) => a.receivedAt - b.receivedAt),
    [invites]
  );

  const toastItem = active[0];
  const modalItem = openId ? invites[openId] : null;

  const dismiss = (roomId: string) => {
    setInvites((prev) => ({
      ...prev,
      [roomId]: { ...prev[roomId], dismissed: true },
    }));
    setOpenId((cur) => (cur === roomId ? null : cur));
  };

  /* Opening the modal sets openId, which hides the toast through its !openId render guard */
  const openModal = (roomId: string) => {
    setOpenId(roomId);
  };

  const closeModal = () => setOpenId(null);

  const doAccept = async (roomId: string) => {
    setBusy(true);
    try {
      const client = getMatrixClient();
      await (client as any).joinRoom(roomId);
      toast.success('Joined room');
      setInvites((prev) => {
        const next = { ...prev };
        delete next[roomId];
        return next;
      });
      setOpenId((cur) => (cur === roomId ? null : cur));
      window.dispatchEvent(new Event('matrix-invite-accepted'));
    } catch {
      toast.error('Failed to join room');
    } finally {
      setBusy(false);
    }
  };

  const doDecline = async (roomId: string) => {
    setBusy(true);
    try {
      const client = getMatrixClient();
      await (client as any).leave(roomId);
      toast.success('Invite declined');
      setInvites((prev) => {
        const next = { ...prev };
        delete next[roomId];
        return next;
      });
      setOpenId((cur) => (cur === roomId ? null : cur));
    } catch {
      toast.error('Failed to decline invite');
    } finally {
      setBusy(false);
    }
  };

  /* Referenced so the effect re-runs when matrix ready state changes */
  void matrixReadyTick;

  if (!isMatrixReady()) return null;
  if (active.length === 0 && !modalItem) return null;

  return (
    <>
      {toastItem && !openId && (
        <div className="fixed bottom-5 right-5 left-5 sm:left-auto z-[80] sm:max-w-md">
          <div className="glass rounded-2xl px-4 py-3 border border-border/60 shadow-none">
            <div className="flex items-start gap-3">
              <div className="flex-1">
                <div className="text-sm font-semibold text-foreground text-center">Room invitation</div>
                <div className="text-xs text-muted-foreground mt-0.5 text-center">
                  <span className="font-medium text-foreground/90">{toastItem.roomName}</span>
                  {' · '}from <span className="font-medium text-foreground/90">{toastItem.invitedBy}</span>
                  {' · '}{formatAge(toastItem.receivedAt)}
                </div>
              </div>

              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  className="h-8 px-3 border-border/70 hover:bg-muted/25"
                  onClick={() => openModal(toastItem.roomId)}
                >
                  Open
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-8 px-3 border-border/70 hover:bg-muted/25"
                  onClick={() => dismiss(toastItem.roomId)}
                >
                  Dismiss
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}

      {modalItem && (
        <div className="fixed inset-0 z-[90] flex items-center justify-center">
          <div className="absolute inset-0 bg-background/40 backdrop-blur-[2px]" onClick={closeModal} />

          <div className="relative w-[92vw] max-w-[420px] glass rounded-3xl p-4 border border-border/70 shadow-none">
            <button
              type="button"
              aria-label="Close"
              onClick={closeModal}
              className="absolute top-3 right-3 rounded-full p-2 hover:bg-muted/40 dark:hover:bg-muted/25 transition"
            >
              <X className="h-5 w-5" />
            </button>

            <div className="text-center">
              <div className="text-base font-semibold text-foreground">Room invitation</div>
              <div className="text-sm text-muted-foreground mt-1.5">
                <div>
                  You have been invited to{' '}
                  <span className="font-medium text-foreground/90">{modalItem.roomName}</span>
                </div>
                <div className="mt-0.5">
                  by <span className="font-medium text-foreground/90">{modalItem.invitedBy}</span>
                </div>
              </div>
            </div>

            <div className="mt-4 rounded-2xl border border-border/60 bg-muted/15 p-3 text-center">
              <div className="text-sm font-semibold text-foreground">Accept this invitation?</div>
              <div className="mt-1 text-xs text-muted-foreground">
                Accepting will add this room to your chat list.
              </div>
            </div>

            <div className="mt-4 flex items-center justify-center gap-3">
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => doAccept(modalItem.roomId)}
                className="px-4 border-border/70 hover:bg-muted/25"
              >
                Accept
              </Button>
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => doDecline(modalItem.roomId)}
                className="px-4 border-border/70 hover:bg-muted/25"
              >
                Decline
              </Button>
            </div>
          </div>
        </div>
      )}
    </>
  );
};

export default RoomInviteOverlay;