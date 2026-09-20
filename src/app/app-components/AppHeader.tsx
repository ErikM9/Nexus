/* eslint-disable @typescript-eslint/no-explicit-any */
'use client';

import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import ReactDOM from 'react-dom';
import { useRouter, usePathname } from 'next/navigation';
import { LogOut, Settings, MoreVertical } from 'lucide-react';
import { MoonIcon, SunIcon } from '@radix-ui/react-icons';
import { useTheme } from 'next-themes';
import { Button } from '@/components/ui/button';
import toast from 'react-hot-toast';
import { logoutMatrixClient } from '../utils/matrix';
import { hardClientReset } from '../utils/helpers';

const AppHeader: React.FC = () => {
  const router = useRouter();
  const pathname = usePathname();
  const { setTheme, theme } = useTheme();
  const currentTheme = theme === 'dark' ? 'dark' : 'light';
  const isAuthPage = pathname === '/auth';
  const [matrixReady, setMatrixReady] = useState(false);
  const [settingsMenuOpen, setSettingsMenuOpen] = useState(false);
  const [themeMenuOpen, setThemeMenuOpen] = useState(false);
  const settingsBtnRef = useRef<HTMLButtonElement | null>(null);
  const themeBtnRef = useRef<HTMLButtonElement | null>(null);
  const [settingsMenuPos, setSettingsMenuPos] = useState<{ top: number; left: number; width: number } | null>(null);
  const [themeMenuPos, setThemeMenuPos] = useState<{ top: number; left: number } | null>(null);

  /* Overflow menu collapsing theme, settings, and logout below the md breakpoint */
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const mobileBtnRef = useRef<HTMLButtonElement | null>(null);
  const [mobileMenuPos, setMobileMenuPos] = useState<{ top: number; left: number; width: number } | null>(null);

  /* skipCloseRef stops the dropdown that just broadcast nexus-close-dropdowns from closing itself */
  const skipCloseRef = useRef(false);

  useEffect(() => {
    const onGlobalDropdown = () => {
      if (skipCloseRef.current) {
        skipCloseRef.current = false;
        return;
      }
      setSettingsMenuOpen(false);
      setThemeMenuOpen(false);
      setMobileMenuOpen(false);
    };
    window.addEventListener('nexus-close-dropdowns', onGlobalDropdown);
    return () => window.removeEventListener('nexus-close-dropdowns', onGlobalDropdown);
  }, []);

  const emitDropdownOpen = () => {
    skipCloseRef.current = true;
    try { window.dispatchEvent(new Event('nexus-close-dropdowns')); } catch {}
  };

  useEffect(() => {
    if (typeof window === 'undefined') return;

    const initial = !!window.__matrix_ready;
    /* Sync with current ready state on mount then listen for changes */
    setMatrixReady(initial);
    const onReady = () => setMatrixReady(true);
    const onNotReady = () => setMatrixReady(false);

    window.addEventListener('matrix-ready', onReady);
    window.addEventListener('matrix-not-ready', onNotReady);

    return () => {
      window.removeEventListener('matrix-ready', onReady);
      window.removeEventListener('matrix-not-ready', onNotReady);
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (settingsMenuOpen) setSettingsMenuOpen(false);
        if (themeMenuOpen) setThemeMenuOpen(false);
        if (mobileMenuOpen) setMobileMenuOpen(false);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [settingsMenuOpen, themeMenuOpen, mobileMenuOpen]);

  useLayoutEffect(() => {
    if (!settingsMenuOpen) return;

    /* Recompute menu position on open and on resize or scroll, clamped to the viewport edges */
    const update = () => {
      const el = settingsBtnRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const width = 161;
      const left = Math.max(8, Math.min(window.innerWidth - width - 8, r.right - width));
      const top = Math.min(window.innerHeight - 8, r.bottom + 10);
      setSettingsMenuPos({ top, left, width });
    };

    update();
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);

    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
    };
  }, [settingsMenuOpen]);

  useLayoutEffect(() => {
    if (!themeMenuOpen) return;

    const update = () => {
      const el = themeBtnRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const width = 112;
      const left = Math.max(8, Math.min(window.innerWidth - width - 8, r.right - width));
      const top = Math.min(window.innerHeight - 8, r.bottom + 10);
      setThemeMenuPos({ top, left });
    };

    update();
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);

    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
    };
  }, [themeMenuOpen]);

  useLayoutEffect(() => {
    if (!mobileMenuOpen) return;

    const update = () => {
      const el = mobileBtnRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const width = 184;
      const left = Math.max(8, Math.min(window.innerWidth - width - 8, r.right - width));
      const top = Math.min(window.innerHeight - 8, r.bottom + 10);
      setMobileMenuPos({ top, left, width });
    };

    update();
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);

    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
    };
  }, [mobileMenuOpen]);

  useEffect(() => {
    /* Close on an outside click, ignoring the trigger button and the menu itself */
    const onDocClick = (e: MouseEvent) => {
      const target = e.target as Node | null;
      if (!target) return;

      if (settingsMenuOpen) {
        const btn = settingsBtnRef.current;
        if (btn && btn.contains(target)) return;
        const menuEl = document.getElementById('nexus-settings-menu');
        if (menuEl && menuEl.contains(target)) return;
        setSettingsMenuOpen(false);
      }

      if (themeMenuOpen) {
        const btn = themeBtnRef.current;
        if (btn && btn.contains(target)) return;
        const menuEl = document.getElementById('nexus-theme-menu');
        if (menuEl && menuEl.contains(target)) return;
        setThemeMenuOpen(false);
      }

      if (mobileMenuOpen) {
        const btn = mobileBtnRef.current;
        if (btn && btn.contains(target)) return;
        const menuEl = document.getElementById('nexus-mobile-menu');
        if (menuEl && menuEl.contains(target)) return;
        setMobileMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [settingsMenuOpen, themeMenuOpen, mobileMenuOpen]);

  /* Dispatches nexus-encryption-open to switch the session overlay to the given panel */
  const openPanel = (mode: 'verification' | 'recovery_create' | 'recovery_restore' | 'forget') => {
    try {
      window.dispatchEvent(new CustomEvent('nexus-encryption-open', { detail: { mode } }));
    } catch {}
  };

  const handleLogout = async () => {
    if (isAuthPage) return;
    try { logoutMatrixClient({ forgetDevice: false }); } catch {}
    hardClientReset();
    toast.success('Logged out');
    router.replace('/auth');
  };

  const labelClass =
    'mt-1 text-[10px] leading-none tracking-[0.22em] uppercase text-sky-600 dark:text-sky-400 select-none';

  /* Settings and logout stay hidden on the login page and while the client is initialising */
  const showAuthedActions = !isAuthPage && matrixReady;

  const settingsMenu =
    /* Portaled to document.body so the menu stacks above overflow-hidden parents */
    settingsMenuOpen && settingsMenuPos && typeof document !== 'undefined'
      ? ReactDOM.createPortal(
          <div
            id="nexus-settings-menu"
            className="fixed z-[9999] glass rounded-2xl border border-border/60 p-2 shadow-none"
            style={{ top: settingsMenuPos.top, left: settingsMenuPos.left, width: settingsMenuPos.width }}
            role="menu"
            aria-label="Settings menu"
            data-testid="settings-menu"
          >
            <button
              className="w-full text-center px-2.5 py-2 rounded-xl hover:bg-accent/60 dark:hover:bg-muted/50 text-sm transition-colors"
              onClick={() => { setSettingsMenuOpen(false); openPanel('recovery_create'); }}
              role="menuitem"
            >
              Get Recovery Key
            </button>
            <button
              className="w-full text-center px-2.5 py-2 rounded-xl hover:bg-accent/60 dark:hover:bg-muted/50 text-sm transition-colors"
              onClick={() => { setSettingsMenuOpen(false); openPanel('recovery_restore'); }}
              role="menuitem"
            >
              Use Recovery Key
            </button>
            <button
              className="w-full text-center px-2.5 py-2 rounded-xl hover:bg-accent/60 dark:hover:bg-muted/50 text-sm transition-colors"
              onClick={() => { setSettingsMenuOpen(false); openPanel('verification'); }}
              role="menuitem"
            >
              Verify this session
            </button>
            <button
              className="w-full text-center px-2.5 py-2 rounded-xl hover:bg-destructive/10 text-sm text-destructive transition-colors"
              onClick={() => { setSettingsMenuOpen(false); openPanel('forget'); }}
              role="menuitem"
            >
              Forget this session
            </button>
          </div>,
          document.body
        )
      : null;

  const themeMenu =
    themeMenuOpen && themeMenuPos && typeof document !== 'undefined'
      ? ReactDOM.createPortal(
          <div
            id="nexus-theme-menu"
            className="fixed z-[9999] glass rounded-2xl border border-border/60 p-2 shadow-none w-[112px]"
            style={{ top: themeMenuPos.top, left: themeMenuPos.left }}
          >
            <button
              className={`w-full text-center px-2.5 py-2 rounded-xl hover:bg-accent/60 dark:hover:bg-muted/50 text-sm transition-colors ${currentTheme === 'light' ? 'font-semibold' : ''}`}
              onClick={() => { setTheme('light'); setThemeMenuOpen(false); }}
            >
              Light Mode
            </button>
            <button
              className={`w-full text-center px-2.5 py-2 rounded-xl hover:bg-accent/60 dark:hover:bg-muted/50 text-sm transition-colors ${currentTheme === 'dark' ? 'font-semibold' : ''}`}
              onClick={() => { setTheme('dark'); setThemeMenuOpen(false); }}
            >
              Dark Mode
            </button>
          </div>,
          document.body
        )
      : null;

  const mobileMenuItemClass =
    'w-full text-center px-2.5 py-2 rounded-xl hover:bg-accent/60 dark:hover:bg-muted/50 text-sm transition-colors';
  const mobileSectionClass =
    'px-2 pt-1.5 pb-1 text-[10px] font-semibold tracking-[0.22em] uppercase text-muted-foreground text-center';

  const mobileMenu =
    mobileMenuOpen && mobileMenuPos && typeof document !== 'undefined'
      ? ReactDOM.createPortal(
          <div
            id="nexus-mobile-menu"
            className="fixed z-[9999] bg-popover rounded-2xl border border-border/60 p-2 shadow-none"
            style={{ top: mobileMenuPos.top, left: mobileMenuPos.left, width: mobileMenuPos.width }}
            role="menu"
            aria-label="Menu"
          >
            <div className={mobileSectionClass}>Theme</div>
            <button
              className={`${mobileMenuItemClass} ${currentTheme === 'light' ? 'font-semibold' : ''}`}
              onClick={() => { setTheme('light'); setMobileMenuOpen(false); }}
              role="menuitem"
            >
              Light Mode
            </button>
            <button
              className={`${mobileMenuItemClass} ${currentTheme === 'dark' ? 'font-semibold' : ''}`}
              onClick={() => { setTheme('dark'); setMobileMenuOpen(false); }}
              role="menuitem"
            >
              Dark Mode
            </button>

            {showAuthedActions && (
              <>
                <div className={`${mobileSectionClass} mt-1 border-t border-border/50`}>Session</div>
                <button
                  className={mobileMenuItemClass}
                  onClick={() => { setMobileMenuOpen(false); openPanel('recovery_create'); }}
                  role="menuitem"
                >
                  Get Recovery Key
                </button>
                <button
                  className={mobileMenuItemClass}
                  onClick={() => { setMobileMenuOpen(false); openPanel('recovery_restore'); }}
                  role="menuitem"
                >
                  Use Recovery Key
                </button>
                <button
                  className={mobileMenuItemClass}
                  onClick={() => { setMobileMenuOpen(false); openPanel('verification'); }}
                  role="menuitem"
                >
                  Verify this session
                </button>
                <button
                  className="w-full text-center px-2.5 py-2 rounded-xl hover:bg-destructive/10 text-sm text-destructive transition-colors"
                  onClick={() => { setMobileMenuOpen(false); openPanel('forget'); }}
                  role="menuitem"
                >
                  Forget this session
                </button>
                <div className="my-1 border-t border-border/50" />
                <button
                  className="w-full text-center px-2.5 py-2 rounded-xl hover:bg-accent/60 dark:hover:bg-muted/50 text-sm font-medium text-sky-600 dark:text-sky-400 transition-colors"
                  onClick={() => { setMobileMenuOpen(false); handleLogout(); }}
                  role="menuitem"
                >
                  Logout
                </button>
              </>
            )}
          </div>,
          document.body
        )
      : null;

  return (
    <header className="glass-flush-left rounded-none no-border-top no-border-right no-border-bottom no-border-left glass-opaque relative flex items-center justify-between px-3 md:px-6 py-3">
      <div className="select-none flex items-center h-full max-md:absolute max-md:inset-y-0 max-md:left-1/2 max-md:-translate-x-1/2">
        <span className="font-thehook text-[30px] uppercase text-sky-500 dark:text-sky-400 leading-none inline-block scale-x-125 origin-center md:ml-5 mt-[5px]">
          NEXUS
        </span>
      </div>

      <div className="hidden md:flex items-end gap-3 md:gap-4">
        <div className="flex flex-col items-center">
          <Button
            ref={themeBtnRef as any}
            variant="ghost"
            size="icon"
            aria-label="Toggle theme"
            onClick={() => {
              if (!themeMenuOpen) emitDropdownOpen();
              setThemeMenuOpen((v) => !v);
            }}
            className="header-icon-btn hover:bg-accent/60 dark:hover:bg-muted/50"
          >
            <SunIcon className="h-[1.2rem] w-[1.2rem] rotate-0 scale-100 transition-all dark:-rotate-90 dark:scale-0" />
            <MoonIcon className="absolute h-[1.2rem] w-[1.2rem] rotate-90 scale-0 transition-all dark:rotate-0 dark:scale-100" />
          </Button>
          <span className={labelClass}>Theme</span>
        </div>

        {showAuthedActions && (
          <div className="flex flex-col items-center relative">
            <Button
              ref={settingsBtnRef as any}
              variant="ghost"
              size="icon"
              aria-label="Settings"
              aria-haspopup="menu"
              aria-expanded={settingsMenuOpen}
              aria-controls="nexus-settings-menu"
              data-testid="settings-button"
              onClick={() => {
                if (!settingsMenuOpen) emitDropdownOpen();
                setSettingsMenuOpen((v) => !v);
              }}
              className="header-icon-btn hover:bg-accent/60 dark:hover:bg-muted/50"
            >
              <Settings className="h-6 w-6" />
            </Button>
            <span className={labelClass}>Settings</span>
          </div>
        )}

        {showAuthedActions && (
          <div className="flex flex-col items-center">
            <Button
              variant="ghost"
              size="icon"
              onClick={handleLogout}
              aria-label="Logout"
              className="header-icon-btn hover:bg-accent/60 dark:hover:bg-muted/50"
            >
              <LogOut className="h-6 w-6" />
            </Button>
            <span className={labelClass}>Logout</span>
          </div>
        )}
      </div>

      <div className="flex md:hidden items-center max-md:ml-auto">
        <Button
          ref={mobileBtnRef as any}
          variant="ghost"
          size="icon"
          aria-label="Menu"
          aria-haspopup="menu"
          aria-expanded={mobileMenuOpen}
          aria-controls="nexus-mobile-menu"
          onClick={() => {
            if (!mobileMenuOpen) emitDropdownOpen();
            setMobileMenuOpen((v) => !v);
          }}
          className="header-icon-btn hover:bg-accent/60 dark:hover:bg-muted/50"
        >
          <MoreVertical className="h-6 w-6" />
        </Button>
      </div>

      {settingsMenu}
      {themeMenu}
      {mobileMenu}
    </header>
  );
};

export default AppHeader;