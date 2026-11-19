import {
  collection,
  doc,
  getDoc,
  getDocs,
  addDoc,
  setDoc,
  updateDoc,
  deleteDoc,
  query,
  where,
  orderBy,
  limit,
  serverTimestamp,
} from 'firebase/firestore';
import { db, auth } from '../firebase/config.js';
import { OperationType, handleFirestoreError } from '../firebase/errors.js';
import { getState, setState } from '../state/store.js';

export async function fetchCollection(colName, constraints = []) {
  try {
    const colRef = collection(db, colName);
    const q = constraints.length > 0 ? query(colRef, ...constraints) : colRef;
    const snap = await getDocs(q);
    return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  } catch (error) {
    handleFirestoreError(error, OperationType.LIST, colName);
  }
}

export async function fetchDocById(colName, id) {
  const path = `${colName}/${id}`;
  try {
    const snap = await getDoc(doc(db, colName, id));
    return snap.exists() ? { id: snap.id, ...snap.data() } : null;
  } catch (error) {
    handleFirestoreError(error, OperationType.GET, path);
  }
}

export async function createDoc(colName, payload) {
  try {
    const ref = await addDoc(collection(db, colName), {
      ...payload,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
    return ref.id;
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, colName);
  }
}

export async function setDocById(colName, id, payload, merge = false) {
  const path = `${colName}/${id}`;
  try {
    await setDoc(
      doc(db, colName, id),
      {
        ...payload,
        updatedAt: serverTimestamp(),
      },
      { merge }
    );
    return id;
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, path);
  }
}

export async function updateDocById(colName, id, patch) {
  const path = `${colName}/${id}`;
  try {
    await updateDoc(doc(db, colName, id), {
      ...patch,
      updatedAt: serverTimestamp(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, path);
  }
}

export async function deleteDocById(colName, id) {
  const path = `${colName}/${id}`;
  try {
    await deleteDoc(doc(db, colName, id));
  } catch (error) {
    handleFirestoreError(error, OperationType.DELETE, path);
  }
}

export async function logAudit(action, entityType, entityId, details = '') {
  const user = auth.currentUser;
  if (!user) return;
  const profile = getState().profile;
  try {
    await addDoc(collection(db, 'auditLogs'), {
      actorUid: user.uid,
      actorEmail: user.email || '',
      actorRole: profile?.role || 'unknown',
      action,
      entityType,
      entityId: String(entityId || ''),
      details: String(details || '').slice(0, 500),
      timestamp: serverTimestamp(),
    });
  } catch (err) {
    console.warn('Audit log write skipped:', err.message);
  }
}

export async function createNotification({ userId, title, message, type = 'announcement', linkView = 'overview' }) {
  if (!userId) return;
  try {
    await addDoc(collection(db, 'notifications'), {
      userId,
      title: String(title).slice(0, 140),
      message: String(message).slice(0, 500),
      type,
      read: false,
      linkView,
      createdAt: serverTimestamp(),
    });
  } catch (err) {
    console.warn('Notification creation failed:', err.message);
  }
}

export async function loadAcademicSettings() {
  try {
    const snap = await getDoc(doc(db, 'settings', 'academic'));
    if (snap.exists()) {
      const data = snap.data();
      setState({
        settings: {
          ...getState().settings,
          ...data,
        },
      });
    }
  } catch {
    // Use default settings if not yet created by Admin
  }
}

export async function saveAcademicSettings(settingsPatch) {
  await setDocById('settings', 'academic', settingsPatch, true);
  setState({
    settings: {
      ...getState().settings,
      ...settingsPatch,
    },
  });
  await logAudit('UPDATE_SETTINGS', 'settings', 'academic', JSON.stringify(settingsPatch));
}

export { where, orderBy, limit };
