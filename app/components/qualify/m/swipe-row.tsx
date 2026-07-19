'use client';

/**
 * Qualify mobile — a single swipe-list row (Prompt 4b). Physics replicate the approved prototype
 * EXACTLY: 8px axis-lock, tint/stamp ramp over 90px, resolve on |dx|>85 OR |v|>0.5, overshoot
 * spring-back cubic-bezier(0.34,1.56,0.64,1), speed-scaled translateX-only fly-off (NO rotation) with
 * collapse-in-place, tap (|dx|<5) opens detail without consuming. Left→onPass (consume immediately),
 * right→onWhy (consume on sheet close, handled by the container), tap→onOpen (no consume).
 *
 * Drag runs on refs (no re-render mid-gesture); window listeners are tied to an AbortController so
 * cleanup is identity-independent. The row markup carries NO dollar fields (rating + line count only),
 * so the amounts gate is satisfied by construction here.
 */
import { useEffect, useRef, type PointerEvent as ReactPointerEvent } from 'react';
import { mobileBucketStyle } from './colors';
import { BuildingIcon, TrendIcon, XIcon } from './icons';
import type { QualifyFacility } from '../../../lib/qualify/contract';

const DIST_THRESHOLD = 85;
const VELOCITY_THRESHOLD = 0.5;
const TINT_RIGHT = '#EAF4F2'; // teal50
const TINT_LEFT = '#F1EFE8'; // warm neutral
const TEAL700 = '#135E5A';
const INK600 = '#4A5C5A';
const INK900 = '#1B2B2A';
const INK400 = '#859794';
const LINE = '#E4E9E6';
const SURFACE = '#FFFFFF';

export function SwipeRow({
  facility,
  onPass,
  onWhy,
  onOpen,
}: {
  facility: QualifyFacility;
  onPass: (f: QualifyFacility) => void;
  onWhy: (f: QualifyFacility) => void;
  onOpen: (f: QualifyFacility) => void;
}) {
  const rowRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const tintRRef = useRef<HTMLDivElement>(null);
  const tintLRef = useRef<HTMLDivElement>(null);
  const stampRRef = useRef<HTMLDivElement>(null);
  const stampLRef = useRef<HTMLDivElement>(null);
  const drag = useRef({ active: false, startX: 0, startY: 0, dx: 0, locked: false, history: [] as { x: number; t: number }[], ac: null as AbortController | null });

  useEffect(() => {
    // defensive: drop any live listeners if the row unmounts mid-gesture
    return () => drag.current.ac?.abort();
  }, []);

  function setOpacity(ref: typeof tintRRef, v: number) {
    if (ref.current) ref.current.style.opacity = String(v);
  }

  function updateVisuals(x: number) {
    if (contentRef.current) contentRef.current.style.transform = `translateX(${x}px)`;
    const rightAmt = Math.max(0, Math.min(x / 90, 1));
    const leftAmt = Math.max(0, Math.min(-x / 90, 1));
    setOpacity(tintRRef, rightAmt);
    setOpacity(tintLRef, leftAmt);
    setOpacity(stampRRef, rightAmt);
    setOpacity(stampLRef, leftAmt);
  }

  function velocity(): number {
    const h = drag.current.history;
    if (h.length < 2) return 0;
    const recent = h[h.length - 1]!;
    const prior = h[Math.max(0, h.length - 4)]!;
    const dt = recent.t - prior.t;
    if (dt <= 0) return 0;
    return (recent.x - prior.x) / dt;
  }

  function cleanup() {
    drag.current.ac?.abort();
    drag.current.ac = null;
  }

  function springBack() {
    const c = contentRef.current;
    if (c) {
      c.style.transition = 'transform 0.3s cubic-bezier(0.34, 1.56, 0.64, 1)';
      c.style.transform = 'translateX(0px)';
    }
    [tintRRef, tintLRef, stampRRef, stampLRef].forEach((r) => {
      if (r.current) {
        r.current.style.transition = 'opacity 0.2s ease-out';
        r.current.style.opacity = '0';
      }
    });
  }

  function resolveRow(goingRight: boolean, v: number) {
    const c = contentRef.current;
    const row = rowRef.current;
    const speed = Math.max(Math.abs(v), 0.35);
    const duration = Math.max(160, Math.min(300, 240 - speed * 100));
    const exit = (typeof window !== 'undefined' ? window.innerWidth : 400) * 1.2 * (goingRight ? 1 : -1);
    if (c) {
      c.style.transition = `transform ${duration}ms cubic-bezier(0.22, 1, 0.36, 1)`;
      c.style.transform = `translateX(${exit}px)`;
    }
    if (row) {
      row.style.transition = `max-height ${duration + 80}ms ease-in, opacity ${duration + 80}ms ease-in, margin-bottom ${duration + 80}ms ease-in`;
      row.style.pointerEvents = 'none';
    }
    window.setTimeout(() => {
      if (!row) return;
      row.style.maxHeight = '84px';
      void row.offsetHeight; // force reflow so the collapse transition fires
      row.style.overflow = 'hidden';
      row.style.maxHeight = '0px';
      row.style.opacity = '0';
      row.style.marginBottom = '-10px';
    }, duration * 0.4);
    window.setTimeout(() => {
      if (goingRight) onWhy(facility);
      else onPass(facility);
    }, duration + 100);
  }

  function onMove(e: PointerEvent) {
    const d = drag.current;
    if (!d.active) return;
    const rawDx = e.clientX - d.startX;
    const rawDy = e.clientY - d.startY;
    if (!d.locked) {
      if (Math.abs(rawDx) < 8 && Math.abs(rawDy) < 8) return;
      d.locked = Math.abs(rawDx) > Math.abs(rawDy);
      if (!d.locked) {
        d.active = false;
        cleanup();
        return;
      }
    }
    if (e.cancelable) e.preventDefault();
    d.dx = rawDx;
    d.history.push({ x: e.clientX, t: e.timeStamp });
    if (d.history.length > 6) d.history.shift();
    updateVisuals(rawDx);
  }

  function onUp() {
    const d = drag.current;
    if (!d.active) {
      cleanup();
      return;
    }
    d.active = false;
    cleanup();
    if (!d.locked) {
      // Never crossed the 8px axis-lock threshold → this was a tap, not a swipe: open detail (no
      // consume). Previously this returned early, so the tap-to-open branch below was unreachable
      // and DetailSheet could never be opened from the list.
      onOpen(facility);
      return;
    }
    const v = velocity();
    const shouldResolve = Math.abs(d.dx) > DIST_THRESHOLD || Math.abs(v) > VELOCITY_THRESHOLD;
    if (shouldResolve) {
      resolveRow(d.dx > 0 || (d.dx === 0 && v > 0), v);
    } else if (Math.abs(d.dx) < 5) {
      // Locked but barely moved — treat as a tap too.
      onOpen(facility);
      springBack();
    } else {
      springBack();
    }
  }

  function onCancel() {
    // A pointer cancel (OS gesture takeover, etc.) is NEVER a tap — abort without opening detail. If the
    // gesture had already locked and moved (e.g. iOS edge-swipe-back takes over mid-drag), updateVisuals
    // has left a partial transform/stamp on the row; spring it back so it doesn't stick offset.
    const d = drag.current;
    d.active = false;
    cleanup();
    if (d.locked) springBack();
  }

  function onPointerDown(e: ReactPointerEvent<HTMLDivElement>) {
    const d = drag.current;
    d.startX = e.clientX;
    d.startY = e.clientY;
    d.dx = 0;
    d.active = true;
    d.locked = false;
    d.history = [{ x: e.clientX, t: e.timeStamp }];
    if (contentRef.current) contentRef.current.style.transition = 'none';
    const ac = new AbortController();
    d.ac = ac;
    window.addEventListener('pointermove', onMove, { passive: false, signal: ac.signal });
    window.addEventListener('pointerup', onUp, { signal: ac.signal });
    window.addEventListener('pointercancel', onCancel, { signal: ac.signal });
  }

  const b = mobileBucketStyle(facility.rating);
  // "City, ST" only when BOTH are present — partial (city-only / state-only) omits cleanly, never "City, " or ", ST".
  const loc = facility.city && facility.state ? `${facility.city}, ${facility.state}` : null;
  const overlay = 'absolute inset-0 pointer-events-none opacity-0';
  const stampBase = 'absolute top-1/2 flex items-center gap-1 rounded-md border-[1.5px] bg-white px-2 py-1 text-[10px] font-bold uppercase opacity-0 pointer-events-none';

  return (
    <div
      ref={rowRef}
      onPointerDown={onPointerDown}
      style={{
        position: 'relative',
        height: 84,
        borderRadius: 16,
        background: SURFACE,
        border: `0.5px solid ${LINE}`,
        borderLeft: `3px solid ${b.color}`,
        overflow: 'hidden',
        boxShadow: '0 1px 2px rgba(27,43,42,0.06)',
        touchAction: 'pan-y',
      }}
    >
      <div ref={tintRRef} className={overlay} style={{ background: TINT_RIGHT }} />
      <div ref={tintLRef} className={overlay} style={{ background: TINT_LEFT }} />
      <div ref={stampRRef} className={stampBase} style={{ right: 10, transform: 'translateY(-50%) rotate(-6deg)', borderColor: TEAL700, color: TEAL700 }}>
        <TrendIcon size={11} color={TEAL700} />
        <span>Why</span>
      </div>
      <div ref={stampLRef} className={stampBase} style={{ left: 10, transform: 'translateY(-50%) rotate(6deg)', borderColor: INK600, color: INK600 }}>
        <XIcon size={11} color={INK600} />
        <span>Pass</span>
      </div>
      <div
        ref={contentRef}
        className="relative z-[2] flex h-full items-center gap-3 px-4"
        style={{ pointerEvents: 'none' }}
      >
        <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-[9px]" style={{ background: b.tint }}>
          <BuildingIcon size={16} color={b.color} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="ths-h truncate text-[13px] font-semibold leading-tight" style={{ color: INK900 }}>
            {facility.name}
          </div>
          <div className="mt-0.5 truncate text-[11px]" style={{ color: INK400 }}>
            {loc ? `${loc} · ` : ''}{facility.lineCount} lines this window
          </div>
        </div>
        <div className="flex-shrink-0 text-right">
          <div className="ths-num text-[20px] font-bold leading-none" style={{ color: b.color }}>
            {facility.rating === null ? '—' : Math.round(facility.rating)}
          </div>
          <div className="mt-0.5 text-[9px] font-bold uppercase tracking-wide" style={{ color: b.color }}>
            {b.label}
          </div>
        </div>
      </div>
    </div>
  );
}
