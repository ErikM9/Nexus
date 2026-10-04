import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Preset, Visibility } from 'matrix-js-sdk';

vi.mock('@/app/utils/matrix', () => ({ getCryptoReady: vi.fn(() => true) }));

import CreateRoomForm from '@/app/app-components/CreateRoomForm';
import { makeClient } from '../support/matrixRoom';

/* A real client whose createRoom request never answers, so the form stays in its creating state */
const setup = () => {
  const client = makeClient();
  const createRoom = vi.spyOn(client, 'createRoom').mockReturnValue(new Promise(() => {}));
  render(<CreateRoomForm client={client} onCreated={vi.fn()} />);
  return { createRoom };
};

describe('CreateRoomForm', () => {
  it('creates one room however often Create is pressed while the request is on its way', async () => {
    const { createRoom } = setup();
    await userEvent.type(screen.getByLabelText('Room name'), 'Ideas');
    const create = screen.getByRole('button', { name: 'Create' });

    await userEvent.click(create);
    fireEvent.click(create);

    expect(createRoom).toHaveBeenCalledTimes(1);
    expect(create).toBeDisabled();
  });

  it('publishes a public room to the directory', async () => {
    const { createRoom } = setup();
    await userEvent.type(screen.getByLabelText('Room name'), 'Ideas');

    await userEvent.click(screen.getByRole('button', { name: 'Create' }));

    expect(createRoom).toHaveBeenCalledWith({ name: 'Ideas', preset: Preset.PublicChat, visibility: Visibility.Public });
  });

  it('names the room type select', () => {
    setup();

    expect(screen.getByRole('combobox', { name: 'Room type' })).toHaveTextContent('🌍 Public (Unencrypted)');
  });
});