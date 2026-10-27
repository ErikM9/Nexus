import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import toast from 'react-hot-toast';
import { EventType, KnownMembership, MatrixError, Room, type MatrixClient } from 'matrix-js-sdk';
import type { MemberActionDetail } from '@/app/app-components/MemberOverlay';
import { BOB, HS, ME, addMessage, makeClient, makeRoom, setState } from '../support/matrixRoom';

const mocks = vi.hoisted(() => ({ client: null as MatrixClient | null }));

vi.mock('@/app/utils/matrix', () => ({
  getMatrixClient: () => {
    if (!mocks.client) throw new Error('Matrix client is not initialized');
    return mocks.client;
  },
  getCryptoReady: () => true,
}));

import ChatList from '@/app/app-components/ChatList';

/* The accessible names of the room buttons, top to bottom */
const listedRooms = () =>
  within(screen.getByRole('list', { name: 'Chat rooms' }))
    .queryAllByRole('button', { name: /^(?!Open menu for )/ })
    .map((button) => button.getAttribute('aria-label'));

/* Collects the confirm-dialog requests the list sends to MemberOverlay */
const captureMemberActions = () => {
  const actions: MemberActionDetail[] = [];
  const listener = (event: Event) => actions.push((event as CustomEvent<MemberActionDetail>).detail);
  window.addEventListener('nexus-member-action', listener);
  return { actions, stop: () => window.removeEventListener('nexus-member-action', listener) };
};

/* Opens a room's actions menu by keyboard and picks an item, as Radix menus open on key presses in any environment */
const pickFromRoomMenu = async (roomName: string, item: string) => {
  screen.getByRole('button', { name: `Open menu for ${roomName}` }).focus();
  await userEvent.keyboard('{Enter}');
  await userEvent.click(await screen.findByRole('menuitem', { name: item }));
};

describe('ChatList', () => {
  let client: MatrixClient;

  beforeEach(() => {
    client = makeClient();
    mocks.client = client;
    window.__matrix_ready = true;
  });

  afterEach(() => {
    mocks.client = null;
    window.__matrix_ready = undefined;
  });

  describe('room list', () => {
    it('puts the room with the newest message first, and an empty room by its creation time', async () => {
      const quiet = await makeRoom(client, { name: 'Quiet', members: [BOB], createdAt: 1_000 });
      await addMessage(quiet, BOB, { msgtype: 'm.text', body: 'old news' }, { ts: 2_000 });
      const busy = await makeRoom(client, { name: 'Busy', members: [BOB], createdAt: 1_500 });
      await addMessage(busy, BOB, { msgtype: 'm.text', body: 'hot news' }, { ts: 5_000 });
      await makeRoom(client, { name: 'Empty', createdAt: 3_000 });

      render(<ChatList onSelect={vi.fn()} />);

      await waitFor(() => expect(listedRooms()).toEqual(['Busy', 'Empty', 'Quiet']));
    });

    it('moves a room to the top when a message arrives in it', async () => {
      const quiet = await makeRoom(client, { name: 'Quiet', members: [BOB], createdAt: 1_000 });
      const busy = await makeRoom(client, { name: 'Busy', members: [BOB], createdAt: 1_500 });
      await addMessage(busy, BOB, { msgtype: 'm.text', body: 'hot news' }, { ts: 5_000 });
      render(<ChatList onSelect={vi.fn()} />);
      await waitFor(() => expect(listedRooms()).toEqual(['Busy', 'Quiet']));

      await act(() => addMessage(quiet, BOB, { msgtype: 'm.text', body: 'breaking news' }, { ts: 9_000 }));

      expect(listedRooms()).toEqual(['Quiet', 'Busy']);
    });

    it('keeps its order when a reaction, an edit or a state change arrives', async () => {
      const quiet = await makeRoom(client, { name: 'Quiet', members: [BOB], createdAt: 1_000 });
      const first = await addMessage(quiet, BOB, { msgtype: 'm.text', body: 'old news' }, { ts: 2_000 });
      const busy = await makeRoom(client, { name: 'Busy', members: [BOB], createdAt: 1_500 });
      await addMessage(busy, BOB, { msgtype: 'm.text', body: 'hot news' }, { ts: 5_000 });
      render(<ChatList onSelect={vi.fn()} />);
      await waitFor(() => expect(listedRooms()).toEqual(['Busy', 'Quiet']));

      await act(async () => {
        await setState(quiet, EventType.RoomTopic, { topic: 'Weekly notes' }, { sender: BOB, ts: 7_000 });
        const reaction = { rel_type: 'm.annotation', event_id: first.getId(), key: '👍' };
        await addMessage(quiet, BOB, { 'm.relates_to': reaction }, { type: EventType.Reaction, ts: 8_000 });
        const edit = { msgtype: 'm.text', body: '* older news', 'm.new_content': { msgtype: 'm.text', body: 'older news' } };
        await addMessage(quiet, BOB, { ...edit, 'm.relates_to': { rel_type: 'm.replace', event_id: first.getId() } }, { ts: 9_000 });
      });

      expect(listedRooms()).toEqual(['Busy', 'Quiet']);
    });

    it('leaves out spaces, invitations and rooms replaced by an upgrade I have joined', async () => {
      await makeRoom(client, { name: 'Community', type: 'm.space' });
      await makeRoom(client, { name: 'Pending', creator: BOB, myMembership: KnownMembership.Invite });
      const old = await makeRoom(client, { name: 'Project' });
      const replacement = await makeRoom(client, { name: 'Project v2' });
      await setState(replacement, EventType.RoomCreate, { room_version: '10', predecessor: { room_id: old.roomId } });
      await setState(old, EventType.RoomTombstone, { body: 'Replaced', replacement_room: replacement.roomId });

      render(<ChatList onSelect={vi.fn()} />);

      await waitFor(() => expect(listedRooms()).toEqual(['Project v2']));
    });

    it('keeps a room whose replacement does not name it as its predecessor', async () => {
      const old = await makeRoom(client, { name: 'Project' });
      const unrelated = await makeRoom(client, { name: 'Unrelated' });
      await setState(old, EventType.RoomTombstone, { body: 'Replaced', replacement_room: unrelated.roomId });

      render(<ChatList onSelect={vi.fn()} />);

      await waitFor(() => expect(listedRooms()).toEqual(['Unrelated', 'Project']));
    });

    it('opens a room with its name, encryption and privacy', async () => {
      const room = await makeRoom(client, { name: 'Vault', encrypted: true, joinRule: 'invite' });
      const onSelect = vi.fn();
      render(<ChatList onSelect={onSelect} />);

      await userEvent.click(await screen.findByRole('button', { name: 'Vault, encrypted' }));

      expect(onSelect).toHaveBeenCalledWith(room.roomId, 'Vault', true, false);
    });

    it('marks the open room as the current one', async () => {
      const room = await makeRoom(client, { name: 'General' });
      await makeRoom(client, { name: 'Random' });

      render(<ChatList onSelect={vi.fn()} selectedRoomId={room.roomId} />);

      expect(await screen.findByRole('button', { name: 'General' })).toHaveAttribute('aria-current', 'true');
      expect(screen.getByRole('button', { name: 'Random' })).not.toHaveAttribute('aria-current');
    });

    it('clears the list and the open chat when the client stops', async () => {
      await makeRoom(client, { name: 'General' });
      const onSelect = vi.fn();
      render(<ChatList onSelect={onSelect} />);
      await screen.findByRole('button', { name: 'General' });

      act(() => {
        window.__matrix_ready = false;
        window.dispatchEvent(new Event('matrix-not-ready'));
      });

      expect(onSelect).toHaveBeenCalledWith(null);
      expect(screen.queryByRole('button', { name: 'General' })).not.toBeInTheDocument();
      expect(screen.getByText('Preparing Matrix client...')).toBeInTheDocument();
    });
  });

  describe('create and join forms', () => {
    it('keeps a half-typed room name while the Join form is shown', async () => {
      render(<ChatList onSelect={vi.fn()} />);
      await userEvent.type(screen.getByLabelText('Room name'), 'Book cl');

      await userEvent.click(screen.getByRole('button', { name: 'Join', pressed: false }));
      await userEvent.click(screen.getByRole('button', { name: 'Create', pressed: false }));

      expect(screen.getByLabelText('Room name')).toHaveValue('Book cl');
    });
  });

  describe('room menu', () => {
    it('opens the invite dialog and returns focus to the menu button when the dialog closes', async () => {
      await makeRoom(client, { name: 'General' });
      render(<ChatList onSelect={vi.fn()} />);
      await pickFromRoomMenu('General', 'Send Invite');
      expect(screen.getByRole('dialog', { name: 'Invite someone' })).toBeInTheDocument();

      await userEvent.keyboard('{Escape}');

      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Open menu for General' })).toHaveFocus();
    });

    it('says so when the browser refuses to copy the room ID', async () => {
      await makeRoom(client, { name: 'General' });
      render(<ChatList onSelect={vi.fn()} />);
      /* jsdom has no clipboard, so user-event's stand-in is installed and refuses the write like a browser without permission */
      userEvent.setup();
      vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(new DOMException('Write permission denied.', 'NotAllowedError'));

      await pickFromRoomMenu('General', 'Copy Room ID');

      await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Copy failed'));
      expect(toast.success).not.toHaveBeenCalled();
    });
  });

  describe('leaving a room', () => {
    let captured: ReturnType<typeof captureMemberActions>;

    beforeEach(() => {
      captured = captureMemberActions();
    });

    afterEach(() => captured.stop());

    it('keeps the open chat when another room is left', async () => {
      const open = await makeRoom(client, { name: 'General' });
      await makeRoom(client, { name: 'Old Project' });
      vi.spyOn(client, 'leave').mockResolvedValue({});
      const onSelect = vi.fn();
      render(<ChatList onSelect={onSelect} selectedRoomId={open.roomId} />);
      await pickFromRoomMenu('Old Project', 'Leave Room');

      await act(() => captured.actions[0].onConfirm());

      expect(onSelect).not.toHaveBeenCalledWith(null);
      expect(listedRooms()).toEqual(['General']);
    });

    it('closes the chat when the open room is left', async () => {
      const open = await makeRoom(client, { name: 'General' });
      vi.spyOn(client, 'leave').mockResolvedValue({});
      const onSelect = vi.fn();
      render(<ChatList onSelect={onSelect} selectedRoomId={open.roomId} />);
      await pickFromRoomMenu('General', 'Leave Room');

      await act(() => captured.actions[0].onConfirm());

      expect(onSelect).toHaveBeenCalledWith(null);
    });

    it('lets the dialog report a refused leave and keeps the room listed', async () => {
      await makeRoom(client, { name: 'General' });
      const refusal = new MatrixError({ errcode: 'M_UNKNOWN', error: 'Try again later' }, 500);
      vi.spyOn(client, 'leave').mockRejectedValue(refusal);
      render(<ChatList onSelect={vi.fn()} />);
      await pickFromRoomMenu('General', 'Leave Room');

      await act(() => expect(captured.actions[0].onConfirm()).rejects.toBe(refusal));

      expect(listedRooms()).toEqual(['General']);
    });
  });

  describe('joining a room', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    const joinByAlias = async () => {
      await userEvent.click(screen.getByRole('button', { name: 'Join' }));
      await userEvent.type(screen.getByPlaceholderText('Search by name or enter ID'), `#books:${HS}{Enter}`);
    };

    it('opens a room joined by alias once sync has delivered it', async () => {
      const joinedId = `!books:${HS}`;
      vi.spyOn(client, 'joinRoom').mockImplementation(async () => new Room(joinedId, client, ME));
      const onSelect = vi.fn();
      render(<ChatList onSelect={onSelect} />);
      await joinByAlias();

      await act(async () => {
        await makeRoom(client, { roomId: joinedId, name: 'Book Club', creator: BOB, joinRule: 'public' });
      });

      await waitFor(() => expect(onSelect).toHaveBeenCalledWith(joinedId, 'Book Club', false, true));
    });

    it('leaves a room opened meanwhile open when the joined room arrives later', async () => {
      const joinedId = `!books:${HS}`;
      const other = await makeRoom(client, { name: 'General' });
      vi.spyOn(client, 'joinRoom').mockImplementation(async () => new Room(joinedId, client, ME));
      const onSelect = vi.fn();
      const { rerender } = render(<ChatList onSelect={onSelect} />);
      await joinByAlias();
      await waitFor(() => expect(client.joinRoom).toHaveBeenCalled());
      rerender(<ChatList onSelect={onSelect} selectedRoomId={other.roomId} />);

      await act(async () => {
        await makeRoom(client, { roomId: joinedId, name: 'Book Club', creator: BOB, joinRule: 'public' });
      });

      expect(onSelect).not.toHaveBeenCalledWith(joinedId, expect.anything(), expect.anything(), expect.anything());
    });

    it('opens nothing when the user signs out while the joined room is on its way', async () => {
      const joinedId = `!books:${HS}`;
      vi.spyOn(client, 'joinRoom').mockImplementation(async () => new Room(joinedId, client, ME));
      const onSelect = vi.fn();
      render(<ChatList onSelect={onSelect} />);
      await joinByAlias();
      act(() => {
        window.__matrix_ready = false;
        window.dispatchEvent(new Event('matrix-not-ready'));
      });

      await act(async () => {
        await makeRoom(client, { roomId: joinedId, name: 'Book Club', creator: BOB, joinRule: 'public' });
      });

      expect(onSelect).not.toHaveBeenCalledWith(joinedId, expect.anything(), expect.anything(), expect.anything());
    });

    it('opens the room under the address the user typed when sync has not delivered it after 10 seconds', async () => {
      const joinedId = `!books:${HS}`;
      let answerJoin!: (room: Room) => void;
      vi.spyOn(client, 'joinRoom').mockReturnValue(
        new Promise((resolve) => {
          answerJoin = resolve;
        })
      );
      const onSelect = vi.fn();
      render(<ChatList onSelect={onSelect} />);
      await joinByAlias();
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      await act(async () => answerJoin(new Room(joinedId, client, ME)));
      await act(() => vi.advanceTimersByTimeAsync(9_999));
      expect(onSelect).not.toHaveBeenCalled();

      await act(() => vi.advanceTimersByTimeAsync(1));

      expect(onSelect).toHaveBeenCalledWith(joinedId, `#books:${HS}`, undefined, undefined);
    });
  });
});