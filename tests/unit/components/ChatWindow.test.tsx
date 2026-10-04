import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ClientEvent, KnownMembership, SyncState } from 'matrix-js-sdk';

vi.mock('@/app/utils/matrix', () => ({
  getMatrixClient: vi.fn(),
}));

import ChatWindow from '@/app/app-components/ChatWindow';
import { getMatrixClient } from '@/app/utils/matrix';
import { renderChatWindow, setupRoom, stubSends } from './chat-window-harness';
import { BOB, CAROL, ME, ROOM_ID, addLive, editOf, event, localEcho, makeClient, makeRoom, reactionTo, settle, textEvent } from '../timeline/sdk-fixtures';

/* The wrapper around a message bubble, which also holds its action bar and thread count */
const messageWrapper = (text: string): HTMLElement => {
  const bubble = screen.getAllByRole('article').find((article) => article.textContent?.includes(text));
  if (!bubble) throw new Error(`No message containing "${text}"`);
  return bubble.closest('[data-message-id]') as HTMLElement;
};

const inThread = (rootId: string) => ({ 'm.relates_to': { rel_type: 'm.thread', event_id: rootId, is_falling_back: true } });

describe('ChatWindow', () => {
  describe('connecting', () => {
    it('shows Connecting… until the Matrix client is ready', () => {
      window.__matrix_ready = false;
      vi.mocked(getMatrixClient).mockImplementation(() => {
        throw new Error('Matrix client is not initialized');
      });

      render(<ChatWindow roomId={ROOM_ID} onLeave={vi.fn()} />);

      expect(screen.getByText('Connecting…')).toBeInTheDocument();
    });

    it('attaches to a room that reaches the store after the window opened', async () => {
      const client = makeClient();
      renderChatWindow(client);
      expect(await screen.findByText('Loading room…')).toBeInTheDocument();

      const room = makeRoom(client);
      await addLive(room, [textEvent('Welcome in')]);
      act(() => {
        client.emit(ClientEvent.Room, room);
      });
      expect(await screen.findByText('Welcome in')).toBeInTheDocument();
      await act(() => addLive(room, [textEvent('Arrived later')]));

      expect(await screen.findByText('Arrived later')).toBeInTheDocument();
    });
  });

  describe('reading', () => {
    it('shows the messages oldest first with their senders', async () => {
      const { client } = await setupRoom([textEvent('First from Bob'), textEvent('Then me', { sender: ME })]);

      renderChatWindow(client);

      const articles = await screen.findAllByRole('article');
      expect(articles.map((a) => a.getAttribute('aria-label'))).toEqual([`Message from ${BOB}`, `Message from ${ME}`]);
      expect(articles.map((a) => a.textContent)).toEqual([expect.stringContaining('First from Bob'), expect.stringContaining('Then me')]);
    });

    it('shows messages that arrive while the room is open', async () => {
      const { client, room } = await setupRoom([textEvent('Earlier')]);
      renderChatWindow(client);
      await screen.findByText('Earlier');

      await act(() => addLive(room, [textEvent('Live one', { sender: CAROL })]));

      expect(await screen.findByText('Live one')).toBeInTheDocument();
    });

    it('keeps thread replies out of the timeline and counts them under their root', async () => {
      const root = textEvent('Release planning');
      const { client } = await setupRoom([root, textEvent('I can take notes', { sender: CAROL }, inThread(root.getId()!))]);

      renderChatWindow(client);

      await screen.findByText('Release planning');
      expect(screen.getAllByRole('article')).toHaveLength(1);
      expect(within(messageWrapper('Release planning')).getByTestId('thread-count')).toHaveTextContent('1 reply');
    });
  });

  describe('replying', () => {
    it('hands the message being replied to over to the composer', async () => {
      const original = textEvent('Pizza tonight?');
      const { client } = await setupRoom([original]);
      renderChatWindow(client);
      await screen.findByText('Pizza tonight?');
      const dispatched = vi.spyOn(window, 'dispatchEvent');

      fireEvent.click(within(messageWrapper('Pizza tonight?')).getByTestId('action-reply'));

      const replyEvents = dispatched.mock.calls.map(([e]) => e as CustomEvent).filter((e) => e.type === 'nexus-reply-to');
      expect(replyEvents.map((e) => e.detail)).toEqual([{ eventId: original.getId(), sender: BOB, body: 'Pizza tonight?' }]);
    });
  });

  describe('reacting', () => {
    it('sends the emoji picked for a message as an annotation', async () => {
      const target = textEvent('Shipped it!');
      const { client } = await setupRoom([target]);
      const { sendEvent } = stubSends(client);
      renderChatWindow(client);
      await screen.findByText('Shipped it!');

      fireEvent.click(within(messageWrapper('Shipped it!')).getByTestId('action-react'));
      fireEvent.click(within(screen.getByTestId('reaction-picker')).getByRole('button', { name: 'React with 🎉' }));

      await waitFor(() =>
        expect(sendEvent).toHaveBeenCalledWith(ROOM_ID, 'm.reaction', {
          'm.relates_to': { rel_type: 'm.annotation', event_id: target.getId(), key: '🎉' },
        })
      );
    });

    it('opens the picker from the keyboard, reacts with Enter and hands focus back', async () => {
      const target = textEvent('React to me');
      const { client } = await setupRoom([target]);
      const { sendEvent } = stubSends(client);
      const user = userEvent.setup();
      renderChatWindow(client);
      await screen.findByText('React to me');
      const trigger = within(messageWrapper('React to me')).getByRole('button', { name: 'Add reaction' });

      trigger.focus();
      await user.keyboard('{Enter}');
      expect(within(screen.getByTestId('reaction-picker')).getByRole('button', { name: 'React with 😀' })).toHaveFocus();
      await user.keyboard('{Tab}{Enter}');

      await waitFor(() =>
        expect(sendEvent).toHaveBeenCalledWith(ROOM_ID, 'm.reaction', {
          'm.relates_to': { rel_type: 'm.annotation', event_id: target.getId(), key: '😂' },
        })
      );
      expect(screen.queryByTestId('reaction-picker')).not.toBeInTheDocument();
      expect(trigger).toHaveFocus();
    });

    it('closes the picker with Escape and hands focus back without reacting', async () => {
      const { client } = await setupRoom([textEvent('React to me')]);
      const { sendEvent } = stubSends(client);
      const user = userEvent.setup();
      renderChatWindow(client);
      await screen.findByText('React to me');
      const trigger = within(messageWrapper('React to me')).getByRole('button', { name: 'Add reaction' });

      trigger.focus();
      await user.keyboard(' ');
      expect(screen.getByTestId('reaction-picker')).toBeInTheDocument();
      await user.keyboard('{Escape}');

      expect(screen.queryByTestId('reaction-picker')).not.toBeInTheDocument();
      expect(trigger).toHaveFocus();
      expect(sendEvent).not.toHaveBeenCalled();
    });

    it('removes my reaction by redacting it when its badge is pressed', async () => {
      const target = textEvent('New logo is up');
      const mine = reactionTo(target, '👍', { sender: ME });
      const { client } = await setupRoom([target, mine]);
      const { redactEvent } = stubSends(client);
      renderChatWindow(client);

      fireEvent.click(await screen.findByRole('button', { name: '👍 reaction, 1 person, you reacted' }));

      await waitFor(() => expect(redactEvent).toHaveBeenCalledWith(ROOM_ID, mine.getId()));
    });
  });

  describe('editing', () => {
    it('offers edit only on my own text messages', async () => {
      const voiceNote = event({ sender: ME, content: { msgtype: 'm.audio', body: 'voice-note.ogg', url: 'mxc://hs.test/voice' } });
      const { client } = await setupRoom([textEvent('Bob wrote this'), textEvent('I wrote this', { sender: ME }), voiceNote]);

      renderChatWindow(client);

      await screen.findByText('I wrote this');
      expect(within(messageWrapper('Bob wrote this')).queryByTestId('action-edit')).not.toBeInTheDocument();
      expect(within(messageWrapper('I wrote this')).getByTestId('action-edit')).toBeInTheDocument();
      /* Media rows have no text to find them by in jsdom, so the row is found by the event ID it carries */
      const voiceRow = document.querySelector(`[data-message-id="${voiceNote.getId()}"]`) as HTMLElement;
      expect(within(voiceRow).getByTestId('action-reply')).toBeInTheDocument();
      expect(within(voiceRow).queryByTestId('action-edit')).not.toBeInTheDocument();
    });

    it('sends an edit as a replacement and closes the editor', async () => {
      const mine = textEvent('See you at 6', { sender: ME });
      const { client } = await setupRoom([mine]);
      const { sendEvent } = stubSends(client);
      renderChatWindow(client);
      await screen.findByText('See you at 6');

      fireEvent.click(within(messageWrapper('See you at 6')).getByTestId('action-edit'));
      fireEvent.change(screen.getByTestId('edit-input'), { target: { value: 'See you at 7' } });
      fireEvent.click(screen.getByTestId('edit-save'));

      expect(screen.queryByTestId('edit-form')).not.toBeInTheDocument();
      await waitFor(() =>
        expect(sendEvent).toHaveBeenCalledWith(ROOM_ID, 'm.room.message', {
          msgtype: 'm.text',
          body: '* See you at 7',
          'm.new_content': { msgtype: 'm.text', body: 'See you at 7' },
          'm.relates_to': { rel_type: 'm.replace', event_id: mine.getId() },
        })
      );
    });

    it('shows an edit from the author but ignores one sent by someone else', async () => {
      const mine = textEvent('I owe Bob £5', { sender: ME });
      const bobs = textEvent('Meet at the cafe');
      const { client, room } = await setupRoom([mine, bobs]);
      renderChatWindow(client);
      await screen.findByText('I owe Bob £5');

      await act(async () => {
        await addLive(room, [editOf(mine, 'I owe Bob £500', { sender: BOB }), editOf(bobs, 'Meet at the library')]);
        await settle();
      });

      expect(await screen.findByText('Meet at the library')).toBeInTheDocument();
      expect(screen.getByText('I owe Bob £5')).toBeInTheDocument();
      expect(screen.queryByText('I owe Bob £500')).not.toBeInTheDocument();
      expect(within(messageWrapper('I owe Bob £5')).queryByTestId('edited-label')).not.toBeInTheDocument();
    });
  });

  describe('deleting', () => {
    it('asks for confirmation before redacting a message', async () => {
      const mine = textEvent('Oops, wrong room', { sender: ME });
      const { client } = await setupRoom([mine]);
      const { redactEvent } = stubSends(client);
      renderChatWindow(client);
      await screen.findByText('Oops, wrong room');

      fireEvent.click(within(messageWrapper('Oops, wrong room')).getByTestId('action-delete'));
      expect(screen.getByTestId('delete-confirm')).toHaveTextContent('Delete this message?');
      expect(redactEvent).not.toHaveBeenCalled();
      fireEvent.click(screen.getByTestId('delete-confirm-yes'));

      await waitFor(() => expect(redactEvent).toHaveBeenCalledWith(ROOM_ID, mine.getId()));
    });

    it('asks for confirmation before redacting an image or a file', async () => {
      const image = event({ sender: ME, content: { msgtype: 'm.image', body: 'pixel.png', url: 'mxc://hs.test/pixel', info: { mimetype: 'image/png' } } });
      const file = event({ sender: ME, content: { msgtype: 'm.file', body: 'report.pdf', url: 'mxc://hs.test/report', info: { mimetype: 'application/pdf' } } });
      const { client } = await setupRoom([image, file]);
      const { redactEvent } = stubSends(client);
      renderChatWindow(client);
      await screen.findAllByRole('article');

      for (const target of [image, file]) {
        /* Media rows have no text to find them by in jsdom, so the row is found by the event ID it carries */
        const row = document.querySelector(`[data-message-id="${target.getId()}"]`) as HTMLElement;
        fireEvent.click(within(row).getByTestId('action-delete'));
        fireEvent.click(within(row).getByTestId('delete-confirm-yes'));
        await waitFor(() => expect(redactEvent).toHaveBeenCalledWith(ROOM_ID, target.getId()));
      }
    });

    it('lets the creator of a version 12 room delete other people’s messages', async () => {
      const { client } = await setupRoom([textEvent('Spam')], { roomVersion: '12', powerLevels: { users: { [BOB]: 50 }, users_default: 0, redact: 50 } });

      renderChatWindow(client);

      await screen.findByText('Spam');
      expect(within(messageWrapper('Spam')).getByTestId('action-delete')).toBeInTheDocument();
    });

    it('offers deleting other people’s messages only to members allowed to redact', async () => {
      const { client } = await setupRoom([textEvent('Spam')], { powerLevels: { users: { [BOB]: 100 }, users_default: 0, redact: 50 } });

      renderChatWindow(client);

      await screen.findByText('Spam');
      expect(within(messageWrapper('Spam')).getByTestId('action-reply')).toBeInTheDocument();
      expect(within(messageWrapper('Spam')).queryByTestId('action-delete')).not.toBeInTheDocument();
    });
  });

  describe('input methods', () => {
    it('ignores Enter that confirms an input-method composition in the edit and thread inputs', async () => {
      const { client } = await setupRoom([textEvent('See you at 6', { sender: ME })]);
      const { sendEvent } = stubSends(client);
      renderChatWindow(client);
      await screen.findByText('See you at 6');
      const row = messageWrapper('See you at 6');

      fireEvent.click(within(row).getByTestId('action-edit'));
      const editInput = screen.getByTestId('edit-input');
      fireEvent.change(editInput, { target: { value: '六時' } });
      fireEvent.keyDown(editInput, { key: 'Enter', isComposing: true });
      fireEvent.keyDown(editInput, { key: 'Enter', keyCode: 229 });
      fireEvent.click(within(row).getByTestId('action-thread'));
      const threadInput = screen.getByTestId('thread-input');
      fireEvent.change(threadInput, { target: { value: 'スレッド' } });
      fireEvent.keyDown(threadInput, { key: 'Enter', isComposing: true });

      expect(screen.getByTestId('edit-input')).toHaveValue('六時');
      expect(threadInput).toHaveValue('スレッド');
      expect(sendEvent).not.toHaveBeenCalled();
    });
  });

  describe('threads', () => {
    it('sends a reply into the open thread', async () => {
      const root = textEvent('Release planning');
      const { client } = await setupRoom([root]);
      const { sendEvent } = stubSends(client);
      renderChatWindow(client);
      await screen.findByText('Release planning');

      fireEvent.click(within(messageWrapper('Release planning')).getByTestId('action-thread'));
      expect(within(screen.getByTestId('thread-panel')).getAllByTestId('thread-message')).toHaveLength(1);
      fireEvent.change(screen.getByTestId('thread-input'), { target: { value: 'I can take the notes' } });
      fireEvent.click(screen.getByTestId('thread-send'));

      await waitFor(() =>
        expect(sendEvent).toHaveBeenCalledWith(ROOM_ID, 'm.room.message', {
          msgtype: 'm.text',
          body: 'I can take the notes',
          'm.relates_to': { rel_type: 'm.thread', event_id: root.getId(), is_falling_back: true },
        })
      );
    });
  });

  describe('pending messages', () => {
    it('offers no actions on a message the server has not accepted yet', async () => {
      const { client, room } = await setupRoom([textEvent('Sent earlier')]);
      renderChatWindow(client);
      await screen.findByText('Sent earlier');

      act(() => room.addPendingEvent(localEcho('Still sending', 'txn-pending'), 'txn-pending'));

      await screen.findByText('Still sending');
      expect(within(messageWrapper('Still sending')).queryByTestId('message-actions')).not.toBeInTheDocument();
      expect(within(messageWrapper('Sent earlier')).getByTestId('message-actions')).toBeInTheDocument();
    });
  });

  describe('membership', () => {
    it('closes the room when I leave it', async () => {
      const { client, room } = await setupRoom([textEvent('Bye')]);
      const { onLeave } = renderChatWindow(client);
      await screen.findByText('Bye');

      act(() => room.updateMyMembership(KnownMembership.Leave));

      await waitFor(() => expect(onLeave).toHaveBeenCalledWith(ROOM_ID));
    });

    it('closes the room when I am banned from it', async () => {
      const { client, room } = await setupRoom([textEvent('Bye')]);
      const { onLeave } = renderChatWindow(client);
      await screen.findByText('Bye');

      act(() => room.updateMyMembership(KnownMembership.Ban));

      await waitFor(() => expect(onLeave).toHaveBeenCalledWith(ROOM_ID));
    });

    it('stays open when my membership becomes an invite', async () => {
      const { client, room } = await setupRoom([textEvent('Still here')]);
      const { onLeave } = renderChatWindow(client);
      await screen.findByText('Still here');

      act(() => {
        room.updateMyMembership(KnownMembership.Invite);
        client.emit(ClientEvent.Sync, SyncState.Syncing, SyncState.Syncing);
      });

      expect(onLeave).not.toHaveBeenCalled();
    });
  });
});