import type React from 'react';

const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [href], [tabindex]:not([tabindex="-1"])';

/* Keeps Tab and Shift+Tab cycling through a modal dialog's enabled controls instead of escaping to the page behind it */
export const trapTabKey = (e: React.KeyboardEvent, container: HTMLElement | null): void => {
  if (e.key !== 'Tab' || !container) return;
  const focusables = Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE));
  if (focusables.length === 0) {
    e.preventDefault();
    return;
  }
  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  const active = document.activeElement as HTMLElement | null;
  const outside = !active || !focusables.includes(active);
  if (e.shiftKey && (active === first || outside)) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && (active === last || outside)) {
    e.preventDefault();
    first.focus();
  }
};