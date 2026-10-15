'use client';

import React, { useEffect, useRef, useState } from 'react';
import { EventType, Preset, Visibility, type ICreateRoomOpts, type MatrixClient } from 'matrix-js-sdk';
import toast from 'react-hot-toast';
import { getCryptoReady } from '../utils/matrix';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

type RoomType = 'public-unencrypted' | 'public-encrypted' | 'private-unencrypted' | 'private-encrypted';

const ROOM_TYPES: Record<RoomType, { isPublic: boolean; isEncrypted: boolean }> = {
  'public-unencrypted': { isPublic: true, isEncrypted: false },
  'public-encrypted': { isPublic: true, isEncrypted: true },
  'private-unencrypted': { isPublic: false, isEncrypted: false },
  'private-encrypted': { isPublic: false, isEncrypted: true },
};

const DEFAULT_ROOM_TYPE: RoomType = 'public-unencrypted';

/* What the sidebar knows about a room it has just asked the server for, used until the room's own state arrives */
export interface RoomFallback {
  name?: string;
  isEncrypted?: boolean;
  isPublic?: boolean;
}

interface CreateRoomFormProps {
  client: MatrixClient | null;
  hidden?: boolean;
  onCreated: (roomId: string, fallback: RoomFallback) => void;
}

/* Name, type and Create button for a new room, allowing one request at a time */
const CreateRoomForm: React.FC<CreateRoomFormProps> = ({ client, hidden, onCreated }) => {
  const [name, setName] = useState('');
  const [roomType, setRoomType] = useState<RoomType>(DEFAULT_ROOM_TYPE);
  const [selectOpen, setSelectOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const creatingRef = useRef(false);

  /* skipCloseRef stops the type select from closing itself on its own nexus-close-dropdowns broadcast */
  const skipCloseRef = useRef(false);

  useEffect(() => {
    const onGlobalDropdown = () => {
      if (skipCloseRef.current) {
        skipCloseRef.current = false;
        return;
      }
      setSelectOpen(false);
    };
    window.addEventListener('nexus-close-dropdowns', onGlobalDropdown);
    return () => window.removeEventListener('nexus-close-dropdowns', onGlobalDropdown);
  }, []);

  /* A signed-out form starts empty for whoever signs in next */
  useEffect(() => {
    if (client) return;
    setName('');
    setRoomType(DEFAULT_ROOM_TYPE);
  }, [client]);

  const createRoom = async () => {
    if (!client) {
      toast.error('Matrix client not ready');
      return;
    }
    const roomName = name.trim();
    if (!roomName || creatingRef.current) return;

    const { isPublic, isEncrypted } = ROOM_TYPES[roomType];
    if (isEncrypted && !getCryptoReady()) {
      toast.error('Crypto not ready for encrypted room');
      return;
    }

    const options: ICreateRoomOpts = {
      name: roomName,
      preset: isPublic ? Preset.PublicChat : Preset.PrivateChat,
      /* The preset only sets the join rule, so a public room is also published to the directory where name searches look */
      visibility: isPublic ? Visibility.Public : Visibility.Private,
    };
    if (isEncrypted) {
      options.initial_state = [
        { type: EventType.RoomEncryption, state_key: '', content: { algorithm: 'm.megolm.v1.aes-sha2' } },
      ];
    }

    creatingRef.current = true;
    setCreating(true);
    try {
      const { room_id } = await client.createRoom(options);
      toast.success('Room created!');
      setName('');
      setRoomType(DEFAULT_ROOM_TYPE);
      onCreated(room_id, { name: roomName, isEncrypted, isPublic });
    } catch {
      toast.error('Failed to create room');
    } finally {
      creatingRef.current = false;
      setCreating(false);
    }
  };

  return (
    <div className={hidden ? 'hidden' : 'flex flex-col gap-2 justify-end h-full'}>
      <div className="flex justify-center">
        <div className="flex items-center gap-2">
          <Input
            type="text"
            placeholder="Choose room name"
            aria-label="Room name"
            value={name}
            onChange={(e) => setName(e.target.value)}
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
                if (open) {
                  skipCloseRef.current = true;
                  try { window.dispatchEvent(new Event('nexus-close-dropdowns')); } catch {}
                }
                setSelectOpen(open);
              }}
            >
              <SelectTrigger aria-label="Room type" className="h-8 text-xs w-full">
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
        <Button onClick={() => void createRoom()} className="w-[66px]" disabled={!client || !name.trim() || creating}>
          Create
        </Button>
      </div>
    </div>
  );
};

export default CreateRoomForm;