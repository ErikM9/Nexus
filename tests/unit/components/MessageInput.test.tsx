import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ClientEvent, ConnectionError, KnownMembership, MatrixError, SyncState, type MatrixClient, type Room } from 'matrix-js-sdk';
import { ME, makeClient, makeRoom, setState } from '../support/matrixRoom';

const mocks = vi.hoisted(() => ({
  client: null as MatrixClient | null,
  logoutMatrixClient: vi.fn(async () => ({ serverSignedOut: true })),
}));

vi.mock('@/app/utils/matrix', () => ({
  getMatrixClient: () => {
    if (!mocks.client) throw new Error('Matrix client is not initialized');
    return mocks.client;
  },
  logoutMatrixClient: mocks.logoutMatrixClient,
}));

import MessageInput from '@/app/app-components/MessageInput';

/* Power levels that leave this member, who is not listed in them, below the level messages need */
const MODERATORS_ONLY = { users: { '@someone-else:hs.test': 100 }, events_default: 50 };

const PICTURE = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'cat.png', { type: 'image/png' });

/* jsdom decodes no pictures, so this stand-in reports a decoded 4 by 3 picture as soon as it is given a source */
class DecodedImage {
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  naturalWidth = 4;
  naturalHeight = 3;

  set src(_url: string) {
    queueMicrotask(() => this.onload?.());
  }
}

/* Replies travel from the timeline to the composer as window events, as ChatWindow sends them */
const replyTo = (detail: { eventId: string; sender: string; body: string }) =>
  act(() => {
    window.dispatchEvent(new CustomEvent('nexus-reply-to', { detail }));
  });

/* Picks a file through the hidden file input behind the Attach image button, which has no accessible name of its own */
const attach = async (file: File) => {
  await userEvent.upload(document.querySelector('input[type="file"]') as HTMLInputElement, file);
  await screen.findByText(new RegExp(`Attached: ${file.name}`));
};

describe('MessageInput', () => {
  let client: MatrixClient;
  let room: Room;
  let sendEvent: MockInstance<MatrixClient['sendEvent']>;

  const renderComposer = async () => {
    render(<MessageInput roomId={room.roomId} />);
    return screen.findByPlaceholderText('Type a message');
  };

  /* The end of a sync is when the composer reads the room's permissions again */
  const finishSync = () =>
    act(() => {
      client.emit(ClientEvent.Sync, SyncState.Syncing, SyncState.Syncing);
    });

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
    it('stops the field with a Connecting notice while the client is not ready', async () => {
      mocks.client = null;
      window.__matrix_ready = false;

      render(<MessageInput roomId={room.roomId} />);

      expect(await screen.findByPlaceholderText('Connecting…')).toBeDisabled();
    });

    it('stops the field in a room where only moderators may speak', async () => {
      await setState(room, 'm.room.power_levels', MODERATORS_ONLY);

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

    it('sends nothing when Send is pressed on an empty field', async () => {
      await renderComposer();

      await userEvent.click(screen.getByRole('button', { name: 'Send' }));

      expect(sendEvent).not.toHaveBeenCalled();
    });

    it('sends nothing for a draft of only spaces', async () => {
      const input = await renderComposer();

      await userEvent.type(input, '   {Enter}');

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

    it('puts the cursor back in the field after the Send button is used', async () => {
      const input = await renderComposer();
      await userEvent.type(input, 'Hello there');

      await userEvent.click(screen.getByRole('button', { name: 'Send' }));

      await waitFor(() => expect(input).toHaveFocus());
    });
  });

  describe('when a send fails', () => {
    it('says the message failed when the server cannot be reached', async () => {
      sendEvent.mockRejectedValueOnce(new ConnectionError('fetch failed'));
      const input = await renderComposer();

      await userEvent.type(input, 'Test message{Enter}');

      expect(await screen.findByPlaceholderText('Failed to send')).toBeEnabled();
    });

    it('goes back to its usual prompt once a later message is sent', async () => {
      sendEvent.mockRejectedValueOnce(new ConnectionError('fetch failed'));
      const input = await renderComposer();
      await userEvent.type(input, 'First try{Enter}');
      await screen.findByPlaceholderText('Failed to send');

      await userEvent.type(input, 'Second try{Enter}');

      expect(await screen.findByPlaceholderText('Type a message')).toBeInTheDocument();
    });

    it('says how long to wait, in whole seconds rounded up, when the server rate-limits the send', async () => {
      sendEvent.mockRejectedValueOnce(new MatrixError({ errcode: 'M_LIMIT_EXCEEDED', error: 'Too many requests', retry_after_ms: 4200 }, 429));
      const input = await renderComposer();

      await userEvent.type(input, 'Test message{Enter}');

      expect(await screen.findByPlaceholderText('Rate limited. Try again in 5s.')).toBeEnabled();
    });

    it('asks to wait when the server rate-limits the send without saying for how long', async () => {
      sendEvent.mockRejectedValueOnce(new MatrixError({ errcode: 'M_LIMIT_EXCEEDED', error: 'Too many requests' }, 429));
      const input = await renderComposer();

      await userEvent.type(input, 'Test message{Enter}');

      expect(await screen.findByPlaceholderText('Rate limited. Please wait.')).toBeEnabled();
    });

    it('stops the field when the server refuses messages from this user', async () => {
      sendEvent.mockRejectedValueOnce(new MatrixError({ errcode: 'M_FORBIDDEN', error: 'You are not allowed to send' }, 403));
      const input = await renderComposer();

      await userEvent.type(input, 'Test message{Enter}');

      expect(await screen.findByPlaceholderText('You cannot send messages in this room')).toBeDisabled();
    });

    it('stops the field when the server no longer knows the room', async () => {
      sendEvent.mockRejectedValueOnce(new MatrixError({ errcode: 'M_NOT_FOUND', error: 'Unknown room' }, 404));
      const input = await renderComposer();

      await userEvent.type(input, 'Test message{Enter}');

      expect(await screen.findByPlaceholderText('Room not found or you are not joined')).toBeDisabled();
    });

    it('ends the session when the server no longer accepts the access token', async () => {
      sendEvent.mockRejectedValueOnce(new MatrixError({ errcode: 'M_UNKNOWN_TOKEN', error: 'Invalid access token passed.', soft_logout: false }, 401));
      const input = await renderComposer();

      await userEvent.type(input, 'Test message{Enter}');

      expect(await screen.findByPlaceholderText('Session expired. Please sign in again.')).toBeDisabled();
      expect(mocks.logoutMatrixClient).toHaveBeenCalledTimes(1);
    });
  });

  describe('when the right to speak changes while typing', () => {
    it('empties and stops the field once a sync shows that only moderators may speak', async () => {
      const input = await renderComposer();
      await userEvent.type(input, 'Half a thought');

      await act(() => setState(room, 'm.room.power_levels', MODERATORS_ONLY));
      finishSync();

      expect(input).toHaveAttribute('placeholder', 'You cannot send messages in this room');
      expect(input).toBeDisabled();
      expect(input).toHaveValue('');
    });

    it('sends nothing when the right to speak was lost since the last sync', async () => {
      const input = await renderComposer();
      await userEvent.type(input, 'Too late');
      await act(() => setState(room, 'm.room.power_levels', MODERATORS_ONLY));

      await userEvent.keyboard('{Enter}');

      expect(sendEvent).not.toHaveBeenCalled();
      expect(input).toHaveAttribute('placeholder', 'You cannot send messages in this room');
      expect(input).toBeDisabled();
    });

    it('opens the field again once a sync shows that this member may speak', async () => {
      await setState(room, 'm.room.power_levels', MODERATORS_ONLY);
      render(<MessageInput roomId={room.roomId} />);
      const input = await screen.findByPlaceholderText('You cannot send messages in this room');

      await act(() => setState(room, 'm.room.power_levels', { users: { [ME]: 50 }, events_default: 50 }));
      finishSync();

      expect(input).toHaveAttribute('placeholder', 'Type a message');
      expect(input).toBeEnabled();
    });

    it('empties and stops the field as soon as I am removed from the room', async () => {
      const input = await renderComposer();
      await userEvent.type(input, 'Half a thought');

      act(() => room.updateMyMembership(KnownMembership.Leave));

      expect(input).toHaveAttribute('placeholder', 'You are not joined to this room');
      expect(input).toBeDisabled();
      expect(input).toHaveValue('');
    });

    it('empties the field and drops the reply when the client stops', async () => {
      const input = await renderComposer();
      await replyTo({ eventId: '$original', sender: '@alice:hs.test', body: 'Original message' });
      await userEvent.type(input, 'Half a thought');

      act(() => {
        window.__matrix_ready = false;
        window.dispatchEvent(new Event('matrix-not-ready'));
      });

      expect(input).toHaveAttribute('placeholder', 'Connecting…');
      expect(input).toBeDisabled();
      expect(input).toHaveValue('');
      expect(screen.queryByTestId('reply-banner')).not.toBeInTheDocument();
    });
  });

  describe('sending a picture', () => {
    const RealImage = window.Image;

    beforeEach(() => {
      window.Image = DecodedImage as unknown as typeof Image;
    });

    afterEach(() => {
      window.Image = RealImage;
      vi.useRealTimers();
    });

    it('keeps the picture and its caption when the upload fails', async () => {
      vi.spyOn(client, 'uploadContent').mockRejectedValue(new MatrixError({ errcode: 'M_TOO_LARGE', error: 'Upload request body is too large' }, 413));
      const input = await renderComposer();
      await attach(PICTURE);

      await userEvent.type(input, 'Our cat{Enter}');

      expect(await screen.findByPlaceholderText('Failed to send')).toBeEnabled();
      expect(input).toHaveValue('Our cat');
      expect(screen.getByText(/Attached: cat\.png/)).toBeInTheDocument();
      expect(sendEvent).not.toHaveBeenCalled();
    });

    it('uploads one picture however often Send is pressed while it is on its way', async () => {
      const uploadContent = vi.spyOn(client, 'uploadContent').mockReturnValue(new Promise(() => {}));
      await renderComposer();
      await attach(PICTURE);
      const send = screen.getByRole('button', { name: 'Send' });
      await userEvent.click(send);
      await waitFor(() => expect(uploadContent).toHaveBeenCalledTimes(1));

      await userEvent.click(send);

      expect(uploadContent).toHaveBeenCalledTimes(1);
      expect(send).toBeDisabled();
    });

    it('gives up on an upload after 30 seconds and keeps the picture for another try', async () => {
      vi.spyOn(client, 'uploadContent').mockReturnValue(new Promise(() => {}));
      const input = await renderComposer();
      await attach(PICTURE);
      vi.useFakeTimers({ shouldAdvanceTime: true });
      await userEvent.click(screen.getByRole('button', { name: 'Send' }));
      await act(() => vi.advanceTimersByTimeAsync(25_000));
      expect(input).toBeDisabled();

      await act(() => vi.advanceTimersByTimeAsync(5_000));

      expect(input).toHaveAttribute('placeholder', 'Sending timed out. Please try again.');
      expect(input).toBeEnabled();
      expect(screen.getByText(/Attached: cat\.png/)).toBeInTheDocument();
      expect(sendEvent).not.toHaveBeenCalled();
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

    it('moves the cursor into the field when a reply starts', async () => {
      const input = await renderComposer();

      await replyTo(original);

      await waitFor(() => expect(input).toHaveFocus());
    });

    it('drops the reply when Cancel reply is pressed', async () => {
      await renderComposer();
      await replyTo(original);

      await userEvent.click(screen.getByRole('button', { name: 'Cancel reply' }));

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

    it('follows an edit of the quoted message', async () => {
      await renderComposer();
      await replyTo(original);

      act(() => {
        window.dispatchEvent(new CustomEvent('nexus-reply-body-update', { detail: { eventId: '$original', body: 'Edited text' } }));
      });

      expect(screen.getByTestId('reply-banner')).toHaveTextContent('Edited text');
      expect(screen.getByTestId('reply-banner')).not.toHaveTextContent('Original message');
    });

    it('ignores an edit of a message other than the quoted one', async () => {
      await renderComposer();
      await replyTo(original);

      act(() => {
        window.dispatchEvent(new CustomEvent('nexus-reply-body-update', { detail: { eventId: '$other', body: 'Unrelated edit' } }));
      });

      expect(screen.getByTestId('reply-banner')).toHaveTextContent('Original message');
    });
  });
});