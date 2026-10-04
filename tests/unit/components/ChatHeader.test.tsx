import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import toast from 'react-hot-toast';
import { EventType, Visibility, type MatrixClient, type Room } from 'matrix-js-sdk';
import type { MemberActionDetail } from '@/app/app-components/MemberOverlay';
import type { RoomDevice } from '@/app/utils/matrix/devices';
import { BOB, CAROL, ME, makeClient, makeRoom } from '../support/matrixRoom';

const mocks = vi.hoisted(() => ({
  client: null as MatrixClient | null,
  checkRoomDevices: vi.fn(async (_client: MatrixClient, _roomId: string) => [] as RoomDevice[]),
  requestVerificationToUser: vi.fn(async (_userId: string, _deviceIds?: string[]) => ({ id: 'req1' }) as any),
  confirmVerificationRequest: vi.fn(async (_id: string) => true),
  cancelVerificationRequest: vi.fn(async (_id: string) => true),
}));

vi.mock('@/app/utils/matrix', () => ({
  getMatrixClient: () => {
    if (!mocks.client) throw new Error('Matrix client not initialised');
    return mocks.client;
  },
  checkRoomDevices: mocks.checkRoomDevices,
  requestVerificationToUser: mocks.requestVerificationToUser,
  confirmVerificationRequest: mocks.confirmVerificationRequest,
  cancelVerificationRequest: mocks.cancelVerificationRequest,
}));

import ChatHeader from '@/app/app-components/ChatHeader';

/* Collects the confirm-dialog requests the header sends to MemberOverlay */
const captureMemberActions = () => {
  const actions: MemberActionDetail[] = [];
  const listener = (event: Event) => actions.push((event as CustomEvent<MemberActionDetail>).detail);
  window.addEventListener('nexus-member-action', listener);
  return { actions, stop: () => window.removeEventListener('nexus-member-action', listener) };
};

/* Opens a header dropdown with the keyboard, as Radix menus open on key presses in any environment */
const openMenu = async (name: string) => {
  screen.getByRole('button', { name }).focus();
  await userEvent.keyboard('{Enter}');
};

const renderHeader = (room: Room, overrides: Partial<{ onLeave: (roomId: string) => void }> = {}) =>
  render(<ChatHeader roomName={room.name} roomId={room.roomId} onLeave={overrides.onLeave ?? vi.fn()} />);

describe('ChatHeader', () => {
  let client: MatrixClient;

  beforeEach(() => {
    client = makeClient();
    mocks.client = client;
    window.__matrix_ready = true;
    mocks.checkRoomDevices.mockReset().mockResolvedValue([]);
    mocks.requestVerificationToUser.mockReset().mockResolvedValue({ id: 'req1' });
    mocks.confirmVerificationRequest.mockReset().mockResolvedValue(true);
    mocks.cancelVerificationRequest.mockReset().mockResolvedValue(true);
  });

  afterEach(() => {
    mocks.client = null;
    window.__matrix_ready = undefined;
    vi.restoreAllMocks();
  });

  describe('rendering', () => {
    it('shows the room name in a heading inside a banner landmark', async () => {
      const room = await makeRoom(client, { name: 'General' });

      renderHeader(room);

      expect(await screen.findByRole('banner')).toBeInTheDocument();
      expect(screen.getByRole('heading', { level: 3 })).toHaveTextContent('General');
    });

    it.each([
      ['public', true, '🛡️'],
      ['public', false, '🌍'],
      ['invite', true, '🔐'],
      ['invite', false, '🔒'],
    ] as const)('shows the right privacy/encryption indicator for a %s, encrypted=%s room', async (joinRule, encrypted, emoji) => {
      const room = await makeRoom(client, { name: 'Vault', joinRule, encrypted });

      const { unmount } = renderHeader(room);

      expect(await screen.findByText(emoji)).toBeInTheDocument();
      unmount();
    });
  });

  describe('renaming a room', () => {
    it('offers renaming only to a member who may send m.room.name', async () => {
      const room = await makeRoom(client, { name: 'General' });

      renderHeader(room);

      expect(await screen.findByRole('button', { name: 'Rename room' })).toBeInTheDocument();
    });

    it('hides the rename control for a member without permission', async () => {
      const room = await makeRoom(client, { name: 'General', creator: BOB, members: [ME] });

      renderHeader(room);

      await screen.findByText('General');
      expect(screen.queryByRole('button', { name: 'Rename room' })).not.toBeInTheDocument();
    });

    it('saves a new name and shows it in the title', async () => {
      const room = await makeRoom(client, { name: 'General' });
      vi.spyOn(client, 'sendStateEvent').mockResolvedValue({ event_id: '$1' } as any);
      renderHeader(room);

      await userEvent.click(await screen.findByRole('button', { name: 'Rename room' }));
      await userEvent.type(screen.getByLabelText('New room name'), 'Team Chat');
      await userEvent.click(screen.getByRole('button', { name: 'Save rename' }));

      expect(await screen.findByTestId('room-name')).toHaveTextContent('Team Chat');
      expect(client.sendStateEvent).toHaveBeenCalledWith(room.roomId, EventType.RoomName, { name: 'Team Chat' }, '');
    });

    it('cancel restores the previous title without saving', async () => {
      const room = await makeRoom(client, { name: 'General' });
      vi.spyOn(client, 'sendStateEvent');
      renderHeader(room);

      await userEvent.click(await screen.findByRole('button', { name: 'Rename room' }));
      await userEvent.type(screen.getByLabelText('New room name'), 'Team Chat');
      await userEvent.click(screen.getByRole('button', { name: 'Cancel rename' }));

      expect(screen.getByTestId('room-name')).toHaveTextContent('General');
      expect(client.sendStateEvent).not.toHaveBeenCalled();
    });

    it('keeps the typed name and reports the failure when the server refuses the rename', async () => {
      const room = await makeRoom(client, { name: 'General' });
      vi.spyOn(client, 'sendStateEvent').mockRejectedValue(new Error('offline'));
      renderHeader(room);

      await userEvent.click(await screen.findByRole('button', { name: 'Rename room' }));
      await userEvent.type(screen.getByLabelText('New room name'), 'Team Chat');
      await userEvent.click(screen.getByRole('button', { name: 'Save rename' }));

      await vi.waitFor(() => expect(toast.error).toHaveBeenCalledWith('Could not rename the room'));
      expect(screen.getByLabelText('New room name')).toHaveValue('Team Chat');
      expect(screen.queryByTestId('room-name')).not.toBeInTheDocument();
    });

    it('disables Save while a rename is in flight', async () => {
      const room = await makeRoom(client, { name: 'General' });
      let resolveSend!: () => void;
      vi.spyOn(client, 'sendStateEvent').mockReturnValue(new Promise((res) => { resolveSend = () => res({} as any); }));
      renderHeader(room);
      await userEvent.click(await screen.findByRole('button', { name: 'Rename room' }));
      await userEvent.type(screen.getByLabelText('New room name'), 'Team Chat');

      await userEvent.click(screen.getByRole('button', { name: 'Save rename' }));

      expect(screen.getByRole('button', { name: 'Save rename' })).toBeDisabled();
      await act(async () => resolveSend());
    });
  });

  describe('privacy and encryption settings', () => {
    it('shows the current privacy and encryption status', async () => {
      const room = await makeRoom(client, { name: 'Vault', joinRule: 'public', encrypted: true });
      renderHeader(room);

      await openMenu('Room settings');

      expect(screen.getByText('Public')).toBeInTheDocument();
      expect(screen.getByText('Encrypted')).toBeInTheDocument();
    });

    it('offers Make Public only to a member who may change the join rule', async () => {
      const room = await makeRoom(client, { name: 'General', creator: BOB, members: [ME] });
      renderHeader(room);

      await openMenu('Room settings');

      expect(screen.queryByRole('menuitem', { name: /Make Public/ })).not.toBeInTheDocument();
    });

    it('makes a room public by setting the join rule and then listing it in the directory', async () => {
      const room = await makeRoom(client, { name: 'General', joinRule: 'invite' });
      const sendState = vi.spyOn(client, 'sendStateEvent').mockResolvedValue({ event_id: '$1' } as any);
      const setVisibility = vi.spyOn(client, 'setRoomDirectoryVisibility').mockResolvedValue(undefined as any);
      renderHeader(room);
      await openMenu('Room settings');

      await userEvent.click(screen.getByRole('menuitem', { name: /Make Public/ }));

      await screen.findByText('Public');
      expect(sendState).toHaveBeenCalledWith(room.roomId, EventType.RoomJoinRules, { join_rule: 'public' }, '');
      expect(setVisibility).toHaveBeenCalledWith(room.roomId, Visibility.Public);
      expect(sendState.mock.invocationCallOrder[0]).toBeLessThan(setVisibility.mock.invocationCallOrder[0]);
    });

    it('makes a room private by unlisting it before restricting the join rule', async () => {
      const room = await makeRoom(client, { name: 'General', joinRule: 'public' });
      const sendState = vi.spyOn(client, 'sendStateEvent').mockResolvedValue({ event_id: '$1' } as any);
      const setVisibility = vi.spyOn(client, 'setRoomDirectoryVisibility').mockResolvedValue(undefined as any);
      renderHeader(room);
      await openMenu('Room settings');

      await userEvent.click(screen.getByRole('menuitem', { name: /Make Private/ }));

      await screen.findByText('Private');
      expect(setVisibility).toHaveBeenCalledWith(room.roomId, Visibility.Private);
      expect(sendState).toHaveBeenCalledWith(room.roomId, EventType.RoomJoinRules, { join_rule: 'invite' }, '');
      expect(setVisibility.mock.invocationCallOrder[0]).toBeLessThan(sendState.mock.invocationCallOrder[0]);
    });

    it('reports a refused privacy change without changing the shown status', async () => {
      const room = await makeRoom(client, { name: 'General', joinRule: 'invite' });
      vi.spyOn(client, 'sendStateEvent').mockRejectedValue(new Error('refused'));
      renderHeader(room);
      await openMenu('Room settings');

      await userEvent.click(screen.getByRole('menuitem', { name: /Make Public/ }));

      await vi.waitFor(() => expect(toast.error).toHaveBeenCalledWith('Could not make the room public'));
      expect(screen.getByText('Private')).toBeInTheDocument();
    });

    it('reports when the room becomes public but cannot be listed', async () => {
      const room = await makeRoom(client, { name: 'General', joinRule: 'invite' });
      vi.spyOn(client, 'sendStateEvent').mockResolvedValue({ event_id: '$1' } as any);
      vi.spyOn(client, 'setRoomDirectoryVisibility').mockRejectedValue(new Error('refused'));
      renderHeader(room);
      await openMenu('Room settings');

      await userEvent.click(screen.getByRole('menuitem', { name: /Make Public/ }));

      await vi.waitFor(() =>
        expect(toast.error).toHaveBeenCalledWith('The room is public but could not be listed in the room directory')
      );
      expect(screen.getByText('Public')).toBeInTheDocument();
    });

    it('offers Enable Encryption only when the room is not yet encrypted and permitted', async () => {
      const room = await makeRoom(client, { name: 'General', encrypted: false });
      renderHeader(room);

      await openMenu('Room settings');

      expect(screen.getByRole('menuitem', { name: /Enable Encryption/ })).toBeInTheDocument();
    });

    it('enables encryption and hides the option once it is on', async () => {
      const room = await makeRoom(client, { name: 'General', encrypted: false });
      vi.spyOn(client, 'sendStateEvent').mockResolvedValue({ event_id: '$1' } as any);
      renderHeader(room);
      await openMenu('Room settings');

      await userEvent.click(screen.getByRole('menuitem', { name: /Enable Encryption/ }));

      await screen.findByText('Encrypted');
      expect(client.sendStateEvent).toHaveBeenCalledWith(
        room.roomId,
        EventType.RoomEncryption,
        { algorithm: 'm.megolm.v1.aes-sha2' },
        ''
      );
      expect(screen.queryByRole('menuitem', { name: /Enable Encryption/ })).not.toBeInTheDocument();
      expect(screen.getByText('Encryption cannot be disabled once enabled.')).toBeInTheDocument();
    });

    it('reports a refused encryption change', async () => {
      const room = await makeRoom(client, { name: 'General', encrypted: false });
      vi.spyOn(client, 'sendStateEvent').mockRejectedValue(new Error('refused'));
      renderHeader(room);
      await openMenu('Room settings');

      await userEvent.click(screen.getByRole('menuitem', { name: /Enable Encryption/ }));

      await vi.waitFor(() => expect(toast.error).toHaveBeenCalledWith('Could not enable encryption'));
      expect(screen.getByText('Not encrypted')).toBeInTheDocument();
    });
  });

  describe('member list and permissions', () => {
    it('lists joined members by power level, highest first', async () => {
      const room = await makeRoom(client, { name: 'Team', members: [BOB, CAROL] });
      renderHeader(room);

      await openMenu('Members');

      const rows = screen.getAllByText(/^@\w+:hs\.test$/).map((el) => el.textContent);
      expect(rows).toEqual([ME, BOB, CAROL]);
    });

    it('shows a room v12 creator as Creator with an unlimited power level', async () => {
      const room = await makeRoom(client, { name: 'Vault', roomVersion: '12' });
      renderHeader(room);

      await openMenu('Members');

      expect(screen.getByRole('menuitem', { name: new RegExp(`${ME}.*Creator · PL: ∞`) })).toBeInTheDocument();
    });

    it("shows Ban for another member when permitted and hides it for the viewer's own row", async () => {
      const room = await makeRoom(client, { name: 'Team', members: [BOB] });
      renderHeader(room);
      await openMenu('Members');

      await userEvent.click(screen.getByText(BOB));
      expect(screen.getByRole('menuitem', { name: 'Ban' })).not.toHaveAttribute('aria-disabled', 'true');

      await userEvent.click(screen.getByRole('menuitem', { name: 'Go back' }));
      await userEvent.click(screen.getByText(ME));
      expect(screen.queryByRole('menuitem', { name: 'Ban' })).not.toBeInTheDocument();
      expect(screen.getByRole('menuitem', { name: 'Leave' })).toBeInTheDocument();
    });

    it('marks Role, Kick and Ban as restricted when the viewer lacks the power level', async () => {
      const room = await makeRoom(client, { name: 'Team', creator: BOB, members: [ME, CAROL] });
      renderHeader(room);
      await openMenu('Members');

      await userEvent.click(screen.getByText(CAROL));

      expect(screen.getByRole('menuitem', { name: 'Role' })).toHaveAttribute('aria-disabled', 'true');
      expect(screen.getByRole('menuitem', { name: 'Kick' })).toHaveAttribute('aria-disabled', 'true');
      expect(screen.getByRole('menuitem', { name: 'Ban' })).toHaveAttribute('aria-disabled', 'true');
    });

    it('always lets the viewer leave, regardless of power level', async () => {
      const room = await makeRoom(client, { name: 'Team', creator: BOB, members: [ME] });
      renderHeader(room);
      await openMenu('Members');

      await userEvent.click(screen.getByText(ME));

      expect(screen.getByRole('menuitem', { name: 'Leave' })).not.toHaveAttribute('aria-disabled', 'true');
    });
  });

  describe('member actions', () => {
    it('kicks the selected member through the shared confirm dialog', async () => {
      const room = await makeRoom(client, { name: 'Team', members: [BOB] });
      vi.spyOn(client, 'kick').mockResolvedValue({} as any);
      const captured = captureMemberActions();
      renderHeader(room);
      await openMenu('Members');
      await userEvent.click(screen.getByText(BOB));

      await userEvent.click(screen.getByRole('menuitem', { name: 'Kick' }));
      await act(() => captured.actions[0].onConfirm());

      expect(client.kick).toHaveBeenCalledWith(room.roomId, BOB, 'Removed');
      captured.stop();
    });

    it('bans the selected member through the shared confirm dialog', async () => {
      const room = await makeRoom(client, { name: 'Team', members: [BOB] });
      vi.spyOn(client, 'ban').mockResolvedValue({} as any);
      const captured = captureMemberActions();
      renderHeader(room);
      await openMenu('Members');
      await userEvent.click(screen.getByText(BOB));

      await userEvent.click(screen.getByRole('menuitem', { name: 'Ban' }));
      await act(() => captured.actions[0].onConfirm());

      expect(client.ban).toHaveBeenCalledWith(room.roomId, BOB, 'Banned');
      captured.stop();
    });

    it("lets the viewer leave the room from their own row", async () => {
      const room = await makeRoom(client, { name: 'Team' });
      vi.spyOn(client, 'leave').mockResolvedValue({} as any);
      const onLeave = vi.fn();
      const captured = captureMemberActions();
      renderHeader(room, { onLeave });
      await openMenu('Members');
      await userEvent.click(screen.getByText(ME));

      await userEvent.click(screen.getByRole('menuitem', { name: 'Leave' }));
      await act(() => captured.actions[0].onConfirm());

      expect(client.leave).toHaveBeenCalledWith(room.roomId);
      expect(onLeave).toHaveBeenCalledWith(room.roomId);
      captured.stop();
    });

    it("changes a member's role by resending power levels with only that entry changed", async () => {
      const room = await makeRoom(client, { name: 'Team', members: [BOB] });
      vi.spyOn(client, 'sendStateEvent').mockResolvedValue({ event_id: '$1' } as any);
      const captured = captureMemberActions();
      renderHeader(room);
      await openMenu('Members');
      await userEvent.click(screen.getByText(BOB));
      await userEvent.click(screen.getByRole('menuitem', { name: 'Role' }));

      await userEvent.click(screen.getByRole('menuitem', { name: 'Moderator' }));
      await act(() => captured.actions[0].onConfirm());

      expect(client.sendStateEvent).toHaveBeenCalledWith(
        room.roomId,
        EventType.RoomPowerLevels,
        { users: { [ME]: 100, [BOB]: 50 }, users_default: 0 },
        ''
      );
      captured.stop();
    });

    it("warns that promoting a member to the viewer's own level cannot be undone", async () => {
      const room = await makeRoom(client, { name: 'Team', members: [BOB] });
      const captured = captureMemberActions();
      renderHeader(room);
      await openMenu('Members');
      await userEvent.click(screen.getByText(BOB));
      await userEvent.click(screen.getByRole('menuitem', { name: 'Role' }));

      await userEvent.click(screen.getByRole('menuitem', { name: 'Admin' }));

      expect(captured.actions[0].warning).toBe('This can’t be undone: they will have the same power level as you.');
      captured.stop();
    });
  });

  describe('device verification', () => {
    it("lists another member's unverified device in the Security section", async () => {
      const room = await makeRoom(client, { name: 'Vault', encrypted: true, members: [BOB] });
      mocks.checkRoomDevices.mockResolvedValue([{ userId: BOB, deviceId: 'BOBPHONE' }]);
      renderHeader(room);

      await openMenu('Members');

      expect(await screen.findByText('Security')).toBeInTheDocument();
      expect(screen.getByRole('menuitem', { name: `Verify ${BOB} · BOBPHONE` })).toBeInTheDocument();
    });

    it("requests verification of that member's own device, never the viewer's [contract]", async () => {
      const room = await makeRoom(client, { name: 'Vault', encrypted: true, members: [BOB] });
      mocks.checkRoomDevices.mockResolvedValue([{ userId: BOB, deviceId: 'BOBPHONE' }]);
      renderHeader(room);
      await openMenu('Members');

      await userEvent.click(await screen.findByRole('menuitem', { name: `Verify ${BOB} · BOBPHONE` }));

      expect(mocks.requestVerificationToUser).toHaveBeenCalledWith(BOB, ['BOBPHONE']);
    });

    it('shows emoji comparison once the verification snapshot carries them', async () => {
      const room = await makeRoom(client, { name: 'Vault', encrypted: true, members: [BOB] });
      mocks.checkRoomDevices.mockResolvedValue([{ userId: BOB, deviceId: 'BOBPHONE' }]);
      mocks.requestVerificationToUser.mockResolvedValue({ id: 'req1', sasEmojis: ['🐶', '🐱'] });
      renderHeader(room);
      await openMenu('Members');

      await userEvent.click(await screen.findByRole('menuitem', { name: `Verify ${BOB} · BOBPHONE` }));

      expect(await screen.findByText('Compare these emojis:')).toBeInTheDocument();
      expect(screen.getByText('🐶')).toBeInTheDocument();
      expect(screen.getByText('🐱')).toBeInTheDocument();
    });

    it('confirms a matching verification', async () => {
      const room = await makeRoom(client, { name: 'Vault', encrypted: true, members: [BOB] });
      mocks.checkRoomDevices.mockResolvedValue([{ userId: BOB, deviceId: 'BOBPHONE' }]);
      mocks.requestVerificationToUser.mockResolvedValue({ id: 'req1', sasEmojis: ['🐶', '🐱'] });
      renderHeader(room);
      await openMenu('Members');
      await userEvent.click(await screen.findByRole('menuitem', { name: `Verify ${BOB} · BOBPHONE` }));

      await userEvent.click(await screen.findByRole('menuitem', { name: 'They match' }));

      expect(mocks.confirmVerificationRequest).toHaveBeenCalledWith('req1');
    });

    it('cancels an in-progress verification', async () => {
      const room = await makeRoom(client, { name: 'Vault', encrypted: true, members: [BOB] });
      mocks.checkRoomDevices.mockResolvedValue([{ userId: BOB, deviceId: 'BOBPHONE' }]);
      mocks.requestVerificationToUser.mockResolvedValue({ id: 'req1', sasEmojis: ['🐶', '🐱'] });
      renderHeader(room);
      await openMenu('Members');
      await userEvent.click(await screen.findByRole('menuitem', { name: `Verify ${BOB} · BOBPHONE` }));

      await userEvent.click(await screen.findByRole('menuitem', { name: 'Cancel' }));

      expect(mocks.cancelVerificationRequest).toHaveBeenCalledWith('req1');
    });

    it('shows no Security section for an unencrypted room', async () => {
      const room = await makeRoom(client, { name: 'General', encrypted: false, members: [BOB] });
      renderHeader(room);

      await openMenu('Members');
      await screen.findByText(BOB);

      expect(screen.queryByText('Security')).not.toBeInTheDocument();
      expect(mocks.checkRoomDevices).not.toHaveBeenCalled();
    });
  });
});