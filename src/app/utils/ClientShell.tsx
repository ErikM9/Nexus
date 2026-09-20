'use client';

import React, { useEffect } from 'react';
import MatrixInit from '@/app/client-init';
import AppHeader from '@/app/app-components/AppHeader';
import RoomInviteOverlay from '@/app/app-components/RoomInviteOverlay';
import SessionOverlay from '@/app/app-components/SessionOverlay';
import MemberOverlay from '@/app/app-components/MemberOverlay';

/* Wraps every page with the Matrix bootstrap and persistent chrome, rendered client-side only */
export default function ClientShell({ children }: { children: React.ReactNode }) {
  /* Snap the horizontal seams outward onto the device pixel grid and publish the ratio their thickness derives from */
  useEffect(() => {
    const snap = () => {
      const dpr = window.devicePixelRatio || 1;
      document.documentElement.style.setProperty('--dpr', String(dpr));
      const seams = document.querySelectorAll<HTMLElement>('.hairline-t, .hairline-b');
      seams.forEach((el) => {
        const rect = el.getBoundingClientRect();
        const shift = el.classList.contains('hairline-t')
          ? Math.floor(rect.top * dpr) / dpr - rect.top
          : rect.bottom - Math.ceil(rect.bottom * dpr) / dpr;
        el.style.setProperty('--seam-shift', `${shift.toFixed(4)}px`);
      });
    };

    let raf = 0;
    const queueSnap = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(snap);
    };

    queueSnap();
    window.addEventListener('resize', queueSnap);
    document.fonts?.ready?.then(queueSnap).catch(() => {});
    const resizeObserver = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(queueSnap);
    resizeObserver?.observe(document.documentElement);
    const mutationObserver = new MutationObserver(queueSnap);
    mutationObserver.observe(document.body, { childList: true, subtree: true });

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', queueSnap);
      resizeObserver?.disconnect();
      mutationObserver.disconnect();
    };
  }, []);

  return (
    <>
      <MatrixInit />
      <SessionOverlay />
      <RoomInviteOverlay />
      <MemberOverlay />
      <div className="h-full min-h-0 flex flex-col overflow-hidden app-canvas-glass">
        <div className="shrink-0 rounded-none hairline-b">
          <AppHeader />
        </div>
        <div className="flex-1 min-h-0 overflow-hidden">{children}</div>
      </div>
    </>
  );
}