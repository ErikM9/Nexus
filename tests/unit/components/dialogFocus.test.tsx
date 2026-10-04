import { describe, it, expect } from 'vitest';
import { useRef } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { trapTabKey } from '@/app/app-components/dialogFocus';

/* A page control followed by a dialog that traps Tab the way MemberOverlay and InviteDialog do */
const PageWithDialog = () => {
  const ref = useRef<HTMLDivElement | null>(null);
  return (
    <>
      <button type="button">Behind the dialog</button>
      <div ref={ref} role="dialog" aria-label="Dialog" onKeyDown={(e) => trapTabKey(e, ref.current)}>
        <button type="button">First</button>
        <button type="button" disabled>
          Unavailable
        </button>
        <input aria-label="Middle" />
        <button type="button">Last</button>
      </div>
    </>
  );
};

describe('trapTabKey', () => {
  it('moves from the last control of the dialog back to the first on Tab', async () => {
    render(<PageWithDialog />);
    screen.getByRole('button', { name: 'Last' }).focus();

    await userEvent.tab();

    expect(screen.getByRole('button', { name: 'First' })).toHaveFocus();
  });

  it('moves from the first control of the dialog to the last on Shift+Tab', async () => {
    render(<PageWithDialog />);
    screen.getByRole('button', { name: 'First' }).focus();

    await userEvent.tab({ shift: true });

    expect(screen.getByRole('button', { name: 'Last' })).toHaveFocus();
  });

  it('lets Tab move normally between controls inside the dialog, skipping disabled ones', async () => {
    render(<PageWithDialog />);
    screen.getByRole('button', { name: 'First' }).focus();

    await userEvent.tab();

    expect(screen.getByRole('textbox', { name: 'Middle' })).toHaveFocus();
  });
});