/* eslint-disable @typescript-eslint/no-explicit-any */

/* matrix-js-sdk references the Node.js global object, so point it at window in the browser */
if (typeof window !== 'undefined') {
  (window as any).global = window;
}

/* Filters out the benign one-time-key 400 the crypto SDK logs when IndexedDB has stale keys */
if (typeof console !== 'undefined') {
  const isKeyUploadNoise = (...args: unknown[]) => {
    const msg = typeof args[0] === 'string' ? args[0] : '';
    return (
      (msg.includes('One time key') && msg.includes('already exists')) ||
      (msg.includes('client/v3/keys/upload') && msg.includes('400'))
    );
  };

  const _origError = console.error.bind(console);
  console.error = (...args: unknown[]) => {
    if (isKeyUploadNoise(...args)) return;
    _origError(...args);
  };

  const _origLog = console.log.bind(console);
  console.log = (...args: unknown[]) => {
    if (isKeyUploadNoise(...args)) return;
    _origLog(...args);
  };
}

/* Mirrors the crypto-ready flag onto window so non-React code can read it */
export const setCryptoReady = (ready: boolean) => {
  if (typeof window !== 'undefined') {
    window.__cryptoReady = ready;
  }
};