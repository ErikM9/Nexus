import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import InviteDialog, { isValidUserId } from '@/app/app-components/InviteDialog';
import { CAROL, HS, makeClient } from '../support/matrixRoom';

const ROOM_ID = `!general:${HS}`;

/* A real client whose invite request never answers, so the dialog stays in its sending state */
const setup = () => {
  const client = makeClient();
  const invite = vi.spyOn(client, 'invite').mockReturnValue(new Promise(() => {}));
  render(<InviteDialog client={client} roomId={ROOM_ID} onClose={vi.fn()} />);
  return { invite, input: screen.getByLabelText('Matrix user ID') };
};

describe('isValidUserId', () => {
  it.each([CAROL, '@carol:hs.test:8448', '@carol:[::1]', '@some.one_else=2:example.org'])('accepts %s', (id) => {
    expect(isValidUserId(id)).toBe(true);
  });

  it.each(['carol', '@carol', 'carol:hs.test', '@:hs.test', '@car ol:hs.test', '@carol:hs test', `@${'a'.repeat(260)}:hs.test`])(
    'rejects %s',
    (id) => {
      expect(isValidUserId(id)).toBe(false);
    }
  );
});

describe('InviteDialog', () => {
  it('explains a malformed user ID instead of sending it', async () => {
    const { invite, input } = setup();

    await userEvent.type(input, 'carol{Enter}');

    expect(screen.getByRole('alert')).toHaveTextContent('Enter a full Matrix ID, like @name:server');
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(invite).not.toHaveBeenCalled();
  });

  it('sends one invite however often Invite is pressed while it is on its way', async () => {
    const { invite, input } = setup();
    await userEvent.type(input, CAROL);
    const button = screen.getByRole('button', { name: 'Invite' });

    await userEvent.click(button);
    fireEvent.click(button);
    fireEvent.keyDown(input, { key: 'Enter' });

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

  it('closes with Escape and gives focus back to the element that opened it', async () => {
    const opener = document.createElement('button');
    document.body.append(opener);
    const client = makeClient();
    const onClose = vi.fn();
    render(<InviteDialog client={client} roomId={ROOM_ID} onClose={onClose} returnFocusTo={opener} />);

    await userEvent.keyboard('{Escape}');

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(opener).toHaveFocus();
    opener.remove();
  });
});