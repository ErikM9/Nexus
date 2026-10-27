import { describe, it, expect, vi, onTestFinished } from 'vitest';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ConnectionError, MatrixError } from 'matrix-js-sdk';
import MemberOverlay, { type MemberActionDetail } from '@/app/app-components/MemberOverlay';
import { BOB, CAROL, HS } from '../support/matrixRoom';

const ROOM_ID = `!team:${HS}`;

const DIALOGS = {
  kick: {
    title: 'Kick member',
    confirm: 'Kick',
    question: `Remove ${BOB} from the room? They can rejoin if the room is accessible.`,
    failure: `Failed to kick ${BOB}`,
  },
  ban: {
    title: 'Ban member',
    confirm: 'Ban',
    question: `Permanently ban ${BOB}? They won't be able to rejoin unless a moderator removes the ban.`,
    failure: `Failed to ban ${BOB}`,
  },
  leave: {
    title: 'Leave room',
    confirm: 'Leave',
    question: 'Leave Team? You can rejoin later if the room is publicly accessible or you receive a new invite.',
    failure: 'Failed to leave Team',
  },
  role: {
    title: 'Change role',
    confirm: 'Confirm',
    question: `Change ${BOB}'s role to Moderator? This will update their permissions in the room.`,
    failure: `Failed to change the role of ${BOB}`,
  },
} as const;

const refusal = () => new MatrixError({ errcode: 'M_FORBIDDEN', error: 'You do not have permission to do that' }, 403);

/* A promise the test settles by hand, standing in for a request the homeserver has not answered yet */
const deferred = () => {
  let resolve!: () => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

/* Asks for a confirm dialog the way ChatHeader and ChatList do, with an action that succeeds unless the test replaces it */
const requestAction = (overrides: Partial<MemberActionDetail> = {}) => {
  const detail: MemberActionDetail = {
    type: 'kick',
    targetUserId: BOB,
    roomId: ROOM_ID,
    roomName: 'Team',
    roleLabel: 'Moderator',
    onConfirm: vi.fn(async () => {}),
    ...overrides,
  };
  act(() => {
    window.dispatchEvent(new CustomEvent<MemberActionDetail>('nexus-member-action', { detail }));
  });
  return detail;
};

/* A control of the page behind the dialog, focused the way the menu item that asks for an action is */
const focusedPageButton = (name: string) => {
  const button = document.createElement('button');
  button.textContent = name;
  document.body.append(button);
  onTestFinished(() => button.remove());
  button.focus();
  return button;
};

/* Errors thrown by window event listeners, which jsdom reports on the window rather than to the code that dispatched */
const uncaughtErrors = () => {
  const errors: unknown[] = [];
  const record = (event: ErrorEvent) => errors.push(event.error);
  window.addEventListener('error', record);
  onTestFinished(() => window.removeEventListener('error', record));
  return errors;
};

describe('MemberOverlay', () => {
  it.each([
    ['carries no detail', null],
    ['has no action to run', { type: 'kick', roomId: ROOM_ID }],
    ['names no kind of action', { roomId: ROOM_ID, onConfirm: vi.fn() }],
  ])('ignores a request that %s', (_problem, detail) => {
    const errors = uncaughtErrors();
    render(<MemberOverlay />);

    act(() => {
      window.dispatchEvent(new CustomEvent('nexus-member-action', { detail }));
    });

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(errors).toEqual([]);
  });

  describe.each(Object.keys(DIALOGS) as (keyof typeof DIALOGS)[])('%s dialog', (type) => {
    const { title, confirm, question, failure } = DIALOGS[type];

    it('asks its question under its own title, with a button named after the action', () => {
      render(<MemberOverlay />);

      requestAction({ type });

      const dialog = screen.getByRole('dialog', { name: title });
      expect(dialog).toHaveAccessibleDescription(question);
      expect(within(dialog).getByRole('button', { name: confirm })).toBeEnabled();
    });

    it('reports a refusal in its own words', async () => {
      render(<MemberOverlay />);
      requestAction({ type, onConfirm: vi.fn().mockRejectedValue(refusal()) });

      await userEvent.click(screen.getByRole('button', { name: confirm }));

      expect(within(await screen.findByRole('alert')).getByText(failure)).toBeInTheDocument();
    });
  });

  it.each([
    ['member', { type: 'kick', targetUserId: undefined }, 'Remove this member from the room? They can rejoin if the room is accessible.'],
    ['room name', { type: 'leave', roomName: undefined }, `Leave ${ROOM_ID}? You can rejoin later if the room is publicly accessible or you receive a new invite.`],
    ['role', { type: 'role', roleLabel: undefined }, `Change ${BOB}'s role to the selected role? This will update their permissions in the room.`],
  ] as const)('still asks a complete question when the action names no %s', (_missing, detail, question) => {
    render(<MemberOverlay />);

    requestAction(detail);

    expect(screen.getByRole('dialog')).toHaveAccessibleDescription(question);
  });

  it('shows the warning an action carries', () => {
    render(<MemberOverlay />);

    requestAction({ type: 'role', roleLabel: 'Admin', warning: 'This can’t be undone: they will have the same power level as you.' });

    expect(within(screen.getByRole('dialog')).getByText('This can’t be undone: they will have the same power level as you.')).toBeInTheDocument();
  });

  describe('backing out', () => {
    it.each([
      ['Cancel', () => userEvent.click(screen.getByRole('button', { name: 'Cancel' }))],
      ['the close button', () => userEvent.click(screen.getByRole('button', { name: 'Close' }))],
      ['a press on the backdrop', () => userEvent.click(screen.getByTestId('overlay-backdrop'))],
      ['Escape', () => userEvent.keyboard('{Escape}')],
    ])('closes without running the action on %s', async (_way, backOut) => {
      render(<MemberOverlay />);
      const { onConfirm } = requestAction();

      await backOut();

      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(onConfirm).not.toHaveBeenCalled();
    });

    it('backs out on Enter straight after opening, as focus starts on Cancel', async () => {
      render(<MemberOverlay />);
      const { onConfirm } = requestAction({ type: 'ban' });

      await userEvent.keyboard('{Enter}');

      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(onConfirm).not.toHaveBeenCalled();
    });

    it('keeps Escape from reaching the page behind the dialog', async () => {
      const onPageKeyDown = vi.fn();
      document.addEventListener('keydown', onPageKeyDown);
      onTestFinished(() => document.removeEventListener('keydown', onPageKeyDown));
      render(<MemberOverlay />);
      requestAction();

      await userEvent.keyboard('{Escape}');

      expect(onPageKeyDown).not.toHaveBeenCalled();
    });
  });

  it('closes when the client stops', () => {
    render(<MemberOverlay />);
    requestAction();

    act(() => {
      window.dispatchEvent(new Event('matrix-not-ready'));
    });

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  describe('focus', () => {
    it('keeps Tab inside the dialog, away from the page behind it', async () => {
      focusedPageButton('Members');
      render(<MemberOverlay />);
      requestAction();

      await userEvent.tab();

      expect(screen.getByRole('button', { name: 'Close' })).toHaveFocus();
    });

    it('returns to the control that had focus when the dialog opened', async () => {
      const opener = focusedPageButton('Members');
      render(<MemberOverlay />);
      requestAction();

      await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));

      expect(opener).toHaveFocus();
    });

    it('returns to the element the action names instead, once the action has succeeded', async () => {
      const members = focusedPageButton('Members');
      focusedPageButton('Room settings');
      render(<MemberOverlay />);
      requestAction({ returnFocusTo: members });

      await userEvent.click(screen.getByRole('button', { name: 'Kick' }));

      expect(members).toHaveFocus();
    });

    it('returns to the first opener when a newer action replaced the dialog meanwhile', async () => {
      const opener = focusedPageButton('Members');
      render(<MemberOverlay />);
      requestAction({ type: 'role' });
      requestAction({ type: 'ban' });

      await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));

      expect(opener).toHaveFocus();
    });
  });

  describe('while the action runs', () => {
    const startKick = async () => {
      render(<MemberOverlay />);
      requestAction({ onConfirm: vi.fn(() => new Promise<void>(() => {})) });
      await userEvent.click(screen.getByRole('button', { name: 'Kick' }));
      return screen.getByRole('dialog');
    };

    it('says Please wait… and disables every button', async () => {
      const dialog = await startKick();

      expect(dialog).toHaveAttribute('aria-busy', 'true');
      expect(within(dialog).getByRole('button', { name: 'Please wait…' })).toBeDisabled();
      expect(within(dialog).getByRole('button', { name: 'Cancel' })).toBeDisabled();
      expect(within(dialog).getByRole('button', { name: 'Close' })).toBeDisabled();
    });

    it('holds focus on the dialog itself', async () => {
      const dialog = await startKick();

      expect(dialog).toHaveFocus();
    });

    it.each([
      ['Escape', () => userEvent.keyboard('{Escape}')],
      ['a press on the backdrop', () => userEvent.click(screen.getByTestId('overlay-backdrop'))],
    ])('stays open on %s', async (_way, backOut) => {
      const dialog = await startKick();

      await backOut();

      expect(dialog).toBeInTheDocument();
    });
  });

  describe('when the action succeeds', () => {
    it('runs it once and closes', async () => {
      render(<MemberOverlay />);
      const { onConfirm } = requestAction();

      await userEvent.click(screen.getByRole('button', { name: 'Kick' }));

      expect(onConfirm).toHaveBeenCalledTimes(1);
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
  });

  describe('when the action fails', () => {
    it("adds the homeserver's reason and stays open for another try, with focus on Cancel", async () => {
      render(<MemberOverlay />);
      requestAction({ onConfirm: vi.fn().mockRejectedValue(refusal()) });

      await userEvent.click(screen.getByRole('button', { name: 'Kick' }));

      expect(await screen.findByRole('alert')).toHaveTextContent('You do not have permission to do that');
      expect(screen.getByRole('button', { name: 'Kick' })).toBeEnabled();
      expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus();
    });

    it.each([
      ['gave no answer', new ConnectionError('fetch failed')],
      ['gave no reason', new MatrixError({ errcode: 'M_FORBIDDEN' }, 403)],
    ])('names the failed action alone when the homeserver %s', async (_case, error) => {
      render(<MemberOverlay />);
      requestAction({ onConfirm: vi.fn().mockRejectedValue(error) });

      await userEvent.click(screen.getByRole('button', { name: 'Kick' }));

      expect((await screen.findByRole('alert')).textContent).toBe(`Failed to kick ${BOB}`);
    });

    it('clears the failure while another try runs', async () => {
      render(<MemberOverlay />);
      requestAction({ onConfirm: vi.fn().mockRejectedValueOnce(refusal()).mockReturnValueOnce(new Promise(() => {})) });
      await userEvent.click(screen.getByRole('button', { name: 'Kick' }));
      await screen.findByRole('alert');

      await userEvent.click(screen.getByRole('button', { name: 'Kick' }));

      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });
  });

  describe('when a newer action replaces the dialog', () => {
    it('asks about the newer action, usable at once even if the replaced one is still running', async () => {
      render(<MemberOverlay />);
      requestAction({ onConfirm: vi.fn(() => new Promise<void>(() => {})) });
      await userEvent.click(screen.getByRole('button', { name: 'Kick' }));

      requestAction({ type: 'ban', targetUserId: CAROL });

      const dialog = screen.getByRole('dialog', { name: 'Ban member' });
      expect(dialog).toHaveAccessibleDescription(new RegExp(`^Permanently ban ${CAROL}\\?`));
      expect(within(dialog).getByRole('button', { name: 'Ban' })).toBeEnabled();
    });

    it('stays open when the replaced action succeeds afterwards', async () => {
      const kick = deferred();
      render(<MemberOverlay />);
      requestAction({ onConfirm: vi.fn(() => kick.promise) });
      await userEvent.click(screen.getByRole('button', { name: 'Kick' }));
      requestAction({ type: 'ban', targetUserId: CAROL });

      await act(async () => {
        kick.resolve();
        await kick.promise;
      });

      expect(screen.getByRole('dialog', { name: 'Ban member' })).toBeInTheDocument();
    });

    it('reports nothing when the replaced action fails afterwards', async () => {
      const kick = deferred();
      render(<MemberOverlay />);
      requestAction({ onConfirm: vi.fn(() => kick.promise) });
      await userEvent.click(screen.getByRole('button', { name: 'Kick' }));
      requestAction({ type: 'ban', targetUserId: CAROL });

      await act(async () => {
        kick.reject(refusal());
        await kick.promise.catch(() => {});
      });

      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Ban' })).toBeEnabled();
    });

    it('drops the failure the replaced action had shown', async () => {
      render(<MemberOverlay />);
      requestAction({ onConfirm: vi.fn().mockRejectedValue(refusal()) });
      await userEvent.click(screen.getByRole('button', { name: 'Kick' }));
      await screen.findByRole('alert');

      requestAction({ type: 'ban', targetUserId: CAROL });

      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });
  });
});