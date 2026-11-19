import { showToast, openModal, closeModal } from './ui.js';

let deferredInstallPrompt = null;
const installListeners = new Set();

export function canInstallPwa() {
  return Boolean(deferredInstallPrompt);
}

export function isRunningStandalone() {
  return (
    window.matchMedia?.('(display-mode: standalone)')?.matches ||
    window.navigator.standalone === true
  );
}

export function isIosSafari() {
  const ua = window.navigator.userAgent || '';
  return /iphone|ipad|ipod/i.test(ua) && !/crios|fxios|edgios/i.test(ua);
}

export function subscribePwaInstallChange(fn) {
  installListeners.add(fn);
  return () => installListeners.delete(fn);
}

function notifyInstallListeners() {
  installListeners.forEach((fn) => {
    try {
      fn(canInstallPwa());
    } catch {
      // ignore listener errors
    }
  });
}

export async function triggerPwaInstall() {
  if (deferredInstallPrompt) {
    deferredInstallPrompt.prompt();
    const result = await deferredInstallPrompt.userChoice;
    deferredInstallPrompt = null;
    notifyInstallListeners();
    if (result?.outcome === 'accepted') {
      showToast('SmartAttend installed to your device.', 'success');
    }
    return true;
  }

  if (isIosSafari() && !isRunningStandalone()) {
    openModal({
      title: 'Install SmartAttend on iOS',
      bodyHtml: `
        <div class="stack-md">
          <p style="color:var(--text-secondary);font-size:0.9375rem;">
            Safari on iOS supports adding SmartAttend directly to your Home Screen as an app:
          </p>
          <ol style="margin:0;padding-left:1.25rem;display:flex;flex-direction:column;gap:0.5rem;color:var(--text-secondary);font-size:0.875rem;">
            <li>Tap the <strong>Share</strong> icon in Safari's toolbar.</li>
            <li>Scroll down and tap <strong>Add to Home Screen</strong>.</li>
            <li>Tap <strong>Add</strong> to launch SmartAttend full-screen.</li>
          </ol>
        </div>
      `,
      footerHtml: `<button type="button" class="btn btn-primary" id="ios-install-ok">Got it</button>`,
      onMount(dialog) {
        dialog.querySelector('#ios-install-ok')?.addEventListener('click', closeModal);
      },
    });
    return true;
  }

  showToast('Use your browser menu ("Install app" or "Add to Home Screen") to install SmartAttend.', 'info');
  return false;
}

export function isNetworkOnline() {
  if (typeof navigator === 'undefined') return true;
  return navigator.onLine !== false;
}

export function assertOnlineForAttendance(actionLabel = 'record live attendance') {
  if (!isNetworkOnline()) {
    throw new Error(
      `Offline detected: SmartAttend cannot ${actionLabel} without a verified server connection. Reconnect to continue.`
    );
  }
}

export function initPwaAndNetwork(onNetworkChange) {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredInstallPrompt = e;
    notifyInstallListeners();
  });

  window.addEventListener('appinstalled', () => {
    deferredInstallPrompt = null;
    notifyInstallListeners();
  });

  const syncOfflineUi = () => {
    const online = isNetworkOnline();
    const banner = document.getElementById('offline-banner');
    if (banner) {
      banner.style.display = online ? 'none' : 'block';
    }
    if (typeof onNetworkChange === 'function') {
      onNetworkChange(online);
    }
  };

  window.addEventListener('online', syncOfflineUi);
  window.addEventListener('offline', syncOfflineUi);
  syncOfflineUi();

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => {
      // Service worker registration skipped if blocked in restricted iframe
    });
  }
}
