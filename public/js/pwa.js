/**
 * Registers the service worker and offers an "Install app" button.
 *
 * Android/Chrome fires beforeinstallprompt, which we hold onto and replay when
 * the user taps. iOS Safari has no such event, so it gets the manual steps.
 */
const isStandalone = () =>
  window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(err => console.warn('SW failed:', err));
  });

  /**
   * Reload once when a new service worker takes over.
   *
   * Without this a deploy needs the app to be opened twice: the first open is
   * still driven by the old worker, which installs the new one and only then
   * steps aside. People reasonably read that as "nothing changed". The guard
   * matters — reloading on every controller change would loop forever.
   */
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloading) return;
    reloading = true;
    location.reload();
  });
}

let deferred = null;

window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault();
  deferred = e;
  document.querySelectorAll('[data-install]').forEach(b => b.hidden = false);
});

window.addEventListener('appinstalled', () => {
  deferred = null;
  document.querySelectorAll('[data-install]').forEach(b => b.hidden = true);
});

/** Wires any element carrying data-install. Safe to call on every page. */
export function mountInstallButton() {
  const buttons = document.querySelectorAll('[data-install]');
  if (!buttons.length) return;

  const iOS = /iphone|ipad|ipod/i.test(navigator.userAgent);

  buttons.forEach(btn => {
    // already installed, or no way to install here — keep it hidden
    btn.hidden = isStandalone() || (!deferred && !iOS);

    btn.onclick = async () => {
      if (deferred) {
        deferred.prompt();
        const { outcome } = await deferred.userChoice;
        if (outcome === 'accepted') btn.hidden = true;
        deferred = null;
        return;
      }
      if (iOS) {
        alert('To install:\n\n1. Tap the Share button in Safari\n2. Choose "Add to Home Screen"\n3. Tap Add');
      }
    };
  });
}

export { isStandalone };
