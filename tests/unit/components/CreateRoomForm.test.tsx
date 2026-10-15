import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import toast from 'react-hot-toast';
import { MatrixError, Preset, Visibility } from 'matrix-js-sdk';

vi.mock('@/app/utils/matrix', () => ({ getCryptoReady: vi.fn(() => true) }));

import CreateRoomForm from '@/app/app-components/CreateRoomForm';
import { getCryptoReady } from '@/app/utils/matrix';
import { makeClient } from '../support/matrixRoom';

const NEW_ROOM_ID = '!new:hs.test';

const ENCRYPTION_STATE = [{ type: 'm.room.encryption', state_key: '', content: { algorithm: 'm.megolm.v1.aes-sha2' } }];

/* A real client whose createRoom call stays unanswered unless a test answers it, keeping the form in its creating state */
const setup = () => {
  const client = makeClient();
  const createRoom = vi.spyOn(client, 'createRoom').mockReturnValue(new Promise(() => {}));
  const onCreated = vi.fn();
  const view = render(<CreateRoomForm client={client} onCreated={onCreated} />);
  return { createRoom, onCreated, ...view };
};

/* Opens the room type list with the keyboard, as Radix selects open on key presses in any environment, and picks an option */
const pickRoomType = async (option: string) => {
  screen.getByRole('combobox', { name: 'Room type' }).focus();
  await userEvent.keyboard('{Enter}');
  await userEvent.click(await screen.findByRole('option', { name: option }));
};

describe('CreateRoomForm', () => {
  /* The open room type list scrolls its selected option into view, which jsdom cannot do */
  beforeEach(() => {
    Element.prototype.scrollIntoView = vi.fn();
  });

  afterEach(() => {
    Reflect.deleteProperty(Element.prototype, 'scrollIntoView');
  });

  it('names the room type select', () => {
    setup();

    expect(screen.getByRole('combobox', { name: 'Room type' })).toHaveTextContent('🌍 Public (Unencrypted)');
  });

  describe('creating a room', () => {
    it.each([
      ['a public, unencrypted, directory-listed', '🌍 Public (Unencrypted)', { preset: Preset.PublicChat, visibility: Visibility.Public }],
      ['a public, encrypted, directory-listed', '🛡️ Public (Encrypted)', { preset: Preset.PublicChat, visibility: Visibility.Public, initial_state: ENCRYPTION_STATE }],
      ['a private, unencrypted, unlisted', '🔒 Private (Unencrypted)', { preset: Preset.PrivateChat, visibility: Visibility.Private }],
      ['a private, encrypted, unlisted', '🔐 Private (Encrypted)', { preset: Preset.PrivateChat, visibility: Visibility.Private, initial_state: ENCRYPTION_STATE }],
    ])('asks the server for %s room', async (_kind, option, expected) => {
      const { createRoom } = setup();
      await userEvent.type(screen.getByLabelText('Room name'), 'Ideas');
      await pickRoomType(option);

      await userEvent.click(screen.getByRole('button', { name: 'Create' }));

      expect(createRoom).toHaveBeenCalledWith({ name: 'Ideas', ...expected });
    });

    it('leaves out spaces around the room name', async () => {
      const { createRoom } = setup();
      await userEvent.type(screen.getByLabelText('Room name'), '  Ideas  ');

      await userEvent.click(screen.getByRole('button', { name: 'Create' }));

      expect(createRoom).toHaveBeenCalledWith(expect.objectContaining({ name: 'Ideas' }));
    });

    it('hands the new room to the list with its name, encryption and privacy', async () => {
      const { createRoom, onCreated } = setup();
      createRoom.mockResolvedValue({ room_id: NEW_ROOM_ID });
      await userEvent.type(screen.getByLabelText('Room name'), 'Ideas');
      await pickRoomType('🔐 Private (Encrypted)');

      await userEvent.click(screen.getByRole('button', { name: 'Create' }));

      expect(onCreated).toHaveBeenCalledWith(NEW_ROOM_ID, { name: 'Ideas', isEncrypted: true, isPublic: false });
      expect(toast.success).toHaveBeenCalledWith('Room created!');
    });

    it('returns to an empty name and the default type once the room exists', async () => {
      const { createRoom } = setup();
      createRoom.mockResolvedValue({ room_id: NEW_ROOM_ID });
      await userEvent.type(screen.getByLabelText('Room name'), 'Ideas');
      await pickRoomType('🔐 Private (Encrypted)');

      await userEvent.click(screen.getByRole('button', { name: 'Create' }));

      expect(screen.getByLabelText('Room name')).toHaveValue('');
      expect(screen.getByRole('combobox', { name: 'Room type' })).toHaveTextContent('🌍 Public (Unencrypted)');
    });
  });

  describe('guards', () => {
    it('keeps Create disabled while the name is only spaces', async () => {
      setup();

      await userEvent.type(screen.getByLabelText('Room name'), '   ');

      expect(screen.getByRole('button', { name: 'Create' })).toBeDisabled();
    });

    it('creates one room however often Create is pressed while the request is on its way', async () => {
      const { createRoom } = setup();
      await userEvent.type(screen.getByLabelText('Room name'), 'Ideas');
      const create = screen.getByRole('button', { name: 'Create' });

      await userEvent.click(create);
      await userEvent.click(create);

      expect(createRoom).toHaveBeenCalledTimes(1);
      expect(create).toBeDisabled();
    });

    it('refuses an encrypted room while encryption is not ready', async () => {
      vi.mocked(getCryptoReady).mockReturnValue(false);
      const { createRoom } = setup();
      await userEvent.type(screen.getByLabelText('Room name'), 'Vault');
      await pickRoomType('🔐 Private (Encrypted)');

      await userEvent.click(screen.getByRole('button', { name: 'Create' }));

      expect(toast.error).toHaveBeenCalledWith('Crypto not ready for encrypted room');
      expect(createRoom).not.toHaveBeenCalled();
    });

    it('still creates an unencrypted room while encryption is not ready', async () => {
      vi.mocked(getCryptoReady).mockReturnValue(false);
      const { createRoom } = setup();
      await userEvent.type(screen.getByLabelText('Room name'), 'Lobby');

      await userEvent.click(screen.getByRole('button', { name: 'Create' }));

      expect(createRoom).toHaveBeenCalledTimes(1);
    });
  });

  describe('when the server refuses', () => {
    it('reports the failure, keeps the name and lets the user try again', async () => {
      const { createRoom, onCreated } = setup();
      createRoom.mockRejectedValue(new MatrixError({ errcode: 'M_FORBIDDEN', error: 'You are not allowed to create rooms' }, 403));
      await userEvent.type(screen.getByLabelText('Room name'), 'Ideas');

      await userEvent.click(screen.getByRole('button', { name: 'Create' }));

      expect(toast.error).toHaveBeenCalledWith('Failed to create room');
      expect(screen.getByLabelText('Room name')).toHaveValue('Ideas');
      expect(screen.getByRole('button', { name: 'Create' })).toBeEnabled();
      expect(onCreated).not.toHaveBeenCalled();
    });
  });

  describe('signing out', () => {
    it('clears the name and the room type and disables the form', async () => {
      const { onCreated, rerender } = setup();
      await userEvent.type(screen.getByLabelText('Room name'), 'Ideas');
      await pickRoomType('🔐 Private (Encrypted)');

      rerender(<CreateRoomForm client={null} onCreated={onCreated} />);

      expect(screen.getByLabelText('Room name')).toHaveValue('');
      expect(screen.getByLabelText('Room name')).toBeDisabled();
      expect(screen.getByRole('combobox', { name: 'Room type' })).toHaveTextContent('🌍 Public (Unencrypted)');
      expect(screen.getByRole('combobox', { name: 'Room type' })).toBeDisabled();
      expect(screen.getByRole('button', { name: 'Create' })).toBeDisabled();
    });
  });
});