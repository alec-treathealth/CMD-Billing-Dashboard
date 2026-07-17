'use client';

/**
 * Qualify mobile — registers the scope-limited service worker and offers an install affordance.
 * beforeinstallprompt drives the button on Chromium; iOS Safari (which fires no such event and can't
 * be installed programmatically) gets a "Share → Add to Home Screen" hint instead. Rendered only
 * inside /qualify/m, which is already role-gated to {super_admin, admissions_seat}.
 */
import { useEffect, useState } from 'react';

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
}

const INK600 = '#4A5C5A';
const TEAL700 = '#135E5A';
const TEAL50 = '#EAF4F2';
const TEAL200 = '#B7DAD5';
const LINE = '#E4E9E6';

export function SwRegister() {
  const [installEvt, setInstallEvt] = useState<BeforeInstallPromptEvent | null>(null);
  const [iosHint, setIosHint] = useState(false);
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
    const standalone = window.matchMedia('(display-mode: standalone)').matches || nav.standalone === true;
    if (isIos && !standalone) setIosHint(true);
    return () => window.removeEventListener('beforeinstallprompt', onBIP);
  }, []);

  if (dismissed) return null;

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
