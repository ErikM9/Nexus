import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import AppHeader from '@/app/app-components/AppHeader';
import { logoutMatrixClient } from '@/app/utils/matrix';
import { hardClientReset } from '@/app/utils/helpers';

const mockPush = vi.fn();
const mockReplace = vi.fn();
let mockPathname = '/chat';

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: mockPush,
    replace: mockReplace,
  }),
  usePathname: () => mockPathname,
}));

const mockSetTheme = vi.fn();
let mockTheme = 'light';

vi.mock('next-themes', () => ({
  useTheme: () => ({
    theme: mockTheme,
    setTheme: mockSetTheme,
  }),
}));

vi.mock('react-hot-toast', () => ({
  default: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('@/app/utils/matrix', () => ({
  logoutMatrixClient: vi.fn(),
}));

vi.mock('@/app/utils/helpers', () => ({
  SESSION_STORAGE_KEYS: ['mx_session', 'mx_access_token', 'mx_refresh_token', 'mx_user_id', 'mx_device_id'],
  hardClientReset: vi.fn(),
}));

describe('AppHeader', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPathname = '/chat';
    mockTheme = 'light';
    window.__matrix_ready = true;

    const store: Record<string, string> = {};
    /* Per-test localStorage mock so each test starts with a clean store */
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation((key) => store[key] || null);
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation((key, value) => {
      store[key] = value;
    });
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation((key) => {
      delete store[key];
    });
  });

  afterEach(() => {
    window.__matrix_ready = undefined;
    vi.restoreAllMocks();
  });

  describe('rendering', () => {
    it('renders the NEXUS logo', () => {
      render(<AppHeader />);
      expect(screen.queryByText('NEXUS')).toBeInTheDocument();
    });

    it('renders theme toggle button', () => {
      render(<AppHeader />);
      expect(screen.queryByLabelText('Toggle theme')).toBeInTheDocument();
    });

    it('renders settings button when authenticated', () => {
      render(<AppHeader />);
      expect(screen.queryByTestId('settings-button')).toBeInTheDocument();
    });

    it('renders logout button when authenticated', () => {
      render(<AppHeader />);
      expect(screen.queryByLabelText('Logout')).toBeInTheDocument();
    });

    it('hides settings and logout on auth page', () => {
      mockPathname = '/auth';
      render(<AppHeader />);

      expect(screen.queryByTestId('settings-button')).not.toBeInTheDocument();
      expect(screen.queryByLabelText('Logout')).not.toBeInTheDocument();
    });

    it('hides settings and logout when matrix is not ready', () => {
      window.__matrix_ready = false;
      render(<AppHeader />);

      expect(screen.queryByTestId('settings-button')).not.toBeInTheDocument();
      expect(screen.queryByLabelText('Logout')).not.toBeInTheDocument();
    });
  });

  describe('theme menu', () => {
    it('opens theme menu on click', async () => {
      const user = userEvent.setup();
      render(<AppHeader />);

      await user.click(screen.getByLabelText('Toggle theme'));

      expect(screen.queryByText('Light Mode')).toBeInTheDocument();
      expect(screen.queryByText('Dark Mode')).toBeInTheDocument();
    });

    it('switches to dark mode', async () => {
      const user = userEvent.setup();
      render(<AppHeader />);

      await user.click(screen.getByLabelText('Toggle theme'));
      await user.click(screen.getByText('Dark Mode'));

      expect(mockSetTheme).toHaveBeenCalledWith('dark');
    });

    it('switches to light mode', async () => {
      mockTheme = 'dark';
      const user = userEvent.setup();
      render(<AppHeader />);

      await user.click(screen.getByLabelText('Toggle theme'));
      await user.click(screen.getByText('Light Mode'));

      expect(mockSetTheme).toHaveBeenCalledWith('light');
    });

    it('closes theme menu after selection', async () => {
      const user = userEvent.setup();
      render(<AppHeader />);

      await user.click(screen.getByLabelText('Toggle theme'));
      await user.click(screen.getByText('Dark Mode'));

      await waitFor(() => {
        expect(screen.queryByText('Light Mode')).not.toBeInTheDocument();
      });
    });
  });

  describe('settings menu', () => {
    it('opens settings menu on click', async () => {
      const user = userEvent.setup();
      render(<AppHeader />);

      await user.click(screen.getByTestId('settings-button'));

      expect(screen.queryByTestId('settings-menu')).toBeInTheDocument();
    });

    it('shows all menu items', async () => {
      const user = userEvent.setup();
      render(<AppHeader />);

      await user.click(screen.getByTestId('settings-button'));

      expect(screen.queryByText('Get Recovery Key')).toBeInTheDocument();
      expect(screen.queryByText('Use Recovery Key')).toBeInTheDocument();
      expect(screen.queryByText('Verify this session')).toBeInTheDocument();
      expect(screen.queryByText('Forget this session')).toBeInTheDocument();
    });

    it('has correct ARIA attributes', async () => {
      const user = userEvent.setup();
      render(<AppHeader />);

      const settingsButton = screen.getByTestId('settings-button');
      expect(settingsButton).toHaveAttribute('aria-haspopup', 'menu');
      expect(settingsButton).toHaveAttribute('aria-expanded', 'false');

      await user.click(settingsButton);

      expect(settingsButton).toHaveAttribute('aria-expanded', 'true');

      const menu = screen.getByTestId('settings-menu');
      expect(menu).toHaveAttribute('role', 'menu');
    });

    it('menu items have menuitem role', async () => {
      const user = userEvent.setup();
      render(<AppHeader />);

      await user.click(screen.getByTestId('settings-button'));

      const menuItems = screen.getAllByRole('menuitem');
      expect(menuItems.length).toBe(4);
    });

    it('dispatches event on Get Recovery Key click', async () => {
      const user = userEvent.setup();
      const dispatchSpy = vi.spyOn(window, 'dispatchEvent');
      render(<AppHeader />);

      await user.click(screen.getByTestId('settings-button'));
      await user.click(screen.getByText('Get Recovery Key'));

      expect(dispatchSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'nexus-encryption-open',
          detail: { mode: 'recovery_create' },
        })
      );
    });

    it('dispatches event on Use Recovery Key click', async () => {
      const user = userEvent.setup();
      const dispatchSpy = vi.spyOn(window, 'dispatchEvent');
      render(<AppHeader />);

      await user.click(screen.getByTestId('settings-button'));
      await user.click(screen.getByText('Use Recovery Key'));

      expect(dispatchSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'nexus-encryption-open',
          detail: { mode: 'recovery_restore' },
        })
      );
    });

    it('dispatches event on Verify this session click', async () => {
      const user = userEvent.setup();
      const dispatchSpy = vi.spyOn(window, 'dispatchEvent');
      render(<AppHeader />);

      await user.click(screen.getByTestId('settings-button'));
      await user.click(screen.getByText('Verify this session'));

      expect(dispatchSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'nexus-encryption-open',
          detail: { mode: 'verification' },
        })
      );
    });

    it('dispatches event on Forget this session click', async () => {
      const user = userEvent.setup();
      const dispatchSpy = vi.spyOn(window, 'dispatchEvent');
      render(<AppHeader />);

      await user.click(screen.getByTestId('settings-button'));
      await user.click(screen.getByText('Forget this session'));

      expect(dispatchSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'nexus-encryption-open',
          detail: { mode: 'forget' },
        })
      );
    });

    it('closes on Escape key', async () => {
      const user = userEvent.setup();
      render(<AppHeader />);

      await user.click(screen.getByTestId('settings-button'));
      expect(screen.queryByTestId('settings-menu')).toBeInTheDocument();

      await user.keyboard('{Escape}');

      await waitFor(() => {
        expect(screen.queryByTestId('settings-menu')).not.toBeInTheDocument();
      });
    });
  });

  describe('logout', () => {
    it('redirects to auth page on logout', async () => {
      const user = userEvent.setup();
      render(<AppHeader />);

      await user.click(screen.getByLabelText('Logout'));

      expect(mockReplace).toHaveBeenCalledWith('/auth');
    });

    it('calls hardClientReset on logout', async () => {
      const user = userEvent.setup();
      render(<AppHeader />);

      await user.click(screen.getByLabelText('Logout'));

      expect(hardClientReset).toHaveBeenCalled();
    });

    it('calls logoutMatrixClient on logout', async () => {
      const user = userEvent.setup();
      render(<AppHeader />);

      await user.click(screen.getByLabelText('Logout'));

      expect(logoutMatrixClient).toHaveBeenCalledWith({ forgetDevice: false });
    });

    it('does not logout when on auth page', async () => {
      mockPathname = '/auth';
      render(<AppHeader />);

      expect(screen.queryByLabelText('Logout')).not.toBeInTheDocument();
    });
  });

  describe('matrix ready events', () => {
    /* Window events should update the UI state */
    it('shows authenticated actions when matrix becomes ready', async () => {
      window.__matrix_ready = false;
      render(<AppHeader />);

      expect(screen.queryByTestId('settings-button')).not.toBeInTheDocument();

      window.__matrix_ready = true;
      window.dispatchEvent(new Event('matrix-ready'));

      await waitFor(() => {
        expect(screen.queryByTestId('settings-button')).toBeInTheDocument();
      });
    });

    it('hides authenticated actions when matrix becomes not ready', async () => {
      render(<AppHeader />);
      expect(screen.queryByTestId('settings-button')).toBeInTheDocument();

      window.__matrix_ready = false;
      window.dispatchEvent(new Event('matrix-not-ready'));

      await waitFor(() => {
        expect(screen.queryByTestId('settings-button')).not.toBeInTheDocument();
      });
    });
  });
});