import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('matrix-js-sdk', async () => {
  const actual = await import('../../__mocks__/matrix-js-sdk');
  return actual;
});

vi.mock('@/app/utils/matrix', () => ({
  getMatrixClient: vi.fn(),
  checkRoomDevices: vi.fn(async () => []),
  requestVerificationToUser: vi.fn(async () => ({ id: 'test_req' })),
  confirmVerificationRequest: vi.fn(async () => true),
  cancelVerificationRequest: vi.fn(async () => true),
}));

vi.mock('react-hot-toast', () => ({
  default: {
    success: vi.fn(),
    error: vi.fn(),
    loading: vi.fn(),
    dismiss: vi.fn(),
  },
}));

import ChatHeader from '@/app/app-components/ChatHeader';
import { MockMatrixClient, MockRoom, KnownMembership } from '../../__mocks__/matrix-js-sdk';
import { getMatrixClient } from '@/app/utils/matrix';

describe('ChatHeader Component', () => {
  let mockClient: MockMatrixClient;
  let mockRoom: MockRoom;

  beforeEach(() => {
    vi.clearAllMocks();
    
    window.__matrix_ready = true;
    
    mockClient = new MockMatrixClient({
      userId: '@testuser:matrix.org',
      deviceId: 'TESTDEVICE',
      baseUrl: 'https://matrix.org',
    });

    mockRoom = new MockRoom('!testroom:matrix.org', 'Test Room');
    mockRoom.addMember('@testuser:matrix.org', KnownMembership.Join, 100);
    mockRoom.addMember('@other:matrix.org', KnownMembership.Join, 0);
    mockClient.addRoom(mockRoom);

    (getMatrixClient as ReturnType<typeof vi.fn>).mockReturnValue(mockClient);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Rendering', () => {
    it('renders room name', () => {
      render(
        <ChatHeader
          roomName="Test Room"
          roomId="!testroom:matrix.org"
          isEncrypted={false}
          onLeave={vi.fn()}
        />
      );

      expect(screen.queryByText('Test Room')).toBeInTheDocument();
    });

    it('renders header element', () => {
      render(
        <ChatHeader
          roomName="Test Room"
          roomId="!testroom:matrix.org"
          isEncrypted={false}
          onLeave={vi.fn()}
        />
      );

      expect(screen.queryByRole('banner')).toBeInTheDocument();
    });

  });

  describe('Room Information', () => {
    it('displays room title in heading', () => {
      render(
        <ChatHeader
          roomName="Test Room"
          roomId="!testroom:matrix.org"
          isEncrypted={false}
          onLeave={vi.fn()}
        />
      );

      const heading = screen.getByRole('heading', { level: 3 });
      expect(heading).toHaveTextContent('Test Room');
    });

    it('renders without crashing when room name is empty', () => {
      const emptyRoom = new MockRoom('!emptyroom:matrix.org', '');
      mockClient.addRoom(emptyRoom);

      render(
        <ChatHeader
          roomName=""
          roomId="!emptyroom:matrix.org"
          isEncrypted={false}
          onLeave={vi.fn()}
        />
      );

      expect(screen.queryByRole('banner')).toBeInTheDocument();
    });

    it('handles long room names', () => {
      const longName = 'A'.repeat(100);
      const longRoom = new MockRoom('!longroom:matrix.org', longName);
      mockClient.addRoom(longRoom);

      render(
        <ChatHeader
          roomName={longName}
          roomId="!longroom:matrix.org"
          isEncrypted={false}
          onLeave={vi.fn()}
        />
      );

      expect(screen.queryByText(longName)).toBeInTheDocument();
    });
  });

  describe('Accessibility', () => {
    it('has accessible header structure', () => {
      render(
        <ChatHeader
          roomName="Test Room"
          roomId="!testroom:matrix.org"
          isEncrypted={false}
          onLeave={vi.fn()}
        />
      );

      expect(screen.queryByRole('banner')).toBeInTheDocument();
      expect(screen.queryByRole('heading')).toBeInTheDocument();
    });
  });

  describe('Component Lifecycle', () => {
    it('unmounts without error', () => {
      const { unmount } = render(
        <ChatHeader
          roomName="Test Room"
          roomId="!testroom:matrix.org"
          isEncrypted={false}
          onLeave={vi.fn()}
        />
      );

      expect(() => unmount()).not.toThrow();
    });

    it('handles prop changes', () => {
      const newRoom = new MockRoom('!newroom:matrix.org', 'New Room');
      newRoom.addMember('@testuser:matrix.org', KnownMembership.Join, 100);
      mockClient.addRoom(newRoom);

      const { rerender } = render(
        <ChatHeader
          roomName="Test Room"
          roomId="!testroom:matrix.org"
          isEncrypted={false}
          onLeave={vi.fn()}
        />
      );

      expect(screen.queryByText('Test Room')).toBeInTheDocument();

      rerender(
        <ChatHeader
          roomName="New Room"
          roomId="!newroom:matrix.org"
          isEncrypted={false}
          onLeave={vi.fn()}
        />
      );

      expect(screen.queryByText('New Room')).toBeInTheDocument();
    });
  });
  describe('Ban member', () => {
    /* Ban dispatches nexus-member-action, so these tests capture onConfirm and call it directly */
    const openMemberPanel = async (userId: string) => {
      const user = userEvent.setup();
      const membersBtn = screen.getByRole('button', { name: 'Members' });
      await user.click(membersBtn);

      await waitFor(() => {
        expect(screen.queryByText(userId)).toBeInTheDocument();
      });

      await user.click(screen.getByText(userId));
    };

    it('Ban button is rendered for another member when user has sufficient power level', async () => {
      render(
        <ChatHeader
          roomName="Test Room"
          roomId="!testroom:matrix.org"
          isEncrypted={false}
          onLeave={vi.fn()}
        />
      );

      await waitFor(() => { expect(screen.queryByRole('button', { name: 'Members' })).toBeInTheDocument(); });
      await openMemberPanel('@other:matrix.org');

      await waitFor(() => {
        expect(screen.queryByTestId('ban-button')).toBeInTheDocument();
      });
    });

    it('Ban button shows restricted indicator when user lacks power level', async () => {
      mockRoom.addMember('@testuser:matrix.org', 'join', 0);

      render(
        <ChatHeader
          roomName="Test Room"
          roomId="!testroom:matrix.org"
          isEncrypted={false}
          onLeave={vi.fn()}
        />
      );

      await waitFor(() => { expect(screen.queryByRole('button', { name: 'Members' })).toBeInTheDocument(); });
      await openMemberPanel('@other:matrix.org');

      await waitFor(() => {
        const banBtn = screen.getByTestId('ban-button');
        /* Without sufficient power level the button exposes aria-disabled rather than visual-only styling */
        expect(banBtn).toHaveAttribute('aria-disabled', 'true');
      });
    });

    it('Ban button is not rendered when viewing own user', async () => {
      render(
        <ChatHeader
          roomName="Test Room"
          roomId="!testroom:matrix.org"
          isEncrypted={false}
          onLeave={vi.fn()}
        />
      );

      await waitFor(() => { expect(screen.queryByRole('button', { name: 'Members' })).toBeInTheDocument(); });

      await openMemberPanel('@testuser:matrix.org');

      await waitFor(() => {
        expect(screen.queryByTestId('ban-button')).not.toBeInTheDocument();
      });
    });

    it('clicking Ban calls client.ban with the correct roomId and userId', async () => {
      /* Capture the onConfirm closure from the event to trigger it without the overlay UI */
      let capturedConfirm: (() => Promise<void>) | undefined;
      const onAction = (e: Event) => {
        capturedConfirm = (e as CustomEvent).detail?.onConfirm;
      };
      window.addEventListener('nexus-member-action', onAction);

      render(
        <ChatHeader
          roomName="Test Room"
          roomId="!testroom:matrix.org"
          isEncrypted={false}
          onLeave={vi.fn()}
        />
      );

      await waitFor(() => { expect(screen.queryByRole('button', { name: 'Members' })).toBeInTheDocument(); });
      await openMemberPanel('@other:matrix.org');
      await waitFor(() => { expect(screen.queryByTestId('ban-button')).toBeInTheDocument(); });
      const user = userEvent.setup();
      await user.click(screen.getByTestId('ban-button'));
      await waitFor(() => { expect(capturedConfirm).toBeDefined(); });
      await capturedConfirm!();

      window.removeEventListener('nexus-member-action', onAction);

      await waitFor(() => {
        expect(mockClient.ban).toHaveBeenCalledWith(
          '!testroom:matrix.org',
          '@other:matrix.org',
          'Banned'
        );
      });
    });

    it('member is removed from the list after a successful ban', async () => {
      let capturedConfirm: (() => Promise<void>) | undefined;
      const onAction = (e: Event) => {
        capturedConfirm = (e as CustomEvent).detail?.onConfirm;
      };
      window.addEventListener('nexus-member-action', onAction);

      render(
        <ChatHeader
          roomName="Test Room"
          roomId="!testroom:matrix.org"
          isEncrypted={false}
          onLeave={vi.fn()}
        />
      );

      await waitFor(() => { expect(screen.queryByRole('button', { name: 'Members' })).toBeInTheDocument(); });

      const user = userEvent.setup();
      await user.click(screen.getByRole('button', { name: 'Members' }));
      await waitFor(() => { expect(screen.queryByText('@other:matrix.org')).toBeInTheDocument(); });
      await user.click(screen.getByText('@other:matrix.org'));
      await waitFor(() => { expect(screen.queryByTestId('ban-button')).toBeInTheDocument(); });
      await user.click(screen.getByTestId('ban-button'));
      await waitFor(() => { expect(capturedConfirm).toBeDefined(); });
      await capturedConfirm!();

      window.removeEventListener('nexus-member-action', onAction);

      await waitFor(() => {
        expect(mockClient.ban).toHaveBeenCalled();
        expect(screen.queryByText('@other:matrix.org')).not.toBeInTheDocument();
      });
    });
  });
});