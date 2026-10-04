import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { EventType, KnownMembership, MatrixError, Room, type MatrixClient } from 'matrix-js-sdk';
import type { MemberActionDetail } from '@/app/app-components/MemberOverlay';
import { BOB, HS, ME, addMessage, makeClient, makeRoom, setState } from '../support/matrixRoom';

const mocks = vi.hoisted(() => ({ client: null as MatrixClient | null }));

vi.mock('@/app/utils/matrix', () => ({
  getMatrixClient: () => {
    if (!mocks.client) throw new Error('Matrix client not initialised');
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

/* Opens a room's ⋮ menu with the keyboard and picks an item, as Radix menus open on key presses in any environment */
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

    it('keeps its order when a reaction or a state change arrives', async () => {
      const quiet = await makeRoom(client, { name: 'Quiet', members: [BOB], createdAt: 1_000 });
      const first = await addMessage(quiet, BOB, { msgtype: 'm.text', body: 'old news' }, { ts: 2_000 });
      const busy = await makeRoom(client, { name: 'Busy', members: [BOB], createdAt: 1_500 });
      await addMessage(busy, BOB, { msgtype: 'm.text', body: 'hot news' }, { ts: 5_000 });
      render(<ChatList onSelect={vi.fn()} />);
      await waitFor(() => expect(listedRooms()).toEqual(['Busy', 'Quiet']));

      await act(async () => {
        await setState(quiet, EventType.RoomTopic, { topic: 'Weekly notes' }, { sender: BOB, ts: 8_000 });
        const relatesTo = { rel_type: 'm.annotation', event_id: first.getId(), key: '👍' };
        await addMessage(quiet, BOB, { 'm.relates_to': relatesTo }, { type: EventType.Reaction, ts: 9_000 });
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

    it('opens a room with its name, encryption and privacy', async () => {
      const room = await makeRoom(client, { name: 'Vault', encrypted: true, joinRule: 'public' });
      const onSelect = vi.fn();
      render(<ChatList onSelect={onSelect} />);

      await userEvent.click(await screen.findByRole('button', { name: 'Vault, encrypted' }));

      expect(onSelect).toHaveBeenCalledWith(room.roomId, 'Vault', true, true);
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
  });
});