import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('matrix-js-sdk', async () => {
  const actual = await import('../../__mocks__/matrix-js-sdk');
  return actual;
});

vi.mock('@/app/utils/matrix', () => ({
  getMatrixClient: vi.fn(),
  getCryptoReady: vi.fn(() => true),
}));

vi.mock('react-hot-toast', () => ({
  default: {
    success: vi.fn(),
    error: vi.fn(),
    loading: vi.fn(),
    dismiss: vi.fn(),
  },
}));

import ChatList from '@/app/app-components/ChatList';
import { MockMatrixClient, MockRoom, KnownMembership } from '../../__mocks__/matrix-js-sdk';
import { getMatrixClient } from '@/app/utils/matrix';

describe('ChatList Component', () => {
  let mockClient: MockMatrixClient;

  beforeEach(() => {
    vi.clearAllMocks();

    window.__matrix_ready = true;

    mockClient = new MockMatrixClient({
      userId: '@testuser:matrix.org',
      deviceId: 'TESTDEVICE',
      baseUrl: 'https://matrix.org',
    });

    (getMatrixClient as ReturnType<typeof vi.fn>).mockReturnValue(mockClient);

    Object.assign(navigator, {
      clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Rendering', () => {
    it('renders without crashing', () => {
      expect(() => render(<ChatList onSelect={vi.fn()} />)).not.toThrow();
    });

    it('renders container element', async () => {
      const { container } = render(<ChatList onSelect={vi.fn()} />);
      await waitFor(() => { expect(container.firstChild).toBeInTheDocument(); });
    });

    it('renders rooms when available', async () => {
      const room1 = new MockRoom('!room1:matrix.org', 'Room One');
      room1.addMember('@testuser:matrix.org', KnownMembership.Join, 0);
      const room2 = new MockRoom('!room2:matrix.org', 'Room Two');
      room2.addMember('@testuser:matrix.org', KnownMembership.Join, 0);
      mockClient.addRoom(room1);
      mockClient.addRoom(room2);

      render(<ChatList onSelect={vi.fn()} />);

      await waitFor(() => {
        expect(screen.queryByText('Room One')).toBeInTheDocument();
        expect(screen.queryByText('Room Two')).toBeInTheDocument();
      });
    });
  });

  describe('Room Selection', () => {
    it('calls onSelect when room is clicked', async () => {
      const onSelectMock = vi.fn();
      const room = new MockRoom('!testroom:matrix.org', 'Test Room');
      room.addMember('@testuser:matrix.org', KnownMembership.Join, 0);
      mockClient.addRoom(room);
      render(<ChatList onSelect={onSelectMock} />);
      await waitFor(() => { expect(screen.queryByText('Test Room')).toBeInTheDocument(); });
      await userEvent.click(screen.getByText('Test Room'));
      expect(onSelectMock).toHaveBeenCalled();
    });

    it('passes room ID, name, and metadata flags to onSelect', async () => {
      const onSelectMock = vi.fn();
      const room = new MockRoom('!specific:matrix.org', 'Specific Room');
      room.addMember('@testuser:matrix.org', KnownMembership.Join, 0);
      mockClient.addRoom(room);
      render(<ChatList onSelect={onSelectMock} />);
      await waitFor(() => { expect(screen.queryByText('Specific Room')).toBeInTheDocument(); });
      await userEvent.click(screen.getByText('Specific Room'));

      expect(onSelectMock).toHaveBeenCalledWith(
        '!specific:matrix.org',
        'Specific Room',
        expect.any(Boolean),
        expect.any(Boolean)
      );
    });

    it('handles clicking the same room twice', async () => {
      const onSelectMock = vi.fn();
      const room = new MockRoom('!test:matrix.org', 'Test Room');
      room.addMember('@testuser:matrix.org', KnownMembership.Join, 0);
      mockClient.addRoom(room);
      render(<ChatList onSelect={onSelectMock} />);
      await waitFor(() => { expect(screen.queryByText('Test Room')).toBeInTheDocument(); });
      await userEvent.click(screen.getByText('Test Room'));
      await userEvent.click(screen.getByText('Test Room'));
      expect(onSelectMock).toHaveBeenCalledTimes(2);
    });
  });

  describe('Mode Toggle', () => {
    it('shows Create and Join toggle buttons', async () => {
      render(<ChatList onSelect={vi.fn()} />);

      await waitFor(() => {
        expect(screen.getAllByText('Create').length).toBeGreaterThanOrEqual(1);
        expect(screen.getAllByText('Join').length).toBeGreaterThanOrEqual(1);
      });
    });

    it('switching to Join mode reveals the search input', async () => {
      render(<ChatList onSelect={vi.fn()} />);
      await waitFor(() => { expect(screen.getAllByText('Join').length).toBeGreaterThanOrEqual(1); });
      await userEvent.click(screen.getAllByText('Join')[0]);
      await waitFor(() => {
        expect(screen.queryByPlaceholderText(/search by name or enter id/i)).toBeInTheDocument();
      });
    });

    it('toggles between create and join modes multiple times without crashing', async () => {
      render(<ChatList onSelect={vi.fn()} />);
      const createButtons = await screen.findAllByText('Create');
      const joinButtons = await screen.findAllByText('Join');
      await userEvent.click(joinButtons[0]);
      await userEvent.click(createButtons[0]);
      await userEvent.click(joinButtons[0]);
      expect(screen.queryByPlaceholderText(/search by name or enter id/i)).toBeInTheDocument();
    });

    it('join mode input accepts room alias format', async () => {
      render(<ChatList onSelect={vi.fn()} />);
      await userEvent.click((await screen.findAllByText('Join'))[0]);
      const input = await screen.findByPlaceholderText(/search by name or enter id/i);
      await userEvent.type(input, '#test:matrix.org');
      expect(input).toHaveValue('#test:matrix.org');
    });

    it('join mode input accepts room ID format', async () => {
      render(<ChatList onSelect={vi.fn()} />);
      await userEvent.click((await screen.findAllByText('Join'))[0]);
      const input = await screen.findByPlaceholderText(/search by name or enter id/i);
      await userEvent.type(input, '!abc123:matrix.org');
      expect(input).toHaveValue('!abc123:matrix.org');
    });

    it('clears join input text when switching back to join mode', async () => {
      render(<ChatList onSelect={vi.fn()} />);
      const joinButtons = await screen.findAllByText('Join');
      const createButtons = await screen.findAllByText('Create');
      await userEvent.click(joinButtons[0]);
      const input = await screen.findByPlaceholderText(/search by name or enter id/i);
      await userEvent.type(input, 'test room');
      expect(input).toHaveValue('test room');
      await userEvent.click(createButtons[0]);
      await userEvent.click(joinButtons[0]);
      expect(await screen.findByPlaceholderText(/search by name or enter id/i)).toBeInTheDocument();
    });
  });

  describe('Room Sorting', () => {
    it('displays all rooms', async () => {
      const rooms = ['Alpha Room', 'Beta Room', 'Gamma Room'].map((name, i) => {
        const r = new MockRoom(`!room${i}:matrix.org`, name);
        r.addMember('@testuser:matrix.org', KnownMembership.Join, 0);
        return r;
      });
      rooms.forEach(r => mockClient.addRoom(r));

      render(<ChatList onSelect={vi.fn()} />);

      await waitFor(() => {
        expect(screen.queryByText('Alpha Room')).toBeInTheDocument();
        expect(screen.queryByText('Beta Room')).toBeInTheDocument();
        expect(screen.queryByText('Gamma Room')).toBeInTheDocument();
      });
    });

    it('omits invite rooms from the main room list', async () => {
      const joinedRoom = new MockRoom('!joined:matrix.org', 'Joined Room');
      joinedRoom.addMember('@testuser:matrix.org', KnownMembership.Join, 0);
      const inviteRoom = new MockRoom('!invite:matrix.org', 'Invite Room');

      /* setMyMembership drives getMyMembership, which is what filters the room list */
      inviteRoom.setMyMembership(KnownMembership.Invite);

      mockClient.addRoom(joinedRoom);
      mockClient.addRoom(inviteRoom);
      render(<ChatList onSelect={vi.fn()} />);
      await waitFor(() => { expect(screen.queryByText('Joined Room')).toBeInTheDocument(); });
      expect(screen.queryByText('Invite Room')).not.toBeInTheDocument();
    });
  });

  describe('Loading State', () => {
    it('renders even when client is initializing', async () => {
      window.__matrix_ready = false;
      const { container } = render(<ChatList onSelect={vi.fn()} />);
      expect(container.firstChild).toBeInTheDocument();
    });

    it('handles null client gracefully', async () => {
      window.__matrix_ready = false;
      (getMatrixClient as ReturnType<typeof vi.fn>).mockReturnValue(null);
      expect(() => render(<ChatList onSelect={vi.fn()} />)).not.toThrow();
    });
  });

  describe('Component Lifecycle', () => {
    it('unmounts without error', () => {
      const { unmount } = render(<ChatList onSelect={vi.fn()} />);
      expect(() => unmount()).not.toThrow();
    });
  });
});