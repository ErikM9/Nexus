import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, screen, waitFor, within } from '@testing-library/react';
import { EventStatus } from 'matrix-js-sdk';

vi.mock('@/app/utils/matrix', () => ({
  getMatrixClient: vi.fn(),
}));

import { renderChatWindow, setupRoom } from './chat-window-harness';
import {
  BOB,
  CAROL,
  ME,
  addLive,
  decrypt,
  editOf,
  encryptedEvent,
  event,
  localEcho,
  reactionTo,
  redactionOf,
  settle,
  textEvent,
} from '../timeline/sdk-fixtures';

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const replyTo = (eventId: string | undefined) => ({ 'm.relates_to': { 'm.in_reply_to': { event_id: eventId } } });

const bubble = (text: string): HTMLElement => {
  const found = screen.getAllByRole('article').find((article) => article.textContent?.includes(text));
  if (!found) throw new Error(`No message containing "${text}"`);
  return found;
};

const imageEvent = (body: string, mimetype: string, mediaId: string) =>
  event({ content: { msgtype: 'm.image', body, url: `mxc://hs.test/${mediaId}`, info: { mimetype } } });

/* Answers every media download with the given bytes and content type, as the homeserver's media endpoint would. The bytes
   are cast because newer TypeScript no longer takes any Uint8Array as a response body */
const serveMedia = (bytes: Uint8Array, contentType: string) =>
  vi.mocked(fetch).mockImplementation(async () => new Response(bytes as BodyInit, { status: 200, headers: { 'content-type': contentType } }));

describe('ChatWindow message rendering', () => {
  let blobCounter = 0;
  beforeEach(() => {
    blobCounter = 0;
    vi.mocked(URL.createObjectURL).mockImplementation(() => `blob:media-${++blobCounter}`);
    vi.mocked(URL.revokeObjectURL).mockImplementation(() => undefined);
  });

  describe('text', () => {
    it('renders message text as text, never as markup', async () => {
      const { client } = await setupRoom([textEvent('<script>alert("xss")</script>')]);

      renderChatWindow(client);

      expect(await screen.findByText('<script>alert("xss")</script>')).toBeInTheDocument();
    });

    it('marks a message the author edited', async () => {
      const original = textEvent('Meet at the cafe');
      const { client } = await setupRoom([original, editOf(original, 'Meet at the library')]);
      await settle();

      renderChatWindow(client);

      expect(within(bubble('Meet at the library')).getByTestId('edited-label')).toHaveTextContent('(edited)');
    });
  });

  describe('replies', () => {
    it('quotes the message a reply points to with its sender', async () => {
      const question = textEvent('Who has the keys?');
      const { client } = await setupRoom([question, textEvent('I do', { sender: CAROL }, replyTo(question.getId()))]);

      renderChatWindow(client);

      expect(within(await screen.findByRole('article', { name: `Message from ${CAROL}` })).getByTestId('reply-context')).toHaveTextContent(
        `${BOB}Who has the keys?`
      );
    });

    it('drops the text of a deleted message from the replies quoting it and from an open reply banner', async () => {
      const secret = textEvent('My door code is 4321');
      const { client, room } = await setupRoom([secret, textEvent('Got it', { sender: CAROL }, replyTo(secret.getId()))]);
      renderChatWindow(client);
      await screen.findByText('Got it');
      const dispatched = vi.spyOn(window, 'dispatchEvent');

      await act(() => addLive(room, [redactionOf(secret)]));

      await waitFor(() => expect(within(bubble('Got it')).getByTestId('reply-context')).toHaveTextContent(`${BOB}(deleted)`));
      expect(screen.queryByText(/4321/)).not.toBeInTheDocument();
      const updates = dispatched.mock.calls.map(([e]) => e as CustomEvent).filter((e) => e.type === 'nexus-reply-body-update');
      expect(updates.map((e) => e.detail)).toContainEqual({ eventId: secret.getId(), body: '(deleted)' });
    });

    it('keeps the quote when the reply is edited', async () => {
      const question = textEvent('Pizza tonight?');
      const answer = textEvent('Count me in', { sender: ME }, replyTo(question.getId()));
      const { client, room } = await setupRoom([question, answer]);
      renderChatWindow(client);
      await screen.findByText('Count me in');

      await act(async () => {
        await addLive(room, [editOf(answer, 'Count me in, with garlic bread', { sender: ME })]);
        await settle();
      });

      await screen.findByText('Count me in, with garlic bread');
      expect(within(bubble('with garlic bread')).getByTestId('reply-context')).toHaveTextContent(`${BOB}Pizza tonight?`);
    });
  });

  describe('encrypted events', () => {
    it('shows a message that cannot be decrypted as such', async () => {
      const undecryptable = encryptedEvent();
      await decrypt(undecryptable, new Error('No room key'));
      const { client } = await setupRoom([undecryptable]);

      renderChatWindow(client);

      expect(await screen.findByText('🔒 Unable to decrypt')).toBeInTheDocument();
      expect(screen.getByRole('alert')).toHaveTextContent('Cannot decrypt');
    });

    it('turns an encrypted reaction into a reaction once it is decrypted', async () => {
      const target = textEvent('Shipped it!');
      const relation = { rel_type: 'm.annotation', event_id: target.getId(), key: '🎉' };
      const reaction = encryptedEvent({ sender: CAROL }, relation);
      const { client } = await setupRoom([target, reaction]);
      renderChatWindow(client);
      await screen.findByText('Shipped it!');
      expect(screen.getAllByRole('article')).toHaveLength(1);

      await act(() => decrypt(reaction, { type: 'm.reaction', content: { 'm.relates_to': relation } }));

      expect(await screen.findByRole('button', { name: '🎉 reaction, 1 person' })).toBeInTheDocument();
      expect(screen.getAllByRole('article')).toHaveLength(1);
      expect(screen.queryByText(/Unable to decrypt/)).not.toBeInTheDocument();
    });
  });

  describe('reactions', () => {
    it('counts reactions per emoji and drops one when it is redacted', async () => {
      const target = textEvent('New logo is up');
      const carols = reactionTo(target, '👍', { sender: CAROL });
      const { client, room } = await setupRoom([target, reactionTo(target, '👍'), carols]);
      renderChatWindow(client);
      expect(await screen.findByRole('button', { name: '👍 reaction, 2 people' })).toHaveTextContent('👍2');

      await act(() => addLive(room, [redactionOf(carols, { sender: CAROL })]));

      expect(await screen.findByRole('button', { name: '👍 reaction, 1 person' })).toBeInTheDocument();
    });
  });

  describe('dates', () => {
    it('separates days and labels today and yesterday', async () => {
      const now = Date.now();
      const { client } = await setupRoom([
        textEvent('Yesterday message', { origin_server_ts: now - 24 * 60 * 60 * 1000 }),
        textEvent('Today message', { origin_server_ts: now }),
      ]);

      renderChatWindow(client);

      await screen.findByText('Today message');
      expect(screen.getAllByRole('separator').map((s) => s.textContent)).toEqual(['Yesterday', 'Today']);
    });
  });

  describe('history', () => {
    it('marks the beginning of the conversation when there is no older history', async () => {
      const { client } = await setupRoom([textEvent('First ever message')]);

      renderChatWindow(client);

      expect(await screen.findByText('Beginning of conversation')).toBeInTheDocument();
    });

    it('keeps loading while older history remains', async () => {
      const { client } = await setupRoom([textEvent('Recent message')], { moreHistory: true });
      vi.spyOn(client, 'paginateEventTimeline').mockReturnValue(new Promise(() => {}));

      renderChatWindow(client);

      expect(await screen.findByText('Loading message history…')).toBeInTheDocument();
      expect(screen.queryByText('Beginning of conversation')).not.toBeInTheDocument();
    });
  });

  describe('send states', () => {
    it('shows a message on its way as sending only', async () => {
      const { client, room } = await setupRoom();
      renderChatWindow(client);

      act(() => room.addPendingEvent(localEcho('Slow network', 'txn-slow'), 'txn-slow'));

      expect(await screen.findByRole('status')).toHaveTextContent('⏳ Sending…');
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });

    it('shows a message the server rejected as failed only', async () => {
      const { client, room } = await setupRoom();
      renderChatWindow(client);
      const echo = localEcho('Doomed', 'txn-doomed');
      act(() => room.addPendingEvent(echo, 'txn-doomed'));
      await screen.findByText('Doomed');

      act(() => room.updatePendingEvent(echo, EventStatus.NOT_SENT));

      expect(await screen.findByRole('alert')).toHaveTextContent('⚠️ Failed');
      expect(screen.queryByText('⏳ Sending…')).not.toBeInTheDocument();
    });
  });

  describe('failed sends', () => {
    const failedEcho = async () => {
      const { client, room } = await setupRoom();
      renderChatWindow(client);
      const echo = localEcho('Doomed', 'txn-doomed');
      act(() => room.addPendingEvent(echo, 'txn-doomed'));
      act(() => room.updatePendingEvent(echo, EventStatus.NOT_SENT));
      await screen.findByRole('alert');
      return { client, room, echo };
    };

    it('sends a rejected message again from its local echo on Retry', async () => {
      const { client, room, echo } = await failedEcho();
      const resend = vi.spyOn(client, 'resendEvent').mockResolvedValue({ event_id: '$resent' });

      act(() => within(bubble('Doomed')).getByRole('button', { name: 'Retry' }).click());

      expect(resend).toHaveBeenCalledWith(echo, room);
    });

    it('drops a rejected message on Delete without redacting anything', async () => {
      const { client } = await failedEcho();
      const redact = vi.spyOn(client, 'redactEvent');

      act(() => within(bubble('Doomed')).getByRole('button', { name: 'Delete' }).click());

      await waitFor(() => expect(screen.queryByText('Doomed')).not.toBeInTheDocument());
      expect(redact).not.toHaveBeenCalled();
    });
  });

  describe('attachments', () => {
    it('shows a received image from a blob of its allow-listed type', async () => {
      serveMedia(PNG_BYTES, 'image/png');
      const { client } = await setupRoom([imageEvent('Holiday snap', 'image/png', 'holiday')]);

      renderChatWindow(client);

      expect(await screen.findByRole('button', { name: 'Click to view full size image' })).toHaveAttribute('src', 'blob:media-1');
      expect(vi.mocked(URL.createObjectURL).mock.calls.map(([blob]) => (blob as Blob).type)).toEqual(['image/png']);
    });

    it('offers an SVG image only as a download with a download-only blob', async () => {
      serveMedia(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>'), 'image/svg+xml');
      const { client } = await setupRoom([imageEvent('logo.svg', 'image/svg+xml', 'logo')]);

      renderChatWindow(client);

      expect(await screen.findByRole('link', { name: 'Download logo.svg' })).toHaveAttribute('href', 'blob:media-1');
      expect(screen.queryByRole('button', { name: 'Click to view full size image' })).not.toBeInTheDocument();
      expect(vi.mocked(URL.createObjectURL).mock.calls.map(([blob]) => (blob as Blob).type)).toEqual(['application/octet-stream']);
    });

    it('plays a received voice note from a blob of its allow-listed type and offers it as a download', async () => {
      serveMedia(new Uint8Array([0x4f, 0x67, 0x67, 0x53]), 'audio/ogg');
      const { client } = await setupRoom([event({ content: { msgtype: 'm.audio', body: 'voice-note.ogg', url: 'mxc://hs.test/voice', info: { mimetype: 'audio/ogg' } } })]);

      renderChatWindow(client);

      expect(await screen.findByLabelText('Audio: voice-note.ogg')).toHaveAttribute('src', 'blob:media-1');
      expect(screen.getByRole('link', { name: 'Download voice-note.ogg' })).toHaveAttribute('href', 'blob:media-1');
      expect(vi.mocked(URL.createObjectURL).mock.calls.map(([blob]) => (blob as Blob).type)).toEqual(['audio/ogg']);
    });

    it('shows a failed download as unavailable and does not retry it on later updates', async () => {
      vi.mocked(fetch).mockImplementation(async () => new Response('{"errcode":"M_NOT_FOUND"}', { status: 404 }));
      const { client, room } = await setupRoom([imageEvent('Gone', 'image/png', 'gone')]);
      renderChatWindow(client);
      expect(await screen.findByText('Image unavailable')).toBeInTheDocument();

      await act(() => addLive(room, [textEvent('Something new')]));
      await screen.findByText('Something new');

      expect(fetch).toHaveBeenCalledTimes(1);
    });

    it('releases every blob URL when the window closes', async () => {
      serveMedia(PNG_BYTES, 'image/png');
      const { client } = await setupRoom([imageEvent('Holiday snap', 'image/png', 'holiday')]);
      const { unmount } = renderChatWindow(client);
      await screen.findByRole('button', { name: 'Click to view full size image' });

      unmount();

      expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:media-1');
    });

    it('never releases the blob URL of an image still on screen, however many are loaded', async () => {
      serveMedia(PNG_BYTES, 'image/png');
      const images = Array.from({ length: 160 }, (_, i) => imageEvent(`Photo ${i}`, 'image/png', `photo${i}`));
      const { client } = await setupRoom(images);

      renderChatWindow(client);

      await waitFor(() => expect(screen.getAllByRole('button', { name: 'Click to view full size image' })).toHaveLength(160));
      expect(URL.revokeObjectURL).not.toHaveBeenCalled();
    });
  });
});