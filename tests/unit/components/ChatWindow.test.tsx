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
import { captureWindowEvents, renderChatWindow, rowOf, setupRoom, stubSends } from './chat-window-harness';
import { BOB, CAROL, ME, ROOM_ID, addLive, editOf, event, localEcho, makeClient, makeRoom, reactionTo, settle, textEvent } from '../timeline/sdk-fixtures';

/* The row of the message containing the text, which also holds its action bar and thread count */
const messageWrapper = (text: string): HTMLElement => {
  const bubble = screen.getAllByRole('article').find((article) => article.textContent?.includes(text));
  if (!bubble) throw new Error(`No message containing "${text}"`);
  return rowOf(bubble);
};

const inThread = (rootId: string) => ({ 'm.relates_to': { rel_type: 'm.thread', event_id: rootId, is_falling_back: true } });

const pickerGroup = () => screen.getByRole('group', { name: 'Pick a reaction' });

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
      expect(within(messageWrapper('Release planning')).getByRole('button', { name: '1 reply' })).toBeInTheDocument();
    });
  });

  describe('replying', () => {
    it('hands the message being replied to over to the composer', async () => {
      const original = textEvent('Pizza tonight?');
      const { client } = await setupRoom([original]);
      renderChatWindow(client);
      await screen.findByText('Pizza tonight?');
      const replies = captureWindowEvents('nexus-reply-to');

      await userEvent.click(within(messageWrapper('Pizza tonight?')).getByRole('button', { name: 'Reply' }));

      expect(replies).toEqual([{ eventId: original.getId(), sender: BOB, body: 'Pizza tonight?' }]);
    });
  });

  describe('reacting', () => {
    it('sends the emoji picked for a message as an annotation', async () => {
      const target = textEvent('Shipped it!');
      const { client } = await setupRoom([target]);
      const { sendEvent } = stubSends(client);
      renderChatWindow(client);
      await screen.findByText('Shipped it!');

      await userEvent.click(within(messageWrapper('Shipped it!')).getByRole('button', { name: 'Add reaction' }));
      await userEvent.click(within(pickerGroup()).getByRole('button', { name: 'React with 🎉' }));

      expect(sendEvent).toHaveBeenCalledWith(ROOM_ID, 'm.reaction', {
        'm.relates_to': { rel_type: 'm.annotation', event_id: target.getId(), key: '🎉' },
      });
    });

    it('keeps focus off the hidden action bar after a reaction is picked with the mouse', async () => {
      const { client } = await setupRoom([textEvent('Shipped it!')]);
      stubSends(client);
      renderChatWindow(client);
      await screen.findByText('Shipped it!');
      const trigger = within(messageWrapper('Shipped it!')).getByRole('button', { name: 'Add reaction' });
      await userEvent.click(trigger);

      await userEvent.click(within(pickerGroup()).getByRole('button', { name: 'React with 🎉' }));

      expect(trigger).not.toHaveFocus();
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
      expect(within(pickerGroup()).getByRole('button', { name: 'React with 😀' })).toHaveFocus();
      await user.keyboard('{Tab}{Enter}');

      await waitFor(() =>
        expect(sendEvent).toHaveBeenCalledWith(ROOM_ID, 'm.reaction', {
          'm.relates_to': { rel_type: 'm.annotation', event_id: target.getId(), key: '😂' },
        })
      );
      expect(screen.queryByRole('group', { name: 'Pick a reaction' })).not.toBeInTheDocument();
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
      expect(pickerGroup()).toBeInTheDocument();
      await user.keyboard('{Escape}');

      expect(screen.queryByRole('group', { name: 'Pick a reaction' })).not.toBeInTheDocument();
      expect(trigger).toHaveFocus();
      expect(sendEvent).not.toHaveBeenCalled();
    });

    it('closes the picker when the user presses anywhere else', async () => {
      const { client } = await setupRoom([textEvent('React to me')]);
      renderChatWindow(client);
      await screen.findByText('React to me');
      await userEvent.click(within(messageWrapper('React to me')).getByRole('button', { name: 'Add reaction' }));

      await userEvent.click(screen.getByRole('log', { name: 'Chat messages' }));

      expect(screen.queryByRole('group', { name: 'Pick a reaction' })).not.toBeInTheDocument();
    });

    it('removes my reaction by redacting it when its badge is pressed', async () => {
      const target = textEvent('New logo is up');
      const mine = reactionTo(target, '👍', { sender: ME });
      const { client } = await setupRoom([target, mine]);
      const { redactEvent } = stubSends(client);
      renderChatWindow(client);

      await userEvent.click(await screen.findByRole('button', { name: '👍 reaction, 1 person, you reacted' }));

      expect(redactEvent).toHaveBeenCalledWith(ROOM_ID, mine.getId());
    });
  });

  describe('editing', () => {
    it('offers Edit on my own text messages only', async () => {
      const { client } = await setupRoom([textEvent('Bob wrote this'), textEvent('I wrote this', { sender: ME })]);

      renderChatWindow(client);

      await screen.findByText('I wrote this');
      expect(within(messageWrapper('Bob wrote this')).queryByRole('button', { name: 'Edit message' })).not.toBeInTheDocument();
      expect(within(messageWrapper('I wrote this')).getByRole('button', { name: 'Edit message' })).toBeInTheDocument();
    });

    it('offers no Edit on my own voice note', async () => {
      const { client } = await setupRoom([event({ sender: ME, content: { msgtype: 'm.audio', body: 'voice-note.ogg', url: 'mxc://hs.test/voice' } })]);

      renderChatWindow(client);

      const row = rowOf(await screen.findByRole('article'));
      expect(within(row).getByRole('button', { name: 'Reply' })).toBeInTheDocument();
      expect(within(row).queryByRole('button', { name: 'Edit message' })).not.toBeInTheDocument();
    });

    it('sends an edit as a replacement and closes the editor', async () => {
      const mine = textEvent('See you at 6', { sender: ME });
      const { client } = await setupRoom([mine]);
      const { sendEvent } = stubSends(client);
      renderChatWindow(client);
      await screen.findByText('See you at 6');
      await userEvent.click(within(messageWrapper('See you at 6')).getByRole('button', { name: 'Edit message' }));

      await userEvent.clear(screen.getByRole('textbox'));
      await userEvent.type(screen.getByRole('textbox'), 'See you at 7');
      await userEvent.click(screen.getByRole('button', { name: 'Save' }));

      expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
      expect(sendEvent).toHaveBeenCalledWith(ROOM_ID, 'm.room.message', {
        msgtype: 'm.text',
        body: '* See you at 7',
        'm.new_content': { msgtype: 'm.text', body: 'See you at 7' },
        'm.relates_to': { rel_type: 'm.replace', event_id: mine.getId() },
      });
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
      expect(within(messageWrapper('I owe Bob £5')).queryByText('(edited)')).not.toBeInTheDocument();
    });
  });

  describe('deleting', () => {
    it('asks for confirmation before redacting a message', async () => {
      const mine = textEvent('Oops, wrong room', { sender: ME });
      const { client } = await setupRoom([mine]);
      const { redactEvent } = stubSends(client);
      renderChatWindow(client);
      await screen.findByText('Oops, wrong room');
      const row = messageWrapper('Oops, wrong room');

      await userEvent.click(within(row).getByRole('button', { name: 'Delete message' }));
      expect(within(row).getByText('Delete this message?')).toBeInTheDocument();
      expect(redactEvent).not.toHaveBeenCalled();
      await userEvent.click(within(row).getByRole('button', { name: 'Delete' }));

      expect(redactEvent).toHaveBeenCalledWith(ROOM_ID, mine.getId());
    });

    it.each([
      ['an image', { msgtype: 'm.image', body: 'pixel.png', url: 'mxc://hs.test/pixel', info: { mimetype: 'image/png' } }],
      ['a file', { msgtype: 'm.file', body: 'report.pdf', url: 'mxc://hs.test/report', info: { mimetype: 'application/pdf' } }],
    ])('asks for confirmation before redacting %s', async (_kind, content) => {
      const attachment = event({ sender: ME, content });
      const { client } = await setupRoom([attachment]);
      const { redactEvent } = stubSends(client);
      renderChatWindow(client);
      const row = rowOf(await screen.findByRole('article'));

      await userEvent.click(within(row).getByRole('button', { name: 'Delete message' }));
      await userEvent.click(within(row).getByRole('button', { name: 'Delete' }));

      expect(redactEvent).toHaveBeenCalledWith(ROOM_ID, attachment.getId());
    });

    it("lets the creator of a version 12 room delete other people's messages", async () => {
      const { client } = await setupRoom([textEvent('Spam')], { roomVersion: '12', powerLevels: { users: { [BOB]: 50 }, users_default: 0, redact: 50 } });

      renderChatWindow(client);

      await screen.findByText('Spam');
      expect(within(messageWrapper('Spam')).getByRole('button', { name: 'Delete message' })).toBeInTheDocument();
    });

    it("offers deleting other people's messages only to members allowed to redact", async () => {
      const { client } = await setupRoom([textEvent('Spam')], { powerLevels: { users: { [BOB]: 100 }, users_default: 0, redact: 50 } });

      renderChatWindow(client);

      await screen.findByText('Spam');
      expect(within(messageWrapper('Spam')).getByRole('button', { name: 'Reply' })).toBeInTheDocument();
      expect(within(messageWrapper('Spam')).queryByRole('button', { name: 'Delete message' })).not.toBeInTheDocument();
    });
  });

  describe('input methods', () => {
    it('leaves Enter that confirms a composition in the edit field to the composition', async () => {
      const { client } = await setupRoom([textEvent('See you at 6', { sender: ME })]);
      const { sendEvent } = stubSends(client);
      renderChatWindow(client);
      await screen.findByText('See you at 6');
      await userEvent.click(within(messageWrapper('See you at 6')).getByRole('button', { name: 'Edit message' }));
      const editor = screen.getByRole('textbox');
      await userEvent.clear(editor);
      await userEvent.type(editor, '六時');

      fireEvent.keyDown(editor, { key: 'Enter', isComposing: true });
      fireEvent.keyDown(editor, { key: 'Enter', keyCode: 229 });

      expect(editor).toHaveValue('六時');
      expect(sendEvent).not.toHaveBeenCalled();
    });

    it('leaves Enter that confirms a composition in the thread reply field to the composition', async () => {
      const { client } = await setupRoom([textEvent('Release planning')]);
      const { sendEvent } = stubSends(client);
      renderChatWindow(client);
      await screen.findByText('Release planning');
      await userEvent.click(within(messageWrapper('Release planning')).getByRole('button', { name: 'Reply in thread' }));
      const replyField = screen.getByPlaceholderText('Reply in thread…');
      await userEvent.type(replyField, 'スレッド');

      fireEvent.keyDown(replyField, { key: 'Enter', isComposing: true });
      fireEvent.keyDown(replyField, { key: 'Enter', keyCode: 229 });

      expect(replyField).toHaveValue('スレッド');
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
      await userEvent.click(within(messageWrapper('Release planning')).getByRole('button', { name: 'Reply in thread' }));

      await userEvent.type(screen.getByPlaceholderText('Reply in thread…'), 'I can take the notes');
      await userEvent.click(screen.getByRole('button', { name: 'Send' }));

      expect(sendEvent).toHaveBeenCalledWith(ROOM_ID, 'm.room.message', {
        msgtype: 'm.text',
        body: 'I can take the notes',
        'm.relates_to': { rel_type: 'm.thread', event_id: root.getId(), is_falling_back: true },
      });
    });

    it('answers a message inside the open thread with a reference to it', async () => {
      const root = textEvent('Release planning');
      const reply = textEvent('I can take notes', { sender: CAROL }, inThread(root.getId()!));
      const { client } = await setupRoom([root, reply]);
      const { sendEvent } = stubSends(client);
      renderChatWindow(client);
      await userEvent.click(await screen.findByRole('button', { name: '1 reply' }));
      const carolsReply = screen.getByRole('article', { name: `Thread message from ${CAROL}` });

      await userEvent.click(within(carolsReply).getByRole('button', { name: 'Reply' }));
      await userEvent.type(screen.getByPlaceholderText('Reply in thread…'), 'Thanks{Enter}');

      expect(sendEvent).toHaveBeenCalledWith(ROOM_ID, 'm.room.message', {
        msgtype: 'm.text',
        body: 'Thanks',
        'm.relates_to': { rel_type: 'm.thread', event_id: root.getId(), is_falling_back: false, 'm.in_reply_to': { event_id: reply.getId() } },
      });
    });
    it('edits my reply inside the open thread', async () => {
      const root = textEvent('Release planning');
      const mine = textEvent('I can take notes', { sender: ME }, inThread(root.getId()!));
      const { client } = await setupRoom([root, mine]);
      const { sendEvent } = stubSends(client);
      renderChatWindow(client);
      await userEvent.click(await screen.findByRole('button', { name: '1 reply' }));
      const myReply = screen.getByRole('article', { name: `Thread message from ${ME}` });
      await userEvent.click(within(myReply).getByRole('button', { name: 'Edit message' }));

      await userEvent.clear(within(myReply).getByRole('textbox'));
      await userEvent.type(within(myReply).getByRole('textbox'), 'I can take the minutes{Enter}');

      expect(sendEvent).toHaveBeenCalledWith(ROOM_ID, 'm.room.message', {
        msgtype: 'm.text',
        body: '* I can take the minutes',
        'm.new_content': { msgtype: 'm.text', body: 'I can take the minutes' },
        'm.relates_to': { rel_type: 'm.replace', event_id: mine.getId() },
      });
    });

    it('deletes my reply inside the open thread after asking first', async () => {
      const root = textEvent('Release planning');
      const mine = textEvent('Wrong thread, sorry', { sender: ME }, inThread(root.getId()!));
      const { client } = await setupRoom([root, mine]);
      const { redactEvent } = stubSends(client);
      renderChatWindow(client);
      await userEvent.click(await screen.findByRole('button', { name: '1 reply' }));
      const myReply = screen.getByRole('article', { name: `Thread message from ${ME}` });

      await userEvent.click(within(myReply).getByRole('button', { name: 'Delete message' }));
      expect(within(myReply).getByText('Delete this message?')).toBeInTheDocument();
      expect(redactEvent).not.toHaveBeenCalled();
      await userEvent.click(within(myReply).getByRole('button', { name: 'Delete' }));

      expect(redactEvent).toHaveBeenCalledWith(ROOM_ID, mine.getId());
    });

    it('reacts to a message inside the open thread', async () => {
      const root = textEvent('Release planning');
      const reply = textEvent('I can take notes', { sender: CAROL }, inThread(root.getId()!));
      const { client } = await setupRoom([root, reply]);
      const { sendEvent } = stubSends(client);
      renderChatWindow(client);
      await userEvent.click(await screen.findByRole('button', { name: '1 reply' }));
      const carolsReply = screen.getByRole('article', { name: `Thread message from ${CAROL}` });

      await userEvent.click(within(carolsReply).getByRole('button', { name: 'Add reaction' }));
      await userEvent.click(within(pickerGroup()).getByRole('button', { name: 'React with 👍' }));

      expect(sendEvent).toHaveBeenCalledWith(ROOM_ID, 'm.reaction', {
        'm.relates_to': { rel_type: 'm.annotation', event_id: reply.getId(), key: '👍' },
      });
    });
  });

  describe('pending messages', () => {
    it('offers no actions on a message the server has not accepted yet', async () => {
      const { client, room } = await setupRoom([textEvent('Sent earlier')]);
      renderChatWindow(client);
      await screen.findByText('Sent earlier');

      act(() => room.addPendingEvent(localEcho('Still sending', 'txn-pending'), 'txn-pending'));

      await screen.findByText('Still sending');
      expect(within(messageWrapper('Still sending')).queryAllByRole('button')).toEqual([]);
      expect(within(messageWrapper('Sent earlier')).getByRole('button', { name: 'Reply' })).toBeInTheDocument();
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