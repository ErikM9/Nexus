import type { MatrixStartupStatus, VerificationSnapshot } from './types';

declare global {
  interface Window {
    __matrix_startup?: MatrixStartupStatus;
  }
}

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

/* Publishes how start-up is going on window as well, so a loading screen that mounts later can read the latest status */
export const emitMatrixStartupStatus = (status: MatrixStartupStatus) => {
  if (typeof window === 'undefined') return;
  try { window.__matrix_startup = status; } catch {}
  try { window.dispatchEvent(new CustomEvent('matrix-startup-status', { detail: status })); } catch {}
};

export const getMatrixStartupStatus = (): MatrixStartupStatus =>
  (typeof window !== 'undefined' && window.__matrix_startup) || { state: 'connecting' };

/* Carries the full snapshot in the event detail */
export const emitVerificationSnapshot = (snap: VerificationSnapshot) => {
  if (typeof window === 'undefined') return;
  try {
    window.dispatchEvent(new CustomEvent('matrix-verification-request', { detail: snap }));
  } catch {}
};