'use client';

import React, { useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { initMatrixClient, logoutMatrixClient, refreshAccessToken, getCryptoReady } from '@/app/utils/matrix';
import { StoredSession } from '@/app/utils/helpers';
import '@/app/utils/global';

/* Reads the session blob from localStorage, falling back to individual credential keys */
const readSession = (): StoredSession | null => {
  if (typeof window === 'undefined') return null;

  const raw = localStorage.getItem('mx_session');
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as StoredSession;
      if (parsed?.accessToken && parsed?.userId && parsed?.baseUrl) return parsed;
    } catch {}
  }

  const accessToken = localStorage.getItem('mx_access_token') || '';
  const userId = localStorage.getItem('mx_user_id') || '';
  const deviceId = localStorage.getItem('mx_device_id') || '';
  const refreshToken = localStorage.getItem('mx_refresh_token') || '';
  const baseUrl = process.env.NEXT_PUBLIC_MATRIX_HOMESERVER || '';

  if (!accessToken || !userId || !baseUrl) return null;

  const session: StoredSession = {
    accessToken,
    userId,
    baseUrl,
    deviceId: deviceId || undefined,
    refreshToken: refreshToken || undefined,
  };

  localStorage.setItem('mx_session', JSON.stringify(session));
  return session;
};

/* Boots the Matrix client on mount, listens for session changes, and refreshes the token */
const MatrixInit: React.FC = () => {
  const router = useRouter();
  const failedOutRef = useRef(false);
  const initInFlightRef = useRef(false);
  const lastSessionKeyRef = useRef<string>('');

  useEffect(() => {
    let mounted = true;
    let refreshInterval: ReturnType<typeof setInterval> | undefined;
    let refreshFailures = 0;

    const stopRefresh = () => {
      if (refreshInterval) {
        clearInterval(refreshInterval);
        refreshInterval = undefined;
      }
    };

    const failOut = () => {
      if (failedOutRef.current) return;
      failedOutRef.current = true;
      stopRefresh();
      logoutMatrixClient();
      if (mounted) router.replace('/auth');
    };

    /* Only refresh when a refresh token exists, giving up after three consecutive failures */
    const startRefreshLoop = (baseUrl: string) => {
      const hasRefreshToken = !!localStorage.getItem('mx_refresh_token');
      if (!hasRefreshToken) return;

      stopRefresh();
      refreshFailures = 0;

      refreshInterval = setInterval(async () => {
        try {
          if (failedOutRef.current) return;

          const stillHasRefreshToken = !!localStorage.getItem('mx_refresh_token');
          if (!stillHasRefreshToken) return;

          const newToken = await refreshAccessToken(baseUrl);
          if (!newToken) {
            refreshFailures += 1;
            if (refreshFailures >= 3) failOut();
            return;
          }

          refreshFailures = 0;
        } catch {
          refreshFailures += 1;
          if (refreshFailures >= 3) failOut();
        }
      }, 30 * 60 * 1000);
    };

    const initMatrix = async (sessionOverride?: StoredSession) => {
      if (typeof window === 'undefined') return;
      if (failedOutRef.current) return;
      if (initInFlightRef.current) return;

      const session = sessionOverride || readSession();
      if (!session) { failOut(); return; }

      /* Skip re-init when already running the same identity with a healthy client */
      const sessionKey = `${session.baseUrl}|${session.userId}|${session.deviceId || ''}`;
      if (sessionKey === lastSessionKeyRef.current && window.__matrix_ready) return;

      initInFlightRef.current = true;

      try {
        const client = await initMatrixClient({
          baseUrl: session.baseUrl,
          accessToken: session.accessToken,
          refreshToken: session.refreshToken,
          userId: session.userId,
          deviceId: session.deviceId,
        });

        /* Persist whatever device ID the client ended up with, which may differ from the stored one */
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const actualDeviceId = (client as any).getDeviceId?.();
        if (actualDeviceId) {
          try { localStorage.setItem('mx_device_id', actualDeviceId); } catch {}
        }

        lastSessionKeyRef.current = `${session.baseUrl}|${session.userId}|${actualDeviceId || session.deviceId || ''}`;

        const cryptoOk = getCryptoReady();
        if (!cryptoOk) {
          throw new Error(
            'Encryption failed to initialize for this session. Remove the Nexus device in Element and sign in again, or reset crypto storage.'
          );
        }

        startRefreshLoop(session.baseUrl);
      } catch {
        failOut();
      } finally {
        initInFlightRef.current = false;
      }
    };

    const onNotReady = () => {
      if (!mounted) return;
      if (failedOutRef.current) return;
      const s = readSession();
      if (!s) return;
      initMatrix(s);
    };

    /* matrix-start fires after login and carries the new session in its detail */
    const onMatrixStart = (ev: Event) => {
      const ce = ev as CustomEvent;
      const detail = ce?.detail as StoredSession | undefined;
      if (detail?.accessToken && detail?.userId) {
        failedOutRef.current = false;
      }
      initMatrix(detail);
    };

    window.addEventListener('matrix-not-ready', onNotReady);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    window.addEventListener('matrix-start', onMatrixStart as any);

    if (!window.__matrix_ready) initMatrix();

    return () => {
      mounted = false;
      window.removeEventListener('matrix-not-ready', onNotReady);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      window.removeEventListener('matrix-start', onMatrixStart as any);
      stopRefresh();
    };
  }, [router]);

  return null;
};

export default MatrixInit;