/* eslint-disable @typescript-eslint/no-explicit-any */
'use client';

import React, { useEffect, useMemo, useState, useCallback, useRef } from 'react';
import { getMatrixClient, getCryptoReady } from '../utils/matrix';
import { Room, RoomEvent, RoomStateEvent, ClientEvent, KnownMembership, MatrixClient } from 'matrix-js-sdk';
import toast from 'react-hot-toast';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ScrollArea } from '@/components/ui/scroll-area';
import { X } from 'lucide-react';
import ReactDOM from 'react-dom';

interface ChatListProps {
  onSelect: (roomId: string | null, initialName?: string, isEncrypted?: boolean, isPublic?: boolean) => void;
}

interface PublicRoom {
  room_id: string;
  name?: string;
}

type RoomType = 'public-unencrypted' | 'public-encrypted' | 'private-unencrypted' | 'private-encrypted';
type Mode = 'create' | 'join';

const PRESET_PUBLIC = 'public_chat';
const PRESET_PRIVATE = 'private_chat';

/* True when the input starts with ! or #, meaning it can be joined directly as an ID or alias */
const looksLikeRoomIdOrAlias = (v: string) => {
  const s = v.trim();
  if (!s) return false;
  return s.startsWith('!') || s.startsWith('#');
};

const ChatList: React.FC<ChatListProps> = ({ onSelect }) => {
  const [client, setClient] = useState<MatrixClient | null>(null);
  const [rooms, setRooms] = useState<Room[]>([]);
  const [loading, setLoading] = useState(true);
  const [mode, setMode] = useState<Mode>('create');
  const [newRoomName, setNewRoomName] = useState('');
  const [roomType, setRoomType] = useState<RoomType>('public-unencrypted');
  const [activeRoomMenu, setActiveRoomMenu] = useState<string | null>(null);
  const [inviteOverlay, setInviteOverlay] = useState<{ roomId: string; user: string } | null>(null);
  const [publicSearchTerm, setPublicSearchTerm] = useState('');
  const [publicRooms, setPublicRooms] = useState<PublicRoom[]>([]);
  const [searching, setSearching] = useState(false);
  /* Debounce the public room search so an API call doesn't fire on every keystroke */
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [publicSearchOpen, setPublicSearchOpen] = useState(false);
  const publicSearchWrapRef = useRef<HTMLDivElement | null>(null);
  const activeRoomMenuRef = useRef<HTMLDivElement | null>(null);
  const [selectedPublicRoom, setSelectedPublicRoom] = useState<PublicRoom | null>(null);
  const [selectOpen, setSelectOpen] = useState(false);

  /* skipCloseRef stops a dropdown opener from closing itself on its own nexus-close-dropdowns broadcast */
  const skipCloseRef = useRef<'menu' | 'select' | null>(null);

  useEffect(() => {
    const onGlobalDropdown = () => {
      if (skipCloseRef.current === 'menu') {
        skipCloseRef.current = null;
        setSelectOpen(false);
        return;
      }
      if (skipCloseRef.current === 'select') {
        skipCloseRef.current = null;
        setActiveRoomMenu(null);
        return;
      }
      setActiveRoomMenu(null);
      setSelectOpen(false);
    };
    window.addEventListener('nexus-close-dropdowns', onGlobalDropdown);
    return () => window.removeEventListener('nexus-close-dropdowns', onGlobalDropdown);
  }, []);

  const emitDropdownOpen = (which: 'menu' | 'select') => {
    skipCloseRef.current = which;
    try { window.dispatchEvent(new Event('nexus-close-dropdowns')); } catch {}
  };

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
      setRooms([]);
      setPublicRooms([]);
      setLoading(true);
      setActiveRoomMenu(null);
      setInviteOverlay(null);
      setPublicSearchTerm('');
      setPublicSearchOpen(false);
      setSelectedPublicRoom(null);
      setMode('create');
      setNewRoomName('');
      setRoomType('public-unencrypted');
      onSelect(null);
    };

    if (window.__matrix_ready) attach();

    window.addEventListener('matrix-ready', attach);
    window.addEventListener('matrix-not-ready', detach);

    /* Re-scan rooms after an invite is accepted so the new room appears immediately */
    window.addEventListener('matrix-invite-accepted', attach);

    return () => {
      window.removeEventListener('matrix-ready', attach);
      window.removeEventListener('matrix-not-ready', detach);
      window.removeEventListener('matrix-invite-accepted', attach);
    };
  }, [onSelect]);

  const refreshRooms = useCallback(() => {
    if (!client) {
      setRooms([]);
      setLoading(true);
      return;
    }

    const allJoined = client.getRooms().filter((r: Room) => r.getMyMembership() === KnownMembership.Join);
    const sorted = allJoined.sort(
      (a: Room, b: Room) => (b.getLastActiveTimestamp() || 0) - (a.getLastActiveTimestamp() || 0)
    );

    setRooms(sorted);
    setLoading(false);
  }, [client]);

  const searchPublicRooms = useCallback(async () => {
    if (!client || !publicSearchTerm.trim()) {
      setPublicRooms([]);
      setPublicSearchOpen(false);
      return;
    }

    const searchTerm = publicSearchTerm.trim();
    /* ID or alias searches are filtered client-side by room_id or canonical_alias, name searches use server results */
    const searchById = looksLikeRoomIdOrAlias(searchTerm);

    setSearching(true);
    try {
      const response = await client.publicRooms({
        filter: { generic_search_term: searchTerm },
      });
      const chunk = response.chunk || [];

      const filteredChunk = searchById
        ? chunk.filter((r: any) =>
            r.room_id?.toLowerCase().includes(searchTerm.toLowerCase()) ||
            (r.canonical_alias || '').toLowerCase().includes(searchTerm.toLowerCase())
          )
        : chunk;

      /* Order by exact name match, then prefix match, then the rest, with localeCompare breaking ties */
      const q = searchTerm.toLowerCase();
      const sorted = [...filteredChunk].sort((a, b) => {
        const aName = (a.name || '').toLowerCase();
        const bName = (b.name || '').toLowerCase();
        const aExact = aName === q ? 0 : aName.startsWith(q) ? 1 : 2;
        const bExact = bName === q ? 0 : bName.startsWith(q) ? 1 : 2;
        if (aExact !== bExact) return aExact - bExact;
        return aName.localeCompare(bName);
      });
      setPublicRooms(sorted);
      setPublicSearchOpen(true);
    } catch {
      toast.error('Search failed');
      setPublicRooms([]);
      setPublicSearchOpen(false);
    } finally {
      setSearching(false);
    }
  }, [client, publicSearchTerm]);

  useEffect(() => {
    if (!client) return;

    const onSync = (state: string) => {
      if (state === 'SYNCING' || state === 'PREPARED' || state === 'READY') refreshRooms();
    };

    const timelineHandler = () => refreshRooms();
    const membershipHandler = (_room: Room, membership: string) => {
      if (membership === KnownMembership.Leave) refreshRooms();
    };
    const stateHandler = () => refreshRooms();

    client.on(ClientEvent.Sync, onSync);
    client.on(RoomEvent.Timeline, timelineHandler);
    client.on(RoomEvent.MyMembership, membershipHandler);
    client.on(RoomStateEvent.Events, stateHandler);

    refreshRooms();

    return () => {
      try {
        client.removeListener(ClientEvent.Sync, onSync);
        client.removeListener(RoomEvent.Timeline, timelineHandler);
        client.removeListener(RoomEvent.MyMembership, membershipHandler);
        client.removeListener(RoomStateEvent.Events, stateHandler);
      } catch {}
    };
  }, [client, refreshRooms]);

  useEffect(() => {
    if (mode !== 'join') return;
    if (debounceTimer.current) clearTimeout(debounceTimer.current);
    debounceTimer.current = setTimeout(() => {
      searchPublicRooms();
    }, 280);

    return () => {
      if (debounceTimer.current) clearTimeout(debounceTimer.current);
    };
  }, [publicSearchTerm, searchPublicRooms, mode]);

  useEffect(() => {
    const onDocMouseDown = (e: MouseEvent) => {
      if (!publicSearchOpen) return;
      const wrap = publicSearchWrapRef.current;
      if (!wrap) return;
      if (wrap.contains(e.target as Node)) return;
      setPublicSearchOpen(false);
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setPublicSearchOpen(false);
    };

    document.addEventListener('mousedown', onDocMouseDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onDocMouseDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [publicSearchOpen]);

  useEffect(() => {
    if (!activeRoomMenu) return;
    const onDocMouseDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (activeRoomMenuRef.current && activeRoomMenuRef.current.contains(target)) return;
      if (target.closest(`[data-room-trigger="${activeRoomMenu}"]`)) return;
      setActiveRoomMenu(null);
    };
    document.addEventListener('mousedown', onDocMouseDown);
    return () => document.removeEventListener('mousedown', onDocMouseDown);
  }, [activeRoomMenu]);

  const directRoomIds = useMemo(() => {
    if (!client) return new Set<string>();
    try {
      /* Builds the set of DM room IDs from m.direct account data to pick the right sidebar emoji */
      const ev = (client as any).getAccountData?.('m.direct');
      const content = ev?.getContent?.();
      const ids = new Set<string>();
      if (content && typeof content === 'object') {
        for (const v of Object.values(content)) {
          if (Array.isArray(v)) {
            for (const rid of v) if (typeof rid === 'string') ids.add(rid);
          }
        }
      }
      return ids;
    } catch {
      return new Set<string>();
    }
  }, [client]);

  const getRoomTraits = useCallback(
    (room: Room) => {
      const encEvent = room.currentState?.getStateEvents?.('m.room.encryption', '');
      const isEncrypted = !!encEvent;
      const joinRulesEv: any = room.currentState?.getStateEvents?.('m.room.join_rules', '');
      const joinRule = joinRulesEv?.getContent?.()?.join_rule;
      const isPublic = joinRule === 'public';
      const isDM = directRoomIds.has(room.roomId) || room.getJoinedMemberCount?.() === 2;

      return { isEncrypted, isPublic, isDM };
    },
    [directRoomIds]
  );

  const renderRoomEmoji = useCallback((traits: { isEncrypted: boolean; isPublic: boolean; isDM: boolean }) => {
    if (traits.isPublic && traits.isEncrypted) return '🛡️';
    if (traits.isPublic) return '🌍';
    if (traits.isEncrypted) return '🔐';
    return '🔒';
  }, []);

  const createRoom = async () => {
    if (!client) {
      toast.error('Matrix client not ready');
      return;
    }

    const name = newRoomName.trim();
    if (!name) return;

    const isEncryptedType = roomType === 'public-encrypted' || roomType === 'private-encrypted';
    if (isEncryptedType && !getCryptoReady()) {
      toast.error('Crypto not ready for encrypted room');
      return;
    }

    try {
      let options: any;

      if (roomType === 'public-unencrypted') {
        options = { name, preset: PRESET_PUBLIC };
      } else if (roomType === 'public-encrypted') {
        options = {
          name,
          preset: PRESET_PUBLIC,
          initial_state: [
            { type: 'm.room.encryption', state_key: '', content: { algorithm: 'm.megolm.v1.aes-sha2' } },
          ],
        };
      } else if (roomType === 'private-unencrypted') {
        options = { name, preset: PRESET_PRIVATE };
      } else {
        options = {
          name,
          preset: PRESET_PRIVATE,
          initial_state: [
            { type: 'm.room.encryption', state_key: '', content: { algorithm: 'm.megolm.v1.aes-sha2' } },
          ],
        };
      }

      const { room_id } = await client.createRoom(options);

      toast.success('Room created!');
      setNewRoomName('');
      setRoomType('public-unencrypted');
      refreshRooms();

      const encEvent = options.initial_state?.find((s: any) => s.type === 'm.room.encryption');
      const isEncrypted = !!encEvent;
      const isPublic = roomType === 'public-unencrypted' || roomType === 'public-encrypted';

      onSelect(room_id, name, isEncrypted, isPublic);
    } catch {
      toast.error('Failed to create room');
    }
  };

  const canInviteToRoom = useCallback((roomId: string): boolean => {
    if (!client) return false;
    try {
      const room = client.getRoom(roomId);
      if (!room) return false;
      const plEvent = room.currentState?.getStateEvents?.('m.room.power_levels', '');
      const plContent = plEvent?.getContent?.() || {};
      const inviteLevel = typeof plContent.invite === 'number' ? plContent.invite : 50;
      const usersDefault = typeof plContent.users_default === 'number' ? plContent.users_default : 0;
      const userId = client.getUserId();
      if (!userId) return false;
      const userPl = plContent.users?.[userId] ?? usersDefault;
      return userPl >= inviteLevel;
    } catch {
      return false;
    }
  }, [client]);

  const handleInvite = (roomId: string) => {
    if (!client) {
      toast.error('Matrix client not ready');
      return;
    }
    setActiveRoomMenu(null);
    setInviteOverlay({ roomId, user: '' });
  };

  const handleSendInvite = () => {
    if (!client || !inviteOverlay) return;
    const { roomId, user } = inviteOverlay;
    if (!user.trim()) return;

    client
      .invite(roomId, user.trim())
      .then(() => {
        toast.success('Invited!');
        setInviteOverlay(null);
      })
      .catch(() => toast.error('Invite failed'));
  };

  const handleCopyLink = (room: Room) => {
    try {
      navigator.clipboard
        .writeText(room.roomId)
        .then(() => toast.success('Room ID copied!'))
        .catch(() => toast.error('Copy failed'));
    } catch {
      toast.error('Copy failed');
    }
  };

  const handleLeaveRoom = (roomId: string) => {
    if (!client) {
      toast.error('Matrix client not ready');
      return;
    }

    const room = client.getRoom(roomId);
    const roomName = room?.name?.trim() || roomId;

    /* Dispatch a confirmation event whose callback runs only if the user confirms */
    window.dispatchEvent(new CustomEvent('nexus-member-action', {
      detail: {
        type: 'leave',
        roomId,
        roomName,
        onConfirm: () => {
          setActiveRoomMenu(null);
          setRooms((prev) => prev.filter((r) => r.roomId !== roomId));
          onSelect(null);
          client
            .leave(roomId)
            .then(() => toast.success('Left room'))
            .catch(() => {
              toast.error('Failed to leave');
              refreshRooms();
            });
        },
      },
    }));
  };

  const toggleRoomMenu = (roomId: string) => {
    const willOpen = activeRoomMenu !== roomId;
    if (willOpen) emitDropdownOpen('menu');
    setActiveRoomMenu((prev) => (prev === roomId ? null : roomId));
  };

  /* Pre-compute invite permissions per room so the render loop doesn't read client state each pass */
  const canInviteMap = useMemo(() => {
    const map: Record<string, boolean> = {};
    for (const room of rooms) {
      map[room.roomId] = canInviteToRoom(room.roomId);
    }
    return map;
  }, [rooms, canInviteToRoom]);

  /* The join target is the room picked from search, or the raw input when it looks like an ID or alias */
  const selectedJoinId = useMemo(() => {
    if (selectedPublicRoom?.room_id) return selectedPublicRoom.room_id;
    if (looksLikeRoomIdOrAlias(publicSearchTerm)) return publicSearchTerm.trim();
    return '';
  }, [selectedPublicRoom, publicSearchTerm]);

  const joinSelectedPublic = async () => {
    if (!client) return;
    const id = selectedJoinId.trim();
    if (!id) {
      toast.error('Select a room first');
      return;
    }

    try {
      await client.joinRoom(id);

      const joined = client.getRoom(id);
      const encEvent = joined?.currentState?.getStateEvents?.('m.room.encryption', '');
      const isEncrypted = !!encEvent;

      toast.success('Joined room');
      refreshRooms();

      onSelect(id, joined?.name || selectedPublicRoom?.name || id, isEncrypted, true);

      setPublicSearchOpen(false);
      setPublicRooms([]);
      setPublicSearchTerm(id);
    } catch {
      toast.error('Failed to join room');
    }
  };

  /* Merge the search input's bottom corners with the dropdown panel below when open */
  const showPublicOverlay =
    mode === 'join' &&
    publicSearchOpen &&
    publicSearchTerm.trim().length > 0 &&
    (searching || publicRooms.length > 0);

  const inputOpenClass = showPublicOverlay ? 'rounded-b-none border-b-transparent' : undefined;

  const selectedToggleClass = 'bg-sky-500 text-white dark:bg-sky-400 dark:text-slate-950';

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
                  className={`w-[92px] px-4 py-[7px] text-[13px] font-semibold tracking-wide transition-all ${
                    mode === 'create'
                      ? selectedToggleClass
                      : 'text-muted-foreground hover:text-foreground hover:bg-muted/60 dark:hover:bg-muted/50'
                  }`}
                  onClick={() => {
                    setMode('create');
                    setPublicSearchOpen(false);
                    setPublicRooms([]);
                    setPublicSearchTerm('');
                    setSelectedPublicRoom(null);
                  }}
                  disabled={!client}
                >
                  Create
                </button>
                <button
                  type="button"
                  className={`w-[92px] px-4 py-[7px] text-[13px] font-semibold tracking-wide transition-all ${
                    mode === 'join'
                      ? selectedToggleClass
                      : 'text-muted-foreground hover:text-foreground hover:bg-muted/40 dark:hover:bg-muted/50'
                  }`}
                  onClick={() => {
                    setMode('join');
                    if (publicSearchTerm.trim()) setPublicSearchOpen(true);
                  }}
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
              {mode === 'create' ? (
                <div className="flex flex-col gap-2 justify-end h-full">
                  <div className="flex justify-center">
                    <div className="flex items-center gap-2">
                      <Input
                        type="text"
                        placeholder="Choose room name"
                        value={newRoomName}
                        onChange={(e) => setNewRoomName(e.target.value)}
                        disabled={!client}
                        className="h-8 text-xs w-[134px]"
                      />
                    </div>
                  </div>

                  <div className="flex justify-center">
                    <div className="flex items-center gap-2">
                      <div className="w-[134px]">
                        <Select
                          value={roomType}
                          onValueChange={(v) => setRoomType(v as RoomType)}
                          disabled={!client}
                          open={selectOpen}
                          onOpenChange={(open) => {
                            if (open) emitDropdownOpen('select');
                            setSelectOpen(open);
                          }}
                        >
                          <SelectTrigger className="h-8 text-xs w-full">
                            <SelectValue placeholder="Room type" />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="public-unencrypted" className="text-xs">🌍 Public (Unencrypted)</SelectItem>
                            <SelectItem value="public-encrypted" className="text-xs">🛡️ Public (Encrypted)</SelectItem>
                            <SelectItem value="private-unencrypted" className="text-xs">🔒 Private (Unencrypted)</SelectItem>
                            <SelectItem value="private-encrypted" className="text-xs">🔐 Private (Encrypted)</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                    </div>
                  </div>

                  <div className="flex justify-center">
                    <Button onClick={createRoom} className="w-[66px]" disabled={!client || !newRoomName.trim()}>
                      Create
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="flex flex-col justify-end h-full">
                  <div className="text-xs font-medium tracking-wide text-muted-foreground text-center mb-1">
                    Join a public room by searching for its name or entering its room ID.
                  </div>

                  <div ref={publicSearchWrapRef} className="relative mx-auto w-[205px]">
                    <Input
                      type="text"
                      placeholder="Search by name or enter ID"
                      value={publicSearchTerm}
                      onChange={(e) => {
                        const v = e.target.value;
                        setPublicSearchTerm(v);

                        if (!v.trim()) {
                          setPublicRooms([]);
                          setPublicSearchOpen(false);
                          setSelectedPublicRoom(null);
                          return;
                        }

                        if (looksLikeRoomIdOrAlias(v)) {
                          setPublicRooms([]);
                          setPublicSearchOpen(false);
                          setSelectedPublicRoom(null);
                          return;
                        }

                        setSelectedPublicRoom(null);
                        setPublicSearchOpen(true);
                      }}
                      onFocus={() => {
                        if (
                          publicSearchTerm.trim() &&
                          (publicRooms.length > 0 || searching)
                        ) {
                          setPublicSearchOpen(true);
                        }
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          if (looksLikeRoomIdOrAlias(publicSearchTerm)) joinSelectedPublic();
                          else searchPublicRooms();
                        }
                        if (e.key === 'Escape') setPublicSearchOpen(false);
                      }}
                      disabled={!client}
                      className={`w-full transition-[border-radius] duration-200 ease-out ${inputOpenClass || ''}`}
                    />

                    {showPublicOverlay && (
                      <div className="absolute left-0 right-0 top-full z-50 mt-[-1px] rounded-t-none rounded-b-md border-t-0 shadow-none border border-[hsl(var(--field-border))] bg-[hsl(var(--field))] text-[hsl(var(--field-foreground))]">
                        <ScrollArea viewportClassName="max-h-56 overflow-y-auto p-2">
                          {searching ? (
                            <div className="px-2 py-2 text-sm text-muted-foreground">Searching…</div>
                          ) : publicRooms.length === 0 ? (
                            <div className="px-2 py-2 text-sm text-muted-foreground">No results</div>
                          ) : (
                            <ul className="space-y-1">
                              {publicRooms.map((pubRoom) => {
                                const active = selectedPublicRoom?.room_id === pubRoom.room_id;
                                return (
                                  <li
                                    key={pubRoom.room_id}
                                    onMouseDown={(ev) => ev.preventDefault()}
                                    onClick={() => {
                                      setSelectedPublicRoom(pubRoom);
                                      setPublicSearchTerm(pubRoom.room_id);
                                      setPublicSearchOpen(false);
                                    }}
                                    className={`cursor-pointer select-none rounded-lg px-2 py-2 transition-colors ${
                                      active ? 'bg-muted/60 dark:bg-muted/30' : 'hover:bg-accent/60 dark:hover:bg-muted/50'
                                    }`}
                                  >
                                    <div className="flex items-center gap-2 min-w-0">
                                      <span className="shrink-0">🌍</span>
                                      <div className="min-w-0 flex-1">
                                        <div className="truncate text-sm">{pubRoom.name || pubRoom.room_id}</div>
                                        <div className="truncate text-[11px] text-muted-foreground">{pubRoom.room_id}</div>
                                      </div>
                                    </div>
                                  </li>
                                );
                              })}
                            </ul>
                          )}
                        </ScrollArea>
                      </div>
                    )}
                  </div>

                  <div className="flex justify-center mt-2">
                    <Button onClick={joinSelectedPublic} className="w-[66px]" disabled={!client || !selectedJoinId.trim()}>
                      Join
                    </Button>
                  </div>
                </div>
              )}
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
            <ul className="space-y-2 pb-4" data-testid="room-list" role="listbox" aria-label="Chat rooms">
              {rooms.map((room) => {
                const traits = getRoomTraits(room);
                const displayName = room.name?.trim() || room.roomId;
                const roomEmoji = renderRoomEmoji(traits);

                return (
                  <li
                    key={room.roomId}
                    className="relative"
                    data-testid="room-item"
                    data-room-id={room.roomId}
                    data-encrypted={traits.isEncrypted}
                    role="option"
                    aria-selected={false}
                    aria-label={`${displayName}${traits.isEncrypted ? ', encrypted' : ''}`}
                  >
                    <div
                      onClick={() => onSelect(room.roomId, displayName, traits.isEncrypted, traits.isPublic)}
                      className="cursor-pointer px-4 py-3 flex justify-between items-center hover:bg-accent/60 dark:hover:bg-muted/50"
                    >
                      <div className="flex items-center space-x-2 min-w-0 pr-2">
                        <span className="text-lg shrink-0" aria-hidden="true" data-testid="encryption-badge">
                          {roomEmoji}
                        </span>
                        <span className="truncate text-foreground">{displayName}</span>
                      </div>
                      <button
                        data-room-trigger={room.roomId}
                        onClick={(e) => {
                          e.stopPropagation();
                          toggleRoomMenu(room.roomId);
                        }}
                        className="shrink-0 text-foreground/50 hover:text-foreground focus:outline-none text-lg leading-none px-1"
                        aria-label={`Open menu for ${displayName}`}
                        aria-haspopup="menu"
                        aria-expanded={activeRoomMenu === room.roomId}
                      >
                        &#8942;
                      </button>
                    </div>

                    {activeRoomMenu === room.roomId && (
                      <div
                        ref={activeRoomMenuRef}
                        className="absolute right-4 z-50 w-[124px] p-2 bg-card rounded-2xl border border-border/60 shadow-none"
                        role="menu"
                        aria-label={`Actions for ${displayName}`}
                      >
                        {canInviteMap[room.roomId] && (
                          <Button variant="ghost" size="default" className="w-full mb-1" onClick={() => handleInvite(room.roomId)} role="menuitem">
                            Send Invite
                          </Button>
                        )}
                        <Button variant="ghost" size="default" className="w-full mb-1" onClick={() => handleCopyLink(room)} role="menuitem">
                          Copy Room ID
                        </Button>
                        <Button variant="ghost" size="default" className="w-full" onClick={() => handleLeaveRoom(room.roomId)} role="menuitem">
                          Leave Room
                        </Button>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </ScrollArea>
      </div>

      {inviteOverlay && typeof document !== 'undefined' && ReactDOM.createPortal(
        <div className="fixed inset-0 z-[200] flex items-center justify-center">
          <div className="absolute inset-0 bg-background/40 backdrop-blur-[2px]" onClick={() => setInviteOverlay(null)} />
          <div className="relative w-[92vw] max-w-[320px] glass rounded-3xl p-5 border border-border/70 shadow-none">
            <button type="button" aria-label="Close" onClick={() => setInviteOverlay(null)} className="absolute top-3 right-3 rounded-full p-2 hover:bg-muted/60 dark:hover:bg-muted/50 transition">
              <X className="h-5 w-5" />
            </button>

            <div className="text-center mb-4">
              <div className="text-base font-semibold text-foreground">Invite someone</div>
              <div className="text-xs text-muted-foreground mt-1">Enter their Matrix user ID and invite them</div>
            </div>

            <div className="flex justify-center">
              <Input
                placeholder="@user:matrix.org"
                value={inviteOverlay.user}
                onChange={(e) => setInviteOverlay((prev) => prev ? { ...prev, user: e.target.value } : null)}
                onKeyDown={(e) => { if (e.key === 'Enter') handleSendInvite(); }}
                autoFocus
                className="w-[210px]"
              />
            </div>

            <div className="mt-4 flex justify-center">
              <Button variant="outline" onClick={handleSendInvite} disabled={!inviteOverlay.user.trim()} className="px-4 border-border/70 hover:bg-muted/25">
                Invite
              </Button>
            </div>
          </div>
        </div>,
        document.body
      )}
    </div>
  );
};

export default ChatList;