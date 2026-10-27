import React, { useState } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import toast from 'react-hot-toast';
import { MatrixError, type MatrixClient } from 'matrix-js-sdk';
import InviteDialog, { isValidUserId } from '@/app/app-components/InviteDialog';
import { CAROL, HS, makeClient } from '../support/matrixRoom';

const ROOM_ID = `!general:${HS}`;

/* A page that closes the dialog like the room list does, with the menu button that opened it and a field to move on to */
const PageWithInviteDialog = ({ client, onClose }: { client: MatrixClient; onClose: () => void }) => {
  const [opener, setOpener] = useState<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(true);
  const close = () => {
    setOpen(false);
    onClose();
  };
  return (
    <>
      <button type="button" ref={setOpener}>
        Open menu for General
      </button>
      <input aria-label="Message" />
      {opener && open && <InviteDialog client={client} roomId={ROOM_ID} onClose={close} returnFocusTo={opener} />}
    </>
  );
};

/* A real client whose invite stays unanswered unless a test settles it, which keeps the dialog in its sending state */
const setup = () => {
  const client = makeClient();
  const invite = vi.spyOn(client, 'invite').mockReturnValue(new Promise(() => {}));
  const onClose = vi.fn();
  render(<PageWithInviteDialog client={client} onClose={onClose} />);
  const opener = screen.getByRole('button', { name: 'Open menu for General' });
  return { invite, onClose, opener, input: screen.getByLabelText('Matrix user ID') };
};

describe('isValidUserId', () => {
  it.each([CAROL, '@carol:hs.test:8448', '@carol:[::1]', '@some.one_else=2:example.org'])('accepts %s', (id) => {
    expect(isValidUserId(id)).toBe(true);
  });

  it.each(['carol', '@carol', 'carol:hs.test', '@:hs.test', '@car ol:hs.test', '@carol:hs test'])('rejects %s', (id) => {
    expect(isValidUserId(id)).toBe(false);
  });

  it('accepts an ID of 255 characters and rejects a longer one', () => {
    const idOfLength = (length: number) => `@${'a'.repeat(length - '@:hs.test'.length)}:hs.test`;

    expect(isValidUserId(idOfLength(255))).toBe(true);
    expect(isValidUserId(idOfLength(256))).toBe(false);
  });
});

describe('InviteDialog', () => {
  it('explains a malformed user ID instead of sending it', async () => {
    const { invite, input } = setup();

    await userEvent.type(input, 'carol{Enter}');

    expect(screen.getByRole('alert')).toHaveTextContent('Enter a full Matrix ID, like @name:server');
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(invite).not.toHaveBeenCalled();
  });

  it('drops the explanation as soon as the ID is edited', async () => {
    const { input } = setup();
    await userEvent.type(input, 'carol{Enter}');

    await userEvent.type(input, ':');

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(input).not.toHaveAttribute('aria-invalid');
  });

  it('sends one invite however often Invite is pressed while it is on its way', async () => {
    const { invite, input } = setup();
    await userEvent.type(input, CAROL);
    const button = screen.getByRole('button', { name: 'Invite' });

    await userEvent.click(button);
    await userEvent.click(button);
    await userEvent.type(input, '{Enter}');

    expect(invite).toHaveBeenCalledTimes(1);
    expect(invite).toHaveBeenCalledWith(ROOM_ID, CAROL);
    expect(button).toBeDisabled();
  });

  it('leaves Enter that confirms a composition to the composition', async () => {
    const { invite, input } = setup();
    await userEvent.type(input, CAROL);

    fireEvent.keyDown(input, { key: 'Enter', isComposing: true });
    fireEvent.keyDown(input, { key: 'Enter', keyCode: 229 });

    expect(invite).not.toHaveBeenCalled();
  });

  it('reports an invite the server refused and lets it be sent again', async () => {
    const { invite, input } = setup();
    invite.mockRejectedValueOnce(new MatrixError({ errcode: 'M_FORBIDDEN', error: 'User is banned' }, 403));
    await userEvent.type(input, `${CAROL}{Enter}`);

    await userEvent.click(screen.getByRole('button', { name: 'Invite' }));

    expect(toast.error).toHaveBeenCalledWith('Invite failed');
    expect(invite).toHaveBeenCalledTimes(2);
  });

  describe('focus', () => {
    it('keeps Tab inside the dialog', async () => {
      const { input } = setup();
      expect(input).toHaveFocus();

      await userEvent.tab();

      expect(screen.getByRole('button', { name: 'Close' })).toHaveFocus();
    });

    it('closes with Escape and gives focus back to the element that opened it', async () => {
      const { onClose, opener } = setup();

      await userEvent.keyboard('{Escape}');

      expect(onClose).toHaveBeenCalledTimes(1);
      expect(opener).toHaveFocus();
    });

    it('closes and gives focus back once the invite is sent', async () => {
      const { invite, input, onClose, opener } = setup();
      invite.mockResolvedValue({});

      await userEvent.type(input, `${CAROL}{Enter}`);

      expect(toast.success).toHaveBeenCalledWith('Invited!');
      expect(onClose).toHaveBeenCalledTimes(1);
      expect(opener).toHaveFocus();
    });

    it('leaves focus where it is when the invite is answered after the dialog was dismissed', async () => {
      const { invite, input, onClose } = setup();
      let answer!: () => void;
      invite.mockReturnValue(
        new Promise((resolve) => {
          answer = () => resolve({});
        })
      );
      await userEvent.type(input, `${CAROL}{Enter}`);
      await userEvent.keyboard('{Escape}');
      await userEvent.click(screen.getByLabelText('Message'));

      await act(async () => answer());

      expect(toast.success).toHaveBeenCalledWith('Invited!');
      expect(onClose).toHaveBeenCalledTimes(1);
      expect(screen.getByLabelText('Message')).toHaveFocus();
    });
  });
});