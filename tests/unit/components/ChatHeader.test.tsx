import { describe, it, expect, vi, beforeEach, afterEach, onTestFinished } from 'vitest';
import { render, screen, act, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import toast from 'react-hot-toast';
import { EventType, MatrixError, Visibility, type MatrixClient, type Room } from 'matrix-js-sdk';
import { CryptoEvent, UserVerificationStatus } from 'matrix-js-sdk/lib/crypto-api';
import type { MemberActionDetail } from '@/app/app-components/MemberOverlay';
import type { RoomDevice } from '@/app/utils/matrix/devices';
import type { VerificationSnapshot } from '@/app/utils/matrix/types';
import { emitMatrixNotReady, emitMatrixReady, emitVerificationSnapshot } from '@/app/utils/matrix/events';
import { BOB, CAROL, ME, makeClient, makeRoom } from '../support/matrixRoom';

const mocks = vi.hoisted(() => ({
  client: null as MatrixClient | null,
  checkRoomDevices: vi.fn<(client: MatrixClient, roomId: string) => Promise<RoomDevice[]>>(),
  requestVerificationToUser: vi.fn<(userId: string, deviceIds?: string[]) => Promise<VerificationSnapshot>>(),
  confirmVerificationRequest: vi.fn<(id: string) => Promise<boolean>>(),
  cancelVerificationRequest: vi.fn<(id: string) => Promise<boolean>>(),
}));

vi.mock('@/app/utils/matrix', () => ({
  getMatrixClient: () => {
    if (!mocks.client) throw new Error('Matrix client is not initialized');
    return mocks.client;
  },
  checkRoomDevices: mocks.checkRoomDevices,
  requestVerificationToUser: mocks.requestVerificationToUser,
  confirmVerificationRequest: mocks.confirmVerificationRequest,
  cancelVerificationRequest: mocks.cancelVerificationRequest,
}));

import ChatHeader from '@/app/app-components/ChatHeader';

const BOBS_PHONE: RoomDevice = { userId: BOB, deviceId: 'BOBPHONE' };
const BOBS_LAPTOP: RoomDevice = { userId: BOB, deviceId: 'BOBLAPTOP' };
const SAS_EMOJIS = ['🐶', '🐱', '🦁', '🐎', '🦄', '🐷', '🐘'];

/* A request to verify Bob's phone as the verification module publishes it, under the transaction ID both devices use */
const requestToBobsPhone = (phase: VerificationSnapshot['phase'], extra: Partial<VerificationSnapshot> = {}): VerificationSnapshot => ({
  id: 'txn-bobphone',
  txnId: 'txn-bobphone',
  fromUserId: BOB,
  fromDeviceId: 'BOBPHONE',
  createdAt: 1_780_000_000_000,
  phase,
  outgoing: true,
  ...extra,
});

/* Collects the confirm-dialog requests the header sends to MemberOverlay */
const captureMemberActions = () => {
  const actions: MemberActionDetail[] = [];
  const listener = (event: Event) => actions.push((event as CustomEvent<MemberActionDetail>).detail);
  window.addEventListener('nexus-member-action', listener);
  return { actions, stop: () => window.removeEventListener('nexus-member-action', listener) };
};

/* A promise the test settles by hand, standing in for a request that is still on its way */
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
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
    mocks.requestVerificationToUser.mockReset().mockResolvedValue(requestToBobsPhone('requested'));
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
      ['🛡️', 'a public, encrypted', 'public', true],
      ['🌍', 'a public, unencrypted', 'public', false],
      ['🔐', 'a private, encrypted', 'invite', true],
      ['🔒', 'a private, unencrypted', 'invite', false],
    ] as const)('shows %s beside the name of %s room', async (emoji, _kind, joinRule, encrypted) => {
      const room = await makeRoom(client, { name: 'Vault', joinRule, encrypted });

      renderHeader(room);

      expect(await screen.findByText(emoji)).toBeInTheDocument();
    });
  });

  describe('renaming a room', () => {
    it('hides the rename control for a member without permission', async () => {
      const room = await makeRoom(client, { name: 'General', creator: BOB, members: [ME] });

      renderHeader(room);

      await screen.findByText('General');
      expect(screen.queryByRole('button', { name: 'Rename room' })).not.toBeInTheDocument();
    });

    it('saves the trimmed new name and shows it in the title', async () => {
      const room = await makeRoom(client, { name: 'General' });
      vi.spyOn(client, 'sendStateEvent').mockResolvedValue({ event_id: '$1' });
      renderHeader(room);

      await userEvent.click(await screen.findByRole('button', { name: 'Rename room' }));
      await userEvent.type(screen.getByLabelText('New room name'), '  Team Chat  ');
      await userEvent.click(screen.getByRole('button', { name: 'Save rename' }));

      expect(await screen.findByRole('heading', { level: 3 })).toHaveTextContent('Team Chat');
      expect(client.sendStateEvent).toHaveBeenCalledWith(room.roomId, EventType.RoomName, { name: 'Team Chat' }, '');
    });

    it('keeps the old title and saves nothing when renaming is cancelled', async () => {
      const room = await makeRoom(client, { name: 'General' });
      vi.spyOn(client, 'sendStateEvent');
      renderHeader(room);

      await userEvent.click(await screen.findByRole('button', { name: 'Rename room' }));
      await userEvent.type(screen.getByLabelText('New room name'), 'Team Chat');
      await userEvent.click(screen.getByRole('button', { name: 'Cancel rename' }));

      expect(screen.getByRole('heading', { level: 3 })).toHaveTextContent('General');
      expect(client.sendStateEvent).not.toHaveBeenCalled();
    });

    it('keeps the typed name and reports the failure when the server refuses the rename', async () => {
      const room = await makeRoom(client, { name: 'General' });
      vi.spyOn(client, 'sendStateEvent').mockRejectedValue(new MatrixError({ errcode: 'M_FORBIDDEN', error: 'Not allowed' }, 403));
      renderHeader(room);

      await userEvent.click(await screen.findByRole('button', { name: 'Rename room' }));
      await userEvent.type(screen.getByLabelText('New room name'), 'Team Chat');
      await userEvent.click(screen.getByRole('button', { name: 'Save rename' }));

      await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Could not rename the room'));
      expect(screen.getByLabelText('New room name')).toHaveValue('Team Chat');
      expect(screen.queryByRole('heading', { level: 3 })).not.toBeInTheDocument();
    });

    it('disables Save while a rename is in flight', async () => {
      const room = await makeRoom(client, { name: 'General' });
      vi.spyOn(client, 'sendStateEvent').mockReturnValue(new Promise(() => {}));
      renderHeader(room);
      await userEvent.click(await screen.findByRole('button', { name: 'Rename room' }));
      await userEvent.type(screen.getByLabelText('New room name'), 'Team Chat');

      await userEvent.click(screen.getByRole('button', { name: 'Save rename' }));

      expect(screen.getByRole('button', { name: 'Save rename' })).toBeDisabled();
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

    it('offers no privacy or encryption change to a member without the power level for it', async () => {
      const room = await makeRoom(client, { name: 'General', creator: BOB, members: [ME] });
      renderHeader(room);

      await openMenu('Room settings');

      expect(screen.queryByRole('menuitem', { name: /Make Public/ })).not.toBeInTheDocument();
      expect(screen.queryByRole('menuitem', { name: /Enable Encryption/ })).not.toBeInTheDocument();
    });

    it('makes a room public by setting the join rule and then listing it in the directory', async () => {
      const room = await makeRoom(client, { name: 'General', joinRule: 'invite' });
      const sendState = vi.spyOn(client, 'sendStateEvent').mockResolvedValue({ event_id: '$1' });
      const setVisibility = vi.spyOn(client, 'setRoomDirectoryVisibility').mockResolvedValue({});
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
      const sendState = vi.spyOn(client, 'sendStateEvent').mockResolvedValue({ event_id: '$1' });
      const setVisibility = vi.spyOn(client, 'setRoomDirectoryVisibility').mockResolvedValue({});
      renderHeader(room);
      await openMenu('Room settings');

      await userEvent.click(screen.getByRole('menuitem', { name: /Make Private/ }));

      await screen.findByText('Private');
      expect(setVisibility).toHaveBeenCalledWith(room.roomId, Visibility.Private);
      expect(sendState).toHaveBeenCalledWith(room.roomId, EventType.RoomJoinRules, { join_rule: 'invite' }, '');
      expect(setVisibility.mock.invocationCallOrder[0]).toBeLessThan(sendState.mock.invocationCallOrder[0]);
    });

    it('keeps a room private and out of the directory when the server refuses to make it public', async () => {
      const room = await makeRoom(client, { name: 'General', joinRule: 'invite' });
      vi.spyOn(client, 'sendStateEvent').mockRejectedValue(new MatrixError({ errcode: 'M_FORBIDDEN', error: 'Not allowed' }, 403));
      const setVisibility = vi.spyOn(client, 'setRoomDirectoryVisibility').mockResolvedValue({});
      renderHeader(room);
      await openMenu('Room settings');

      await userEvent.click(screen.getByRole('menuitem', { name: /Make Public/ }));

      await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Could not make the room public'));
      expect(screen.getByText('Private')).toBeInTheDocument();
      expect(setVisibility).not.toHaveBeenCalled();
    });

    it('reports when the room becomes public but cannot be listed', async () => {
      const room = await makeRoom(client, { name: 'General', joinRule: 'invite' });
      vi.spyOn(client, 'sendStateEvent').mockResolvedValue({ event_id: '$1' });
      vi.spyOn(client, 'setRoomDirectoryVisibility').mockRejectedValue(new MatrixError({ errcode: 'M_FORBIDDEN', error: 'Not allowed' }, 403));
      renderHeader(room);
      await openMenu('Room settings');

      await userEvent.click(screen.getByRole('menuitem', { name: /Make Public/ }));

      await waitFor(() => expect(toast.error).toHaveBeenCalledWith('The room is public but could not be listed in the room directory'));
      expect(screen.getByText('Public')).toBeInTheDocument();
    });

    it('enables encryption and hides the option once it is on', async () => {
      const room = await makeRoom(client, { name: 'General', encrypted: false });
      vi.spyOn(client, 'sendStateEvent').mockResolvedValue({ event_id: '$1' });
      renderHeader(room);
      await openMenu('Room settings');

      await userEvent.click(screen.getByRole('menuitem', { name: /Enable Encryption/ }));

      await screen.findByText('Encrypted');
      expect(client.sendStateEvent).toHaveBeenCalledWith(room.roomId, EventType.RoomEncryption, { algorithm: 'm.megolm.v1.aes-sha2' }, '');
      expect(screen.queryByRole('menuitem', { name: /Enable Encryption/ })).not.toBeInTheDocument();
      expect(screen.getByText('Encryption cannot be disabled once enabled.')).toBeInTheDocument();
    });

    it('reports a refused encryption change', async () => {
      const room = await makeRoom(client, { name: 'General', encrypted: false });
      vi.spyOn(client, 'sendStateEvent').mockRejectedValue(new MatrixError({ errcode: 'M_FORBIDDEN', error: 'Not allowed' }, 403));
      renderHeader(room);
      await openMenu('Room settings');

      await userEvent.click(screen.getByRole('menuitem', { name: /Enable Encryption/ }));

      await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Could not enable encryption'));
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

    it('offers Leave instead of Kick and Ban on my own row', async () => {
      const room = await makeRoom(client, { name: 'Team', members: [BOB] });
      renderHeader(room);
      await openMenu('Members');

      await userEvent.click(screen.getByText(ME));

      expect(screen.getByRole('menuitem', { name: 'Leave' })).toBeInTheDocument();
      expect(screen.queryByRole('menuitem', { name: 'Kick' })).not.toBeInTheDocument();
      expect(screen.queryByRole('menuitem', { name: 'Ban' })).not.toBeInTheDocument();
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
    let captured: ReturnType<typeof captureMemberActions>;

    beforeEach(() => {
      captured = captureMemberActions();
    });

    afterEach(() => captured.stop());

    it('kicks the selected member through the shared confirm dialog', async () => {
      const room = await makeRoom(client, { name: 'Team', members: [BOB] });
      vi.spyOn(client, 'kick').mockResolvedValue({});
      renderHeader(room);
      await openMenu('Members');
      await userEvent.click(screen.getByText(BOB));

      await userEvent.click(screen.getByRole('menuitem', { name: 'Kick' }));
      await act(() => captured.actions[0].onConfirm());

      expect(client.kick).toHaveBeenCalledWith(room.roomId, BOB, 'Removed');
    });

    it('bans the selected member through the shared confirm dialog', async () => {
      const room = await makeRoom(client, { name: 'Team', members: [BOB] });
      vi.spyOn(client, 'ban').mockResolvedValue({});
      renderHeader(room);
      await openMenu('Members');
      await userEvent.click(screen.getByText(BOB));

      await userEvent.click(screen.getByRole('menuitem', { name: 'Ban' }));
      await act(() => captured.actions[0].onConfirm());

      expect(client.ban).toHaveBeenCalledWith(room.roomId, BOB, 'Banned');
    });

    it('lets the viewer leave the room from their own row', async () => {
      const room = await makeRoom(client, { name: 'Team' });
      vi.spyOn(client, 'leave').mockResolvedValue({});
      const onLeave = vi.fn();
      renderHeader(room, { onLeave });
      await openMenu('Members');
      await userEvent.click(screen.getByText(ME));

      await userEvent.click(screen.getByRole('menuitem', { name: 'Leave' }));
      await act(() => captured.actions[0].onConfirm());

      expect(client.leave).toHaveBeenCalledWith(room.roomId);
      expect(toast.success).toHaveBeenCalledWith('Left room');
      expect(onLeave).toHaveBeenCalledWith(room.roomId);
    });

    it("changes a member's role by resending power levels with only that entry changed", async () => {
      const room = await makeRoom(client, { name: 'Team', members: [BOB] });
      vi.spyOn(client, 'sendStateEvent').mockResolvedValue({ event_id: '$1' });
      renderHeader(room);
      await openMenu('Members');
      await userEvent.click(screen.getByText(BOB));
      await userEvent.click(screen.getByRole('menuitem', { name: 'Role' }));

      await userEvent.click(screen.getByRole('menuitem', { name: 'Moderator' }));
      await act(() => captured.actions[0].onConfirm());

      expect(client.sendStateEvent).toHaveBeenCalledWith(room.roomId, EventType.RoomPowerLevels, { users: { [ME]: 100, [BOB]: 50 }, users_default: 0 }, '');
    });

    it("warns that promoting a member to the viewer's own level cannot be undone", async () => {
      const room = await makeRoom(client, { name: 'Team', members: [BOB] });
      renderHeader(room);
      await openMenu('Members');
      await userEvent.click(screen.getByText(BOB));
      await userEvent.click(screen.getByRole('menuitem', { name: 'Role' }));

      await userEvent.click(screen.getByRole('menuitem', { name: 'Admin' }));

      expect(captured.actions[0].warning).toBe('This can’t be undone: they will have the same power level as you.');
    });

    it('warns that lowering my own power level cannot be undone', async () => {
      const room = await makeRoom(client, { name: 'Team', members: [BOB] });
      renderHeader(room);
      await openMenu('Members');
      await userEvent.click(screen.getByText(ME));
      await userEvent.click(screen.getByRole('menuitem', { name: 'Role' }));

      await userEvent.click(screen.getByRole('menuitem', { name: 'Moderator' }));

      expect(captured.actions[0].warning).toBe('This can’t be undone: you are lowering your own power level.');
    });
  });

  describe('room options', () => {
    it('leaves out Send Invite for a member without the power level to invite', async () => {
      const levels = { users: { [BOB]: 100 }, users_default: 0, invite: 50 };
      const room = await makeRoom(client, { name: 'Announcements', creator: BOB, members: [ME], powerLevels: levels });
      renderHeader(room);

      await openMenu('Room options');

      expect(screen.getAllByRole('menuitem').map((item) => item.textContent)).toEqual(['Copy Room ID', 'Leave Room']);
    });

    it('invites someone to this room and gives focus back to Room options', async () => {
      const room = await makeRoom(client, { name: 'Team' });
      vi.spyOn(client, 'invite').mockResolvedValue({});
      renderHeader(room);
      await openMenu('Room options');

      await userEvent.click(screen.getByRole('menuitem', { name: 'Send Invite' }));
      await userEvent.type(screen.getByRole('textbox', { name: 'Matrix user ID' }), `${CAROL}{Enter}`);

      expect(client.invite).toHaveBeenCalledWith(room.roomId, CAROL);
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Room options' })).toHaveFocus();
    });

    it("puts this room's ID on the clipboard", async () => {
      const user = userEvent.setup();
      const room = await makeRoom(client, { name: 'Team' });
      renderHeader(room);
      screen.getByRole('button', { name: 'Room options' }).focus();
      await user.keyboard('{Enter}');

      await user.click(screen.getByRole('menuitem', { name: 'Copy Room ID' }));

      expect(await navigator.clipboard.readText()).toBe(room.roomId);
      expect(toast.success).toHaveBeenCalledWith('Room ID copied!');
    });

    it('drops an open invite dialog when the client stops, so it does not come back with the client', async () => {
      const room = await makeRoom(client, { name: 'Team' });
      renderHeader(room);
      await openMenu('Room options');
      await userEvent.click(screen.getByRole('menuitem', { name: 'Send Invite' }));

      act(() => emitMatrixNotReady());
      act(() => emitMatrixReady());

      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    it('closes when a dropdown elsewhere in the app opens', async () => {
      const room = await makeRoom(client, { name: 'Team' });
      renderHeader(room);
      await openMenu('Room options');

      act(() => {
        window.dispatchEvent(new Event('nexus-close-dropdowns'));
      });

      expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    });

    it('asks dropdowns elsewhere in the app to close when it opens', async () => {
      const room = await makeRoom(client, { name: 'Team' });
      renderHeader(room);
      const broadcasts: Event[] = [];
      const record = (event: Event) => broadcasts.push(event);
      window.addEventListener('nexus-close-dropdowns', record);
      onTestFinished(() => window.removeEventListener('nexus-close-dropdowns', record));

      await openMenu('Room options');

      expect(screen.getByRole('menu', { name: 'Actions for Team' })).toBeInTheDocument();
      expect(broadcasts).toHaveLength(1);
    });

    it('leaves the room through the confirm dialog, which hands focus back to Room options', async () => {
      const captured = captureMemberActions();
      const room = await makeRoom(client, { name: 'Team' });
      vi.spyOn(client, 'leave').mockResolvedValue({});
      const onLeave = vi.fn();
      renderHeader(room, { onLeave });
      await openMenu('Room options');

      await userEvent.click(screen.getByRole('menuitem', { name: 'Leave Room' }));
      const [request] = captured.actions;
      captured.stop();
      expect(request).toMatchObject({ type: 'leave', roomId: room.roomId, roomName: 'Team' });
      expect(request.returnFocusTo).toBe(screen.getByRole('button', { name: 'Room options' }));
      await act(() => request.onConfirm());

      expect(client.leave).toHaveBeenCalledWith(room.roomId);
      expect(toast.success).toHaveBeenCalledWith('Left room');
      expect(onLeave).toHaveBeenCalledWith(room.roomId);
    });
  });

  describe('device verification', () => {
    /* Opens the member list of an encrypted room with the given unverified devices of Bob and asks to verify his phone */
    const startVerifyingBobsPhone = async (devices: RoomDevice[] = [BOBS_PHONE]) => {
      const room = await makeRoom(client, { name: 'Vault', encrypted: true, members: [BOB] });
      mocks.checkRoomDevices.mockResolvedValue(devices);
      renderHeader(room);
      await openMenu('Members');
      await userEvent.click(await screen.findByRole('menuitem', { name: `Verify ${BOB} · BOBPHONE` }));
    };

    it("lists another member's unverified device in the Security section", async () => {
      const room = await makeRoom(client, { name: 'Vault', encrypted: true, members: [BOB] });
      mocks.checkRoomDevices.mockResolvedValue([BOBS_PHONE]);
      renderHeader(room);

      await openMenu('Members');

      expect(await screen.findByText('Security')).toBeInTheDocument();
      expect(screen.getByRole('menuitem', { name: `Verify ${BOB} · BOBPHONE` })).toBeInTheDocument();
    });

    it("requests verification of that member's own device, never the viewer's", async () => {
      await startVerifyingBobsPhone();

      expect(mocks.requestVerificationToUser).toHaveBeenCalledWith(BOB, ['BOBPHONE']);
    });

    it('shows the emojis to compare once the other device has accepted', async () => {
      await startVerifyingBobsPhone();

      act(() => emitVerificationSnapshot(requestToBobsPhone('showing_sas', { sasEmojis: SAS_EMOJIS })));

      expect(screen.getByText('Compare these emojis:')).toBeInTheDocument();
      expect(screen.getByRole('menu')).toHaveTextContent(SAS_EMOJIS.join(''));
    });

    it('ignores the emojis of a verification request this panel did not send', async () => {
      await startVerifyingBobsPhone();

      act(() =>
        emitVerificationSnapshot({
          ...requestToBobsPhone('showing_sas', { sasEmojis: SAS_EMOJIS }),
          id: 'txn-carol',
          txnId: 'txn-carol',
          fromUserId: CAROL,
          fromDeviceId: 'CAROLPC',
          outgoing: false,
        })
      );

      expect(screen.getByText('Starting verification…')).toBeInTheDocument();
      expect(screen.queryByText('Compare these emojis:')).not.toBeInTheDocument();
    });

    it('confirms matching emojis and drops the verified device from the list', async () => {
      await startVerifyingBobsPhone();
      act(() => emitVerificationSnapshot(requestToBobsPhone('showing_sas', { sasEmojis: SAS_EMOJIS })));
      mocks.checkRoomDevices.mockResolvedValue([]);

      await userEvent.click(screen.getByRole('menuitem', { name: 'They match' }));

      expect(mocks.confirmVerificationRequest).toHaveBeenCalledWith('txn-bobphone');
      await waitFor(() => expect(screen.queryByRole('menuitem', { name: `Verify ${BOB} · BOBPHONE` })).not.toBeInTheDocument());
    });

    it('cancels a running verification and closes its panel', async () => {
      await startVerifyingBobsPhone();
      act(() => emitVerificationSnapshot(requestToBobsPhone('showing_sas', { sasEmojis: SAS_EMOJIS })));

      await userEvent.click(screen.getByRole('menuitem', { name: 'Cancel' }));

      expect(mocks.cancelVerificationRequest).toHaveBeenCalledWith('txn-bobphone');
      expect(screen.queryByText(`Verify device: ${BOB} · BOBPHONE`)).not.toBeInTheDocument();
    });

    it('closes the verification panel when the other device cancels', async () => {
      await startVerifyingBobsPhone();

      act(() => emitVerificationSnapshot(requestToBobsPhone('cancelled', { cancelReason: 'It was cancelled.' })));

      expect(screen.queryByText(`Verify device: ${BOB} · BOBPHONE`)).not.toBeInTheDocument();
    });

    it('closes the verification panel when the request cannot be sent', async () => {
      const request = deferred<VerificationSnapshot>();
      mocks.requestVerificationToUser.mockReturnValue(request.promise);
      await startVerifyingBobsPhone();
      expect(screen.getByText('Starting verification…')).toBeInTheDocument();

      await act(async () => request.reject(new Error('Encryption is not ready yet.')));

      expect(screen.queryByText('Starting verification…')).not.toBeInTheDocument();
    });

    it('lets only one device be verified at a time', async () => {
      await startVerifyingBobsPhone([BOBS_PHONE, BOBS_LAPTOP]);

      expect(screen.getByRole('menuitem', { name: `Verify ${BOB} · BOBLAPTOP` })).toHaveAttribute('aria-disabled', 'true');
    });

    it('cancels a running verification when the user signs out', async () => {
      await startVerifyingBobsPhone();

      act(() => emitMatrixNotReady());

      expect(mocks.cancelVerificationRequest).toHaveBeenCalledWith('txn-bobphone');
    });

    it('lists a device a member adds while the room is open', async () => {
      const room = await makeRoom(client, { name: 'Vault', encrypted: true, members: [BOB] });
      renderHeader(room);
      await openMenu('Members');
      await screen.findByText(BOB);
      mocks.checkRoomDevices.mockResolvedValue([BOBS_PHONE]);

      act(() => {
        client.emit(CryptoEvent.DevicesUpdated, [BOB], false);
      });

      expect(await screen.findByRole('menuitem', { name: `Verify ${BOB} · BOBPHONE` })).toBeInTheDocument();
    });

    it('drops a device from the list once it is verified in another session', async () => {
      const room = await makeRoom(client, { name: 'Vault', encrypted: true, members: [BOB] });
      mocks.checkRoomDevices.mockResolvedValue([BOBS_PHONE]);
      renderHeader(room);
      await openMenu('Members');
      await screen.findByRole('menuitem', { name: `Verify ${BOB} · BOBPHONE` });
      mocks.checkRoomDevices.mockResolvedValue([]);

      act(() => {
        client.emit(CryptoEvent.UserTrustStatusChanged, BOB, new UserVerificationStatus(true, true, false));
      });

      await waitFor(() => expect(screen.queryByRole('menuitem', { name: `Verify ${BOB} · BOBPHONE` })).not.toBeInTheDocument());
    });

    it('keeps the newest device list when an older check answers late', async () => {
      const room = await makeRoom(client, { name: 'Vault', encrypted: true, members: [BOB] });
      const firstCheck = deferred<RoomDevice[]>();
      mocks.checkRoomDevices.mockReturnValueOnce(firstCheck.promise).mockResolvedValue([BOBS_PHONE]);
      renderHeader(room);
      await openMenu('Members');
      act(() => {
        client.emit(CryptoEvent.DevicesUpdated, [BOB], false);
      });
      await screen.findByRole('menuitem', { name: `Verify ${BOB} · BOBPHONE` });

      await act(async () => firstCheck.resolve([]));

      expect(screen.getByRole('menuitem', { name: `Verify ${BOB} · BOBPHONE` })).toBeInTheDocument();
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