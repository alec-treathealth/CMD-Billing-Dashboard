'use client';

/**
 * Qualify mobile — registers the scope-limited service worker and offers an install affordance.
 * beforeinstallprompt drives the button on Chromium; iOS Safari (which fires no such event and can't
 * be installed programmatically) gets a "Share → Add to Home Screen" hint instead. Rendered only
 * inside /qualify/m, which is already role-gated to {super_admin, admissions_seat}.
 *
 * When a freshly-invited user lands here from the "Set up on mobile" invite link (?welcome=1), we show
 * a PROMINENT, platform-agnostic install card (instructions for BOTH platforms, plus the native button
 * when available) instead of the subtle affordance — because a link can NEVER auto-install a PWA, so
 * the install step must be an explicit, visible action the user takes.
 */
import { useEffect, useState } from 'react';

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
}

const INK600 = '#4A5C5A';
const INK900 = '#1B2B2A';
const TEAL700 = '#135E5A';
const TEAL50 = '#EAF4F2';
const TEAL200 = '#B7DAD5';
const LINE = '#E4E9E6';

export function SwRegister() {
  const [installEvt, setInstallEvt] = useState<BeforeInstallPromptEvent | null>(null);
  const [iosHint, setIosHint] = useState(false);
  const [welcome, setWelcome] = useState(false);
  const [standalone, setStandalone] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/qualify/m/sw.js', { scope: '/qualify/m/' }).catch(() => {});
    }
    const onBIP = (e: Event) => {
      e.preventDefault();
      setInstallEvt(e as BeforeInstallPromptEvent);
    };
    window.addEventListener('beforeinstallprompt', onBIP);
    const isIos = /iphone|ipad|ipod/i.test(navigator.userAgent);
    const nav = navigator as unknown as { standalone?: boolean };
    const isStandalone = window.matchMedia('(display-mode: standalone)').matches || nav.standalone === true;
    setStandalone(isStandalone);
    if (isIos && !isStandalone) setIosHint(true);
    try {
      if (new URLSearchParams(window.location.search).get('welcome')) setWelcome(true);
    } catch {
      /* no-op: window.location always defined in the client, but stay defensive */
    }
    return () => window.removeEventListener('beforeinstallprompt', onBIP);
  }, []);

  if (dismissed) return null;

  // Fresh-invite welcome: a prominent card that works on BOTH platforms (no beforeinstallprompt
  // dependency), because the invite link routed here specifically to get the app installed. Already
  // installed (standalone) → nothing to do.
  if (welcome && !standalone) {
    return (
      <div style={{ margin: '4px 16px 12px', padding: '14px 14px', borderRadius: 14, border: `0.5px solid ${TEAL200}`, background: TEAL50 }}>
        <div className="ths-h" style={{ fontSize: 14, fontWeight: 700, color: INK900 }}>Add Lead lookup to your home screen</div>
        <div style={{ marginTop: 4, fontSize: 12, lineHeight: 1.5, color: INK600 }}>
          Keep it one tap away. <b>iPhone (Safari):</b> tap <b>Share</b> → <b>Add to Home Screen</b>. <b>Android (Chrome):</b> use the <b>Install</b> button below or the browser menu → <b>Install app</b>.
        </div>
        {installEvt ? (
          <button
            type="button"
            onClick={async () => {
              await installEvt.prompt();
              setInstallEvt(null);
            }}
            style={{ marginTop: 10, width: '100%', height: 40, borderRadius: 12, border: 'none', background: TEAL700, color: '#fff', fontWeight: 600, fontSize: 13 }}
          >
            Install Lead lookup
          </button>
        ) : null}
        <button type="button" onClick={() => setDismissed(true)} style={{ marginTop: 8, width: '100%', height: 32, borderRadius: 10, border: `0.5px solid ${TEAL200}`, background: 'transparent', color: TEAL700, fontWeight: 600, fontSize: 12 }}>
          Continue without installing
        </button>
      </div>
    );
  }

  if (installEvt) {
    return (
      <div style={{ padding: '0 16px 12px' }}>
        <button
          type="button"
          onClick={async () => {
            await installEvt.prompt();
            setInstallEvt(null);
          }}
          style={{ width: '100%', height: 40, borderRadius: 12, border: `0.5px solid ${TEAL200}`, background: TEAL50, color: TEAL700, fontWeight: 600, fontSize: 13 }}
        >
          Install Lead lookup
        </button>
      </div>
    );
  }

  if (iosHint) {
    return (
      <div style={{ margin: '0 16px 12px', padding: '10px 12px', borderRadius: 12, border: `0.5px solid ${LINE}`, background: '#fff', display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: INK600 }}>
        <span>Install: tap <b>Share</b> → <b>Add to Home Screen</b></span>
        <button type="button" onClick={() => setDismissed(true)} style={{ marginLeft: 'auto', color: TEAL700, fontWeight: 600, background: 'none', border: 'none' }}>Got it</button>
      </div>
    );
  }

  return null;
}
