import { describe, it, expect } from 'vitest';
import { useRef } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { trapTabKey } from '@/app/app-components/dialogFocus';

/* A page control and a dialog that traps Tab like MemberOverlay, whose controls are all disabled while it is busy */
const PageWithDialog = ({ busy = false }: { busy?: boolean }) => {
  const ref = useRef<HTMLDivElement | null>(null);
  return (
    <>
      <button type="button">Behind the dialog</button>
      <div ref={ref} role="dialog" aria-label="Dialog" tabIndex={-1} onKeyDown={(e) => trapTabKey(e, ref.current)}>
        <button type="button" disabled={busy}>
          First
        </button>
        <input aria-label="Middle" disabled={busy} />
        <button type="button" disabled={busy}>
          Last
        </button>
        <button type="button" disabled>
          Unavailable
        </button>
      </div>
    </>
  );
};

describe('trapTabKey', () => {
  it('moves from the last enabled control of the dialog back to the first on Tab', async () => {
    render(<PageWithDialog />);
    screen.getByRole('button', { name: 'Last' }).focus();

    await userEvent.tab();

    expect(screen.getByRole('button', { name: 'First' })).toHaveFocus();
  });

  it('moves from the first control of the dialog to the last enabled one on Shift+Tab', async () => {
    render(<PageWithDialog />);
    screen.getByRole('button', { name: 'First' }).focus();

    await userEvent.tab({ shift: true });

    expect(screen.getByRole('button', { name: 'Last' })).toHaveFocus();
  });

  it('lets Tab move normally between controls inside the dialog', async () => {
    render(<PageWithDialog />);
    screen.getByRole('button', { name: 'First' }).focus();

    await userEvent.tab();

    expect(screen.getByRole('textbox', { name: 'Middle' })).toHaveFocus();
  });

  it('moves from the dialog itself to its last enabled control on Shift+Tab', async () => {
    render(<PageWithDialog />);
    screen.getByRole('dialog').focus();

    await userEvent.tab({ shift: true });

    expect(screen.getByRole('button', { name: 'Last' })).toHaveFocus();
  });

  it('keeps focus on a dialog whose controls are all disabled', async () => {
    render(<PageWithDialog busy />);
    screen.getByRole('dialog').focus();

    await userEvent.tab();

    expect(screen.getByRole('dialog')).toHaveFocus();
  });

  it('leaves keys other than Tab alone', async () => {
    render(<PageWithDialog />);
    screen.getByRole('button', { name: 'Last' }).focus();

    await userEvent.keyboard('{ArrowDown}');

    expect(screen.getByRole('button', { name: 'Last' })).toHaveFocus();
  });
});