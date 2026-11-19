import { initializeApp, getApps } from 'firebase/app';
import { getAuth } from 'firebase/auth';
import { getFirestore, doc, getDocFromServer } from 'firebase/firestore';
import { getDatabase } from 'firebase/database';
import { getStorage } from 'firebase/storage';
import { getFunctions } from 'firebase/functions';

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
export const auth = getAuth(app);
export const db = getFirestore(app);
export const rtdb = getDatabase(app);
export const storage = getStorage(app);
export const functions = getFunctions(app, 'us-central1');

// Secondary Firebase app instance used strictly when Admin creates accounts on Spark plan
// (when Cloud Functions are not deployed), preventing Admin session sign-out.
export function getSecondaryAuth() {
  const existing = getApps().find((a) => a.name === 'adminProvisioner');
  const secondaryApp = existing || initializeApp(firebaseConfig, 'adminProvisioner');
  return getAuth(secondaryApp);
}

export async function testFirestoreConnection() {
  try {
    await getDocFromServer(doc(db, 'test', 'connection'));
    return { ok: true };
  } catch (error) {
    if (error instanceof Error && error.message.includes('the client is offline')) {
      console.error('Firestore appears offline. Please verify Firebase project configuration.');
      return { ok: false, offline: true, message: error.message };
    }
    // Permission denied on test/connection still confirms Firestore server reachability
    return { ok: true };
  }
}
