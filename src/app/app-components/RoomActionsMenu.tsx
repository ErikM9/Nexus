'use client';

import React, { useRef } from 'react';
import * as DropdownMenuPrimitive from '@radix-ui/react-dropdown-menu';
import toast from 'react-hot-toast';
import { Button } from '@/components/ui/button';

interface RoomActionsMenuProps {
  roomId: string;
  name: string;
  canInvite: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /* The button that opens the menu, which gets focus back when a dialog the menu opened closes */
  trigger: React.ReactElement;
  onInvite: (returnFocusTo: HTMLElement | null) => void;
  onLeave: (returnFocusTo: HTMLElement | null) => void;
}

const menuItemClass = 'w-full mb-1 last:mb-0';

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

/* A room's Send Invite, Copy Room ID and Leave Room actions, behind the button its sidebar row or header gives it */
const RoomActionsMenu: React.FC<RoomActionsMenuProps> = ({ roomId, name, canInvite, open, onOpenChange, trigger, onInvite, onLeave }) => {
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  return (
    <DropdownMenuPrimitive.Root modal={false} open={open} onOpenChange={onOpenChange}>
      <DropdownMenuPrimitive.Trigger ref={triggerRef} asChild>
        {trigger}
      </DropdownMenuPrimitive.Trigger>

      <DropdownMenuPrimitive.Portal>
        <DropdownMenuPrimitive.Content
          align="end"
          sideOffset={4}
          aria-label={`Actions for ${name}`}
          aria-labelledby={undefined}
          className="z-50 w-[124px] p-2 bg-card rounded-2xl border border-border/60 shadow-none"
        >
          {canInvite && (
            <DropdownMenuPrimitive.Item
              asChild
              onSelect={(e) => {
                /* The invite dialog takes focus itself, which closes this menu without refocusing its trigger */
                e.preventDefault();
                onInvite(triggerRef.current);
              }}
            >
              <Button variant="ghost" size="default" className={menuItemClass}>
                Send Invite
              </Button>
            </DropdownMenuPrimitive.Item>
          )}
          <DropdownMenuPrimitive.Item asChild onSelect={() => copyRoomId(roomId)}>
            <Button variant="ghost" size="default" className={menuItemClass}>
              Copy Room ID
            </Button>
          </DropdownMenuPrimitive.Item>
          <DropdownMenuPrimitive.Item
            asChild
            onSelect={(e) => {
              e.preventDefault();
              onLeave(triggerRef.current);
            }}
          >
            <Button variant="ghost" size="default" className={menuItemClass}>
              Leave Room
            </Button>
          </DropdownMenuPrimitive.Item>
        </DropdownMenuPrimitive.Content>
      </DropdownMenuPrimitive.Portal>
    </DropdownMenuPrimitive.Root>
  );
};

export default RoomActionsMenu;