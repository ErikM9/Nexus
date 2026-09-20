import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';

vi.mock('matrix-js-sdk', async () => {
  const actual = await import('../../__mocks__/matrix-js-sdk');
  return actual;
});

vi.mock('@/app/utils/matrix', () => ({
  getMatrixClient: vi.fn(),
}));

vi.mock('react-hot-toast', () => ({
  default: {
    success: vi.fn(),
    error: vi.fn(),
    loading: vi.fn(),
    dismiss: vi.fn(),
  },
}));

import ChatWindow from '@/app/app-components/ChatWindow';
import { 
  MockMatrixClient, 
  MockRoom, 
  MockMatrixEvent, 
  MsgType,
  EventType,
} from '../../__mocks__/matrix-js-sdk';
import { getMatrixClient } from '@/app/utils/matrix';

describe('ChatWindow Component', () => {
  let mockClient: MockMatrixClient;
  let mockRoom: MockRoom;

  const createMockMessage = (opts: {
    id?: string;
    body: string;
    sender?: string;
    timestamp?: number;
    msgtype?: string;
  }) => {
    return new MockMatrixEvent({
      id: opts.id || `$event_${Date.now()}_${Math.random()}`,
      type: EventType.RoomMessage,
      content: {
        msgtype: opts.msgtype || MsgType.Text,
        body: opts.body,
      },
      sender: opts.sender || '@other:matrix.org',
      timestamp: opts.timestamp || Date.now(),
    });
  };

  beforeEach(() => {
    vi.clearAllMocks();
    
    window.__matrix_ready = true;
    
    mockClient = new MockMatrixClient({
      userId: '@testuser:matrix.org',
      deviceId: 'TESTDEVICE',
      baseUrl: 'https://matrix.org',
    });

    mockRoom = new MockRoom('!testroom:matrix.org', 'Test Room');
    mockClient.addRoom(mockRoom);

    (getMatrixClient as ReturnType<typeof vi.fn>).mockReturnValue(mockClient);

    window.URL.createObjectURL = vi.fn(() => 'blob:mock-url');
    window.URL.revokeObjectURL = vi.fn();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Rendering', () => {
    it('renders empty state when room has no messages', async () => {
      render(
        <ChatWindow
          roomId="!testroom:matrix.org"
          onLeave={vi.fn()}
        />
      );

      await waitFor(() => {
        expect(screen.queryByText(/no messages yet/i)).toBeInTheDocument();
      });
    });

    it('renders messages when room has events', async () => {
      const message = createMockMessage({ body: 'Hello World!' });
      mockRoom.addEvent(message);

      render(
        <ChatWindow
          roomId="!testroom:matrix.org"
          onLeave={vi.fn()}
        />
      );

      await waitFor(() => {
        expect(screen.queryByText('Hello World!')).toBeInTheDocument();
      });
    });

    it('renders multiple messages', async () => {
      const msg1 = createMockMessage({ body: 'First message', timestamp: 1000, id: '$msg1' });
      const msg2 = createMockMessage({ body: 'Second message', timestamp: 2000, id: '$msg2' });
      
      mockRoom.addEvent(msg1);
      mockRoom.addEvent(msg2);

      render(
        <ChatWindow
          roomId="!testroom:matrix.org"
          onLeave={vi.fn()}
        />
      );

      await waitFor(() => {
        expect(screen.queryByText('First message')).toBeInTheDocument();
        expect(screen.queryByText('Second message')).toBeInTheDocument();
      });
    });

    it('shows sender information', async () => {
      const message = createMockMessage({
        body: 'Hello',
        sender: '@alice:matrix.org',
      });
      mockRoom.addEvent(message);

      render(
        <ChatWindow
          roomId="!testroom:matrix.org"
          onLeave={vi.fn()}
        />
      );

      await waitFor(() => {
        expect(screen.queryByText('Hello')).toBeInTheDocument();
        expect(screen.queryByText('@alice:matrix.org')).toBeInTheDocument();
      });
    });
  });

  describe('Message Types', () => {
    it('handles text messages', async () => {
      const textMsg = createMockMessage({
        body: 'This is a text message',
        msgtype: MsgType.Text,
      });
      mockRoom.addEvent(textMsg);

      render(
        <ChatWindow
          roomId="!testroom:matrix.org"
          onLeave={vi.fn()}
        />
      );

      await waitFor(() => {
        expect(screen.queryByText('This is a text message')).toBeInTheDocument();
      });
    });

    it('handles notice messages', async () => {
      const noticeMsg = createMockMessage({
        body: 'This is a notice',
        msgtype: MsgType.Notice,
      });
      mockRoom.addEvent(noticeMsg);

      render(
        <ChatWindow
          roomId="!testroom:matrix.org"
          onLeave={vi.fn()}
        />
      );

      await waitFor(() => {
        expect(screen.queryByText('This is a notice')).toBeInTheDocument();
      });
    });
  });

  describe('Loading States', () => {
    it('shows loading state when client not ready', async () => {
      window.__matrix_ready = false;
      (getMatrixClient as ReturnType<typeof vi.fn>).mockImplementation(() => {
        throw new Error('Client not ready');
      });

      render(
        <ChatWindow
          roomId="!testroom:matrix.org"
          onLeave={vi.fn()}
        />
      );

      await waitFor(() => {
        expect(screen.queryByText('Connecting…')).toBeInTheDocument();
      });
    });

    it('shows loading room state when room not found', async () => {
      mockClient = new MockMatrixClient({
        userId: '@testuser:matrix.org',
        deviceId: 'TESTDEVICE',
        baseUrl: 'https://matrix.org',
      });
      (getMatrixClient as ReturnType<typeof vi.fn>).mockReturnValue(mockClient);

      render(
        <ChatWindow
          roomId="!nonexistent:matrix.org"
          onLeave={vi.fn()}
        />
      );

      await waitFor(() => {
        expect(screen.queryByText('Loading room…')).toBeInTheDocument();
      });
    });
  });

  describe('Accessibility', () => {
    it('has accessible message list', async () => {
      const message = createMockMessage({ body: 'Test message' });
      mockRoom.addEvent(message);

      render(
        <ChatWindow
          roomId="!testroom:matrix.org"
          onLeave={vi.fn()}
        />
      );

      await waitFor(() => {
        expect(screen.queryByRole('log')).toBeInTheDocument();
      });
    });

    it('has accessible message articles', async () => {
      const message = createMockMessage({ body: 'Accessible message', sender: '@sender:matrix.org' });
      mockRoom.addEvent(message);

      render(
        <ChatWindow
          roomId="!testroom:matrix.org"
          onLeave={vi.fn()}
        />
      );

      await waitFor(() => {
        expect(screen.queryByRole('article')).toBeInTheDocument();
      });
    });
  });

  describe('Component Lifecycle', () => {
    it('cleans up event listeners on unmount', async () => {
      const { unmount } = render(
        <ChatWindow
          roomId="!testroom:matrix.org"
          onLeave={vi.fn()}
        />
      );

      await waitFor(() => {
        expect(screen.queryByText('Connecting…')).not.toBeInTheDocument();
      });

      expect(() => unmount()).not.toThrow();
    });

    it('handles room change', async () => {
      const message1 = createMockMessage({ body: 'Room 1 message' });
      mockRoom.addEvent(message1);

      const { rerender } = render(
        <ChatWindow
          roomId="!testroom:matrix.org"
          onLeave={vi.fn()}
        />
      );

      await waitFor(() => {
        expect(screen.queryByText('Room 1 message')).toBeInTheDocument();
      });

      const newRoom = new MockRoom('!newroom:matrix.org', 'New Room');
      const message2 = createMockMessage({ body: 'Room 2 message' });
      newRoom.addEvent(message2);
      mockClient.addRoom(newRoom);

      rerender(
        <ChatWindow
          roomId="!newroom:matrix.org"
          onLeave={vi.fn()}
        />
      );

      await waitFor(() => {
        expect(screen.queryByText('Room 2 message')).toBeInTheDocument();
      });
    });
  });
  describe('Message Actions', () => {
    it('renders action toolbar in DOM for messages with event IDs', async () => {
      const message = createMockMessage({ body: 'Action test', id: '$action1' });
      mockRoom.addEvent(message);

      render(<ChatWindow roomId="!testroom:matrix.org" onLeave={vi.fn()} />);

      await waitFor(() => {
        expect(screen.queryByText('Action test')).toBeInTheDocument();
      });

      /* The toolbar stays in the DOM with opacity toggled, so querying by testid is the best choice */
      expect(screen.queryByTestId('message-actions')).toBeInTheDocument();
    });

    it('reply button dispatches nexus-reply-to event with correct detail', async () => {
      const message = createMockMessage({ body: 'Reply me', id: '$replytest', sender: '@alice:matrix.org' });
      mockRoom.addEvent(message);

      render(<ChatWindow roomId="!testroom:matrix.org" onLeave={vi.fn()} />);

      await waitFor(() => { expect(screen.queryByText('Reply me')).toBeInTheDocument(); });

      /* Spy on dispatchEvent so no listener lingers on window after the test */
      const dispatchSpy = vi.spyOn(window, 'dispatchEvent');

      const replyBtn = screen.getByTestId('action-reply');
      fireEvent.click(replyBtn);

      const replyEvents = dispatchSpy.mock.calls
        .map(([e]) => e as CustomEvent)
        .filter((e) => e.type === 'nexus-reply-to');
      expect(replyEvents).toHaveLength(1);
      expect(replyEvents[0].detail.eventId).toBe('$replytest');
      expect(replyEvents[0].detail.sender).toBe('@alice:matrix.org');
      expect(replyEvents[0].detail.body).toBe('Reply me');
    });

    it('react button opens the emoji picker', async () => {
      const message = createMockMessage({ body: 'React me', id: '$reacttest' });
      mockRoom.addEvent(message);

      render(<ChatWindow roomId="!testroom:matrix.org" onLeave={vi.fn()} />);

      await waitFor(() => { expect(screen.queryByText('React me')).toBeInTheDocument(); });

      expect(screen.queryByTestId('reaction-picker')).not.toBeInTheDocument();

      const reactBtn = screen.getByTestId('action-react');
      fireEvent.mouseDown(reactBtn);

      expect(screen.queryByTestId('reaction-picker')).toBeInTheDocument();
    });

    it('selecting an emoji from the picker sends m.reaction event', async () => {
      mockClient.redactEvent.mockResolvedValue({ event_id: '' });
      const message = createMockMessage({ body: 'Emoji me', id: '$emojitest' });
      mockRoom.addEvent(message);

      render(<ChatWindow roomId="!testroom:matrix.org" onLeave={vi.fn()} />);

      await waitFor(() => { expect(screen.queryByText('Emoji me')).toBeInTheDocument(); });

      fireEvent.mouseDown(screen.getByTestId('action-react'));
      await waitFor(() => { expect(screen.queryByTestId('reaction-picker')).toBeInTheDocument(); });

      const thumbsUp = screen.getByLabelText('React with 👍');
      fireEvent.click(thumbsUp);

      await waitFor(() => {
        expect(mockClient.sendEvent).toHaveBeenCalledWith(
          '!testroom:matrix.org',
          'm.reaction',
          expect.objectContaining({
            'm.relates_to': expect.objectContaining({
              rel_type: 'm.annotation',
              event_id: '$emojitest',
              key: '👍',
            }),
          })
        );
      });
    });

    it('edit button is present for own text messages', async () => {
      const message = createMockMessage({ body: 'My message', id: '$ownmsg', sender: '@testuser:matrix.org' });
      mockRoom.addEvent(message);

      render(<ChatWindow roomId="!testroom:matrix.org" onLeave={vi.fn()} />);

      await waitFor(() => { expect(screen.queryByText('My message')).toBeInTheDocument(); });

      expect(screen.queryByTestId('action-edit')).toBeInTheDocument();
    });

    it('edit button is absent for others messages', async () => {
      const message = createMockMessage({ body: 'Others message', id: '$othermsg', sender: '@other:matrix.org' });
      mockRoom.addEvent(message);

      render(<ChatWindow roomId="!testroom:matrix.org" onLeave={vi.fn()} />);

      await waitFor(() => { expect(screen.queryByText('Others message')).toBeInTheDocument(); });

      expect(screen.queryByTestId('action-edit')).not.toBeInTheDocument();
    });

    it('clicking edit shows the inline edit form', async () => {
      const message = createMockMessage({ body: 'Edit this', id: '$editme', sender: '@testuser:matrix.org' });
      mockRoom.addEvent(message);

      render(<ChatWindow roomId="!testroom:matrix.org" onLeave={vi.fn()} />);

      await waitFor(() => { expect(screen.queryByText('Edit this')).toBeInTheDocument(); });

      fireEvent.click(screen.getByTestId('action-edit'));

      await waitFor(() => {
        expect(screen.queryByTestId('edit-form')).toBeInTheDocument();
        expect(screen.queryByTestId('edit-input')).toBeInTheDocument();
        expect(screen.queryByTestId('edit-save')).toBeInTheDocument();
        expect(screen.queryByTestId('edit-cancel')).toBeInTheDocument();
      });
    });

    it('saving an edit sends m.replace event', async () => {
      (mockClient as any).sendEvent = vi.fn(async () => ({ event_id: '$edit_ev' }));
      const message = createMockMessage({ body: 'Original', id: '$editable', sender: '@testuser:matrix.org' });
      mockRoom.addEvent(message);

      render(<ChatWindow roomId="!testroom:matrix.org" onLeave={vi.fn()} />);

      await waitFor(() => { expect(screen.queryByText('Original')).toBeInTheDocument(); });

      fireEvent.click(screen.getByTestId('action-edit'));

      await waitFor(() => { expect(screen.queryByTestId('edit-input')).toBeInTheDocument(); });

      const input = screen.getByTestId('edit-input');
      fireEvent.change(input, { target: { value: 'Updated text' } });
      fireEvent.click(screen.getByTestId('edit-save'));

      await waitFor(() => {
        expect((mockClient as any).sendEvent).toHaveBeenCalledWith(
          '!testroom:matrix.org',
          'm.room.message',
          expect.objectContaining({
            'm.relates_to': expect.objectContaining({ rel_type: 'm.replace', event_id: '$editable' }),
            'm.new_content': expect.objectContaining({ body: 'Updated text' }),
          })
        );
      });
    });

    it('cancel button closes the edit form without saving', async () => {
      const message = createMockMessage({ body: 'Cancel test', id: '$canceltest', sender: '@testuser:matrix.org' });
      mockRoom.addEvent(message);

      render(<ChatWindow roomId="!testroom:matrix.org" onLeave={vi.fn()} />);

      await waitFor(() => { expect(screen.queryByText('Cancel test')).toBeInTheDocument(); });

      fireEvent.click(screen.getByTestId('action-edit'));
      await waitFor(() => { expect(screen.queryByTestId('edit-form')).toBeInTheDocument(); });

      fireEvent.click(screen.getByTestId('edit-cancel'));

      await waitFor(() => { expect(screen.queryByTestId('edit-form')).not.toBeInTheDocument(); });
      expect(screen.queryByText('Cancel test')).toBeInTheDocument();
    });

    it('delete button is present for own messages', async () => {
      mockClient.redactEvent.mockResolvedValue({ event_id: '' });
      const message = createMockMessage({ body: 'Delete me', id: '$delmsg', sender: '@testuser:matrix.org' });
      mockRoom.addEvent(message);

      render(<ChatWindow roomId="!testroom:matrix.org" onLeave={vi.fn()} />);

      await waitFor(() => { expect(screen.queryByText('Delete me')).toBeInTheDocument(); });

      expect(screen.queryByTestId('action-delete')).toBeInTheDocument();
    });

    it('delete button is present for others messages when user has redact power level', async () => {
      mockClient.redactEvent.mockResolvedValue({ event_id: '' });

      /* Override room power levels so test user at PL 100 can redact others */
      mockRoom.currentState.getStateEvents = vi.fn((type: string) => {
        if (type === 'm.room.power_levels') {
          return {
            getContent: () => ({
              users: { '@testuser:matrix.org': 100 },
              users_default: 0,
              events: {},
              events_default: 0,
              state_default: 50,
              ban: 50,
              kick: 50,
              redact: 50,
              invite: 0,
            }),
          };
        }
        return null;
      });
      const message = createMockMessage({ body: 'Others deletable', id: '$otherdel', sender: '@other:matrix.org' });
      mockRoom.addEvent(message);

      render(<ChatWindow roomId="!testroom:matrix.org" onLeave={vi.fn()} />);

      await waitFor(() => { expect(screen.queryByText('Others deletable')).toBeInTheDocument(); });

      expect(screen.queryByTestId('action-delete')).toBeInTheDocument();
    });

    it('clicking delete shows inline confirmation options', async () => {
      mockClient.redactEvent.mockResolvedValue({ event_id: '' });
      const message = createMockMessage({ body: 'Delete me', id: '$delmsg2', sender: '@testuser:matrix.org' });
      mockRoom.addEvent(message);

      render(<ChatWindow roomId="!testroom:matrix.org" onLeave={vi.fn()} />);

      await waitFor(() => { expect(screen.queryByText('Delete me')).toBeInTheDocument(); });

      /* First click opens the inline confirmation and does not delete yet */
      fireEvent.click(screen.getByTestId('action-delete'));

      await waitFor(() => {
        expect(screen.queryByTestId('delete-confirm')).toBeInTheDocument();
        expect(screen.queryByTestId('delete-confirm-yes')).toBeInTheDocument();
        expect(screen.queryByTestId('delete-cancel')).toBeInTheDocument();
      });

      /* Deletion has not fired yet */
      expect(mockClient.redactEvent).not.toHaveBeenCalled();
    });

    it('clicking delete Cancel dismisses confirmation without deleting', async () => {
      mockClient.redactEvent.mockResolvedValue({ event_id: '' });
      const message = createMockMessage({ body: 'Keep me', id: '$keepme', sender: '@testuser:matrix.org' });
      mockRoom.addEvent(message);

      render(<ChatWindow roomId="!testroom:matrix.org" onLeave={vi.fn()} />);

      await waitFor(() => { expect(screen.queryByText('Keep me')).toBeInTheDocument(); });

      fireEvent.click(screen.getByTestId('action-delete'));
      await waitFor(() => { expect(screen.queryByTestId('delete-confirm')).toBeInTheDocument(); });

      fireEvent.click(screen.getByTestId('delete-cancel'));

      await waitFor(() => { expect(screen.queryByTestId('delete-confirm')).not.toBeInTheDocument(); });
      expect(screen.queryByText('Keep me')).toBeInTheDocument();
      expect(mockClient.redactEvent).not.toHaveBeenCalled();
    });

    it('confirming delete calls redactEvent with the correct event ID', async () => {
      mockClient.redactEvent.mockResolvedValue({ event_id: '' });
      const message = createMockMessage({ body: 'Redact me', id: '$redactme', sender: '@testuser:matrix.org' });
      mockRoom.addEvent(message);

      render(<ChatWindow roomId="!testroom:matrix.org" onLeave={vi.fn()} />);

      await waitFor(() => { expect(screen.queryByText('Redact me')).toBeInTheDocument(); });

      fireEvent.click(screen.getByTestId('action-delete'));
      await waitFor(() => { expect(screen.queryByTestId('delete-confirm')).toBeInTheDocument(); });
      fireEvent.click(screen.getByTestId('delete-confirm-yes'));

      await waitFor(() => {
        expect(mockClient.redactEvent).toHaveBeenCalledWith('!testroom:matrix.org', '$redactme');
      });
    });

    it('message disappears from UI after confirming deletion', async () => {
      mockClient.redactEvent.mockResolvedValue({ event_id: '' });
      const message = createMockMessage({ body: 'Gone soon', id: '$gone', sender: '@testuser:matrix.org' });
      mockRoom.addEvent(message);

      render(<ChatWindow roomId="!testroom:matrix.org" onLeave={vi.fn()} />);

      await waitFor(() => { expect(screen.queryByText('Gone soon')).toBeInTheDocument(); });

      fireEvent.click(screen.getByTestId('action-delete'));
      await waitFor(() => { expect(screen.queryByTestId('delete-confirm')).toBeInTheDocument(); });
      fireEvent.click(screen.getByTestId('delete-confirm-yes'));

      await waitFor(() => { expect(screen.queryByText('Gone soon')).not.toBeInTheDocument(); });
    });
  });

  describe('Thread Actions', () => {
    it('thread button is present in the action toolbar', async () => {
      const message = createMockMessage({ body: 'Thread me', id: '$threadmsg' });
      mockRoom.addEvent(message);

      render(<ChatWindow roomId="!testroom:matrix.org" onLeave={vi.fn()} />);

      await waitFor(() => { expect(screen.queryByText('Thread me')).toBeInTheDocument(); });

      expect(screen.queryByTestId('action-thread')).toBeInTheDocument();
    });

    it('clicking thread button opens the thread panel', async () => {
      const message = createMockMessage({ body: 'Open thread', id: '$openthread' });
      mockRoom.addEvent(message);

      render(<ChatWindow roomId="!testroom:matrix.org" onLeave={vi.fn()} />);

      await waitFor(() => { expect(screen.queryByText('Open thread')).toBeInTheDocument(); });

      expect(screen.queryByTestId('thread-panel')).not.toBeInTheDocument();

      fireEvent.click(screen.getByTestId('action-thread'));

      await waitFor(() => {
        expect(screen.queryByTestId('thread-panel')).toBeInTheDocument();
        expect(screen.queryByTestId('thread-input')).toBeInTheDocument();
        expect(screen.queryByTestId('thread-send')).toBeInTheDocument();
      });
    });

    it('thread panel shows the root message', async () => {
      const message = createMockMessage({ body: 'Root message text', id: '$rootmsg' });
      mockRoom.addEvent(message);

      render(<ChatWindow roomId="!testroom:matrix.org" onLeave={vi.fn()} />);

      await waitFor(() => { expect(screen.queryByText('Root message text')).toBeInTheDocument(); });

      fireEvent.click(screen.getByTestId('action-thread'));

      await waitFor(() => {
        const panel = screen.getByTestId('thread-panel');
        expect(panel).toHaveTextContent('Root message text');
      });
    });

    it('close button dismisses the thread panel', async () => {
      const message = createMockMessage({ body: 'Close thread', id: '$closethread' });
      mockRoom.addEvent(message);

      render(<ChatWindow roomId="!testroom:matrix.org" onLeave={vi.fn()} />);

      await waitFor(() => { expect(screen.queryByText('Close thread')).toBeInTheDocument(); });

      fireEvent.click(screen.getByTestId('action-thread'));
      await waitFor(() => { expect(screen.queryByTestId('thread-panel')).toBeInTheDocument(); });

      fireEvent.click(screen.getByTestId('thread-close'));

      await waitFor(() => { expect(screen.queryByTestId('thread-panel')).not.toBeInTheDocument(); });
    });

    it('sending a thread reply calls sendEvent with m.thread relation', async () => {
      const message = createMockMessage({ body: 'Thread root', id: '$troot' });
      mockRoom.addEvent(message);

      render(<ChatWindow roomId="!testroom:matrix.org" onLeave={vi.fn()} />);

      await waitFor(() => { expect(screen.queryByText('Thread root')).toBeInTheDocument(); });

      fireEvent.click(screen.getByTestId('action-thread'));
      await waitFor(() => { expect(screen.queryByTestId('thread-input')).toBeInTheDocument(); });

      fireEvent.change(screen.getByTestId('thread-input'), { target: { value: 'Thread reply!' } });
      fireEvent.click(screen.getByTestId('thread-send'));

      await waitFor(() => {
        expect(mockClient.sendEvent).toHaveBeenCalledWith(
          '!testroom:matrix.org',
          'm.room.message',
          expect.objectContaining({
            body: 'Thread reply!',
            'm.relates_to': expect.objectContaining({
              rel_type: 'm.thread',
              event_id: '$troot',
            }),
          })
        );
      });
    });

    it('m.thread events do not appear in the main message list', async () => {
      const { MockMatrixEvent: Ev } = await import('../../__mocks__/matrix-js-sdk');
      const root = createMockMessage({ body: 'Main message', id: '$mainmsg' });
      mockRoom.addEvent(root);

      render(<ChatWindow roomId="!testroom:matrix.org" onLeave={vi.fn()} />);
      await waitFor(() => { expect(screen.queryByText('Main message')).toBeInTheDocument(); });

      /* Emit a thread reply through the room emitter to simulate a post-mount timeline event */
      const threadEv = new Ev({
        id: '$threadreply',
        type: 'm.room.message',
        content: {
          msgtype: 'm.text',
          body: 'Thread-only message',
          'm.relates_to': { rel_type: 'm.thread', event_id: '$mainmsg' },
        },
        sender: '@alice:matrix.org',
      });
      await act(async () => { mockRoom.emit('Room.timeline', threadEv, mockRoom); });

      await waitFor(() => {
        const articles = screen.getAllByRole('article');
        /* Only the root message appears in the main timeline */
        expect(articles).toHaveLength(1);
      });

      fireEvent.click(screen.getByTestId('action-thread'));
      await waitFor(() => {
        expect(screen.queryByTestId('thread-panel')).toBeInTheDocument();

        expect(screen.getAllByTestId('thread-message').length).toBeGreaterThanOrEqual(1);
        expect(screen.queryByText('Thread-only message')).toBeInTheDocument();
      });
    });

    it('thread count indicator appears below message when thread has replies', async () => {
      const { MockMatrixEvent: Ev } = await import('../../__mocks__/matrix-js-sdk');
      const root = createMockMessage({ body: 'Has replies', id: '$hasreplies' });
      mockRoom.addEvent(root);

      render(<ChatWindow roomId="!testroom:matrix.org" onLeave={vi.fn()} />);
      await waitFor(() => { expect(screen.queryByText('Has replies')).toBeInTheDocument(); });

      const threadEv = new Ev({
        id: '$tr1',
        type: 'm.room.message',
        content: { msgtype: 'm.text', body: 'First reply', 'm.relates_to': { rel_type: 'm.thread', event_id: '$hasreplies' } },
        sender: '@alice:matrix.org',
      });
      await act(async () => { mockRoom.emit('Room.timeline', threadEv, mockRoom); });

      await waitFor(() => {
        expect(screen.queryByTestId('thread-count')).toBeInTheDocument();
        expect(screen.getByTestId('thread-count')).toHaveTextContent('1 reply');
      });
    });
  });
});