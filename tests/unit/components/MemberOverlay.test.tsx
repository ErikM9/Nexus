import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { MatrixError } from 'matrix-js-sdk';
import MemberOverlay, { type MemberActionDetail } from '@/app/app-components/MemberOverlay';

/* Fires a nexus-member-action event with defaults and returns the detail for assertions */
function dispatch(overrides: Partial<MemberActionDetail> = {}) {
  const detail = {
    type: 'kick' as const,
    targetUserId: '@target:matrix.org',
    roomId: '!room:matrix.org',
    roomName: 'Test Room',
    onConfirm: vi.fn(),
    ...overrides,
  };
  act(() => {
    window.dispatchEvent(new CustomEvent('nexus-member-action', { detail }));
  });
  return detail;
}

describe('MemberOverlay', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('rendering', () => {
    it('renders nothing before any event is dispatched', () => {
      const { container } = render(<MemberOverlay />);
      expect(container).toBeEmptyDOMElement();
    });

    it('appears when a nexus-member-action event fires', () => {
      render(<MemberOverlay />);
      dispatch({ type: 'kick' });
      expect(screen.queryByTestId('member-overlay')).toBeInTheDocument();
    });

    it('has dialog role and aria-modal attribute', () => {
      render(<MemberOverlay />);
      dispatch({ type: 'kick' });
      const dialog = screen.getByRole('dialog');
      expect(dialog).toHaveAttribute('aria-modal', 'true');
    });

    it('has an accessible close button', () => {
      render(<MemberOverlay />);
      dispatch({ type: 'kick' });
      expect(screen.queryByLabelText('Close')).toBeInTheDocument();
    });
  });

  describe('kick dialog', () => {
    it('shows "Kick member" as the title', () => {
      render(<MemberOverlay />);
      dispatch({ type: 'kick', targetUserId: '@alice:matrix.org' });
      expect(screen.getByTestId('overlay-title')).toHaveTextContent('Kick member');
    });

    it('target user ID appears in the description', () => {
      render(<MemberOverlay />);
      dispatch({ type: 'kick', targetUserId: '@alice:matrix.org' });
      expect(screen.getByTestId('overlay-description')).toHaveTextContent('@alice:matrix.org');
    });

    it('has a "Kick" confirm button', () => {
      render(<MemberOverlay />);
      dispatch({ type: 'kick' });
      expect(screen.getByTestId('overlay-confirm')).toHaveTextContent('Kick');
    });

    it('info box mentions removal', () => {
      render(<MemberOverlay />);
      dispatch({ type: 'kick' });
      expect(screen.getByTestId('member-overlay')).toHaveTextContent(/remove/i);
    });
  });

  describe('ban dialog', () => {
    it('shows "Ban member" as the title', () => {
      render(<MemberOverlay />);
      dispatch({ type: 'ban', targetUserId: '@bob:matrix.org' });
      expect(screen.getByTestId('overlay-title')).toHaveTextContent('Ban member');
    });

    it('target user ID appears in the description', () => {
      render(<MemberOverlay />);
      dispatch({ type: 'ban', targetUserId: '@bob:matrix.org' });
      expect(screen.getByTestId('overlay-description')).toHaveTextContent('@bob:matrix.org');
    });

    it('has a "Ban" confirm button', () => {
      render(<MemberOverlay />);
      dispatch({ type: 'ban' });
      expect(screen.getByTestId('overlay-confirm')).toHaveTextContent('Ban');
    });

    it('info box mentions permanent ban', () => {
      render(<MemberOverlay />);
      dispatch({ type: 'ban' });
      expect(screen.getByTestId('member-overlay')).toHaveTextContent(/ban/i);
    });
  });

  describe('leave dialog', () => {
    it('shows "Leave room" as the title', () => {
      render(<MemberOverlay />);
      dispatch({ type: 'leave', roomName: 'General' });
      expect(screen.getByTestId('overlay-title')).toHaveTextContent('Leave room');
    });

    it('room name appears in the description', () => {
      render(<MemberOverlay />);
      dispatch({ type: 'leave', roomName: 'General Chat' });
      expect(screen.getByTestId('overlay-description')).toHaveTextContent('General Chat');
    });

    it('falls back to roomId in description when roomName is absent', () => {
      render(<MemberOverlay />);
      dispatch({ type: 'leave', roomName: undefined as any, roomId: '!fallback:matrix.org' });
      expect(screen.getByTestId('overlay-description')).toHaveTextContent('!fallback:matrix.org');
    });

    it('has a "Leave" confirm button', () => {
      render(<MemberOverlay />);
      dispatch({ type: 'leave', roomName: 'A Room' });
      expect(screen.getByTestId('overlay-confirm')).toHaveTextContent('Leave');
    });

    it('description does not contain a user ID for a leave action', () => {
      render(<MemberOverlay />);
      dispatch({ type: 'leave', roomName: 'A Room', targetUserId: undefined });
      expect(screen.getByTestId('overlay-description')).toHaveTextContent('A Room');
      expect(screen.getByTestId('overlay-description')).not.toHaveTextContent('@');
    });
  });

  describe('role change dialog', () => {
    it('shows "Change role" as the title', () => {
      render(<MemberOverlay />);
      dispatch({ type: 'role', targetUserId: '@carol:matrix.org', roleLabel: 'Moderator' });
      expect(screen.getByTestId('overlay-title')).toHaveTextContent('Change role');
    });

    it('target user ID appears in the description', () => {
      render(<MemberOverlay />);
      dispatch({ type: 'role', targetUserId: '@carol:matrix.org', roleLabel: 'Admin' });
      expect(screen.getByTestId('overlay-description')).toHaveTextContent('@carol:matrix.org');
    });

    it('includes the target role name in the info box', () => {
      render(<MemberOverlay />);
      dispatch({ type: 'role', roleLabel: 'Moderator' });
      expect(screen.getByTestId('member-overlay')).toHaveTextContent('Moderator');
    });

    it('has a "Confirm" button (not a destructive label)', () => {
      render(<MemberOverlay />);
      dispatch({ type: 'role', roleLabel: 'Member' });
      expect(screen.getByTestId('overlay-confirm')).toHaveTextContent('Confirm');
    });
  });

  describe('cancel behaviour', () => {
    it('Cancel button dismisses the overlay without calling onConfirm', async () => {
      render(<MemberOverlay />);
      const { onConfirm } = dispatch({ type: 'kick' });

      fireEvent.click(screen.getByTestId('overlay-cancel'));

      await waitFor(() => {
        expect(screen.queryByTestId('member-overlay')).not.toBeInTheDocument();
      });
      expect(onConfirm).not.toHaveBeenCalled();
    });

    it('close button (×) dismisses the overlay without calling onConfirm', async () => {
      render(<MemberOverlay />);
      const { onConfirm } = dispatch({ type: 'ban' });

      fireEvent.click(screen.getByLabelText('Close'));

      await waitFor(() => {
        expect(screen.queryByTestId('member-overlay')).not.toBeInTheDocument();
      });
      expect(onConfirm).not.toHaveBeenCalled();
    });

    it('clicking the backdrop dismisses the overlay without calling onConfirm', async () => {
      render(<MemberOverlay />);
      const { onConfirm } = dispatch({ type: 'leave', roomName: 'A Room' });

      fireEvent.click(screen.getByTestId('overlay-backdrop'));

      await waitFor(() => {
        expect(screen.queryByTestId('member-overlay')).not.toBeInTheDocument();
      });
      expect(onConfirm).not.toHaveBeenCalled();
    });
  });

  describe('confirm behaviour', () => {
    it('calls onConfirm when the confirm button is clicked', async () => {
      render(<MemberOverlay />);
      const { onConfirm } = dispatch({ type: 'kick' });

      fireEvent.click(screen.getByTestId('overlay-confirm'));

      await waitFor(() => { expect(onConfirm).toHaveBeenCalledTimes(1); });
    });

    it('closes the overlay after onConfirm resolves', async () => {
      render(<MemberOverlay />);
      dispatch({ type: 'ban', onConfirm: vi.fn().mockResolvedValue(undefined) });

      fireEvent.click(screen.getByTestId('overlay-confirm'));

      await waitFor(() => {
        expect(screen.queryByTestId('member-overlay')).not.toBeInTheDocument();
      });
    });

    it('keeps the dialog open with the server\'s reason when the action is refused', async () => {
      render(<MemberOverlay />);
      const refusal = new MatrixError({ errcode: 'M_FORBIDDEN', error: 'Cannot remove this user' }, 403);
      dispatch({ type: 'kick', targetUserId: '@carol:hs.test', onConfirm: vi.fn().mockRejectedValue(refusal) });

      fireEvent.click(screen.getByTestId('overlay-confirm'));

      expect(await screen.findByRole('alert')).toHaveTextContent('Failed to kick @carol:hs.testCannot remove this user');
      expect(screen.getByTestId('overlay-confirm')).toBeEnabled();
      expect(screen.getByTestId('overlay-cancel')).toHaveFocus();
    });

    it('reports a failure without a server reason by its action alone', async () => {
      render(<MemberOverlay />);
      dispatch({ type: 'leave', roomName: 'A Room', onConfirm: vi.fn().mockRejectedValue(new Error('offline')) });

      fireEvent.click(screen.getByTestId('overlay-confirm'));

      expect(await screen.findByRole('alert')).toHaveTextContent(/^Failed to leave A Room$/);
    });

    it('shows a warning that comes with the action', () => {
      render(<MemberOverlay />);

      dispatch({ type: 'role', targetUserId: '@carol:hs.test', roleLabel: 'Admin', warning: 'This can’t be undone.' });

      expect(screen.getByTestId('overlay-warning')).toHaveTextContent('This can’t be undone.');
    });

    it('gives focus back to the requested element when it closes', async () => {
      const opener = document.createElement('button');
      document.body.append(opener);
      render(<MemberOverlay />);
      dispatch({ type: 'kick', returnFocusTo: opener, onConfirm: vi.fn().mockResolvedValue(undefined) });

      fireEvent.click(screen.getByTestId('overlay-confirm'));

      await waitFor(() => expect(opener).toHaveFocus());
      opener.remove();
    });

    it('shows "Please wait…" and disables all controls while onConfirm is in progress', async () => {
      let resolveFn!: () => void;
      const slowConfirm = vi.fn(() => new Promise<void>((res) => { resolveFn = res; }));

      render(<MemberOverlay />);
      dispatch({ type: 'kick', onConfirm: slowConfirm });

      fireEvent.click(screen.getByTestId('overlay-confirm'));

      await waitFor(() => {
        expect(screen.getByTestId('overlay-confirm')).toHaveTextContent('Please wait');
      });

      expect(screen.getByTestId('overlay-confirm')).toBeDisabled();
      expect(screen.getByTestId('overlay-cancel')).toBeDisabled();
      expect(screen.getByLabelText('Close')).toBeDisabled();

      await act(async () => { resolveFn(); });
    });

    it('backdrop click does nothing while busy', async () => {
      let resolveFn!: () => void;
      const slowConfirm = vi.fn(() => new Promise<void>((res) => { resolveFn = res; }));

      render(<MemberOverlay />);
      dispatch({ type: 'ban', onConfirm: slowConfirm });

      fireEvent.click(screen.getByTestId('overlay-confirm'));
      await waitFor(() => { expect(screen.getByTestId('overlay-confirm')).toBeDisabled(); });

      fireEvent.click(screen.getByTestId('overlay-backdrop'));
      expect(screen.queryByTestId('member-overlay')).toBeInTheDocument();

      await act(async () => { resolveFn(); });
    });
  });

  describe('sequential events', () => {
    it('replaces a pending dialog when a second event fires before confirming', async () => {
      render(<MemberOverlay />);

      dispatch({ type: 'kick', targetUserId: '@alice:matrix.org' });
      expect(screen.getByTestId('overlay-title')).toHaveTextContent('Kick member');

      dispatch({ type: 'ban', targetUserId: '@bob:matrix.org' });

      await waitFor(() => {
        expect(screen.getByTestId('overlay-title')).toHaveTextContent('Ban member');
        expect(screen.getByTestId('overlay-description')).toHaveTextContent('@bob:matrix.org');
      });
    });

    /* The overlay resets correctly between sequential events */
    it('shows a fresh dialog after a previous one is dismissed', async () => {
      render(<MemberOverlay />);

      dispatch({ type: 'kick' });
      fireEvent.click(screen.getByTestId('overlay-cancel'));
      await waitFor(() => { expect(screen.queryByTestId('member-overlay')).not.toBeInTheDocument(); });

      dispatch({ type: 'leave', roomName: 'Second Room' });
      expect(screen.getByTestId('overlay-title')).toHaveTextContent('Leave room');
      expect(screen.getByTestId('overlay-description')).toHaveTextContent('Second Room');
    });

    it('ignores events without a valid type or onConfirm', () => {
      render(<MemberOverlay />);

      /* Missing onConfirm, so the overlay rejects the event and stays closed */
      act(() => {
        window.dispatchEvent(new CustomEvent('nexus-member-action', { detail: { type: 'kick' } }));
      });
      expect(screen.queryByTestId('member-overlay')).not.toBeInTheDocument();

      /* Null detail should not crash */
      act(() => {
        window.dispatchEvent(new CustomEvent('nexus-member-action', { detail: null }));
      });
      expect(screen.queryByTestId('member-overlay')).not.toBeInTheDocument();
    });
  });
});