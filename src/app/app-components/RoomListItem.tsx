'use client';

import React, { useRef } from 'react';
import * as DropdownMenuPrimitive from '@radix-ui/react-dropdown-menu';
import { Button } from '@/components/ui/button';

interface RoomListItemProps {
  roomId: string;
  name: string;
  badge: string;
  isEncrypted: boolean;
  isCurrent: boolean;
  canInvite: boolean;
  menuOpen: boolean;
  onMenuOpenChange: (open: boolean) => void;
  onOpen: () => void;
  onInvite: (returnFocusTo: HTMLElement | null) => void;
  onCopyId: () => void;
  onLeave: (returnFocusTo: HTMLElement | null) => void;
}

const menuItemClass = 'w-full mb-1 last:mb-0';

/* One sidebar row, a full-width button that opens the room beside a separate button for the room's actions menu */
const RoomListItem: React.FC<RoomListItemProps> = ({
  roomId,
  name,
  badge,
  isEncrypted,
  isCurrent,
  canInvite,
  menuOpen,
  onMenuOpenChange,
  onOpen,
  onInvite,
  onCopyId,
  onLeave,
}) => {
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  return (
    <li className="relative" data-testid="room-item" data-room-id={roomId}>
      <div className="flex items-center hover:bg-accent/60 dark:hover:bg-muted/50">
        {/* The label spells out encryption, which sighted users read from the badge, and still starts with the visible name */}
        <button
          type="button"
          onClick={onOpen}
          aria-label={isEncrypted ? `${name}, encrypted` : name}
          aria-current={isCurrent ? 'true' : undefined}
          className="flex-1 min-w-0 flex items-center space-x-2 pl-4 pr-2 py-3 text-left cursor-pointer focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
        >
          <span className="text-lg shrink-0" aria-hidden="true" data-testid="encryption-badge">
            {badge}
          </span>
          <span className="truncate text-foreground">{name}</span>
        </button>

        <DropdownMenuPrimitive.Root modal={false} open={menuOpen} onOpenChange={onMenuOpenChange}>
          <DropdownMenuPrimitive.Trigger asChild>
            <button
              ref={triggerRef}
              type="button"
              aria-label={`Open menu for ${name}`}
              className="shrink-0 mr-4 rounded-md px-1 text-lg leading-none text-foreground/50 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            >
              &#8942;
            </button>
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
              <DropdownMenuPrimitive.Item asChild onSelect={onCopyId}>
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
      </div>
    </li>
  );
};

export default RoomListItem;