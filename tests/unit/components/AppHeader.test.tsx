import { describe, it, expect, vi, onTestFinished } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import toast from 'react-hot-toast';
import { usePathname, useRouter } from 'next/navigation';
import { useTheme } from 'next-themes';

vi.mock('@/app/utils/matrix', () => ({ logoutMatrixClient: vi.fn() }));

import AppHeader from '@/app/app-components/AppHeader';
import { logoutMatrixClient } from '@/app/utils/matrix';

/* No breakpoints apply in jsdom, so the desktop buttons and the phone's Menu button are in the document together */
const MENUS = {
  /* The theme menu has no menu role, so its Dark Mode button stands for it */
  'theme menu': { opener: 'Toggle theme', role: 'button', label: 'Dark Mode' },
  'settings menu': { opener: 'Settings', role: 'menu', label: 'Settings menu' },
  'phone menu': { opener: 'Menu', role: 'menu', label: 'Menu' },
} as const;

type MenuName = keyof typeof MENUS;

/* Shows the header to a signed-in user on the chat page unless told otherwise */
const renderHeader = ({ pathname = '/', ready = true }: { pathname?: string; ready?: boolean } = {}) => {
  const router = { push: vi.fn(), replace: vi.fn(), back: vi.fn(), forward: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() };
  const setTheme = vi.fn();
  vi.mocked(useRouter).mockReturnValue(router);
  vi.mocked(usePathname).mockReturnValue(pathname);
  vi.mocked(useTheme).mockReturnValue({ theme: 'light', setTheme, themes: ['light', 'dark'] });
  window.__matrix_ready = ready;
  render(<AppHeader />);
  return { router, setTheme };
};

const openMenu = async (name: MenuName) => {
  await userEvent.click(screen.getByRole('button', { name: MENUS[name].opener }));
  return screen.getByRole(MENUS[name].role, { name: MENUS[name].label });
};

const shown = (name: MenuName) => screen.queryByRole(MENUS[name].role, { name: MENUS[name].label });

const phoneMenuItems = async () =>
  within(await openMenu('phone menu'))
    .getAllByRole('menuitem')
    .map((item) => item.textContent);

/* Records every event of one type that reaches the window until the test ends */
const eventsOnWindow = (type: string) => {
  const events: Event[] = [];
  const record = (event: Event) => events.push(event);
  window.addEventListener(type, record);
  onTestFinished(() => window.removeEventListener(type, record));
  return events;
};

const clientBecomesReady = () =>
  act(() => {
    window.__matrix_ready = true;
    window.dispatchEvent(new Event('matrix-ready'));
  });

const clientStops = () =>
  act(() => {
    window.__matrix_ready = false;
    window.dispatchEvent(new Event('matrix-not-ready'));
  });

describe('AppHeader', () => {
  describe('without a signed-in client', () => {
    it('offers only the theme on the sign-in page, even while a client is running', async () => {
      renderHeader({ pathname: '/auth', ready: true });

      expect(screen.queryByRole('button', { name: 'Settings' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Logout' })).not.toBeInTheDocument();
      expect(await phoneMenuItems()).toEqual(['Light Mode', 'Dark Mode']);
    });

    it('offers only the theme while the client is not ready', async () => {
      renderHeader({ ready: false });

      expect(screen.queryByRole('button', { name: 'Settings' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Logout' })).not.toBeInTheDocument();
      expect(await phoneMenuItems()).toEqual(['Light Mode', 'Dark Mode']);
    });
  });

  describe('across sign-in and sign-out', () => {
    it('adds Settings and Logout when the client becomes ready', () => {
      renderHeader({ ready: false });

      clientBecomesReady();

      expect(screen.getByRole('button', { name: 'Settings' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Logout' })).toBeInTheDocument();
    });

    it('takes Settings and Logout away when the client stops', () => {
      renderHeader();

      clientStops();

      expect(screen.queryByRole('button', { name: 'Settings' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Logout' })).not.toBeInTheDocument();
    });

    it('closes an open settings menu when the client stops', async () => {
      renderHeader();
      await openMenu('settings menu');

      clientStops();

      expect(shown('settings menu')).not.toBeInTheDocument();
    });
  });

  describe.each(Object.keys(MENUS) as MenuName[])('%s', (menu) => {
    it('closes when its button is pressed again', async () => {
      renderHeader();
      await openMenu(menu);

      await userEvent.click(screen.getByRole('button', { name: MENUS[menu].opener }));

      expect(shown(menu)).not.toBeInTheDocument();
    });

    it('closes on Escape', async () => {
      renderHeader();
      await openMenu(menu);

      await userEvent.keyboard('{Escape}');

      expect(shown(menu)).not.toBeInTheDocument();
    });

    it('closes on a press outside it', async () => {
      renderHeader();
      await openMenu(menu);

      await userEvent.click(document.body);

      expect(shown(menu)).not.toBeInTheDocument();
    });

    it('closes when a dropdown elsewhere in the app opens', async () => {
      renderHeader();
      await openMenu(menu);

      act(() => {
        window.dispatchEvent(new Event('nexus-close-dropdowns'));
      });

      expect(shown(menu)).not.toBeInTheDocument();
    });

    it('asks dropdowns elsewhere in the app to close when it opens', async () => {
      renderHeader();
      const broadcasts = eventsOnWindow('nexus-close-dropdowns');

      await openMenu(menu);

      expect(broadcasts).toHaveLength(1);
    });
  });

  it.each([
    ['theme menu', 'settings menu'],
    ['settings menu', 'theme menu'],
  ] as const)('closes the %s when the %s is opened from the keyboard', async (first, second) => {
    renderHeader();
    await openMenu(first);

    screen.getByRole('button', { name: MENUS[second].opener }).focus();
    await userEvent.keyboard('{Enter}');

    expect(shown(second)).toBeInTheDocument();
    expect(shown(first)).not.toBeInTheDocument();
  });

  it.each(['Settings', 'Menu'])('marks the %s button as expanded while its menu is open', async (opener) => {
    renderHeader();
    const button = screen.getByRole('button', { name: opener, expanded: false });

    await userEvent.click(button);

    expect(screen.getByRole('button', { name: opener, expanded: true })).toBe(button);
  });

  describe('choosing a theme', () => {
    it.each([
      ['Light Mode', 'Toggle theme', 'light', 'button'],
      ['Dark Mode', 'Toggle theme', 'dark', 'button'],
      ['Light Mode', 'Menu', 'light', 'menuitem'],
      ['Dark Mode', 'Menu', 'dark', 'menuitem'],
    ])('%s behind %s sets the %s theme and closes the menu', async (item, opener, theme, role) => {
      const { setTheme } = renderHeader();
      await userEvent.click(screen.getByRole('button', { name: opener }));

      await userEvent.click(screen.getByRole(role, { name: item }));

      expect(setTheme).toHaveBeenCalledWith(theme);
      expect(screen.queryByRole(role, { name: item })).not.toBeInTheDocument();
    });
  });

  describe('session actions', () => {
    it('lists the theme, the session actions and Logout in the phone menu', async () => {
      renderHeader();

      expect(await phoneMenuItems()).toEqual([
        'Light Mode',
        'Dark Mode',
        'Get Recovery Key',
        'Use Recovery Key',
        'Verify this session',
        'Forget this session',
        'Logout',
      ]);
    });

    describe.each(['settings menu', 'phone menu'] as const)('in the %s', (menu) => {
      it.each([
        ['Get Recovery Key', 'recovery_create'],
        ['Use Recovery Key', 'recovery_restore'],
        ['Verify this session', 'verification'],
        ['Forget this session', 'forget'],
      ])('%s asks the session overlay for its %s panel and closes the menu', async (item, mode) => {
        renderHeader();
        const requests = eventsOnWindow('nexus-encryption-open');
        const items = await openMenu(menu);

        await userEvent.click(within(items).getByRole('menuitem', { name: item }));

        expect(requests.map((request) => (request as CustomEvent).detail)).toEqual([{ mode }]);
        expect(shown(menu)).not.toBeInTheDocument();
      });
    });
  });

  describe('signing out', () => {
    it('confirms the sign-out and goes to the sign-in page', async () => {
      vi.mocked(logoutMatrixClient).mockResolvedValue({ serverSignedOut: true });
      const { router } = renderHeader();

      await userEvent.click(screen.getByRole('button', { name: 'Logout' }));

      await waitFor(() => expect(router.replace).toHaveBeenCalledWith('/auth'));
      expect(toast.success).toHaveBeenCalledWith('Logged out');
      expect(toast.error).not.toHaveBeenCalled();
    });

    it('goes to the sign-in page with a warning when the server could not be told', async () => {
      vi.mocked(logoutMatrixClient).mockResolvedValue({ serverSignedOut: false });
      const { router } = renderHeader();

      await userEvent.click(screen.getByRole('button', { name: 'Logout' }));

      await waitFor(() => expect(router.replace).toHaveBeenCalledWith('/auth'));
      expect(toast.error).toHaveBeenCalledWith("Logged out on this device, but the server couldn't be reached to end the session.");
      expect(toast.success).not.toHaveBeenCalled();
    });

    it('disables Logout while the sign-out is running', async () => {
      vi.mocked(logoutMatrixClient).mockReturnValue(new Promise(() => {}));
      renderHeader();
      const logout = screen.getByRole('button', { name: 'Logout' });

      await userEvent.click(logout);

      expect(logout).toBeDisabled();
    });

    it('signs out from the phone menu and closes it', async () => {
      vi.mocked(logoutMatrixClient).mockResolvedValue({ serverSignedOut: true });
      const { router } = renderHeader();
      const menu = await openMenu('phone menu');

      await userEvent.click(within(menu).getByRole('menuitem', { name: 'Logout' }));

      await waitFor(() => expect(router.replace).toHaveBeenCalledWith('/auth'));
      expect(logoutMatrixClient).toHaveBeenCalledTimes(1);
      expect(shown('phone menu')).not.toBeInTheDocument();
    });

    it('starts one sign-out however often Logout is picked from the phone menu meanwhile', async () => {
      vi.mocked(logoutMatrixClient).mockReturnValue(new Promise(() => {}));
      renderHeader();
      await userEvent.click(within(await openMenu('phone menu')).getByRole('menuitem', { name: 'Logout' }));

      await userEvent.click(within(await openMenu('phone menu')).getByRole('menuitem', { name: 'Logout' }));

      expect(logoutMatrixClient).toHaveBeenCalledTimes(1);
    });
  });
});