import type { VerificationSnapshot } from './types';

export const emitMatrixReady = () => {
  if (typeof window === 'undefined') return;
  /* Set the flag before dispatching so synchronous listeners read the correct value */
  try { window.__matrix_ready = true; } catch {}
  try { window.dispatchEvent(new Event('matrix-ready')); } catch {}
};

export const emitMatrixNotReady = () => {
  if (typeof window === 'undefined') return;
  try { window.__matrix_ready = false; } catch {}
  try { window.dispatchEvent(new Event('matrix-not-ready')); } catch {}
};

/* Carries the full snapshot in the event detail */
export const emitVerificationSnapshot = (snap: VerificationSnapshot) => {
  if (typeof window === 'undefined') return;
  try {
    window.dispatchEvent(new CustomEvent('matrix-verification-request', { detail: snap }));
  } catch {}
};