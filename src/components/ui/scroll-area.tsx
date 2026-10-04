'use client';

import * as React from 'react';
import { cn } from '@/lib/utils';

interface ScrollAreaProps extends React.HTMLAttributes<HTMLDivElement> {
  viewportClassName?: string;
  viewportRef?: React.Ref<HTMLDivElement>;
}

const ARROW_STEP = 60;
const MIN_THUMB = 24;

/* Overlay scrollbar that never takes layout width */
export const ScrollArea = React.forwardRef<HTMLDivElement, ScrollAreaProps>(
  ({ className, viewportClassName, viewportRef, children, ...props }, ref) => {
    const innerRef = React.useRef<HTMLDivElement | null>(null);
    const trackRef = React.useRef<HTMLDivElement | null>(null);
    const dragRef = React.useRef<{ startY: number; startScroll: number } | null>(null);
    const holdRef = React.useRef<ReturnType<typeof setInterval> | null>(null);
    const [thumb, setThumb] = React.useState({ height: 0, top: 0, visible: false });
    const [dragging, setDragging] = React.useState(false);

    const assignViewport = (node: HTMLDivElement | null) => {
      innerRef.current = node;
      if (typeof viewportRef === 'function') viewportRef(node);
      else if (viewportRef && typeof viewportRef === 'object') {
        (viewportRef as React.MutableRefObject<HTMLDivElement | null>).current = node;
      }
    };

    const recompute = React.useCallback(() => {
      const el = innerRef.current;
      const track = trackRef.current;
      if (!el || !track) return;
      const { scrollTop, scrollHeight, clientHeight } = el;
      const trackH = track.clientHeight;
      if (scrollHeight <= clientHeight + 1 || trackH <= 0) {
        setThumb((t) => (t.visible ? { ...t, visible: false } : t));
        return;
      }
      const h = Math.max((clientHeight / scrollHeight) * trackH, MIN_THUMB);
      const maxTop = trackH - h;
      const top = maxTop * (scrollTop / (scrollHeight - clientHeight));
      setThumb({ height: h, top, visible: true });
    }, []);

    React.useEffect(() => {
      const el = innerRef.current;
      if (!el) return;
      recompute();
      el.addEventListener('scroll', recompute, { passive: true });
      const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(recompute);
      ro?.observe(el);
      const mo = new MutationObserver(recompute);
      mo.observe(el, { childList: true, subtree: true, characterData: true });
      window.addEventListener('resize', recompute);
      return () => {
        el.removeEventListener('scroll', recompute);
        ro?.disconnect();
        mo.disconnect();
        window.removeEventListener('resize', recompute);
      };
    }, [recompute]);

    const onThumbDown = (e: React.PointerEvent<HTMLDivElement>) => {
      const el = innerRef.current;
      if (!el) return;
      e.preventDefault();
      e.stopPropagation();
      e.currentTarget.setPointerCapture(e.pointerId);
      dragRef.current = { startY: e.clientY, startScroll: el.scrollTop };
      setDragging(true);
    };

    const onThumbMove = (e: React.PointerEvent<HTMLDivElement>) => {
      const el = innerRef.current;
      const track = trackRef.current;
      const drag = dragRef.current;
      if (!el || !track || !drag) return;
      const { scrollHeight, clientHeight } = el;
      const trackH = track.clientHeight;
      const h = Math.max((clientHeight / scrollHeight) * trackH, MIN_THUMB);
      const maxTop = trackH - h;
      if (maxTop <= 0) return;
      const delta = e.clientY - drag.startY;
      el.scrollTop = drag.startScroll + (delta / maxTop) * (scrollHeight - clientHeight);
    };

    const onThumbUp = (e: React.PointerEvent<HTMLDivElement>) => {
      dragRef.current = null;
      setDragging(false);
      try { e.currentTarget.releasePointerCapture(e.pointerId); } catch {}
    };

    const scrollStep = (dir: 1 | -1) => {
      innerRef.current?.scrollBy({ top: dir * ARROW_STEP });
    };

    const stopHold = () => {
      if (holdRef.current) { clearInterval(holdRef.current); holdRef.current = null; }
    };

    const startHold = (dir: 1 | -1) => {
      scrollStep(dir);
      stopHold();
      holdRef.current = setInterval(() => scrollStep(dir), 60);
    };

    React.useEffect(() => stopHold, []);

    /* Forward wheel over the thumb or arrows to the viewport since they sit outside it */
    const onOverlayWheel = (e: React.WheelEvent) => {
      innerRef.current?.scrollBy({ top: e.deltaY });
    };

    return (
      <div ref={ref} className={cn('relative', className)}>
        <div ref={assignViewport} className={cn('scroll-host overscroll-contain', viewportClassName)} {...props}>
          {children}
        </div>

        <div
          className="pointer-events-none absolute right-0 top-0 z-10 flex h-full w-[10px] flex-col items-center"
          aria-hidden="true"
        >
          <button
            type="button"
            tabIndex={-1}
            onPointerDown={(e) => { e.preventDefault(); startHold(-1); }}
            onPointerUp={stopHold}
            onPointerLeave={stopHold}
            onWheel={onOverlayWheel}
            className={cn(
              'overlay-scroll-arrow overlay-scroll-arrow-up transition-opacity duration-150',
              thumb.visible ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none'
            )}
          />
          <div ref={trackRef} className="relative w-full flex-1">
            {thumb.visible && (
              <div
                onPointerDown={onThumbDown}
                onPointerMove={onThumbMove}
                onPointerUp={onThumbUp}
                onPointerCancel={onThumbUp}
                onWheel={onOverlayWheel}
                style={{ height: thumb.height, top: thumb.top }}
                className={cn(
                  'overlay-scroll-thumb pointer-events-auto absolute left-1/2 -translate-x-1/2',
                  dragging && 'overlay-scroll-thumb-active'
                )}
              />
            )}
          </div>
          <button
            type="button"
            tabIndex={-1}
            onPointerDown={(e) => { e.preventDefault(); startHold(1); }}
            onPointerUp={stopHold}
            onPointerLeave={stopHold}
            onWheel={onOverlayWheel}
            className={cn(
              'overlay-scroll-arrow overlay-scroll-arrow-down transition-opacity duration-150',
              thumb.visible ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none'
            )}
          />
        </div>
      </div>
    );
  }
);

ScrollArea.displayName = 'ScrollArea';