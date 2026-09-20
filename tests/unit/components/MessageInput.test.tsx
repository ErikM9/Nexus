import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

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

import MessageInput from '@/app/app-components/MessageInput';
import { MockMatrixClient, MockRoom } from '../../__mocks__/matrix-js-sdk';
import { getMatrixClient } from '@/app/utils/matrix';

describe('MessageInput Component', () => {
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
    mockClient.addRoom(mockRoom);

    (getMatrixClient as ReturnType<typeof vi.fn>).mockReturnValue(mockClient);

    /* Minimal crypto stubs for the attachment encryption path, unused by the send-message tests */
    global.crypto = {
      ...global.crypto,
      getRandomValues: vi.fn((array: Uint8Array) => {
        for (let i = 0; i < array.length; i++) {
          array[i] = Math.floor(Math.random() * 256);
        }
        return array;
      }),
      subtle: {
        generateKey: vi.fn(async () => ({
          type: 'secret',
          extractable: true,
        })),
        exportKey: vi.fn(async () => ({ k: 'mockKey' })),
        encrypt: vi.fn(async (_algo, _key, data) => data),
        digest: vi.fn(async () => new ArrayBuffer(32)),
      },
    } as any;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Rendering', () => {
    it('renders text input', async () => {
      render(<MessageInput roomId="!testroom:matrix.org" />);
      
      await waitFor(() => {
        expect(screen.queryByPlaceholderText(/message/i)).toBeInTheDocument();
      });
    });

    it('renders send button', async () => {
      render(<MessageInput roomId="!testroom:matrix.org" />);
      
      await waitFor(() => {
        expect(screen.queryByRole('button', { name: /send/i })).toBeInTheDocument();
      });
    });

    it('renders emoji button', async () => {
      render(<MessageInput roomId="!testroom:matrix.org" />);

      await waitFor(() => {
        expect(screen.queryByLabelText('Emoji')).toBeInTheDocument();
      });
    });

  });

  describe('Text Input', () => {
    it('allows typing in the input field', async () => {
      const user = userEvent.setup();
      render(<MessageInput roomId="!testroom:matrix.org" />);

      const input = await screen.findByPlaceholderText(/message/i);
      await user.type(input, 'Hello World');

      expect(input).toHaveValue('Hello World');
    });

    it('clears input after sending', async () => {
      const user = userEvent.setup();
      render(<MessageInput roomId="!testroom:matrix.org" />);

      const input = await screen.findByPlaceholderText(/message/i);
      await user.type(input, 'Test message');
      
      const sendButton = screen.getByRole('button', { name: /send/i });
      await user.click(sendButton);

      await waitFor(() => {
        expect(input).toHaveValue('');
      });
    });

    it('does not send empty messages', async () => {
      const user = userEvent.setup();
      render(<MessageInput roomId="!testroom:matrix.org" />);

      const sendButton = await screen.findByRole('button', { name: /send/i });
      await user.click(sendButton);

      expect(mockClient.sendEvent).not.toHaveBeenCalled();
    });

    it('does not send whitespace-only messages', async () => {
      const user = userEvent.setup();
      render(<MessageInput roomId="!testroom:matrix.org" />);

      const input = await screen.findByPlaceholderText(/message/i);
      await user.type(input, '   ');
      
      const sendButton = screen.getByRole('button', { name: /send/i });
      await user.click(sendButton);

      expect(mockClient.sendEvent).not.toHaveBeenCalled();
    });
  });

  describe('Send Message', () => {
    it('sends text message on button click', async () => {
      const user = userEvent.setup();
      render(<MessageInput roomId="!testroom:matrix.org" />);

      const input = await screen.findByPlaceholderText(/message/i);
      await user.type(input, 'Hello World');
      
      const sendButton = screen.getByRole('button', { name: /send/i });
      await user.click(sendButton);

      await waitFor(() => {
        expect(mockClient.sendEvent).toHaveBeenCalledWith(
          '!testroom:matrix.org',
          'm.room.message',
          expect.objectContaining({
            msgtype: 'm.text',
            body: 'Hello World',
          })
        );
      });
    });

    it('sends message on Enter key', async () => {
      const user = userEvent.setup();
      render(<MessageInput roomId="!testroom:matrix.org" />);

      const input = await screen.findByPlaceholderText(/message/i);
      await user.type(input, 'Enter test{Enter}');

      await waitFor(() => {
        expect(mockClient.sendEvent).toHaveBeenCalled();
      });
    });
  });

  describe('Error Handling', () => {
    it('shows failure message on send error', async () => {
      mockClient.sendEvent.mockRejectedValueOnce(new Error('Network error'));
      
      const user = userEvent.setup();
      render(<MessageInput roomId="!testroom:matrix.org" />);

      const input = await screen.findByPlaceholderText(/message/i);
      await user.type(input, 'Test message');
      
      const sendButton = screen.getByRole('button', { name: /send/i });
      await user.click(sendButton);

      await waitFor(() => {
        expect(screen.queryByPlaceholderText(/failed to send/i)).toBeInTheDocument();
      }, { timeout: 15000 });
    });

    it('handles rate limit errors', async () => {
      const rateLimitError = new Error('Rate limited');
      (rateLimitError as any).errcode = 'M_LIMIT_EXCEEDED';
      (rateLimitError as any).data = { retry_after_ms: 5000 };
      mockClient.sendEvent.mockRejectedValueOnce(rateLimitError);
      
      const user = userEvent.setup();
      render(<MessageInput roomId="!testroom:matrix.org" />);

      const input = await screen.findByPlaceholderText(/message/i);
      await user.type(input, 'Test message');
      
      const sendButton = screen.getByRole('button', { name: /send/i });
      await user.click(sendButton);

      await waitFor(() => {
        expect(screen.queryByPlaceholderText(/rate limited/i)).toBeInTheDocument();
      }, { timeout: 15000 });
    });

    it('handles forbidden errors', async () => {
      const forbiddenError = new Error('Forbidden');
      (forbiddenError as any).errcode = 'M_FORBIDDEN';
      mockClient.sendEvent.mockRejectedValueOnce(forbiddenError);
      
      const user = userEvent.setup();
      render(<MessageInput roomId="!testroom:matrix.org" />);

      const input = await screen.findByPlaceholderText(/message/i);
      await user.type(input, 'Test message');
      
      const sendButton = screen.getByRole('button', { name: /send/i });
      await user.click(sendButton);

      await waitFor(() => {
        expect(screen.queryByPlaceholderText(/cannot send messages/i)).toBeInTheDocument();
      }, { timeout: 15000 });
    });
  });

  describe('Keyboard Navigation', () => {
    it('input can receive focus', async () => {
      render(<MessageInput roomId="!testroom:matrix.org" />);

      const input = await screen.findByPlaceholderText(/message/i);

      input.focus();

      expect(input).toHaveFocus();
    });
  });

  describe('Loading State', () => {
    it('shows connecting state when client not ready', async () => {
      window.__matrix_ready = false;
      (getMatrixClient as ReturnType<typeof vi.fn>).mockImplementation(() => {
        throw new Error('Not ready');
      });

      render(<MessageInput roomId="!testroom:matrix.org" />);

      await waitFor(() => {
        const input = screen.queryByPlaceholderText(/message/i);
        expect(input).toBeNull();
      });
    });
  });
  describe('Reply Wiring', () => {
    /* Simulate a reply event dispatched to the input */
    it('shows reply banner when nexus-reply-to event fires', async () => {
      render(<MessageInput roomId="!testroom:matrix.org" />);
      await screen.findByPlaceholderText(/message/i);

      fireEvent(
        window,
        new CustomEvent('nexus-reply-to', {
          detail: { eventId: '$replyev', sender: '@alice:matrix.org', body: 'Hello World' },
        })
      );

      await waitFor(() => {
        expect(screen.queryByTestId('reply-banner')).toBeInTheDocument();
        expect(screen.getByTestId('reply-banner')).toHaveTextContent('@alice:matrix.org');
        expect(screen.getByTestId('reply-banner')).toHaveTextContent('Hello World');
      });
    });

    it('clicking Cancel reply clears the reply banner', async () => {
      render(<MessageInput roomId="!testroom:matrix.org" />);
      await screen.findByPlaceholderText(/message/i);

      fireEvent(
        window,
        new CustomEvent('nexus-reply-to', {
          detail: { eventId: '$rev', sender: '@alice:matrix.org', body: 'Original' },
        })
      );

      await waitFor(() => { expect(screen.queryByTestId('reply-banner')).toBeInTheDocument(); });

      fireEvent.click(screen.getByTestId('reply-cancel'));

      await waitFor(() => { expect(screen.queryByTestId('reply-banner')).not.toBeInTheDocument(); });
    });

    it('sends message with m.in_reply_to when reply is set', async () => {
      const user = userEvent.setup();
      render(<MessageInput roomId="!testroom:matrix.org" />);
      const input = await screen.findByPlaceholderText(/message/i);

      fireEvent(
        window,
        new CustomEvent('nexus-reply-to', {
          detail: { eventId: '$origev', sender: '@alice:matrix.org', body: 'Original message' },
        })
      );

      await waitFor(() => { expect(screen.queryByTestId('reply-banner')).toBeInTheDocument(); });

      await user.type(input, 'My reply');
      await user.click(screen.getByRole('button', { name: /send/i }));

      await waitFor(() => {
        expect(mockClient.sendEvent).toHaveBeenCalledWith(
          '!testroom:matrix.org',
          'm.room.message',
          expect.objectContaining({
            msgtype: 'm.text',
            body: 'My reply',
            'm.relates_to': { 'm.in_reply_to': { event_id: '$origev' } },
          })
        );
      });
    });

    it('clears reply banner after successfully sending', async () => {
      const user = userEvent.setup();
      render(<MessageInput roomId="!testroom:matrix.org" />);
      const input = await screen.findByPlaceholderText(/message/i);

      fireEvent(
        window,
        new CustomEvent('nexus-reply-to', {
          detail: { eventId: '$clrtest', sender: '@alice:matrix.org', body: 'Clear after send' },
        })
      );

      await waitFor(() => { expect(screen.queryByTestId('reply-banner')).toBeInTheDocument(); });

      await user.type(input, 'Replying');
      await user.click(screen.getByRole('button', { name: /send/i }));

      await waitFor(() => { expect(screen.queryByTestId('reply-banner')).not.toBeInTheDocument(); });
    });

    it('sends plain message without m.in_reply_to when no reply is set', async () => {
      const user = userEvent.setup();
      render(<MessageInput roomId="!testroom:matrix.org" />);
      const input = await screen.findByPlaceholderText(/message/i);

      await user.type(input, 'Plain message');
      await user.click(screen.getByRole('button', { name: /send/i }));

      await waitFor(() => {
        expect(mockClient.sendEvent).toHaveBeenCalledWith(
          '!testroom:matrix.org',
          'm.room.message',
          expect.not.objectContaining({ 'm.relates_to': expect.anything() })
        );
      });
    });

    /* Simulate an edit event after the quoted message is edited */
    it('reply banner body updates in real time when the quoted message is edited', async () => {
      render(<MessageInput roomId="!testroom:matrix.org" />);
      await screen.findByPlaceholderText(/message/i);

      fireEvent(window, new CustomEvent('nexus-reply-to', {
        detail: { eventId: '$editme', sender: '@alice:matrix.org', body: 'Original text' },
      }));
      await waitFor(() => {
        expect(screen.getByTestId('reply-banner')).toHaveTextContent('Original text');
      });

      fireEvent(window, new CustomEvent('nexus-reply-body-update', {
        detail: { eventId: '$editme', body: 'Edited text' },
      }));

      await waitFor(() => {
        expect(screen.getByTestId('reply-banner')).toHaveTextContent('Edited text');
        expect(screen.getByTestId('reply-banner')).not.toHaveTextContent('Original text');
      });
    });

    /* Updates for unrelated events must not overwrite the displayed body */
    it('nexus-reply-body-update does not affect banner for a different eventId', async () => {
      render(<MessageInput roomId="!testroom:matrix.org" />);
      await screen.findByPlaceholderText(/message/i);

      fireEvent(window, new CustomEvent('nexus-reply-to', {
        detail: { eventId: '$mine', sender: '@alice:matrix.org', body: 'My reply target' },
      }));
      await waitFor(() => {
        expect(screen.getByTestId('reply-banner')).toHaveTextContent('My reply target');
      });

      fireEvent(window, new CustomEvent('nexus-reply-body-update', {
        detail: { eventId: '$other', body: 'Should not appear' },
      }));

      expect(screen.getByTestId('reply-banner')).toHaveTextContent('My reply target');
      expect(screen.getByTestId('reply-banner')).not.toHaveTextContent('Should not appear');
    });
  });
});