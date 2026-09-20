/* eslint-disable @typescript-eslint/no-explicit-any */
'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { checkRoomDevices, requestVerificationToUser, confirmVerificationRequest, cancelVerificationRequest, getMatrixClient } from '../utils/matrix';
import { Room, RoomEvent, RoomStateEvent, ClientEvent, MatrixClient } from 'matrix-js-sdk';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from '@/components/ui/dropdown-menu';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Users, Pencil, Check, X, ArrowLeft, Settings, Ban, Lock, Unlock, Globe, ShieldCheck } from 'lucide-react';

interface ChatHeaderProps {
  roomName: string;
  roomId: string;
  isEncrypted?: boolean;
  isPublic?: boolean;
  onLeave?: () => void;
  onBack?: () => void;
}

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

const roleLabelFor = (pl: number) => {
  if (pl >= ROLE_LEVELS.Admin) return 'Admin';
  if (pl >= ROLE_LEVELS.Moderator) return 'Moderator';
  if (pl >= ROLE_LEVELS.Member) return 'Member';
  return 'Spectator';
};

const ChatHeader: React.FC<ChatHeaderProps> = ({ roomName, roomId, isEncrypted, isPublic, onLeave, onBack }) => {
  const [client, setClient] = useState<MatrixClient | null>(null);
  const [unverifiedDevices, setUnverifiedDevices] = useState<string[]>([]);
  const [sasEmojis, setSasEmojis] = useState<string[] | null>(null);
  const [verifyingDevice, setVerifyingDevice] = useState<string | null>(null);
  const [encrypted, setEncrypted] = useState<boolean>(!!isEncrypted);
  const [joinRule, setJoinRule] = useState<string | null>(() => (isPublic ? 'public' : null));
  const [roomTitle, setRoomTitle] = useState(roomName || roomId);
  const [newRoomName, setNewRoomName] = useState('');
  const [isEditingName, setIsEditingName] = useState(false);
  const [members, setMembers] = useState<Member[]>([]);
  const [membersLoading, setMembersLoading] = useState(true);
  const [myPowerLevel, setMyPowerLevel] = useState(0);
  const [activeMemberId, setActiveMemberId] = useState<string | null>(null);
  const [memberView, setMemberView] = useState<'main' | 'roles' | 'roles_help'>('main');
  const [infoDropdownOpen, setInfoDropdownOpen] = useState(false);
  const [membersDropdownOpen, setMembersDropdownOpen] = useState(false);
  const verificationRequestRef = useRef<string | null>(null);
  const mountedRef = useRef(true);
  const skipCloseRef = useRef(false);

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
    setRoomTitle(roomName || roomId);
  }, [roomName, roomId]);

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
      setUnverifiedDevices([]);
      setSasEmojis(null);
      setVerifyingDevice(null);
      setEncrypted(false);
      setJoinRule(null);
      setMembers([]);
      setMembersLoading(true);
      setMyPowerLevel(0);
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

  useEffect(() => setEncrypted(!!isEncrypted), [isEncrypted]);

  useEffect(() => {
    setJoinRule(isPublic ? 'public' : null);
  }, [roomId, isPublic]);

  const [room, setRoom] = useState<Room | null>(null);

  useEffect(() => {
    if (!client) { setRoom(null); return; }
    setRoom(client.getRoom(roomId) || null);
    const onRoomSync = () => setRoom(client.getRoom(roomId) || null);
    client.on(ClientEvent.Sync, onRoomSync);
    return () => { try { client.removeListener(ClientEvent.Sync, onRoomSync); } catch {} };
  }, [client, roomId]);

  const myUserId = client?.getUserId?.() || null;

  const refreshRoomName = useCallback(() => {
    if (!room) {
      setRoomTitle(roomName || roomId);
      return;
    }
    setRoomTitle(room.name || roomName || roomId);
  }, [room, roomName, roomId]);

  const computeJoinRule = useCallback(() => {
    if (!client) return;
    const r = client.getRoom(roomId);
    const ev: any = r?.currentState?.getStateEvents?.('m.room.join_rules', '');
    const jr = ev?.getContent?.()?.join_rule;
    setJoinRule(typeof jr === 'string' ? jr : null);
  }, [client, roomId]);

  const computeEncrypted = useCallback(() => {
    if (!client) return;
    const r = client.getRoom(roomId);
    const encEvent = r?.currentState?.getStateEvents?.('m.room.encryption', '');
    setEncrypted(!!encEvent);
  }, [client, roomId]);

  const getPowerLevelsContent = useCallback(() => {
    const r = room;
    if (!r) return null;
    const ev = r.currentState?.getStateEvents?.('m.room.power_levels', '');
    const c = (ev as any)?.getContent?.();
    return c && typeof c === 'object' ? c : null;
  }, [room]);

  /* Resolves effective power level from m.room.power_levels, falling back to users_default followed by the member */
  const getMemberPL = useCallback(
    (userId: string) => {
      const pl = getPowerLevelsContent() || {};
      const users = (pl as any).users && typeof (pl as any).users === 'object' ? (pl as any).users : {};
      const usersDefault = Number.isFinite((pl as any).users_default) ? (pl as any).users_default : 0;
      const fromUsers = users?.[userId];
      if (Number.isFinite(fromUsers)) return fromUsers;
      const fromMember = room?.getMember?.(userId)?.powerLevel;
      if (Number.isFinite(fromMember)) return fromMember;
      return usersDefault;
    },
    [getPowerLevelsContent, room]
  );

  const getRequiredPLForStateEvent = useCallback(
    (eventType: string) => {
      const pl = getPowerLevelsContent();
      if (!pl) return 50;
      const events = (pl as any).events && typeof (pl as any).events === 'object' ? (pl as any).events : {};
      const v = events?.[eventType];
      if (Number.isFinite(v)) return v;
      if (Number.isFinite((pl as any).state_default)) return (pl as any).state_default;
      return 50;
    },
    [getPowerLevelsContent]
  );

  const getKickPL = useCallback(() => {
    const pl = getPowerLevelsContent();
    if (!pl) return 50;
    if (Number.isFinite((pl as any).kick)) return (pl as any).kick;
    return 50;
  }, [getPowerLevelsContent]);

  const getBanPL = useCallback(() => {
    const pl = getPowerLevelsContent();
    if (!pl) return 50;
    if (Number.isFinite((pl as any).ban)) return (pl as any).ban;
    return 50;
  }, [getPowerLevelsContent]);

  const canRename = useMemo(() => {
    if (!myUserId) return false;
    return myPowerLevel >= getRequiredPLForStateEvent('m.room.name');
  }, [getRequiredPLForStateEvent, myPowerLevel, myUserId]);

  const canEditJoinRules = useMemo(() => {
    if (!myUserId) return false;
    return myPowerLevel >= getRequiredPLForStateEvent('m.room.join_rules');
  }, [getRequiredPLForStateEvent, myPowerLevel, myUserId]);

  const canEditEncryption = useMemo(() => {
    if (!myUserId) return false;
    if (encrypted) return false;
    return myPowerLevel >= getRequiredPLForStateEvent('m.room.encryption');
  }, [getRequiredPLForStateEvent, myPowerLevel, myUserId, encrypted]);

  const canAffectMember = useCallback(
    (userId: string) => {
      if (!myUserId) return false;
      const theirs = getMemberPL(userId);
      return myPowerLevel > theirs;
    },
    [getMemberPL, myPowerLevel, myUserId]
  );

  const canKick = useCallback(
    (targetUserId: string) => {
      if (!myUserId) return false;
      if (targetUserId === myUserId) return false;
      const kickPL = getKickPL();
      if (myPowerLevel < kickPL) return false;
      return canAffectMember(targetUserId);
    },
    [canAffectMember, getKickPL, myPowerLevel, myUserId]
  );

  const canBan = useCallback(
    (targetUserId: string) => {
      if (!myUserId) return false;
      if (targetUserId === myUserId) return false;
      const banPL = getBanPL();
      if (myPowerLevel < banPL) return false;
      return canAffectMember(targetUserId);
    },
    [canAffectMember, getBanPL, myPowerLevel, myUserId]
  );

  const isAdminLabel = useMemo(() => myPowerLevel >= ROLE_LEVELS.Admin, [myPowerLevel]);

  const canSetPowerLevel = useCallback(
    (targetUserId: string, newLevel: number) => {
      if (!myUserId) return false;

      const requiredForPL = getRequiredPLForStateEvent('m.room.power_levels');
      if (myPowerLevel < requiredForPL) return false;

      if (targetUserId === myUserId) {
        if (!isAdminLabel) return false;
        return true;
      }

      const targetPL = getMemberPL(targetUserId);
      if (myPowerLevel <= targetPL) return false;
      if (myPowerLevel <= newLevel) return false;

      return true;
    },
    [getMemberPL, getRequiredPLForStateEvent, isAdminLabel, myPowerLevel, myUserId]
  );

  const refreshMembersAndPower = useCallback(() => {
    if (!client || !room) return;
    const uid = client.getUserId();
    if (!uid) return;

    const list = room.getJoinedMembers?.() || room.getMembers?.() || [];
    const mapped = list.map((m: any) => ({
      userId: m.userId,
      powerLevel: getMemberPL(m.userId),
    }));

    mapped.sort((a, b) => b.powerLevel - a.powerLevel || a.userId.localeCompare(b.userId));

    setMembers(mapped);
    setMembersLoading(false);
    setMyPowerLevel(getMemberPL(uid));
  }, [client, room, getMemberPL]);

  useEffect(() => {
    if (!client) return;

    /* Stop the spinner after 2s even on a slow sync so the member list never loads forever */
    const loadTimeout = setTimeout(() => {
      setMembersLoading(false);
    }, 2000);

    const onSync = (syncState: string) => {
      if (syncState === 'SYNCING' || syncState === 'PREPARED') {
        const currentRoom = client.getRoom(roomId);
        if (currentRoom) {
          computeEncrypted();
          computeJoinRule();
          refreshRoomName();
          const uid = client.getUserId();
          if (uid) {
            const list = currentRoom.getJoinedMembers?.() || currentRoom.getMembers?.() || [];
            const mapped = list.map((m: any) => ({
              userId: m.userId,
              powerLevel: getMemberPL(m.userId),
            }));
            mapped.sort((a, b) => b.powerLevel - a.powerLevel || a.userId.localeCompare(b.userId));
            setMembers(mapped);
            setMembersLoading(false);
            setMyPowerLevel(getMemberPL(uid));
          }
        }
      }
    };

    client.on(ClientEvent.Sync, onSync);

    if (!room) {
      return () => {
        clearTimeout(loadTimeout);
        client.removeListener(ClientEvent.Sync, onSync);
      };
    }

    refreshRoomName();
    computeEncrypted();
    computeJoinRule();
    refreshMembersAndPower();

    const fetchUnverified = async () => {
      try {
        if (!encrypted) {
          if (!mountedRef.current) return;
          setUnverifiedDevices([]);
          return;
        }
        const unverified = await checkRoomDevices(client, roomId);
        if (!mountedRef.current) return;
        setUnverifiedDevices(unverified);
      } catch {
        if (!mountedRef.current) return;
        setUnverifiedDevices([]);
      }
    };

    fetchUnverified();

    const onState = (ev: any) => {
      const t = ev?.getType?.();
      if (ev?.getRoomId?.() !== roomId) return;
      if (t === 'm.room.join_rules') computeJoinRule();
      if (t === 'm.room.encryption') computeEncrypted();
      /* Keep the member list and power levels in sync as room state changes */
      if (t === 'm.room.power_levels' || t === 'm.room.member') refreshMembersAndPower();
      if (t === 'm.room.name') {
        const newName = ev?.getContent?.()?.name;
        if (typeof newName === 'string' && newName) {
          setRoomTitle(newName);
        } else {
          refreshRoomName();
        }
      }
    };

    const onTimeline = (ev: any, r: any) => {
      if (r?.roomId !== roomId) return;
      const t = ev?.getType?.();
      if (t === 'm.room.member') refreshMembersAndPower();
    };

    client.on(RoomStateEvent.Events, onState as any);
    client.on(RoomEvent.Timeline, onTimeline as any);

    return () => {
      clearTimeout(loadTimeout);
      try {
        client.removeListener(RoomStateEvent.Events, onState as any);
        client.removeListener(RoomEvent.Timeline, onTimeline as any);
        client.removeListener(ClientEvent.Sync, onSync);
      } catch {}
    };
  }, [client, room, roomId, computeEncrypted, computeJoinRule, refreshMembersAndPower, refreshRoomName, encrypted, getMemberPL]);

  /* Small indicator beside the room name showing privacy and encryption status */
  const roomEmoji = useMemo(() => {
    const jr =
      joinRule ??
      (() => {
        const joinRulesEv: any = room?.currentState?.getStateEvents?.('m.room.join_rules', '');
        return joinRulesEv?.getContent?.()?.join_rule ?? null;
      })();
    if (jr === 'public' && encrypted) return '🛡️';
    if (jr === 'public') return '🌍';
    if (encrypted) return '🔐';
    if (!jr) return ' ';
    return '🔒';
  }, [encrypted, joinRule, room]);

  const privacyLabel = useMemo(() => {
    if (joinRule === 'public') return 'Public';
    return 'Private';
  }, [joinRule]);

  const privacyShort = useMemo(() => {
    if (joinRule === 'public') return 'Anyone can discover this room and join it, contingent on room settings.';
    return 'Joining is restricted to invited or approved users only, contingent on room settings.';
  }, [joinRule]);

  const encryptionLabel = encrypted ? 'Encrypted' : 'Not encrypted';
  const encryptionShort = encrypted
    ? 'Messages are end-to-end encrypted. Only verified devices should be trusted.'
    : 'Messages are not end-to-end encrypted. The server may be able to read them.';

  const doRename = async () => {
    if (!client) return;
    const name = newRoomName.trim();
    if (!name) return;
    try {
      await (client as any).sendStateEvent(roomId, 'm.room.name', { name }, '');
      setIsEditingName(false);
      setNewRoomName('');
      setRoomTitle(name);
    } catch {}
  };

  const togglePrivacy = async () => {
    if (!client || !canEditJoinRules) return;
    const newRule = joinRule === 'public' ? 'invite' : 'public';
    try {
      await (client as any).sendStateEvent(roomId, 'm.room.join_rules', { join_rule: newRule }, '');
      setJoinRule(newRule);
    } catch {}
  };

  const enableEncryption = async () => {
    if (!client || !canEditEncryption || encrypted) return;
    try {
      await (client as any).sendStateEvent(roomId, 'm.room.encryption', { algorithm: 'm.megolm.v1.aes-sha2' }, '');
      setEncrypted(true);
    } catch {}
  };

  /* Each action dispatches a nexus-member-action event whose onConfirm holds the Matrix call to run on confirm */
  const doSetRole = (userId: string, targetLevel: number, roleLabel: string) => {
    window.dispatchEvent(new CustomEvent('nexus-member-action', {
      detail: {
        type: 'role',
        targetUserId: userId,
        roomId,
        roomName: roomTitle,
        roleLabel,
        onConfirm: async () => {
          if (!client) return;
          try {
            const content = getPowerLevelsContent();
            if (!content) return;
            const users: any =
              (content as any).users && typeof (content as any).users === 'object'
                ? { ...(content as any).users }
                : {};
            users[userId] = targetLevel;
            await (client as any).sendStateEvent(roomId, 'm.room.power_levels', { ...(content as any), users }, '');
            setMembers((prev) => prev.map((m) => (m.userId === userId ? { ...m, powerLevel: targetLevel } : m)));
            if (userId === myUserId) setMyPowerLevel(targetLevel);
          } catch {}
        },
      },
    }));
  };

  const doKick = (userId: string) => {
    window.dispatchEvent(new CustomEvent('nexus-member-action', {
      detail: {
        type: 'kick',
        targetUserId: userId,
        roomId,
        roomName: roomTitle,
        onConfirm: async () => {
          if (!client) return;
          try {
            await client.kick(roomId, userId, 'Removed');
            setMembers((prev) => prev.filter((m) => m.userId !== userId));
            if (activeMemberId === userId) setActiveMemberId(null);
          } catch {}
        },
      },
    }));
  };

  const doBan = (userId: string) => {
    window.dispatchEvent(new CustomEvent('nexus-member-action', {
      detail: {
        type: 'ban',
        targetUserId: userId,
        roomId,
        roomName: roomTitle,
        onConfirm: async () => {
          if (!client) return;
          try {
            await client.ban(roomId, userId, 'Banned');
            setMembers((prev) => prev.filter((m) => m.userId !== userId));
            if (activeMemberId === userId) setActiveMemberId(null);
          } catch {}
        },
      },
    }));
  };

  const doLeave = () => {
    window.dispatchEvent(new CustomEvent('nexus-member-action', {
      detail: {
        type: 'leave',
        roomId,
        roomName: roomTitle,
        onConfirm: async () => {
          if (!client) return;
          try {
            await client.leave(roomId);
            onLeave?.();
          } catch {}
        },
      },
    }));
  };

  const startVerification = useCallback(
    async (deviceId: string) => {
      if (!client || !myUserId) return;

      setVerifyingDevice(deviceId);
      setSasEmojis(null);

      try {
        const snapshot = await requestVerificationToUser(myUserId, [deviceId]);
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

  const canOpenRoleTab = useMemo(() => {
    if (!activeMember || !myUserId) return false;
    return myPowerLevel >= getRequiredPLForStateEvent('m.room.power_levels');
  }, [activeMember, myUserId, myPowerLevel, getRequiredPLForStateEvent]);

  const canKickActive = useMemo(() => {
    if (!activeMember) return false;
    if (activeIsMe) return true;
    return canKick(activeMember.userId);
  }, [activeMember, activeIsMe, canKick]);

  const canBanActive = useMemo(() => {
    if (!activeMember || activeIsMe) return false;
    return canBan(activeMember.userId);
  }, [activeMember, activeIsMe, canBan]);

  const actionWidthClass = 'w-[99px]';
  const btnBase = 'h-9 rounded-xl justify-center transition-colors border text-foreground bg-muted/30 border-border/60 dark:bg-muted/20 dark:border-border/40';
  const btnHover = 'hover:bg-accent/60 dark:hover:bg-muted/60';
  const btnDanger = 'text-destructive hover:text-destructive hover:bg-destructive/10 dark:hover:bg-destructive/15';
  const restrictedBtn = 'opacity-70 cursor-not-allowed pointer-events-none';

  const dropdownHeaderTitle = useMemo(() => {
    if (!activeMember) return 'Member List';
    if (memberView === 'roles' || memberView === 'roles_help') return 'Role';
    return 'Options';
  }, [activeMember, memberView]);

  const onHeaderBack = () => {
    if (!activeMember) return;
    if (memberView === 'roles_help') { setMemberView('roles'); return; }
    if (memberView === 'roles') { setMemberView('main'); return; }
    setActiveMemberId(null);
    setMemberView('main');
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
                onClick={doRename}
                disabled={!newRoomName.trim()}
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
                      {joinRule === 'public' ? (
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
                      <Button
                        variant="ghost"
                        size="sm"
                        className="w-[120px] text-xs h-7 rounded-xl border bg-sky-500/10 dark:bg-sky-400/10 border-sky-500/20 dark:border-sky-400/20 text-foreground hover:bg-sky-500/20 dark:hover:bg-sky-400/20 transition-colors"
                        onClick={togglePrivacy}
                      >
                        {joinRule === 'public' ? (
                          <><Lock className="h-3 w-3 mr-1.5" />Make Private</>
                        ) : (
                          <><Globe className="h-3 w-3 mr-1.5" />Make Public</>
                        )}
                      </Button>
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
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-xs h-7 rounded-xl border bg-sky-500/10 dark:bg-sky-400/10 border-sky-500/20 dark:border-sky-400/20 text-foreground hover:bg-sky-500/20 dark:hover:bg-sky-400/20 transition-colors"
                        onClick={enableEncryption}
                      >
                        <ShieldCheck className="h-3 w-3 mr-1.5" />
                        Enable Encryption
                      </Button>
                    </div>
                  )}
                  {encrypted && (
                    <div className="mt-2 text-[10px] text-amber-600 dark:text-amber-400">
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
                variant="ghost"
                size="icon"
                aria-label="Members"
                className="header-icon-btn hover:bg-accent/60 dark:hover:bg-muted/50"
              >
                <Users className="h-5 w-5 text-muted-foreground" />
              </Button>
            </DropdownMenuTrigger>

            <DropdownMenuContent align="end" className="glass border-border/60 w-[201px] flex flex-col overflow-hidden p-0">
              <div className="relative shrink-0 px-3 pt-2.5 pb-2">
                {showHeaderBack && (
                  <button
                    type="button"
                    onClick={onHeaderBack}
                    className="absolute left-2 top-1/2 -translate-y-1/2 flex items-center text-foreground underline underline-offset-2"
                    aria-label="Go back"
                  >
                    <ArrowLeft className="h-5 w-5 stroke-[2.5]" />
                  </button>
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
                        onSelect={(e) => {
                          e.preventDefault();
                          setActiveMemberId(m.userId);
                          setMemberView('main');
                        }}
                        className="flex flex-col items-start gap-0.5 rounded-xl px-3 py-2 transition-colors hover:bg-accent/60 dark:hover:bg-muted/50 focus:bg-accent/60 dark:focus:bg-muted/50"
                      >
                        <div className="font-medium truncate w-full">{m.userId}</div>
                        <div className="text-xs text-muted-foreground truncate w-full">
                          {roleLabelFor(m.powerLevel)} · PL: {m.powerLevel}
                        </div>
                      </DropdownMenuItem>
                    ))
                  )}
                </ScrollArea>
              ) : (
                <ScrollArea className="flex-1 min-h-0" viewportClassName="max-h-[60vh] w-full overflow-y-auto p-3">
                  {memberView === 'main' ? (
                    <div className="flex flex-col items-center gap-2">
                      <Button
                        variant="secondary"
                        size="sm"
                        aria-disabled={!canOpenRoleTab}
                        className={`${btnBase} ${btnHover} ${actionWidthClass} ${!canOpenRoleTab ? restrictedBtn : ''}`}
                        onClick={() => {
                          if (!canOpenRoleTab) return;
                          setMemberView('roles');
                        }}
                      >
                        <ActionLabel label="Role" restricted={!canOpenRoleTab} />
                      </Button>

                      <Button
                        variant="secondary"
                        size="sm"
                        aria-disabled={!canKickActive}
                        className={`${btnBase} ${btnDanger} ${actionWidthClass} ${!canKickActive ? restrictedBtn : ''}`}
                        onClick={() => {
                          if (!canKickActive) return;
                          if (activeIsMe) doLeave();
                          else doKick(activeMember.userId);
                        }}
                      >
                        <ActionLabel label={activeIsMe ? 'Leave' : 'Kick'} restricted={!canKickActive} />
                      </Button>

                      {!activeIsMe && (
                        <Button
                          variant="secondary"
                          size="sm"
                          aria-disabled={!canBanActive}
                          className={`${btnBase} ${btnDanger} ${actionWidthClass} ${!canBanActive ? restrictedBtn : ''}`}
                          onClick={() => {
                            if (!canBanActive) return;
                            doBan(activeMember.userId);
                          }}
                          data-testid="ban-button"
                        >
                          <ActionLabel label="Ban" restricted={!canBanActive} />
                        </Button>
                      )}
                    </div>
                  ) : memberView === 'roles' ? (
                    <div className="flex flex-col items-center gap-2">
                      <div className="w-full px-1">
                        <div className="text-sm font-semibold truncate text-center">{activeMember.userId}</div>
                        <div className="text-xs text-muted-foreground text-center mt-1">
                          {roleLabelFor(activeMember.powerLevel)} · PL: {activeMember.powerLevel}
                        </div>
                      </div>

                      <button
                        type="button"
                        className="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground transition-colors"
                        onClick={() => setMemberView('roles_help')}
                      >
                        Explain roles
                      </button>

                      <div className="flex flex-col items-center gap-2">
                        {(Object.keys(ROLE_LEVELS) as (keyof typeof ROLE_LEVELS)[]).map((k) => {
                          const level = ROLE_LEVELS[k];
                          const allowed = !!activeMember && canSetPowerLevel(activeMember.userId, level);
                          return (
                            <Button
                              key={k}
                              variant="secondary"
                              size="sm"
                              aria-disabled={!allowed}
                              className={`${btnBase} ${btnHover} ${actionWidthClass} ${!allowed ? restrictedBtn : ''}`}
                              onClick={() => {
                                if (!activeMember || !allowed) return;
                                doSetRole(activeMember.userId, level, k);
                              }}
                            >
                              <ActionLabel label={k} restricted={!allowed} />
                            </Button>
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
                      <Button
                        key={d}
                        variant="secondary"
                        size="sm"
                        className="w-full justify-center transition-colors"
                        disabled={!!verifyingDevice}
                        onClick={() => startVerification(d)}
                      >
                        Verify {d}
                      </Button>
                    ))}
                  </div>

                  {verifyingDevice && (
                    <div className="mt-2 rounded-xl bg-muted/20 dark:bg-muted/15 p-3">
                      <div className="text-sm font-medium mb-2">Verify device: {verifyingDevice}</div>

                      {sasEmojis ? (
                        <>
                          <div className="text-sm text-muted-foreground mb-2">Compare these emojis:</div>
                          <div className="flex flex-wrap gap-2 mb-3">
                            {sasEmojis.map((e, idx) => (
                              <span key={`${e}-${idx}`} className="text-2xl">{e}</span>
                            ))}
                          </div>
                          <div className="flex gap-2">
                            <Button size="sm" onClick={confirmVerification} className="transition-colors">
                              They match
                            </Button>
                            <Button variant="secondary" size="sm" onClick={cancelVerification} className="transition-colors">
                              Cancel
                            </Button>
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