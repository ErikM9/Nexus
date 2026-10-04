'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ClientEvent,
  EventType,
  JoinRule,
  KnownMembership,
  RelationType,
  RoomEvent,
  RoomStateEvent,
  SyncState,
  type MatrixClient,
  type Room,
} from 'matrix-js-sdk';
import toast from 'react-hot-toast';
import { getMatrixClient } from '../utils/matrix';
import { getRoomPermissions } from '../utils/matrix/permissions';
import { ScrollArea } from '@/components/ui/scroll-area';
import CreateRoomForm, { type RoomFallback } from './CreateRoomForm';
import JoinRoomForm from './JoinRoomForm';
import RoomListItem from './RoomListItem';
import InviteDialog from './InviteDialog';
import type { MemberActionDetail } from './MemberOverlay';

interface ChatListProps {
  onSelect: (roomId: string | null, initialName?: string, isEncrypted?: boolean, isPublic?: boolean) => void;
  selectedRoomId?: string | null;
}

type Mode = 'create' | 'join';

/* How long a joined or created room may take to arrive through sync before it is opened without its state */
const ROOM_ARRIVAL_TIMEOUT_MS = 10_000;

/* Event types that count as conversation activity, unlike reactions and state changes */
const ACTIVITY_TYPES = new Set<string>([EventType.RoomMessage, EventType.RoomMessageEncrypted, EventType.Sticker]);

/* Time of the newest message-like event in the loaded timeline, ignoring edits, or of the room's creation when there is none */
const lastActivity = (room: Room): number => {
  const events = room.getLiveTimeline().getEvents();
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (ACTIVITY_TYPES.has(event.getType()) && !event.isRelation(RelationType.Replace)) return event.getTs();
  }
  return room.currentState.getStateEvents(EventType.RoomCreate, '')?.getTs() ?? 0;
};

/* A tombstoned room is superseded once the user has joined its replacement, provided the replacement names it as predecessor */
const hasJoinedSuccessor = (client: MatrixClient, room: Room): boolean => {
  const replacement = room.currentState.getStateEvents(EventType.RoomTombstone, '')?.getContent().replacement_room;
  if (typeof replacement !== 'string') return false;
  const successor = client.getRoom(replacement);
  return successor?.getMyMembership() === KnownMembership.Join && successor.findPredecessor()?.roomId === room.roomId;
};

/* Joined chats, most recently active first, leaving out spaces and rooms replaced by an upgrade */
const listChatRooms = (client: MatrixClient): Room[] =>
  client
    .getRooms()
    .filter((room) => room.getMyMembership() === KnownMembership.Join && !room.isSpaceRoom() && !hasJoinedSuccessor(client, room))
    .map((room) => ({ room, activity: lastActivity(room) }))
    .sort((a, b) => b.activity - a.activity)
    .map(({ room }) => room);

/* Resolves with the room once sync has stored it as joined, or with null when that takes longer than the timeout */
const waitForJoinedRoom = (client: MatrixClient, roomId: string, timeoutMs: number): Promise<Room | null> =>
  new Promise((resolve) => {
    const joinedRoom = () => {
      const room = client.getRoom(roomId);
      return room?.getMyMembership() === KnownMembership.Join ? room : null;
    };
    const ready = joinedRoom();
    if (ready) {
      resolve(ready);
      return;
    }

    const check = () => {
      const room = joinedRoom();
      if (room) finish(room);
    };
    const finish = (room: Room | null) => {
      clearTimeout(timer);
      client.removeListener(ClientEvent.Room, check);
      client.removeListener(RoomEvent.MyMembership, check);
      resolve(room);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    client.on(ClientEvent.Room, check);
    client.on(RoomEvent.MyMembership, check);
  });

const displayName = (room: Room) => room.name?.trim() || room.roomId;

const roomBadge = (isPublic: boolean, isEncrypted: boolean) => {
  if (isPublic && isEncrypted) return '🛡️';
  if (isPublic) return '🌍';
  if (isEncrypted) return '🔐';
  return '🔒';
};

const ChatList: React.FC<ChatListProps> = ({ onSelect, selectedRoomId = null }) => {
  const [client, setClient] = useState<MatrixClient | null>(null);
  const [rooms, setRooms] = useState<Room[]>([]);
  const [loading, setLoading] = useState(true);
  const [mode, setMode] = useState<Mode>('create');
  const [activeRoomMenu, setActiveRoomMenu] = useState<string | null>(null);
  const [invite, setInvite] = useState<{ roomId: string; returnFocusTo: HTMLElement | null } | null>(null);

  /* Async work compares against these to notice a sign-out or a different open room since it started */
  const clientRef = useRef<MatrixClient | null>(null);
  const selectedRoomIdRef = useRef<string | null>(selectedRoomId);

  /* skipCloseRef stops a room menu from closing itself on its own nexus-close-dropdowns broadcast */
  const skipCloseRef = useRef(false);

  useEffect(() => {
    selectedRoomIdRef.current = selectedRoomId;
  }, [selectedRoomId]);

  useEffect(() => {
    const onGlobalDropdown = () => {
      if (skipCloseRef.current) {
        skipCloseRef.current = false;
        return;
      }
      setActiveRoomMenu(null);
    };
    window.addEventListener('nexus-close-dropdowns', onGlobalDropdown);
    return () => window.removeEventListener('nexus-close-dropdowns', onGlobalDropdown);
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return;

    const attach = () => {
      let next: MatrixClient | null = null;
      try {
        next = getMatrixClient();
      } catch {
        next = null;
      }
      clientRef.current = next;
      setClient(next);
    };

    const detach = () => {
      clientRef.current = null;
      setClient(null);
      setRooms([]);
      setLoading(true);
      setActiveRoomMenu(null);
      setInvite(null);
      setMode('create');
      onSelect(null);
    };

    if (window.__matrix_ready) attach();

    window.addEventListener('matrix-ready', attach);
    window.addEventListener('matrix-not-ready', detach);

    return () => {
      window.removeEventListener('matrix-ready', attach);
      window.removeEventListener('matrix-not-ready', detach);
    };
  }, [onSelect]);

  const refreshRooms = useCallback(() => {
    if (!client) return;
    setRooms(listChatRooms(client));
    setLoading(false);
  }, [client]);

  useEffect(() => {
    if (!client) return;

    const onSync = (state: SyncState) => {
      if (state === SyncState.Prepared || state === SyncState.Syncing) refreshRooms();
    };

    /* Membership, timeline and state changes can each add, drop, rename, re-badge or reorder a room */
    client.on(ClientEvent.Sync, onSync);
    client.on(ClientEvent.Room, refreshRooms);
    client.on(ClientEvent.DeleteRoom, refreshRooms);
    client.on(RoomEvent.MyMembership, refreshRooms);
    client.on(RoomEvent.Timeline, refreshRooms);
    client.on(RoomEvent.Name, refreshRooms);
    client.on(RoomStateEvent.Events, refreshRooms);

    refreshRooms();

    return () => {
      client.removeListener(ClientEvent.Sync, onSync);
      client.removeListener(ClientEvent.Room, refreshRooms);
      client.removeListener(ClientEvent.DeleteRoom, refreshRooms);
      client.removeListener(RoomEvent.MyMembership, refreshRooms);
      client.removeListener(RoomEvent.Timeline, refreshRooms);
      client.removeListener(RoomEvent.Name, refreshRooms);
      client.removeListener(RoomStateEvent.Events, refreshRooms);
    };
  }, [client, refreshRooms]);

  /* Opens a room the user has just joined or created once sync has delivered it, so every panel starts from its real state */
  const openWhenJoined = useCallback(
    async (roomId: string, fallback: RoomFallback) => {
      const origin = clientRef.current;
      if (!origin) return;
      const openBefore = selectedRoomIdRef.current;
      const room = await waitForJoinedRoom(origin, roomId, ROOM_ARRIVAL_TIMEOUT_MS);
      /* Signing out, or opening another room while this one was on its way, cancels the automatic open */
      if (clientRef.current !== origin || selectedRoomIdRef.current !== openBefore) return;
      if (room) {
        onSelect(roomId, displayName(room), room.hasEncryptionStateEvent(), room.getJoinRule() === JoinRule.Public);
      } else {
        onSelect(roomId, fallback.name || roomId, fallback.isEncrypted, fallback.isPublic);
      }
    },
    [onSelect]
  );

  const openRoomMenu = (roomId: string, open: boolean) => {
    if (open) {
      skipCloseRef.current = true;
      try { window.dispatchEvent(new Event('nexus-close-dropdowns')); } catch {}
      setActiveRoomMenu(roomId);
    } else {
      setActiveRoomMenu((current) => (current === roomId ? null : current));
    }
  };

  const openInvite = (roomId: string, returnFocusTo: HTMLElement | null) => {
    if (!client) {
      toast.error('Matrix client not ready');
      return;
    }
    setInvite({ roomId, returnFocusTo });
  };

  const copyRoomId = (roomId: string) => {
    try {
      navigator.clipboard
        .writeText(roomId)
        .then(() => toast.success('Room ID copied!'))
        .catch(() => toast.error('Copy failed'));
    } catch {
      toast.error('Copy failed');
    }
  };

  /* The dialog waits for the server, and only a room that is open in the chat panel gets closed */
  const leaveRoom = (room: Room, returnFocusTo: HTMLElement | null) => {
    if (!client) {
      toast.error('Matrix client not ready');
      return;
    }
    const { roomId } = room;
    const detail: MemberActionDetail = {
      type: 'leave',
      roomId,
      roomName: displayName(room),
      returnFocusTo,
      onConfirm: async () => {
        await client.leave(roomId);
        toast.success('Left room');
        setRooms((prev) => prev.filter((r) => r.roomId !== roomId));
        if (selectedRoomIdRef.current === roomId) onSelect(null);
      },
    };
    window.dispatchEvent(new CustomEvent<MemberActionDetail>('nexus-member-action', { detail }));
  };

  const myUserId = client?.getUserId() ?? null;

  const toggleClass = (active: boolean, hover: string) =>
    `w-[92px] px-4 py-[7px] text-[13px] font-semibold tracking-wide transition-all ${
      active ? 'bg-sky-500 text-white dark:bg-sky-400 dark:text-slate-950' : `text-muted-foreground hover:text-foreground ${hover}`
    }`;

  const panelHeader = mode === 'create' ? 'Create room' : 'Join room';

  return (
    <div className="h-full min-h-0 overflow-hidden flex flex-col bg-transparent">
      <div className="flex-1 min-h-0 overflow-hidden flex flex-col glass no-border-top no-border-right no-border-left no-border-bottom glass-opaque hairline-r">
        <div className="shrink-0 border-b">
          <div className="px-4 pt-2 pb-2 space-y-2 shadow-none">
            <div className="flex justify-center">
              <div className="inline-flex rounded-full border border-border/70 overflow-hidden bg-muted/20 dark:bg-muted/15">
                <button
                  type="button"
                  aria-pressed={mode === 'create'}
                  className={toggleClass(mode === 'create', 'hover:bg-muted/60 dark:hover:bg-muted/50')}
                  onClick={() => setMode('create')}
                  disabled={!client}
                >
                  Create
                </button>
                <button
                  type="button"
                  aria-pressed={mode === 'join'}
                  className={toggleClass(mode === 'join', 'hover:bg-muted/40 dark:hover:bg-muted/50')}
                  onClick={() => setMode('join')}
                  disabled={!client}
                >
                  Join
                </button>
              </div>
            </div>

            <div className="text-xs font-semibold tracking-[0.18em] uppercase text-muted-foreground text-center pb-2">
              {panelHeader}
            </div>

            <div className="h-[105px] flex flex-col">
              {/* The create form stays mounted while hidden so a half-typed room name survives a look at Join */}
              <CreateRoomForm client={client} hidden={mode !== 'create'} onCreated={openWhenJoined} />
              {mode === 'join' && <JoinRoomForm client={client} onJoined={openWhenJoined} />}
            </div>
          </div>
        </div>

        <ScrollArea className="flex-1 min-h-0" viewportClassName="h-full w-full overflow-auto">
          <div className="px-4 pt-4 pb-2">
            <div className="text-xs font-semibold tracking-[0.18em] uppercase text-muted-foreground text-center">
              Your chats
            </div>
          </div>

          {!client ? (
            <p className="px-4 pb-4 text-muted-foreground">Preparing Matrix client...</p>
          ) : loading ? (
            <p className="px-4 pb-4 text-muted-foreground">Loading rooms...</p>
          ) : (
            <ul className="space-y-2 pb-4" data-testid="room-list" aria-label="Chat rooms">
              {rooms.map((room) => {
                const isEncrypted = room.hasEncryptionStateEvent();
                const isPublic = room.getJoinRule() === JoinRule.Public;
                const name = displayName(room);
                return (
                  <RoomListItem
                    key={room.roomId}
                    roomId={room.roomId}
                    name={name}
                    badge={roomBadge(isPublic, isEncrypted)}
                    isEncrypted={isEncrypted}
                    isCurrent={room.roomId === selectedRoomId}
                    canInvite={!!myUserId && getRoomPermissions(room, myUserId).canInvite}
                    menuOpen={activeRoomMenu === room.roomId}
                    onMenuOpenChange={(open) => openRoomMenu(room.roomId, open)}
                    onOpen={() => onSelect(room.roomId, name, isEncrypted, isPublic)}
                    onInvite={(returnFocusTo) => openInvite(room.roomId, returnFocusTo)}
                    onCopyId={() => copyRoomId(room.roomId)}
                    onLeave={(returnFocusTo) => leaveRoom(room, returnFocusTo)}
                  />
                );
              })}
            </ul>
          )}
        </ScrollArea>
      </div>

      {invite && client && (
        <InviteDialog
          client={client}
          roomId={invite.roomId}
          returnFocusTo={invite.returnFocusTo}
          onClose={() => setInvite(null)}
        />
      )}
    </div>
  );
};

export default ChatList;