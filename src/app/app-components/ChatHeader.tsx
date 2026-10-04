'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { checkRoomDevices, requestVerificationToUser, confirmVerificationRequest, cancelVerificationRequest, getMatrixClient } from '../utils/matrix';
import type { RoomDevice } from '../utils/matrix/devices';
import {
  NO_PERMISSIONS,
  canBan,
  canKick,
  canSetPowerLevel,
  getPowerLevel,
  getRoomPermissions,
  type RoomPermissions,
} from '../utils/matrix/permissions';
import type { MemberActionDetail } from './MemberOverlay';
import {
  ClientEvent,
  EventType,
  JoinRule,
  RoomEvent,
  RoomStateEvent,
  Visibility,
  type MatrixClient,
  type MatrixEvent,
  type Room,
} from 'matrix-js-sdk';
import { CryptoEvent } from 'matrix-js-sdk/lib/crypto-api';
import toast from 'react-hot-toast';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import * as DropdownMenuPrimitive from '@radix-ui/react-dropdown-menu';
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from '@/components/ui/dropdown-menu';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Users, Pencil, Check, X, ArrowLeft, Settings, Ban, Lock, Unlock, Globe, ShieldCheck } from 'lucide-react';

interface ChatHeaderProps {
  roomName: string;
  roomId: string;
  isEncrypted?: boolean;
  isPublic?: boolean;
  /* Called with the room's ID once the user has left it from this header */
  onLeave?: (roomId: string) => void;
  onBack?: () => void;
}

type MemberView = 'main' | 'roles' | 'roles_help';

interface Member {
  userId: string;
  powerLevel: number;
}

/* Power level thresholds matching common homeserver defaults, overridable per room via m.room.power_levels */
const ROLE_LEVELS = {
  Spectator: -10,
  Member: 0,
  Moderator: 50,
  Admin: 100,
} as const;

/* Creators of a room version 12 room hold an unlimited power level that no power levels event can change */
const roleLabelFor = (pl: number) => {
  if (pl === Infinity) return 'Creator';
  if (pl >= ROLE_LEVELS.Admin) return 'Admin';
  if (pl >= ROLE_LEVELS.Moderator) return 'Moderator';
  if (pl >= ROLE_LEVELS.Member) return 'Member';
  return 'Spectator';
};

const levelText = (pl: number) => (Number.isFinite(pl) ? String(pl) : '∞');

/* Highest power level first, then by user ID, comparing without subtraction so two unlimited levels tie */
const byLevelThenId = (a: Member, b: Member) => {
  if (a.powerLevel === b.powerLevel) return a.userId.localeCompare(b.userId);
  return b.powerLevel > a.powerLevel ? 1 : -1;
};

/* Joined members with the power level the SDK derives from the room's current power levels and creators */
const listMembers = (room: Room): Member[] =>
  room
    .getJoinedMembers()
    .map((member) => ({ userId: member.userId, powerLevel: member.powerLevel }))
    .sort(byLevelThenId);

const ChatHeader: React.FC<ChatHeaderProps> = ({ roomName, roomId, isEncrypted, isPublic, onLeave, onBack }) => {
  const [client, setClient] = useState<MatrixClient | null>(null);
  const [room, setRoom] = useState<Room | null>(null);
  const [permissions, setPermissions] = useState<RoomPermissions>(NO_PERMISSIONS);
  const [unverifiedDevices, setUnverifiedDevices] = useState<RoomDevice[]>([]);
  const [sasEmojis, setSasEmojis] = useState<string[] | null>(null);
  const [verifyingDevice, setVerifyingDevice] = useState<RoomDevice | null>(null);
  const [encrypted, setEncrypted] = useState<boolean>(!!isEncrypted);
  const [joinRule, setJoinRule] = useState<string | null>(() => (isPublic ? JoinRule.Public : null));
  const [roomTitle, setRoomTitle] = useState(roomName || roomId);
  const [newRoomName, setNewRoomName] = useState('');
  const [isEditingName, setIsEditingName] = useState(false);
  const [members, setMembers] = useState<Member[]>([]);
  const [membersLoading, setMembersLoading] = useState(true);
  const [activeMemberId, setActiveMemberId] = useState<string | null>(null);
  const [memberView, setMemberView] = useState<MemberView>('main');
  const [renaming, setRenaming] = useState(false);
  const [infoDropdownOpen, setInfoDropdownOpen] = useState(false);
  const [membersDropdownOpen, setMembersDropdownOpen] = useState(false);
  const verificationRequestRef = useRef<string | null>(null);
  const mountedRef = useRef(true);
  const skipCloseRef = useRef(false);
  const membersTriggerRef = useRef<HTMLButtonElement | null>(null);
  const membersContentRef = useRef<HTMLDivElement | null>(null);

  /* Set while a member action opens its confirm dialog, so the closing menu leaves focus to the dialog instead of its trigger */
  const dialogOpeningRef = useRef(false);

  /* Holds the current listener so it can be removed before a fresh verification attempt attaches one */
  const verificationListenerRef = useRef<((ev: Event) => void) | null>(null);

  useEffect(() => {
    const onGlobalDropdown = () => {
      if (skipCloseRef.current) {
        skipCloseRef.current = false;
        return;
      }
      setInfoDropdownOpen(false);
      setMembersDropdownOpen(false);
    };
    window.addEventListener('nexus-close-dropdowns', onGlobalDropdown);
    return () => window.removeEventListener('nexus-close-dropdowns', onGlobalDropdown);
  }, []);

  const emitDropdownOpen = () => {
    skipCloseRef.current = true;
    try { window.dispatchEvent(new Event('nexus-close-dropdowns')); } catch {}
  };

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      /* Remove any listener from a previous attempt before attaching the new one */
      if (verificationListenerRef.current) {
        window.removeEventListener('matrix-verification-request', verificationListenerRef.current);
        verificationListenerRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return;

    const attach = () => {
      try { setClient(getMatrixClient()); }
      catch { setClient(null); }
    };

    const detach = () => {
      try {
        if (verificationRequestRef.current) {
          void cancelVerificationRequest(verificationRequestRef.current);
        }
      } catch {}
      verificationRequestRef.current = null;

      setClient(null);
      setRoom(null);
      setPermissions(NO_PERMISSIONS);
      setUnverifiedDevices([]);
      setSasEmojis(null);
      setVerifyingDevice(null);
      setEncrypted(false);
      setJoinRule(null);
      setMembers([]);
      setMembersLoading(true);
      setActiveMemberId(null);
      setIsEditingName(false);
      setNewRoomName('');
      setMemberView('main');
    };

    if (window.__matrix_ready) attach();
    else detach();

    window.addEventListener('matrix-ready', attach);
    window.addEventListener('matrix-not-ready', detach);

    return () => {
      window.removeEventListener('matrix-ready', attach);
      window.removeEventListener('matrix-not-ready', detach);
    };
  }, []);

  const myUserId = client?.getUserId() ?? null;

  /* Title, privacy, encryption, members and permissions are all read again from the SDK's room state whenever any state event reaches this room */
  useEffect(() => {
    if (!client) return;

    const update = () => {
      const current = client.getRoom(roomId);
      setRoom(current);
      if (!current) return;
      const me = client.getUserId();
      setPermissions(me ? getRoomPermissions(current, me) : NO_PERMISSIONS);
      setMembers(listMembers(current));
      setMembersLoading(false);
      setJoinRule(current.getJoinRule());
      setEncrypted(current.hasEncryptionStateEvent());
      setRoomTitle(current.name || roomName || roomId);
    };
    const onStateEvent = (event: MatrixEvent) => {
      if (event.getRoomId() === roomId) update();
    };
    const onRoom = (changed: Room) => {
      if (changed.roomId === roomId) update();
    };

    /* Stop the spinner after 2s even on a slow sync so the member list never loads forever */
    const loadTimeout = setTimeout(() => setMembersLoading(false), 2000);

    update();
    client.on(RoomStateEvent.Events, onStateEvent);
    client.on(ClientEvent.Room, onRoom);
    client.on(RoomEvent.Name, onRoom);
    return () => {
      clearTimeout(loadTimeout);
      client.removeListener(RoomStateEvent.Events, onStateEvent);
      client.removeListener(ClientEvent.Room, onRoom);
      client.removeListener(RoomEvent.Name, onRoom);
    };
  }, [client, roomId, roomName]);

  /* Device lists reach the crypto machine after the room opens and change later, so the Security list is fetched again whenever the SDK reports new devices or trust */
  useEffect(() => {
    if (!client || !encrypted) {
      setUnverifiedDevices([]);
      return;
    }
    let active = true;
    let latest = 0;
    const refresh = () => {
      const request = ++latest;
      checkRoomDevices(client, roomId)
        .then((devices) => {
          if (active && request === latest) setUnverifiedDevices(devices);
        })
        .catch(() => {
          if (active && request === latest) setUnverifiedDevices([]);
        });
    };

    refresh();
    client.on(CryptoEvent.DevicesUpdated, refresh);
    client.on(CryptoEvent.UserTrustStatusChanged, refresh);
    return () => {
      active = false;
      client.removeListener(CryptoEvent.DevicesUpdated, refresh);
      client.removeListener(CryptoEvent.UserTrustStatusChanged, refresh);
    };
  }, [client, roomId, encrypted]);

  const canRename = permissions.canRename;
  const canEditJoinRules = permissions.canChangeJoinRule;
  const canEditEncryption = permissions.canEnableEncryption && !encrypted;

  /* Small indicator beside the room name showing privacy and encryption status */
  const roomEmoji = useMemo(() => {
    if (joinRule === JoinRule.Public && encrypted) return '🛡️';
    if (joinRule === JoinRule.Public) return '🌍';
    if (encrypted) return '🔐';
    if (!joinRule) return ' ';
    return '🔒';
  }, [encrypted, joinRule]);

  const privacyLabel = joinRule === JoinRule.Public ? 'Public' : 'Private';
  const privacyShort =
    joinRule === JoinRule.Public
      ? 'Anyone can discover this room and join it, contingent on room settings.'
      : 'Joining is restricted to invited or approved users only, contingent on room settings.';

  const encryptionLabel = encrypted ? 'Encrypted' : 'Not encrypted';
  const encryptionShort = encrypted
    ? 'Messages are end-to-end encrypted. Only verified devices should be trusted.'
    : 'Messages are not end-to-end encrypted. The server may be able to read them.';

  /* Every async action below re-checks mountedRef, since the header is keyed by room and a result for a room the user has left must not touch the next one */
  const doRename = async () => {
    const name = newRoomName.trim();
    if (!client || !name || renaming) return;
    setRenaming(true);
    try {
      await client.sendStateEvent(roomId, EventType.RoomName, { name }, '');
      if (!mountedRef.current) return;
      setIsEditingName(false);
      setNewRoomName('');
      setRoomTitle(name);
    } catch {
      if (mountedRef.current) toast.error('Could not rename the room');
    } finally {
      if (mountedRef.current) setRenaming(false);
    }
  };

  /* The directory listing follows the join rule, so a room is listed only after it turns public and unlisted before it stops being public */
  const togglePrivacy = async () => {
    if (!client || !canEditJoinRules) return;
    if (joinRule === JoinRule.Public) {
      try {
        await client.setRoomDirectoryVisibility(roomId, Visibility.Private);
        await client.sendStateEvent(roomId, EventType.RoomJoinRules, { join_rule: JoinRule.Invite }, '');
        if (mountedRef.current) setJoinRule(JoinRule.Invite);
      } catch {
        if (mountedRef.current) toast.error('Could not make the room private');
      }
      return;
    }

    try {
      await client.sendStateEvent(roomId, EventType.RoomJoinRules, { join_rule: JoinRule.Public }, '');
      if (mountedRef.current) setJoinRule(JoinRule.Public);
    } catch {
      if (mountedRef.current) toast.error('Could not make the room public');
      return;
    }
    try {
      await client.setRoomDirectoryVisibility(roomId, Visibility.Public);
    } catch {
      if (mountedRef.current) toast.error('The room is public but could not be listed in the room directory');
    }
  };

  const enableEncryption = async () => {
    if (!client || !canEditEncryption) return;
    try {
      await client.sendStateEvent(roomId, EventType.RoomEncryption, { algorithm: 'm.megolm.v1.aes-sha2' }, '');
      if (mountedRef.current) setEncrypted(true);
    } catch {
      if (mountedRef.current) toast.error('Could not enable encryption');
    }
  };

  /* Opens the shared confirm dialog, whose onConfirm rejects on failure so the dialog stays open and shows the reason */
  const requestMemberAction = (detail: Omit<MemberActionDetail, 'roomId' | 'roomName' | 'returnFocusTo'>) => {
    dialogOpeningRef.current = true;
    window.dispatchEvent(
      new CustomEvent<MemberActionDetail>('nexus-member-action', {
        detail: { ...detail, roomId, roomName: roomTitle, returnFocusTo: membersTriggerRef.current },
      })
    );
  };

  const requireClient = (): MatrixClient => {
    if (!client) throw new Error('Matrix client not ready');
    return client;
  };

  /* Irreversible role changes get a warning in the confirm dialog, since nobody at or below the sender's level can undo them */
  const roleChangeWarning = (userId: string, targetLevel: number): string | undefined => {
    if (!room || !myUserId) return undefined;
    if (userId === myUserId) return 'This can’t be undone: you are lowering your own power level.';
    if (targetLevel === getPowerLevel(room, myUserId)) return 'This can’t be undone: they will have the same power level as you.';
    return undefined;
  };

  /* The new power levels copy the room's current content and change one user's entry, as the auth rules compare entry by entry */
  const doSetRole = (userId: string, targetLevel: number, roleLabel: string) =>
    requestMemberAction({
      type: 'role',
      targetUserId: userId,
      roleLabel,
      warning: roleChangeWarning(userId, targetLevel),
      onConfirm: async () => {
        const matrix = requireClient();
        const content = matrix.getRoom(roomId)?.currentState.getStateEvents(EventType.RoomPowerLevels, '')?.getContent();
        if (!content) throw new Error('This room has no power levels to change');
        const users = { ...(content.users ?? {}), [userId]: targetLevel };
        await matrix.sendStateEvent(roomId, EventType.RoomPowerLevels, { ...content, users }, '');
      },
    });

  const doKick = (userId: string) =>
    requestMemberAction({
      type: 'kick',
      targetUserId: userId,
      onConfirm: async () => {
        await requireClient().kick(roomId, userId, 'Removed');
      },
    });

  const doBan = (userId: string) =>
    requestMemberAction({
      type: 'ban',
      targetUserId: userId,
      onConfirm: async () => {
        await requireClient().ban(roomId, userId, 'Banned');
      },
    });

  const doLeave = () =>
    requestMemberAction({
      type: 'leave',
      onConfirm: async () => {
        await requireClient().leave(roomId);
        if (mountedRef.current) onLeave?.(roomId);
      },
    });

  const startVerification = useCallback(
    async (device: RoomDevice) => {
      if (!client || !myUserId) return;

      setVerifyingDevice(device);
      setSasEmojis(null);

      try {
        const snapshot = await requestVerificationToUser(device.userId, [device.deviceId]);
        if (!snapshot?.id) {
          setVerifyingDevice(null);
          setSasEmojis(null);
          return;
        }

        verificationRequestRef.current = snapshot.id;

        if (verificationListenerRef.current) {
          window.removeEventListener('matrix-verification-request', verificationListenerRef.current);
          verificationListenerRef.current = null;
        }

        const onVerificationUpdate = (ev: Event) => {
          if (!mountedRef.current) return;
          const snap = (ev as CustomEvent).detail;
          if (snap?.id !== verificationRequestRef.current && snap?.txnId !== verificationRequestRef.current) return;

          if (snap?.sasEmojis?.length) setSasEmojis(snap.sasEmojis);

          if (snap?.phase === 'done' || snap?.phase === 'cancelled') {
            setVerifyingDevice(null);
            setSasEmojis(null);

            window.removeEventListener('matrix-verification-request', onVerificationUpdate);
            verificationListenerRef.current = null;
          }
        };

        window.addEventListener('matrix-verification-request', onVerificationUpdate);
        verificationListenerRef.current = onVerificationUpdate;

        if (snapshot.sasEmojis?.length) setSasEmojis(snapshot.sasEmojis);
      } catch {
        if (!mountedRef.current) return;
        setVerifyingDevice(null);
        setSasEmojis(null);
      }
    },
    [client, myUserId]
  );

  const confirmVerification = useCallback(async () => {
    try {
      const reqId = verificationRequestRef.current;
      if (reqId) await confirmVerificationRequest(reqId);
      setVerifyingDevice(null);
      setSasEmojis(null);
      if (!client) return;
      const unverified = await checkRoomDevices(client, roomId);
      if (!mountedRef.current) return;
      setUnverifiedDevices(unverified);
    } catch {}
  }, [roomId, client]);

  const cancelVerification = useCallback(async () => {
    try {
      const reqId = verificationRequestRef.current;
      if (reqId) await cancelVerificationRequest(reqId);
    } catch {}
    setVerifyingDevice(null);
    setSasEmojis(null);
  }, []);

  const activeMember = useMemo(() => {
    if (!activeMemberId) return null;
    return members.find((m) => m.userId === activeMemberId) || null;
  }, [activeMemberId, members]);

  const activeIsMe = !!activeMember && activeMember.userId === myUserId;

  /* The SDK's room state is current whenever this renders, because every state event re-renders the header */
  const canOpenRoleTab = !!activeMember && permissions.canChangeRoles;
  const canKickActive = !!activeMember && !!room && !!myUserId && (activeIsMe || canKick(room, myUserId, activeMember.userId));
  const canBanActive = !!activeMember && !activeIsMe && !!room && !!myUserId && canBan(room, myUserId, activeMember.userId);
  const canSetRoleOfActive = (level: number) => !!activeMember && !!room && !!myUserId && canSetPowerLevel(room, myUserId, activeMember.userId, level);

  const actionWidthClass = 'w-[99px]';
  const btnBase = 'h-9 rounded-xl justify-center transition-colors border text-foreground bg-muted/30 border-border/60 dark:bg-muted/20 dark:border-border/40';
  const btnHover = 'hover:bg-accent/60 dark:hover:bg-muted/60';
  const btnDanger = 'text-destructive hover:text-destructive hover:bg-destructive/10 dark:hover:bg-destructive/15';
  const restrictedBtn = 'opacity-70 cursor-not-allowed pointer-events-none';
  const settingsActionClass = 'text-xs h-7 rounded-xl border bg-sky-500/10 dark:bg-sky-400/10 border-sky-500/20 dark:border-sky-400/20 text-foreground hover:bg-sky-500/20 dark:hover:bg-sky-400/20 focus-visible:bg-sky-500/20 dark:focus-visible:bg-sky-400/20 transition-colors';

  const dropdownHeaderTitle = useMemo(() => {
    if (!activeMember) return 'Member List';
    if (memberView === 'roles' || memberView === 'roles_help') return 'Role';
    return 'Options';
  }, [activeMember, memberView]);

  /* Switching the Members dropdown to another view unmounts the focused item, so focus moves to the first enabled action of the new view */
  const showMemberView = (memberId: string | null, view: MemberView) => {
    setActiveMemberId(memberId);
    setMemberView(view);
    requestAnimationFrame(() => {
      const content = membersContentRef.current;
      const enabled = content?.querySelectorAll<HTMLElement>('[role="menuitem"]:not([data-disabled])');
      const target = Array.from(enabled ?? []).find((item) => !item.hasAttribute('data-menu-back')) ?? enabled?.[0] ?? content;
      target?.focus();
    });
  };

  const onHeaderBack = () => {
    if (!activeMember) return;
    if (memberView === 'roles_help') showMemberView(activeMember.userId, 'roles');
    else if (memberView === 'roles') showMemberView(activeMember.userId, 'main');
    else showMemberView(null, 'main');
  };

  /* Radix closes a menu when one of its items is selected, which these items prevent because they act inside the open menu */
  const inMenu = (action: () => void) => (event: Event) => {
    event.preventDefault();
    action();
  };

  const showHeaderBack = !!activeMember;

  const ActionLabel = ({ label, restricted }: { label: string; restricted: boolean }) => (
    <span className="inline-flex items-center gap-2">
      <span>{label}</span>
      {restricted && <Ban className="h-4 w-4 text-destructive" aria-hidden="true" />}
    </span>
  );

  return (
    <header className="glass-flush-left rounded-none no-border-top no-border-right no-border-bottom glass-opaque shadow-none" data-testid="chat-header">
      <div className="flex items-center justify-between px-4 h-16 gap-3">
        <div className="flex items-center min-w-0 flex-1 gap-2">
          {onBack && (
            <Button
              variant="ghost"
              size="icon"
              onClick={onBack}
              aria-label="Back to chats"
              className="header-icon-btn hover:bg-accent/60 dark:hover:bg-muted/50 shrink-0 md:hidden"
            >
              <ArrowLeft className="h-5 w-5" />
            </Button>
          )}
          {isEditingName && canRename ? (
            <div className="flex items-center gap-2 min-w-0 flex-1">
              <Input
                placeholder="New name"
                aria-label="New room name"
                value={newRoomName}
                onChange={(e) => setNewRoomName(e.target.value)}
                className="h-8 flex-1 min-w-0 max-w-[260px]"
              />
              <Button
                variant="secondary"
                size="icon"
                className="h-8 w-8 rounded-full shrink-0"
                onClick={() => { setIsEditingName(false); setNewRoomName(''); }}
                aria-label="Cancel rename"
              >
                <X className="h-4 w-4" />
              </Button>
              <Button
                variant="secondary"
                size="icon"
                className="h-8 w-8 rounded-full shrink-0"
                onClick={() => void doRename()}
                disabled={!newRoomName.trim() || renaming}
                aria-label="Save rename"
              >
                <Check className="h-4 w-4" />
              </Button>
            </div>
          ) : (
            <h3 className="text-lg font-bold text-foreground flex items-center gap-2 min-w-0">
              <span className="shrink-0" aria-hidden="true">
                {roomEmoji}
              </span>
              <span className="truncate" data-testid="room-name">{roomTitle}</span>
              {canRename && (
                <Button
                  variant="ghost"
                  size="icon"
                  className="header-icon-btn hover:bg-accent/60 dark:hover:bg-muted/50 shrink-0"
                  onClick={() => {
                    setIsEditingName((f) => !f);
                    setNewRoomName('');
                  }}
                  aria-label="Rename room"
                >
                  <Pencil className="h-4 w-4" />
                </Button>
              )}
            </h3>
          )}
        </div>

        <div className="flex items-center gap-1">

          <DropdownMenu
            modal={false}
            open={infoDropdownOpen}
            onOpenChange={(open) => {
              if (open) emitDropdownOpen();
              setInfoDropdownOpen(open);
            }}
          >
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                aria-label="Room settings"
                className="header-icon-btn hover:bg-accent/60 dark:hover:bg-muted/50"
              >
                <Settings className="h-5 w-5 text-muted-foreground" />
              </Button>
            </DropdownMenuTrigger>

            <DropdownMenuContent align="end" className="glass border-border/60 w-[280px] p-0 overflow-hidden">
              <div className="px-3 pt-2.5 pb-2">
                <div className="text-xs font-semibold tracking-[0.18em] uppercase text-muted-foreground text-center">
                  Room Settings
                </div>
              </div>

              <div className="px-3 pb-3 space-y-2">
                <div className="rounded-xl border border-border bg-muted/20 dark:bg-muted/15 px-3 py-2">
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex items-center gap-2">
                      {joinRule === JoinRule.Public ? (
                        <Globe className="h-4 w-4 text-muted-foreground" />
                      ) : (
                        <Lock className="h-4 w-4 text-muted-foreground" />
                      )}
                      <div className="text-sm font-semibold text-foreground">Privacy</div>
                    </div>
                    <div className="text-xs font-semibold leading-none px-2 py-0.5 rounded-full bg-sky-500/10 dark:bg-sky-400/10 border border-sky-500/20 dark:border-sky-400/20">
                      {privacyLabel}
                    </div>
                  </div>
                  <div className="mt-1 text-xs text-muted-foreground">{privacyShort}</div>
                  {canEditJoinRules && (
                    <div className="mt-2 flex justify-center">
                      <DropdownMenuPrimitive.Item asChild onSelect={inMenu(() => void togglePrivacy())}>
                        <Button variant="ghost" size="sm" className={`w-[120px] ${settingsActionClass}`}>
                          {joinRule === JoinRule.Public ? (
                            <><Lock className="h-3 w-3 mr-1.5" />Make Private</>
                          ) : (
                            <><Globe className="h-3 w-3 mr-1.5" />Make Public</>
                          )}
                        </Button>
                      </DropdownMenuPrimitive.Item>
                    </div>
                  )}
                </div>

                <div className="rounded-xl border border-border bg-muted/20 dark:bg-muted/15 px-3 py-2">
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex items-center gap-2">
                      {encrypted ? (
                        <ShieldCheck className="h-4 w-4 text-muted-foreground" />
                      ) : (
                        <Unlock className="h-4 w-4 text-muted-foreground" />
                      )}
                      <div className="text-sm font-semibold text-foreground">Encryption</div>
                    </div>
                    <div className="text-xs font-semibold leading-none px-2 py-0.5 rounded-full bg-sky-500/10 dark:bg-sky-400/10 border border-sky-500/20 dark:border-sky-400/20">
                      {encryptionLabel}
                    </div>
                  </div>
                  <div className="mt-1 text-xs text-muted-foreground">{encryptionShort}</div>
                  {canEditEncryption && (
                    <div className="mt-2 flex justify-center">
                      <DropdownMenuPrimitive.Item asChild onSelect={inMenu(() => void enableEncryption())}>
                        <Button variant="ghost" size="sm" className={settingsActionClass}>
                          <ShieldCheck className="h-3 w-3 mr-1.5" />
                          Enable Encryption
                        </Button>
                      </DropdownMenuPrimitive.Item>
                    </div>
                  )}
                  {encrypted && (
                    <div className="mt-2 text-[10px] text-amber-800 dark:text-amber-400">
                      Encryption cannot be disabled once enabled.
                    </div>
                  )}
                </div>
              </div>
            </DropdownMenuContent>
          </DropdownMenu>

          <DropdownMenu
            modal={false}
            open={membersDropdownOpen}
            onOpenChange={(open) => {
              if (open) {
                emitDropdownOpen();
                setActiveMemberId(null);
                setMemberView('main');
              }
              setMembersDropdownOpen(open);
            }}
          >
            <DropdownMenuTrigger asChild>
              <Button
                ref={membersTriggerRef}
                variant="ghost"
                size="icon"
                aria-label="Members"
                className="header-icon-btn hover:bg-accent/60 dark:hover:bg-muted/50"
              >
                <Users className="h-5 w-5 text-muted-foreground" />
              </Button>
            </DropdownMenuTrigger>

            <DropdownMenuContent
              ref={membersContentRef}
              align="end"
              className="glass border-border/60 w-[201px] flex flex-col overflow-hidden p-0"
              onCloseAutoFocus={(event) => {
                if (!dialogOpeningRef.current) return;
                dialogOpeningRef.current = false;
                event.preventDefault();
              }}
            >
              <div className="relative shrink-0 px-3 pt-2.5 pb-2">
                {showHeaderBack && (
                  <DropdownMenuPrimitive.Item asChild onSelect={inMenu(onHeaderBack)}>
                    <button
                      type="button"
                      data-menu-back=""
                      className="absolute left-2 top-1/2 -translate-y-1/2 flex items-center rounded-md text-foreground underline underline-offset-2 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                      aria-label="Go back"
                    >
                      <ArrowLeft className="h-5 w-5 stroke-[2.5]" />
                    </button>
                  </DropdownMenuPrimitive.Item>
                )}

                <div className="text-xs font-semibold tracking-[0.18em] uppercase text-muted-foreground text-center">
                  {dropdownHeaderTitle}
                </div>
              </div>

              {!activeMember ? (
                <ScrollArea className="flex-1 min-h-0" viewportClassName="max-h-[60vh] w-full overflow-y-auto p-2">
                  {membersLoading ? (
                    <div className="flex flex-col items-center justify-center py-4 gap-2">
                      <div
                        className="h-5 w-5 rounded-full border-2 border-border/60 border-t-muted-foreground animate-spin"
                        aria-hidden="true"
                      />
                      <div className="text-xs text-muted-foreground">Loading members…</div>
                    </div>
                  ) : members.length === 0 ? (
                    <div className="px-3 py-2 text-sm text-muted-foreground text-center">No members</div>
                  ) : (
                    members.map((m) => (
                      <DropdownMenuItem
                        key={m.userId}
                        onSelect={inMenu(() => showMemberView(m.userId, 'main'))}
                        className="flex flex-col items-start gap-0.5 rounded-xl px-3 py-2 transition-colors hover:bg-accent/60 dark:hover:bg-muted/50 focus:bg-accent/60 dark:focus:bg-muted/50"
                      >
                        <div className="font-medium truncate w-full">{m.userId}</div>
                        <div className="text-xs text-muted-foreground truncate w-full">
                          {roleLabelFor(m.powerLevel)} · PL: {levelText(m.powerLevel)}
                        </div>
                      </DropdownMenuItem>
                    ))
                  )}
                </ScrollArea>
              ) : (
                <ScrollArea className="flex-1 min-h-0" viewportClassName="max-h-[60vh] w-full overflow-y-auto p-3">
                  {memberView === 'main' ? (
                    <div className="flex flex-col items-center gap-2">
                      <DropdownMenuPrimitive.Item
                        asChild
                        disabled={!canOpenRoleTab}
                        onSelect={inMenu(() => showMemberView(activeMember.userId, 'roles'))}
                      >
                        <Button
                          variant="secondary"
                          size="sm"
                          className={`${btnBase} ${btnHover} ${actionWidthClass} ${!canOpenRoleTab ? restrictedBtn : ''}`}
                        >
                          <ActionLabel label="Role" restricted={!canOpenRoleTab} />
                        </Button>
                      </DropdownMenuPrimitive.Item>

                      <DropdownMenuPrimitive.Item
                        asChild
                        disabled={!canKickActive}
                        onSelect={() => (activeIsMe ? doLeave() : doKick(activeMember.userId))}
                      >
                        <Button
                          variant="secondary"
                          size="sm"
                          className={`${btnBase} ${btnDanger} ${actionWidthClass} ${!canKickActive ? restrictedBtn : ''}`}
                        >
                          <ActionLabel label={activeIsMe ? 'Leave' : 'Kick'} restricted={!canKickActive} />
                        </Button>
                      </DropdownMenuPrimitive.Item>

                      {!activeIsMe && (
                        <DropdownMenuPrimitive.Item asChild disabled={!canBanActive} onSelect={() => doBan(activeMember.userId)}>
                          <Button
                            variant="secondary"
                            size="sm"
                            className={`${btnBase} ${btnDanger} ${actionWidthClass} ${!canBanActive ? restrictedBtn : ''}`}
                            data-testid="ban-button"
                          >
                            <ActionLabel label="Ban" restricted={!canBanActive} />
                          </Button>
                        </DropdownMenuPrimitive.Item>
                      )}
                    </div>
                  ) : memberView === 'roles' ? (
                    <div className="flex flex-col items-center gap-2">
                      <div className="w-full px-1">
                        <div className="text-sm font-semibold truncate text-center">{activeMember.userId}</div>
                        <div className="text-xs text-muted-foreground text-center mt-1">
                          {roleLabelFor(activeMember.powerLevel)} · PL: {levelText(activeMember.powerLevel)}
                        </div>
                      </div>

                      <DropdownMenuPrimitive.Item asChild onSelect={inMenu(() => showMemberView(activeMember.userId, 'roles_help'))}>
                        <button
                          type="button"
                          className="rounded-md text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground focus-visible:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring transition-colors"
                        >
                          Explain roles
                        </button>
                      </DropdownMenuPrimitive.Item>

                      <div className="flex flex-col items-center gap-2">
                        {(Object.keys(ROLE_LEVELS) as (keyof typeof ROLE_LEVELS)[]).map((k) => {
                          const level = ROLE_LEVELS[k];
                          const allowed = canSetRoleOfActive(level);
                          return (
                            <DropdownMenuPrimitive.Item
                              key={k}
                              asChild
                              disabled={!allowed}
                              onSelect={() => doSetRole(activeMember.userId, level, k)}
                            >
                              <Button
                                variant="secondary"
                                size="sm"
                                className={`${btnBase} ${btnHover} ${actionWidthClass} ${!allowed ? restrictedBtn : ''}`}
                              >
                                <ActionLabel label={k} restricted={!allowed} />
                              </Button>
                            </DropdownMenuPrimitive.Item>
                          );
                        })}
                      </div>
                    </div>
                  ) : (
                    <div className="px-1">
                      <div className="space-y-2 text-xs">
                        <div>
                          <div className="font-semibold text-foreground">Spectator</div>
                          <div className="text-muted-foreground">Power Level: -10. Read-only access to the chat room.</div>
                        </div>
                        <div>
                          <div className="font-semibold text-foreground">Member</div>
                          <div className="text-muted-foreground">Power Level: 0. Enjoys default member privileges.</div>
                        </div>
                        <div>
                          <div className="font-semibold text-foreground">Moderator</div>
                          <div className="text-muted-foreground">
                            Power Level: 50. Can typically rename rooms and kick lower PL users.
                          </div>
                        </div>
                        <div>
                          <div className="font-semibold text-foreground">Admin</div>
                          <div className="text-muted-foreground">
                            Power Level: 100. Can typically manage roles and moderate lower PL users.
                          </div>
                        </div>
                        <div className="text-[11px] text-muted-foreground">
                          Final permissions come from the room&apos;s <span className="font-semibold">m.room.power_levels</span>{' '}
                          settings and may differ per room.
                        </div>
                      </div>
                    </div>
                  )}
                </ScrollArea>
              )}

              {encrypted && unverifiedDevices.length > 0 && (
                <div className="p-3 space-y-2">
                  <div className="text-xs font-semibold tracking-[0.18em] uppercase text-muted-foreground text-center">
                    Security
                  </div>

                  <div className="text-xs text-muted-foreground text-center">
                    Unverified devices can&apos;t be fully trusted for encryption.
                  </div>

                  <div className="flex flex-col gap-2">
                    {unverifiedDevices.map((d) => (
                      <DropdownMenuPrimitive.Item
                        key={`${d.userId}|${d.deviceId}`}
                        asChild
                        disabled={!!verifyingDevice}
                        onSelect={inMenu(() => void startVerification(d))}
                      >
                        <Button variant="secondary" size="sm" className="w-full justify-center transition-colors data-[disabled]:opacity-50">
                          Verify {d.userId} · {d.deviceId}
                        </Button>
                      </DropdownMenuPrimitive.Item>
                    ))}
                  </div>

                  {verifyingDevice && (
                    <div className="mt-2 rounded-xl bg-muted/20 dark:bg-muted/15 p-3">
                      <div className="text-sm font-medium mb-2">Verify device: {verifyingDevice.userId} · {verifyingDevice.deviceId}</div>

                      {sasEmojis ? (
                        <>
                          <div className="text-sm text-muted-foreground mb-2">Compare these emojis:</div>
                          <div className="flex flex-wrap gap-2 mb-3">
                            {sasEmojis.map((e, idx) => (
                              <span key={`${e}-${idx}`} className="text-2xl">{e}</span>
                            ))}
                          </div>
                          <div className="flex gap-2">
                            <DropdownMenuPrimitive.Item asChild onSelect={inMenu(() => void confirmVerification())}>
                              <Button size="sm" className="transition-colors">
                                They match
                              </Button>
                            </DropdownMenuPrimitive.Item>
                            <DropdownMenuPrimitive.Item asChild onSelect={inMenu(() => void cancelVerification())}>
                              <Button variant="secondary" size="sm" className="transition-colors">
                                Cancel
                              </Button>
                            </DropdownMenuPrimitive.Item>
                          </div>
                        </>
                      ) : (
                        <div className="text-sm text-muted-foreground">Starting verification…</div>
                      )}
                    </div>
                  )}
                </div>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    </header>
  );
};

export default ChatHeader;