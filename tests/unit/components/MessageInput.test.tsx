import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ConnectionError, MatrixError, type MatrixClient, type Room } from 'matrix-js-sdk';
import { makeClient, makeRoom, setState } from '../support/matrixRoom';

const mocks = vi.hoisted(() => ({ client: null as MatrixClient | null }));

vi.mock('@/app/utils/matrix', () => ({
  getMatrixClient: () => {
    if (!mocks.client) throw new Error('Matrix client is not initialized');
    return mocks.client;
  },
}));

import MessageInput from '@/app/app-components/MessageInput';

/* Replies travel from the timeline to the composer as window events, as ChatWindow sends them */
const replyTo = (detail: { eventId: string; sender: string; body: string }) =>
  act(() => {
    window.dispatchEvent(new CustomEvent('nexus-reply-to', { detail }));
  });

describe('MessageInput', () => {
  let client: MatrixClient;
  let room: Room;
  let sendEvent: MockInstance<MatrixClient['sendEvent']>;

  const renderComposer = async () => {
    render(<MessageInput roomId={room.roomId} />);
    return screen.findByPlaceholderText('Type a message');
  };

  beforeEach(async () => {
    client = makeClient();
    room = await makeRoom(client, { name: 'General' });
    mocks.client = client;
    window.__matrix_ready = true;
    sendEvent = vi.spyOn(client, 'sendEvent').mockResolvedValue({ event_id: '$sent' });
  });

  afterEach(() => {
    mocks.client = null;
    window.__matrix_ready = undefined;
    vi.restoreAllMocks();
  });

  describe('composing', () => {
    it('offers a message field, a Send button and an emoji picker once the room is ready', async () => {
      await renderComposer();

      expect(screen.getByRole('button', { name: 'Send' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Emoji' })).toBeInTheDocument();
    });

    it('shows no message field while the client is still connecting', async () => {
      mocks.client = null;
      window.__matrix_ready = false;

      render(<MessageInput roomId={room.roomId} />);

      expect(await screen.findByPlaceholderText('Connecting…')).toBeDisabled();
      expect(screen.queryByPlaceholderText('Type a message')).not.toBeInTheDocument();
    });

    it('stops the field in a room where only moderators may speak', async () => {
      await setState(room, 'm.room.power_levels', { users: { '@someone-else:hs.test': 100 }, events_default: 50 });

      render(<MessageInput roomId={room.roomId} />);

      expect(await screen.findByPlaceholderText('You cannot send messages in this room')).toBeDisabled();
    });
  });

  describe('sending', () => {
    it('sends the trimmed text with the Send button and clears the field', async () => {
      const input = await renderComposer();

      await userEvent.type(input, '  Hello there  ');
      await userEvent.click(screen.getByRole('button', { name: 'Send' }));

      expect(sendEvent).toHaveBeenCalledWith(room.roomId, 'm.room.message', { msgtype: 'm.text', body: 'Hello there' });
      expect(input).toHaveValue('');
    });

    it('sends with Enter', async () => {
      const input = await renderComposer();

      await userEvent.type(input, 'Enter test{Enter}');

      expect(sendEvent).toHaveBeenCalledWith(room.roomId, 'm.room.message', { msgtype: 'm.text', body: 'Enter test' });
    });

    it.each([
      ['an empty field', ''],
      ['only spaces', '   '],
    ])('sends nothing for %s', async (_case, text) => {
      const input = await renderComposer();

      if (text) await userEvent.type(input, text);
      await userEvent.click(screen.getByRole('button', { name: 'Send' }));

      expect(sendEvent).not.toHaveBeenCalled();
    });

    it('leaves Enter that confirms an input-method composition to the composition', async () => {
      const input = await renderComposer();
      fireEvent.change(input, { target: { value: 'にほんご' } });

      fireEvent.keyDown(input, { key: 'Enter', isComposing: true });
      fireEvent.keyDown(input, { key: 'Enter', keyCode: 229 });

      expect(sendEvent).not.toHaveBeenCalled();
      expect(input).toHaveValue('にほんご');
    });

    it('clears the draft as soon as the message is handed to the timeline, before the server answers', async () => {
      sendEvent.mockReturnValueOnce(new Promise(() => {}));
      const input = await renderComposer();

      await userEvent.type(input, 'Slow network{Enter}');

      expect(sendEvent).toHaveBeenCalledWith(room.roomId, 'm.room.message', { msgtype: 'm.text', body: 'Slow network' });
      expect(input).toHaveValue('');
      expect(input).toBeEnabled();
    });
  });

  describe('when a send fails', () => {
    it('says the message failed when the server cannot be reached', async () => {
      sendEvent.mockRejectedValueOnce(new ConnectionError('fetch failed'));
      const input = await renderComposer();

      await userEvent.type(input, 'Test message{Enter}');

      expect(await screen.findByPlaceholderText('Failed to send')).toBeInTheDocument();
    });

    it('says how long to wait when the server rate-limits the send', async () => {
      sendEvent.mockRejectedValueOnce(new MatrixError({ errcode: 'M_LIMIT_EXCEEDED', error: 'Too many requests', retry_after_ms: 5000 }, 429));
      const input = await renderComposer();

      await userEvent.type(input, 'Test message{Enter}');

      expect(await screen.findByPlaceholderText('Rate limited. Try again in 5s.')).toBeInTheDocument();
    });

    it('stops the field when the server refuses messages from this user', async () => {
      sendEvent.mockRejectedValueOnce(new MatrixError({ errcode: 'M_FORBIDDEN', error: 'You are not allowed to send' }, 403));
      const input = await renderComposer();

      await userEvent.type(input, 'Test message{Enter}');

      expect(await screen.findByPlaceholderText('You cannot send messages in this room')).toBeDisabled();
    });
  });

  describe('replying', () => {
    const original = { eventId: '$original', sender: '@alice:hs.test', body: 'Original message' };

    it('shows the message being replied to in a banner', async () => {
      await renderComposer();

      await replyTo(original);

      const banner = screen.getByTestId('reply-banner');
      expect(banner).toHaveTextContent('@alice:hs.test');
      expect(banner).toHaveTextContent('Original message');
    });

    it('drops the reply when Cancel reply is pressed', async () => {
      await renderComposer();
      await replyTo(original);

      await userEvent.click(screen.getByTestId('reply-cancel'));

      expect(screen.queryByTestId('reply-banner')).not.toBeInTheDocument();
    });

    it('sends the reply with a reference to the original and clears the banner', async () => {
      const input = await renderComposer();
      await replyTo(original);

      await userEvent.type(input, 'My reply{Enter}');

      expect(sendEvent).toHaveBeenCalledWith(room.roomId, 'm.room.message', {
        msgtype: 'm.text',
        body: 'My reply',
        'm.relates_to': { 'm.in_reply_to': { event_id: '$original' } },
      });
      expect(screen.queryByTestId('reply-banner')).not.toBeInTheDocument();
    });

    it('follows edits of the quoted message and ignores edits of other messages', async () => {
      await renderComposer();
      await replyTo(original);

      act(() => {
        window.dispatchEvent(new CustomEvent('nexus-reply-body-update', { detail: { eventId: '$other', body: 'Unrelated edit' } }));
        window.dispatchEvent(new CustomEvent('nexus-reply-body-update', { detail: { eventId: '$original', body: 'Edited text' } }));
      });

      const banner = screen.getByTestId('reply-banner');
      expect(banner).toHaveTextContent('Edited text');
      expect(banner).not.toHaveTextContent('Unrelated edit');
      expect(banner).not.toHaveTextContent('Original message');
    });
  });
});