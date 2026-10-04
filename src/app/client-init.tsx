'use client';

import React, { useEffect } from 'react';
import {
  readStoredSession,
  retryMatrixStartup,
  startMatrixInThisTab,
  stopMatrixClient,
  type StoredSession,
} from '@/app/utils/matrix';
import '@/app/utils/global';

const toInitOptions = (session: StoredSession) => ({
  baseUrl: session.baseUrl,
  accessToken: session.accessToken,
  refreshToken: session.refreshToken,
  userId: session.userId,
  deviceId: session.deviceId,
  cryptoStorePrefix: session.cryptoStorePrefix,
});

/* Starts the Matrix client for the stored session on mount, after each sign-in, when the loading screen asks to retry, and when this tab takes over from another */
const MatrixInit: React.FC = () => {
  useEffect(() => {
    /* Start-up publishes its own progress and failures, and a session the server rejects is ended by the client module */
    const start = (session: StoredSession | null, takeOver = false) => {
      if (!session) return;
      startMatrixInThisTab(toInitOptions(session), { takeOver }).catch(() => {});
    };

    const onMatrixStart = (ev: Event) => {
      const detail = (ev as CustomEvent<StoredSession | undefined>).detail;
      start(detail?.accessToken && detail.userId ? detail : readStoredSession());
    };

    const onRetry = () => {
      if (!retryMatrixStartup()) start(readStoredSession());
    };

    const onTakeOver = () => start(readStoredSession(), true);

    window.addEventListener('matrix-start', onMatrixStart);
    window.addEventListener('matrix-retry', onRetry);
    window.addEventListener('matrix-take-over', onTakeOver);

    if (!window.__matrix_ready) start(readStoredSession());

    return () => {
      window.removeEventListener('matrix-start', onMatrixStart);
      window.removeEventListener('matrix-retry', onRetry);
      window.removeEventListener('matrix-take-over', onTakeOver);
      stopMatrixClient();
    };
  }, []);

  return null;
};

export default MatrixInit;