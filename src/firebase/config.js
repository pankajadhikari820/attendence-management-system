import { initializeApp, getApps } from 'firebase/app';
import { getAuth } from 'firebase/auth';
import {
  initializeFirestore,
  getFirestore,
  persistentLocalCache,
  persistentMultipleTabManager,
  doc,
  getDocFromServer,
} from 'firebase/firestore';
import { getDatabase } from 'firebase/database';
import { getStorage } from 'firebase/storage';
import { getFunctions } from 'firebase/functions';
import { initializeAppCheck, ReCaptchaEnterpriseProvider } from 'firebase/app-check';

// Firebase Configuration supplied by project owner (attendence-system-867c1)
export const firebaseConfig = {
  apiKey: 'AIzaSyB8dA1ZW13UtbdmeUGahFjRJkht7RXu1Lc',
  authDomain: 'attendence-system-867c1.firebaseapp.com',
  databaseURL: 'https://attendence-system-867c1-default-rtdb.firebaseio.com',
  projectId: 'attendence-system-867c1',
  storageBucket: 'attendence-system-867c1.firebasestorage.app',
  messagingSenderId: '1067385874361',
  appId: '1:1067385874361:web:da3ffbe331505b6a7e7868',
  measurementId: 'G-BCM285Q750',
};

export const app = getApps().find((a) => a.name === '[DEFAULT]') || initializeApp(firebaseConfig);

let appCheckInstance = null;
let secondaryAppCheckInstance = null;
let appCheckStatus = {
  enabled: false,
  reason: 'App Check reCAPTCHA Enterprise site key not configured.',
};

function resolveRecaptchaEnterpriseSiteKey() {
  const envSiteKey =
    import.meta.env?.VITE_RECAPTCHA_ENTERPRISE_SITE_KEY ||
    import.meta.env?.VITE_FIREBASE_APPCHECK_SITE_KEY ||
    import.meta.env?.VITE_RECAPTCHA_SITE_KEY ||
    '';

  if (String(envSiteKey).trim()) {
    return String(envSiteKey).trim();
  }

  if (typeof window !== 'undefined') {
    try {
      const storedKey = window.localStorage.getItem('smartattend_appcheck_site_key') || '';
      if (storedKey.trim()) return storedKey.trim();
    } catch {
      return '';
    }
  }

  return '';
}

export function initFirebaseAppCheck() {
  if (appCheckInstance) return appCheckStatus;

  if (typeof window === 'undefined') {
    return appCheckStatus;
  }

  const siteKey = resolveRecaptchaEnterpriseSiteKey();
  if (!siteKey) {
    appCheckStatus = {
      enabled: false,
      reason:
        'Configure VITE_RECAPTCHA_ENTERPRISE_SITE_KEY in Vercel/Vite environment variables (or save your public Site Key below) after registering reCAPTCHA Enterprise in Firebase App Check.',
    };
    return appCheckStatus;
  }

  try {
    appCheckInstance = initializeAppCheck(app, {
      provider: new ReCaptchaEnterpriseProvider(siteKey),
      isTokenAutoRefreshEnabled: true,
    });
    appCheckStatus = {
      enabled: true,
      reason: 'Firebase App Check (reCAPTCHA Enterprise) active.',
    };
  } catch (err) {
    appCheckStatus = {
      enabled: false,
      reason: err?.message || 'App Check initialization failed.',
    };
  }
  return appCheckStatus;
}

// Initialize App Check synchronously at module startup BEFORE getAuth/initializeFirestore
// so every Authentication and Firestore request carries a valid App Check token.
initFirebaseAppCheck();

export function getAppCheckStatus() {
  return appCheckStatus;
}

export const auth = getAuth(app);

let firestoreInstance;
try {
  firestoreInstance = initializeFirestore(app, {
    localCache: persistentLocalCache({
      tabManager: persistentMultipleTabManager(),
    }),
  });
} catch {
  firestoreInstance = getFirestore(app);
}
export const db = firestoreInstance;
export const rtdb = getDatabase(app);
export const storage = getStorage(app);
export const functions = getFunctions(app, 'us-central1');

// Secondary Firebase app instance used strictly when Org Admin provisions member accounts on Spark plan
// (when Cloud Functions are not deployed), keeping the Owner/Admin signed in.
export function getSecondaryAuth() {
  const existing = getApps().find((a) => a.name === 'adminProvisioner');
  const secondaryApp = existing || initializeApp(firebaseConfig, 'adminProvisioner');

  if (!secondaryAppCheckInstance && typeof window !== 'undefined') {
    const siteKey = resolveRecaptchaEnterpriseSiteKey();
    if (siteKey) {
      try {
        secondaryAppCheckInstance = initializeAppCheck(secondaryApp, {
          provider: new ReCaptchaEnterpriseProvider(siteKey),
          isTokenAutoRefreshEnabled: true,
        });
      } catch {
        // Already initialized on this secondary app instance
      }
    }
  }

  return getAuth(secondaryApp);
}

export async function testFirestoreConnection() {
  try {
    await getDocFromServer(doc(db, 'test', 'connection'));
    return { ok: true };
  } catch (error) {
    if (error instanceof Error && error.message.includes('the client is offline')) {
      return { ok: false, offline: true, message: error.message };
    }
    return { ok: true };
  }
}
