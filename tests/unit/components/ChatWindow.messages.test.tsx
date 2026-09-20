import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';

vi.mock('matrix-js-sdk', async () => {
  const actual = await import('../../__mocks__/matrix-js-sdk');
  return actual;
});

vi.mock('@/app/utils/matrix', () => ({
  getMatrixClient: vi.fn(),
  logoutMatrixClient: vi.fn(),
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
  KnownMembership,
  RoomEvent
} from '../../__mocks__/matrix-js-sdk';
import { getMatrixClient } from '@/app/utils/matrix';

describe('ChatMessage Rendering', () => {
  let mockClient: MockMatrixClient;
  let mockRoom: MockRoom;

  const createMockEvent = (opts: {
    id?: string;
    type?: string;
    content: Record<string, unknown>;
    sender?: string;
    timestamp?: number;
  }) => {
    return new MockMatrixEvent({
      id: opts.id || `$event_${Date.now()}_${Math.random()}`,
      type: opts.type || EventType.RoomMessage,
      content: opts.content,
      sender: opts.sender || '@other:matrix.org',
      timestamp: opts.timestamp || Date.now(),
    });
  };

  const createTextMessage = (body: string, opts: Partial<{
    id: string;
    sender: string;
    timestamp: number;
  }> = {}) => {
    return createMockEvent({
      ...opts,
      content: {
        msgtype: MsgType.Text,
        body,
      },
    });
  };

  const createImageMessage = (opts: {
    body?: string;
    filename?: string;
    url?: string;
    info?: Record<string, unknown>;
    file?: Record<string, unknown>;
    id?: string;
    sender?: string;
  } = {}) => {
    return createMockEvent({
      id: opts.id,
      sender: opts.sender,
      content: {
        msgtype: MsgType.Image,
        body: opts.body || 'image.png',
        filename: opts.filename,
        url: opts.url || 'mxc://matrix.org/someimage',
        info: opts.info || { mimetype: 'image/png', size: 12345 },
        file: opts.file,
      },
    });
  };

  const createFileMessage = (opts: {
    body?: string;
    filename?: string;
    url?: string;
    info?: Record<string, unknown>;
    file?: Record<string, unknown>;
    id?: string;
    sender?: string;
  } = {}) => {
    return createMockEvent({
      id: opts.id,
      sender: opts.sender,
      content: {
        msgtype: MsgType.File,
        body: opts.body || 'document.pdf',
        filename: opts.filename || 'document.pdf',
        url: opts.url || 'mxc://matrix.org/somefile',
        info: opts.info || { mimetype: 'application/pdf', size: 102400 },
        file: opts.file,
      },
    });
  };

  const createEncryptedMessage = (opts: {
    body?: string;
    decryptionFailure?: boolean;
    id?: string;
    sender?: string;
  } = {}) => {
    const event = createMockEvent({
      id: opts.id,
      sender: opts.sender,
      type: EventType.RoomEncrypted,
      content: {
        /* 'm.bad.encrypted' makes the event report a decryption failure, which drives the failure indicator */
        msgtype: opts.decryptionFailure ? 'm.bad.encrypted' : MsgType.Text,
        body: opts.decryptionFailure ? '** Unable to decrypt **' : (opts.body || 'Encrypted message'),
      },
    });
    

    /* Flag the event as encrypted so it is classified correctly */
    (event as any)._encrypted = true;
    if (opts.decryptionFailure) {
      (event as any)._decryptionFailure = true;
    }
    
    return event;
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

    /* Stub URL methods so blob URL creation doesn't throw in jsdom */
    window.URL.createObjectURL = vi.fn(() => 'blob:mock-url');
    window.URL.revokeObjectURL = vi.fn();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Text Messages', () => {
    it('renders plain text message', async () => {
      const message = createTextMessage('Hello, World!');
      mockRoom.addEvent(message);

      render(
        <ChatWindow
          roomId="!testroom:matrix.org"
          onLeave={vi.fn()}
        />
      );

      await waitFor(() => {
        expect(screen.queryByText('Hello, World!')).toBeInTheDocument();
      });
    });

    it('renders message with emojis', async () => {
      const message = createTextMessage('Hello 👋 World 🌍');
      mockRoom.addEvent(message);

      render(
        <ChatWindow
          roomId="!testroom:matrix.org"
          onLeave={vi.fn()}
        />
      );

      await waitFor(() => {
        expect(screen.queryByText('Hello 👋 World 🌍')).toBeInTheDocument();
      });
    });

    it('renders multiline message', async () => {
      const message = createTextMessage('Line 1\nLine 2\nLine 3');
      mockRoom.addEvent(message);

      render(
        <ChatWindow
          roomId="!testroom:matrix.org"
          onLeave={vi.fn()}
        />
      );

      await waitFor(() => {
        expect(screen.queryByText(/Line 1/)).toBeInTheDocument();
      });
    });

    it('renders long message without truncation', async () => {
      const longText = 'A'.repeat(500);
      const message = createTextMessage(longText);
      mockRoom.addEvent(message);

      render(
        <ChatWindow
          roomId="!testroom:matrix.org"
          onLeave={vi.fn()}
        />
      );

      await waitFor(() => {
        expect(screen.queryByText(longText)).toBeInTheDocument();
      });
    });
  });

  /* Image rendering resolves mxc URLs asynchronously, which never completes in jsdom, so these assert no crash */
  describe('Image Messages', () => {
    it('renders image message without crashing', async () => {
      const message = createImageMessage({
        body: 'Screenshot of app',
        url: 'mxc://matrix.org/screenshot',
      });
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

    /* The test hash doesn't match the mock digest, so decryption throws before createObjectURL, verifying no crash */
    it('handles encrypted image attachment', async () => {
      const message = createImageMessage({
        body: 'Encrypted image',
        url: undefined,
        file: {
          url: 'mxc://matrix.org/encrypted',
          key: { k: 'somekey' },
          iv: 'someiv',
          hashes: { sha256: 'somehash' },
        },
      });
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

  /* File details only appear after the async load, so these assert no crash */
  describe('File Messages', () => {
    it('renders file message without crashing', async () => {
      const message = createFileMessage({
        body: 'Important document',
        filename: 'report.pdf',
        info: { mimetype: 'application/pdf', size: 102400 },
      });
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

    /* Same hash-mismatch crash guard as the encrypted image case */
    it('handles encrypted file attachment', async () => {
      const message = createFileMessage({
        body: 'Encrypted file',
        filename: 'secret.docx',
        url: undefined,
        file: {
          url: 'mxc://matrix.org/encrypted',
          key: { k: 'somekey' },
          iv: 'someiv',
          hashes: { sha256: 'somehash' },
        },
      });
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

  describe('Message States', () => {
    it('renders a message in sending state without crashing', async () => {
      const message = createTextMessage('Sending...', { id: '$pending1' });

      (message as any)._sending = true;
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

    it('renders a message in failed state without crashing', async () => {
      const message = createTextMessage('Failed message', { id: '$failed1' });

      (message as any)._sendFailed = true;
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

  describe('Encryption States', () => {
    it('renders decrypted encrypted message without crashing', async () => {
      const message = createEncryptedMessage({
        body: 'Secret message',
        decryptionFailure: false,
      });
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

    it('shows decryption failure indicator', async () => {
      const message = createEncryptedMessage({
        decryptionFailure: true,
      });
      mockRoom.addEvent(message);

      render(
        <ChatWindow
          roomId="!testroom:matrix.org"
          onLeave={vi.fn()}
        />
      );

      await waitFor(() => {
        expect(screen.queryByText(/unable to decrypt/i)).toBeInTheDocument();
      });
    });
  });

  describe('Timestamps', () => {
    it('orders messages by timestamp', async () => {
      const older = createTextMessage('First', { 
        id: '$older', 
        timestamp: 1000 
      });
      const newer = createTextMessage('Second', { 
        id: '$newer', 
        timestamp: 2000 
      });
      
      mockRoom.addEvent(newer);
      mockRoom.addEvent(older);

      render(
        <ChatWindow
          roomId="!testroom:matrix.org"
          onLeave={vi.fn()}
        />
      );

      await waitFor(() => {
        const articles = screen.getAllByRole('article');
        expect(articles).toHaveLength(2);
        expect(articles[0]).toHaveTextContent('First');
        expect(articles[1]).toHaveTextContent('Second');
      });
    });
  });

  describe('Sender Display', () => {
    /* The sender strip collapses for consecutive messages, so these use a single message to keep it shown */
    it('shows sender username', async () => {
      const message = createTextMessage('Hello', { sender: '@alice:matrix.org' });
      mockRoom.addEvent(message);

      render(
        <ChatWindow
          roomId="!testroom:matrix.org"
          onLeave={vi.fn()}
        />
      );

      await waitFor(() => {
        expect(screen.queryByText('@alice:matrix.org')).toBeInTheDocument();
      });
    });

    /* Own-message styling applies when the sender matches the client user ID */
    it('handles messages from current user', async () => {
      const message = createTextMessage('My message', { sender: '@testuser:matrix.org' });
      mockRoom.addEvent(message);

      render(
        <ChatWindow
          roomId="!testroom:matrix.org"
          onLeave={vi.fn()}
        />
      );

      await waitFor(() => {
        expect(screen.queryByText('@testuser:matrix.org')).toBeInTheDocument();
      });
    });
  });

  describe('Message Accessibility', () => {
    it('has aria-label on message articles', async () => {
      const message = createTextMessage('Accessible', { sender: '@user:matrix.org' });
      mockRoom.addEvent(message);

      render(
        <ChatWindow
          roomId="!testroom:matrix.org"
          onLeave={vi.fn()}
        />
      );

      await waitFor(() => {
        const article = screen.getByRole('article');
        expect(article).toHaveAttribute('aria-label', expect.stringContaining('@user:matrix.org'));
      });
    });

  });

  describe('Edge Cases', () => {
    it('handles empty body gracefully', async () => {
      const message = createMockEvent({
        content: {
          msgtype: MsgType.Text,
          body: '',
        },
      });
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

    it('handles missing content fields', async () => {
      const message = createMockEvent({
        content: {
          msgtype: MsgType.Text,

        },
      });
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

    it('handles very long sender names', async () => {
      const longName = '@' + 'a'.repeat(100) + ':matrix.org';
      const message = createTextMessage('Message', { sender: longName });
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

    it('handles special characters in message body', async () => {
      const message = createTextMessage('<script>alert("xss")</script>');
      mockRoom.addEvent(message);

      render(
        <ChatWindow
          roomId="!testroom:matrix.org"
          onLeave={vi.fn()}
        />
      );

      await waitFor(() => {
        expect(screen.queryByText('<script>alert("xss")</script>')).toBeInTheDocument();
      });
    });

    it('handles unicode and RTL text', async () => {
      const message = createTextMessage('مرحبا بالعالم 你好世界');
      mockRoom.addEvent(message);

      render(
        <ChatWindow
          roomId="!testroom:matrix.org"
          onLeave={vi.fn()}
        />
      );

      await waitFor(() => {
        expect(screen.queryByText('مرحبا بالعالم 你好世界')).toBeInTheDocument();
      });
    });
  });

  describe('Real-time Updates', () => {
    /* Simulate the SDK firing a timeline event after mount */
    it('displays new messages as they arrive', async () => {
      render(
        <ChatWindow
          roomId="!testroom:matrix.org"
          onLeave={vi.fn()}
        />
      );

      await waitFor(() => {
        expect(screen.queryByText(/no messages yet/i)).toBeInTheDocument();
      });

      const message = createTextMessage('New message arrived!');
      mockRoom.addEvent(message);
      

      mockRoom.emit('Room.timeline', message, mockRoom);

      await waitFor(() => {
        expect(screen.queryByText('New message arrived!')).toBeInTheDocument();
      });
    });

  });

  describe('Date Separators', () => {
    it('shows "Today" separator for messages from today', async () => {
      const now = Date.now();
      const message = createTextMessage('Hello today', { 
        id: '$today1',
        timestamp: now 
      });
      mockRoom.addEvent(message);

      render(
        <ChatWindow
          roomId="!testroom:matrix.org"
          onLeave={vi.fn()}
        />
      );

      await waitFor(() => {
        expect(screen.queryByText('Today')).toBeInTheDocument();
        expect(screen.queryByText('Hello today')).toBeInTheDocument();
      });
    });

    it('shows "Yesterday" separator for messages from yesterday', async () => {
      const yesterday = Date.now() - (24 * 60 * 60 * 1000);
      const message = createTextMessage('Hello yesterday', { 
        id: '$yesterday1',
        timestamp: yesterday 
      });
      mockRoom.addEvent(message);

      render(
        <ChatWindow
          roomId="!testroom:matrix.org"
          onLeave={vi.fn()}
        />
      );

      await waitFor(() => {
        expect(screen.queryByText('Yesterday')).toBeInTheDocument();
        expect(screen.queryByText('Hello yesterday')).toBeInTheDocument();
      });
    });

    it('shows weekday name for messages within last 7 days', async () => {
      const threeDaysAgo = Date.now() - (3 * 24 * 60 * 60 * 1000);
      const date = new Date(threeDaysAgo);
      const expectedWeekday = date.toLocaleDateString(undefined, { weekday: 'long' });
      
      const message = createTextMessage('Hello from 3 days ago', { 
        id: '$threedays1',
        timestamp: threeDaysAgo 
      });
      mockRoom.addEvent(message);

      render(
        <ChatWindow
          roomId="!testroom:matrix.org"
          onLeave={vi.fn()}
        />
      );

      await waitFor(() => {
        expect(screen.queryByText(expectedWeekday)).toBeInTheDocument();
        expect(screen.queryByText('Hello from 3 days ago')).toBeInTheDocument();
      });
    });

    it('shows month and day for messages older than 7 days in same year', async () => {
      const twoWeeksAgo = Date.now() - (14 * 24 * 60 * 60 * 1000);
      const date = new Date(twoWeeksAgo);
      const expectedDate = date.toLocaleDateString(undefined, { month: 'long', day: 'numeric' });
      
      const message = createTextMessage('Hello from 2 weeks ago', { 
        id: '$twoweeks1',
        timestamp: twoWeeksAgo 
      });
      mockRoom.addEvent(message);

      render(
        <ChatWindow
          roomId="!testroom:matrix.org"
          onLeave={vi.fn()}
        />
      );

      await waitFor(() => {
        expect(screen.queryByText(expectedDate)).toBeInTheDocument();
        expect(screen.queryByText('Hello from 2 weeks ago')).toBeInTheDocument();
      });
    });

    it('shows full date with year for messages from previous years', async () => {
      const oldDate = new Date('2023-01-15T12:00:00Z').getTime();
      const date = new Date(oldDate);
      const expectedDate = date.toLocaleDateString(undefined, { 
        year: 'numeric', 
        month: 'long', 
        day: 'numeric' 
      });
      
      const message = createTextMessage('Hello from 2023', { 
        id: '$old1',
        timestamp: oldDate 
      });
      mockRoom.addEvent(message);

      render(
        <ChatWindow
          roomId="!testroom:matrix.org"
          onLeave={vi.fn()}
        />
      );

      await waitFor(() => {
        expect(screen.queryByText(expectedDate)).toBeInTheDocument();
        expect(screen.queryByText('Hello from 2023')).toBeInTheDocument();
      });
    });

    it('does not show separator between messages on the same day', async () => {
      const today = new Date();
      today.setHours(10, 0, 0, 0);
      const timestamp1 = today.getTime();
      const timestamp2 = today.getTime() + (2 * 60 * 60 * 1000);
      
      const msg1 = createTextMessage('First message', { 
        id: '$msg1',
        timestamp: timestamp1 
      });
      const msg2 = createTextMessage('Second message', { 
        id: '$msg2',
        timestamp: timestamp2 
      });
      
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

      const todaySeparators = screen.getAllByText('Today');
      expect(todaySeparators).toHaveLength(1);
    });

    it('shows separator between messages from different days', async () => {
      const today = Date.now();
      const yesterday = today - (24 * 60 * 60 * 1000);
      
      const msg1 = createTextMessage('Yesterday message', { 
        id: '$msg1',
        timestamp: yesterday 
      });
      const msg2 = createTextMessage('Today message', { 
        id: '$msg2',
        timestamp: today 
      });
      
      mockRoom.addEvent(msg1);
      mockRoom.addEvent(msg2);

      render(
        <ChatWindow
          roomId="!testroom:matrix.org"
          onLeave={vi.fn()}
        />
      );

      await waitFor(() => {
        expect(screen.queryByText('Yesterday')).toBeInTheDocument();
        expect(screen.queryByText('Today')).toBeInTheDocument();
      });
    });

    it('date separator has proper accessibility role', async () => {
      const message = createTextMessage('Test message', { 
        id: '$test1',
        timestamp: Date.now() 
      });
      mockRoom.addEvent(message);

      render(
        <ChatWindow
          roomId="!testroom:matrix.org"
          onLeave={vi.fn()}
        />
      );

      await waitFor(() => {
        expect(screen.queryByRole('separator')).toBeInTheDocument();
      });
    });
  });

  describe('Pagination and History Loading', () => {
    it('shows "Beginning of conversation" when no more history', async () => {
      const message = createTextMessage('First ever message', { 
        id: '$first1',
        timestamp: 1000 
      });
      mockRoom.addEvent(message);
      

      const timeline = mockRoom.getLiveTimeline();
      timeline.getPaginationToken = vi.fn().mockReturnValue(null);

      render(
        <ChatWindow
          roomId="!testroom:matrix.org"
          onLeave={vi.fn()}
        />
      );

      await waitFor(() => {
        expect(screen.queryByText('Beginning of conversation')).toBeInTheDocument();
      });
    });

    it('does not show beginning indicator when there is more history', async () => {
      const message = createTextMessage('Recent message', { 
        id: '$recent1',
        timestamp: Date.now() 
      });
      mockRoom.addEvent(message);
      

      const timeline = mockRoom.getLiveTimeline();
      timeline.getPaginationToken = vi.fn().mockReturnValue('has_more_token');

      render(
        <ChatWindow
          roomId="!testroom:matrix.org"
          onLeave={vi.fn()}
        />
      );

      await waitFor(() => {
        expect(screen.queryByText('Recent message')).toBeInTheDocument();
      });

      expect(screen.queryByText('Beginning of conversation')).not.toBeInTheDocument();
    });
  });

  describe('Membership Handling', () => {
    it('does NOT close room when membership is invite', async () => {
      const onLeaveMock = vi.fn();
      const message = createTextMessage('Test message');
      mockRoom.addEvent(message);
      

      mockRoom.getMyMembership = vi.fn().mockReturnValue(KnownMembership.Join);

      render(
        <ChatWindow
          roomId="!testroom:matrix.org"
          onLeave={onLeaveMock}
        />
      );

      await waitFor(() => {
        expect(screen.queryByText('Test message')).toBeInTheDocument();
      });

      mockRoom.getMyMembership = vi.fn().mockReturnValue(KnownMembership.Invite);
      
      await act(async () => {
        mockRoom.emit(RoomEvent.MyMembership, mockRoom, KnownMembership.Invite);
      });

      expect(onLeaveMock).not.toHaveBeenCalled();
    });

    it('closes room when membership changes to leave', async () => {
      const onLeaveMock = vi.fn();
      const message = createTextMessage('Test message');
      mockRoom.addEvent(message);
      
      mockRoom.getMyMembership = vi.fn().mockReturnValue(KnownMembership.Join);

      render(
        <ChatWindow
          roomId="!testroom:matrix.org"
          onLeave={onLeaveMock}
        />
      );

      await waitFor(() => {
        expect(screen.queryByText('Test message')).toBeInTheDocument();
      });

      mockRoom.getMyMembership = vi.fn().mockReturnValue(KnownMembership.Leave);
      
      await act(async () => {
        mockClient.emit(RoomEvent.MyMembership, mockRoom, KnownMembership.Leave);
      });

      expect(onLeaveMock).toHaveBeenCalled();
    });

    it('closes room when membership changes to ban', async () => {
      const onLeaveMock = vi.fn();
      const message = createTextMessage('Test message');
      mockRoom.addEvent(message);
      
      mockRoom.getMyMembership = vi.fn().mockReturnValue(KnownMembership.Join);

      render(
        <ChatWindow
          roomId="!testroom:matrix.org"
          onLeave={onLeaveMock}
        />
      );

      await waitFor(() => {
        expect(screen.queryByText('Test message')).toBeInTheDocument();
      });

      mockRoom.getMyMembership = vi.fn().mockReturnValue(KnownMembership.Ban);
      
      await act(async () => {
        mockClient.emit(RoomEvent.MyMembership, mockRoom, KnownMembership.Ban);
      });

      expect(onLeaveMock).toHaveBeenCalled();
    });

    it('handles room not found gracefully', async () => {
      const onLeaveMock = vi.fn();
      

      mockClient.getRoom = vi.fn().mockReturnValue(null);

      render(
        <ChatWindow
          roomId="!nonexistent:matrix.org"
          onLeave={onLeaveMock}
        />
      );

      await waitFor(() => {
        expect(screen.queryByText('Loading room…')).toBeInTheDocument();
      });

      expect(onLeaveMock).not.toHaveBeenCalled();
    });
  });

  describe('Message Time Formatting', () => {
    it('renders message article without crashing', async () => {
      const date = new Date();
      date.setHours(14, 30, 0, 0);
      
      const message = createTextMessage('Afternoon message', { 
        id: '$afternoon1',
        timestamp: date.getTime() 
      });
      mockRoom.addEvent(message);

      render(
        <ChatWindow
          roomId="!testroom:matrix.org"
          onLeave={vi.fn()}
        />
      );

      await waitFor(() => {
        expect(screen.queryByText('Afternoon message')).toBeInTheDocument();
      });
    });

    it('handles midnight edge case', async () => {
      const date = new Date();
      date.setHours(0, 5, 0, 0);
      
      const message = createTextMessage('Midnight message', { 
        id: '$midnight1',
        timestamp: date.getTime() 
      });
      mockRoom.addEvent(message);

      render(
        <ChatWindow
          roomId="!testroom:matrix.org"
          onLeave={vi.fn()}
        />
      );

      await waitFor(() => {
        expect(screen.queryByText('Midnight message')).toBeInTheDocument();
      });
    });

    it('handles noon edge case', async () => {
      const date = new Date();
      date.setHours(12, 0, 0, 0);
      
      const message = createTextMessage('Noon message', { 
        id: '$noon1',
        timestamp: date.getTime() 
      });
      mockRoom.addEvent(message);

      render(
        <ChatWindow
          roomId="!testroom:matrix.org"
          onLeave={vi.fn()}
        />
      );

      await waitFor(() => {
        expect(screen.queryByText('Noon message')).toBeInTheDocument();
      });
    });
  });

  describe('Reactions Display', () => {
    it('shows reaction badges when a reaction event arrives on the timeline', async () => {
      const { MockMatrixEvent: Ev, EventType: ET } = await import('../../__mocks__/matrix-js-sdk');
      const message = createTextMessage('React to me', { id: '$reactmsg' });
      mockRoom.addEvent(message);

      render(<ChatWindow roomId="!testroom:matrix.org" onLeave={vi.fn()} />);
      await waitFor(() => { expect(screen.queryByText('React to me')).toBeInTheDocument(); });

      const reactionEv = new Ev({
        id: '$rxn1',
        type: 'm.reaction',
        content: {
          'm.relates_to': { rel_type: 'm.annotation', event_id: '$reactmsg', key: '👍' },
        },
        sender: '@alice:matrix.org',
      });

      await act(async () => {
        mockRoom.emit('Room.timeline', reactionEv, mockRoom);
      });

      await waitFor(() => {
        expect(screen.queryByTestId('reaction-list')).toBeInTheDocument();
        const badges = screen.getAllByTestId('reaction-badge');
        expect(badges.length).toBeGreaterThan(0);
        expect(badges[0]).toHaveTextContent('👍');
        expect(badges[0]).toHaveTextContent('1');
      });
    });

    it('renders badge for own reactions', async () => {
      const { MockMatrixEvent: Ev } = await import('../../__mocks__/matrix-js-sdk');
      const message = createTextMessage('My reaction', { id: '$myreact' });
      mockRoom.addEvent(message);

      render(<ChatWindow roomId="!testroom:matrix.org" onLeave={vi.fn()} />);
      await waitFor(() => { expect(screen.queryByText('My reaction')).toBeInTheDocument(); });

      const reactionEv = new Ev({
        id: '$myrxn',
        type: 'm.reaction',
        content: {
          'm.relates_to': { rel_type: 'm.annotation', event_id: '$myreact', key: '❤️' },
        },
        sender: '@testuser:matrix.org',
      });

      await act(async () => {
        mockRoom.emit('Room.timeline', reactionEv, mockRoom);
      });

      await waitFor(() => {
        const badge = screen.getByTestId('reaction-badge');
        expect(badge).toHaveTextContent('❤️');
        expect(badge).toHaveTextContent('1');
      });
    });

    it('aggregates multiple reactions on the same message', async () => {
      const { MockMatrixEvent: Ev } = await import('../../__mocks__/matrix-js-sdk');
      const message = createTextMessage('Multi react', { id: '$multireact' });
      mockRoom.addEvent(message);

      render(<ChatWindow roomId="!testroom:matrix.org" onLeave={vi.fn()} />);
      await waitFor(() => { expect(screen.queryByText('Multi react')).toBeInTheDocument(); });

      const r1 = new Ev({ id: '$r1', type: 'm.reaction', content: { 'm.relates_to': { rel_type: 'm.annotation', event_id: '$multireact', key: '👍' } }, sender: '@alice:matrix.org' });
      const r2 = new Ev({ id: '$r2', type: 'm.reaction', content: { 'm.relates_to': { rel_type: 'm.annotation', event_id: '$multireact', key: '👍' } }, sender: '@bob:matrix.org' });

      await act(async () => {
        mockRoom.emit('Room.timeline', r1, mockRoom);
        mockRoom.emit('Room.timeline', r2, mockRoom);
      });

      await waitFor(() => {
        const badge = screen.getByTestId('reaction-badge');
        expect(badge).toHaveTextContent('2');
      });
    });

    it('reaction badge disappears after its event is redacted', async () => {
      const { MockMatrixEvent: Ev } = await import('../../__mocks__/matrix-js-sdk');
      const message = createTextMessage('Redact reaction', { id: '$rrmsg' });
      mockRoom.addEvent(message);

      render(<ChatWindow roomId="!testroom:matrix.org" onLeave={vi.fn()} />);
      await waitFor(() => { expect(screen.queryByText('Redact reaction')).toBeInTheDocument(); });

      const reactionEv = new Ev({ id: '$rrxn1', type: 'm.reaction', content: { 'm.relates_to': { rel_type: 'm.annotation', event_id: '$rrmsg', key: '🔥' } }, sender: '@alice:matrix.org' });
      await act(async () => { mockRoom.emit('Room.timeline', reactionEv, mockRoom); });
      await waitFor(() => { expect(screen.queryByTestId('reaction-badge')).toBeInTheDocument(); });

      const redactionEv = new Ev({ id: '$rdct1', type: 'm.room.redaction', content: {}, sender: '@alice:matrix.org' });
      Object.defineProperty(redactionEv, 'event', { get: () => ({ redacts: '$rrxn1' }), configurable: true });
      await act(async () => { mockRoom.emit('Room.timeline', redactionEv, mockRoom); });

      await waitFor(() => { expect(screen.queryByTestId('reaction-badge')).not.toBeInTheDocument(); });
    });
  });

  describe('Reply Context', () => {
    it('shows reply-context block for messages with m.in_reply_to', async () => {
      const original = createTextMessage('Original message', { id: '$orig' });
      mockRoom.addEvent(original);

      const reply = createMockEvent({
        id: '$replyev',
        content: {
          msgtype: MsgType.Text,
          body: '> Original message\n\nThis is my reply',
          'm.relates_to': { 'm.in_reply_to': { event_id: '$orig' } },
        },
        sender: '@bob:matrix.org',
      });
      mockRoom.addEvent(reply);

      render(<ChatWindow roomId="!testroom:matrix.org" onLeave={vi.fn()} />);

      await waitFor(() => {
        expect(screen.getAllByText('Original message').length).toBeGreaterThanOrEqual(1);
        expect(screen.queryByTestId('reply-context')).toBeInTheDocument();
      });
    });
  });

  describe('Edit Form', () => {
    it('applying an m.replace event updates the message body', async () => {
      const { MockMatrixEvent: Ev } = await import('../../__mocks__/matrix-js-sdk');
      const message = createTextMessage('Original body', { id: '$editbody', sender: '@testuser:matrix.org' });
      mockRoom.addEvent(message);

      render(<ChatWindow roomId="!testroom:matrix.org" onLeave={vi.fn()} />);
      await waitFor(() => { expect(screen.queryByText('Original body')).toBeInTheDocument(); });

      const editEv = new Ev({
        id: '$editev',
        type: 'm.room.message',
        content: {
          msgtype: 'm.text',
          body: '* Edited body',
          'm.new_content': { msgtype: 'm.text', body: 'Edited body' },
          'm.relates_to': { rel_type: 'm.replace', event_id: '$editbody' },
        },
        sender: '@testuser:matrix.org',
      });

      await act(async () => { mockRoom.emit('Room.timeline', editEv, mockRoom); });

      await waitFor(() => {
        expect(screen.queryByText('Original body')).not.toBeInTheDocument();
        expect(screen.queryByText('Edited body')).toBeInTheDocument();
      });
    });

    it('shows (edited) label after a message is edited', async () => {
      const { MockMatrixEvent: Ev } = await import('../../__mocks__/matrix-js-sdk');
      const message = createTextMessage('Before edit', { id: '$editlabel', sender: '@testuser:matrix.org' });
      mockRoom.addEvent(message);

      render(<ChatWindow roomId="!testroom:matrix.org" onLeave={vi.fn()} />);
      await waitFor(() => { expect(screen.queryByText('Before edit')).toBeInTheDocument(); });

      expect(screen.queryByTestId('edited-label')).not.toBeInTheDocument();

      const editEv = new Ev({
        id: '$editlabelev',
        type: 'm.room.message',
        content: {
          msgtype: 'm.text',
          body: '* After edit',
          'm.new_content': { msgtype: 'm.text', body: 'After edit' },
          'm.relates_to': { rel_type: 'm.replace', event_id: '$editlabel' },
        },
        sender: '@testuser:matrix.org',
      });

      await act(async () => { mockRoom.emit('Room.timeline', editEv, mockRoom); });

      await waitFor(() => {
        expect(screen.queryByTestId('edited-label')).toBeInTheDocument();
        expect(screen.getByTestId('edited-label')).toHaveTextContent('(edited)');
      });
    });

    it('edit events do not appear as standalone messages in the timeline', async () => {
      const { MockMatrixEvent: Ev } = await import('../../__mocks__/matrix-js-sdk');
      const message = createTextMessage('Keep one', { id: '$keepone', sender: '@testuser:matrix.org' });
      mockRoom.addEvent(message);

      render(<ChatWindow roomId="!testroom:matrix.org" onLeave={vi.fn()} />);
      await waitFor(() => { expect(screen.queryByText('Keep one')).toBeInTheDocument(); });

      const editEv = new Ev({
        id: '$phantom',
        type: 'm.room.message',
        content: {
          msgtype: 'm.text',
          body: '* Should not appear',
          'm.new_content': { msgtype: 'm.text', body: 'Should not appear' },
          'm.relates_to': { rel_type: 'm.replace', event_id: '$keepone' },
        },
        sender: '@testuser:matrix.org',
      });

      await act(async () => { mockRoom.emit('Room.timeline', editEv, mockRoom); });

      await waitFor(() => {
        const articles = screen.getAllByRole('article');
        expect(articles).toHaveLength(1);
      });
    });
  });
});