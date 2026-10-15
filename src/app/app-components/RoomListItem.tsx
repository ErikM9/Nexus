'use client';

import React from 'react';
import RoomActionsMenu from './RoomActionsMenu';

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
  onLeave: (returnFocusTo: HTMLElement | null) => void;
}

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
  onLeave,
}) => {
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

        <RoomActionsMenu
          roomId={roomId}
          name={name}
          canInvite={canInvite}
          open={menuOpen}
          onOpenChange={onMenuOpenChange}
          onInvite={onInvite}
          onLeave={onLeave}
          trigger={
            <button
              type="button"
              aria-label={`Open menu for ${name}`}
              className="shrink-0 mr-4 rounded-md px-1 text-lg leading-none text-foreground/50 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            >
              &#8942;
            </button>
          }
        />
      </div>
    </li>
  );
};

export default RoomListItem;