import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import RoomInviteOverlay from '@/app/app-components/RoomInviteOverlay';
import { RoomEvent, KnownMembership } from 'matrix-js-sdk';

const mockToastSuccess = vi.fn();
const mockToastError = vi.fn();

vi.mock('react-hot-toast', () => ({
  default: {
    success: (msg: string) => mockToastSuccess(msg),
    error: (msg: string) => mockToastError(msg),
  },
}));

const mockJoinRoom = vi.fn();
const mockLeave = vi.fn();
const mockGetRooms = vi.fn();
const mockGetUserId = vi.fn(() => '@user:matrix.org');
const mockOn = vi.fn();
const mockRemoveListener = vi.fn();

vi.mock('@/app/utils/matrix', () => ({
  getMatrixClient: () => ({
    getRooms: mockGetRooms,
    getUserId: mockGetUserId,
    joinRoom: mockJoinRoom,
    leave: mockLeave,
    on: mockOn,
    removeListener: mockRemoveListener,
  }),
}));

vi.mock('@/app/utils/helpers', () => ({
  formatAge: (ts: number) => {
    const s = Math.floor((Date.now() - ts) / 1000);
    if (s < 60) return `${s}s ago`;
    return `${Math.floor(s / 60)}m ago`;
  },
  isMatrixReady: () => (window as any).__matrix_ready === true,
}));

const createMockRoom = (roomId: string, name: string, membership: string, invitedBy?: string) => ({
  roomId,
  name,
  getMyMembership: () => membership,
  currentState: {
    getStateEvents: (type: string, stateKey: string) => {
      if (type === 'm.room.member' && stateKey === '@user:matrix.org') {
        return {
          getSender: () => invitedBy || '@inviter:matrix.org',
        };
      }
      return null;
    },
  },
});

describe('RoomInviteOverlay', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.__matrix_ready = true;
    mockGetRooms.mockReturnValue([]);
  });

  afterEach(() => {
    window.__matrix_ready = undefined;
  });

  describe('initial rendering', () => {
    it('renders nothing when matrix is not ready', () => {
      window.__matrix_ready = false;
      const { container } = render(<RoomInviteOverlay />);
      expect(container).toBeEmptyDOMElement();
    });

    it('renders nothing when there are no invites', () => {
      mockGetRooms.mockReturnValue([]);
      const { container } = render(<RoomInviteOverlay />);
      expect(container).toBeEmptyDOMElement();
    });

    it('renders toast when there is an invite', () => {
      mockGetRooms.mockReturnValue([
        createMockRoom('!room1:matrix.org', 'Test Room', KnownMembership.Invite),
      ]);

      render(<RoomInviteOverlay />);

      expect(screen.queryByText('Room invitation')).toBeInTheDocument();
      expect(screen.queryByText('Test Room')).toBeInTheDocument();
    });

    it('shows inviter name in toast', () => {
      mockGetRooms.mockReturnValue([
        createMockRoom('!room1:matrix.org', 'Test Room', KnownMembership.Invite, '@alice:matrix.org'),
      ]);

      render(<RoomInviteOverlay />);

      expect(screen.queryByText('@alice:matrix.org')).toBeInTheDocument();
    });
  });

  describe('toast interactions', () => {
    it('shows Open and Dismiss buttons', () => {
      mockGetRooms.mockReturnValue([
        createMockRoom('!room1:matrix.org', 'Test Room', KnownMembership.Invite),
      ]);

      render(<RoomInviteOverlay />);

      expect(screen.queryByRole('button', { name: 'Open' })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Dismiss' })).toBeInTheDocument();
    });

    it('opens modal when Open is clicked', async () => {
      mockGetRooms.mockReturnValue([
        createMockRoom('!room1:matrix.org', 'Test Room', KnownMembership.Invite),
      ]);

      render(<RoomInviteOverlay />);

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Open' }));
      });

      expect(screen.queryByText('Accept this invitation?')).toBeInTheDocument();
    });

    it('dismisses toast when Dismiss is clicked', async () => {
      mockGetRooms.mockReturnValue([
        createMockRoom('!room1:matrix.org', 'Test Room', KnownMembership.Invite),
      ]);

      render(<RoomInviteOverlay />);

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
      });

      await waitFor(() => {
        expect(screen.queryByText('Room invitation')).not.toBeInTheDocument();
      });
    });
  });

  describe('modal interactions', () => {
    const setupModal = async () => {
      mockGetRooms.mockReturnValue([
        createMockRoom('!room1:matrix.org', 'Test Room', KnownMembership.Invite, '@bob:matrix.org'),
      ]);

      render(<RoomInviteOverlay />);

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Open' }));
      });
    };

    it('shows room name in modal', async () => {
      await setupModal();
      expect(screen.queryByText('Test Room')).toBeInTheDocument();
    });

    it('shows inviter in modal', async () => {
      await setupModal();
      expect(screen.queryByText('@bob:matrix.org')).toBeInTheDocument();
    });

    it('shows Accept and Decline buttons', async () => {
      await setupModal();
      expect(screen.queryByRole('button', { name: 'Accept' })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Decline' })).toBeInTheDocument();
    });

    it('has close button', async () => {
      await setupModal();
      expect(screen.queryByLabelText('Close')).toBeInTheDocument();
    });

    it('closes modal on close button click', async () => {
      await setupModal();

      await act(async () => {
        fireEvent.click(screen.getByLabelText('Close'));
      });

      await waitFor(() => {
        expect(screen.queryByText('Accept this invitation?')).not.toBeInTheDocument();
      });
    });

    it('closes modal on backdrop click', async () => {
      await setupModal();

      const backdrop = document.querySelector('.bg-background\\/40');
      /* A failure here means the backdrop's CSS class changed and the selector needs updating */
      expect(backdrop).not.toBeNull();
      await act(async () => {
        fireEvent.click(backdrop!);
      });

      await waitFor(() => {
        expect(screen.queryByText('Accept this invitation?')).not.toBeInTheDocument();
      });
    });
  });

  describe('accept invite', () => {
    it('calls joinRoom when Accept is clicked', async () => {
      mockJoinRoom.mockResolvedValue({});
      mockGetRooms.mockReturnValue([
        createMockRoom('!room1:matrix.org', 'Test Room', KnownMembership.Invite),
      ]);

      render(<RoomInviteOverlay />);

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Open' }));
      });

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Accept' }));
      });

      expect(mockJoinRoom).toHaveBeenCalledWith('!room1:matrix.org');
    });

    it('shows success toast on successful join', async () => {
      mockJoinRoom.mockResolvedValue({});
      mockGetRooms.mockReturnValue([
        createMockRoom('!room1:matrix.org', 'Test Room', KnownMembership.Invite),
      ]);

      render(<RoomInviteOverlay />);

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Open' }));
      });

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Accept' }));

        await Promise.resolve();
      });

      expect(mockToastSuccess).toHaveBeenCalledWith('Joined room');
    });

    it('shows error toast on failed join', async () => {
      mockJoinRoom.mockRejectedValue(new Error('Join failed'));
      mockGetRooms.mockReturnValue([
        createMockRoom('!room1:matrix.org', 'Test Room', KnownMembership.Invite),
      ]);

      render(<RoomInviteOverlay />);

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Open' }));
      });

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Accept' }));

        await Promise.resolve();
      });

      expect(mockToastError).toHaveBeenCalledWith('Failed to join room');
    });

    it('dispatches matrix-invite-accepted event on success', async () => {
      mockJoinRoom.mockResolvedValue({});
      mockGetRooms.mockReturnValue([
        createMockRoom('!room1:matrix.org', 'Test Room', KnownMembership.Invite),
      ]);
      const dispatchSpy = vi.spyOn(window, 'dispatchEvent');

      render(<RoomInviteOverlay />);

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Open' }));
      });

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Accept' }));
        await Promise.resolve();
      });

      expect(dispatchSpy).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'matrix-invite-accepted' })
      );
    });

    it('closes modal after accepting', async () => {
      mockJoinRoom.mockResolvedValue({});
      mockGetRooms.mockReturnValue([
        createMockRoom('!room1:matrix.org', 'Test Room', KnownMembership.Invite),
      ]);

      render(<RoomInviteOverlay />);

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Open' }));
      });

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Accept' }));
        await Promise.resolve();
      });

      await waitFor(() => {
        expect(screen.queryByText('Accept this invitation?')).not.toBeInTheDocument();
      });
    });
  });

  describe('decline invite', () => {
    it('calls leave when Decline is clicked', async () => {
      mockLeave.mockResolvedValue({});
      mockGetRooms.mockReturnValue([
        createMockRoom('!room1:matrix.org', 'Test Room', KnownMembership.Invite),
      ]);

      render(<RoomInviteOverlay />);

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Open' }));
      });

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Decline' }));
      });

      expect(mockLeave).toHaveBeenCalledWith('!room1:matrix.org');
    });

    it('shows success toast on successful decline', async () => {
      mockLeave.mockResolvedValue({});
      mockGetRooms.mockReturnValue([
        createMockRoom('!room1:matrix.org', 'Test Room', KnownMembership.Invite),
      ]);

      render(<RoomInviteOverlay />);

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Open' }));
      });

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Decline' }));
        await Promise.resolve();
      });

      expect(mockToastSuccess).toHaveBeenCalledWith('Invite declined');
    });

    it('shows error toast on failed decline', async () => {
      mockLeave.mockRejectedValue(new Error('Leave failed'));
      mockGetRooms.mockReturnValue([
        createMockRoom('!room1:matrix.org', 'Test Room', KnownMembership.Invite),
      ]);

      render(<RoomInviteOverlay />);

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Open' }));
      });

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Decline' }));
        await Promise.resolve();
      });

      expect(mockToastError).toHaveBeenCalledWith('Failed to decline invite');
    });
  });

  describe('multiple invites', () => {
    it('shows the first pending invite when multiple are queued', async () => {
      mockGetRooms.mockReturnValue([
        createMockRoom('!room1:matrix.org', 'Older Room', KnownMembership.Invite),
        createMockRoom('!room2:matrix.org', 'Newer Room', KnownMembership.Invite),
      ]);

      render(<RoomInviteOverlay />);

      /* The component works FIFO, showing the first invite in the array first */
      await waitFor(() => {
        expect(screen.queryByText('Older Room')).toBeInTheDocument();
      });
      expect(screen.queryByText('Newer Room')).not.toBeInTheDocument();
    });

    it('shows next invite after dismissing first', async () => {
      const newerRoom = createMockRoom('!room2:matrix.org', 'Newer Room', KnownMembership.Invite);

      mockGetRooms.mockReturnValue([
        createMockRoom('!room1:matrix.org', 'Older Room', KnownMembership.Invite),
        newerRoom,
      ]);

      render(<RoomInviteOverlay />);

      await act(async () => {
        /* After dismiss the component re-fetches, and the mock now returns only the next invite */
        mockGetRooms.mockReturnValue([newerRoom]);
        fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
      });

      await waitFor(() => {
        expect(screen.queryByText('Newer Room')).toBeInTheDocument();
      });
    });
  });

  describe('matrix events', () => {
    /* The component subscribes to membership events so invites arriving after mount are picked up */
    it('listens for RoomEvent.MyMembership', () => {
      mockGetRooms.mockReturnValue([]);
      render(<RoomInviteOverlay />);

      expect(mockOn).toHaveBeenCalledWith(RoomEvent.MyMembership, expect.any(Function));
    });

    it('cleans up listener on unmount', () => {
      mockGetRooms.mockReturnValue([]);
      const { unmount } = render(<RoomInviteOverlay />);

      unmount();

      expect(mockRemoveListener).toHaveBeenCalledWith(RoomEvent.MyMembership, expect.any(Function));
    });

    /* A matrix-ready event makes the component re-check for pending invites */
    it('responds to matrix-ready event', async () => {
      window.__matrix_ready = false;
      const { container } = render(<RoomInviteOverlay />);

      expect(container).toBeEmptyDOMElement();

      mockGetRooms.mockReturnValue([
        createMockRoom('!room1:matrix.org', 'Test Room', KnownMembership.Invite),
      ]);
      window.__matrix_ready = true;

      await act(async () => {
        window.dispatchEvent(new Event('matrix-ready'));
      });

      await waitFor(() => {
        expect(screen.queryByText('Room invitation')).toBeInTheDocument();
      });
    });
  });
});