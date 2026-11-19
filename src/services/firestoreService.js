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
import { getState } from '../state/store.js';

export function orgCol(orgId, subcollection) {
  if (!orgId) throw new Error('Organization context (orgId) is required.');
  return collection(db, 'organizations', orgId, subcollection);
}

export function orgDoc(orgId, subcollection, docId) {
  if (!orgId) throw new Error('Organization context (orgId) is required.');
  return doc(db, 'organizations', orgId, subcollection, docId);
}

export async function fetchOrgCollection(orgId, subcollection, constraints = []) {
  const path = `organizations/${orgId}/${subcollection}`;
  try {
    const ref = orgCol(orgId, subcollection);
    const q = constraints.length > 0 ? query(ref, ...constraints) : ref;
    const snap = await getDocs(q);
    return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  } catch (error) {
    handleFirestoreError(error, OperationType.LIST, path);
  }
}

export async function fetchOrgDoc(orgId, subcollection, id) {
  const path = `organizations/${orgId}/${subcollection}/${id}`;
  try {
    const snap = await getDoc(orgDoc(orgId, subcollection, id));
    return snap.exists() ? { id: snap.id, ...snap.data() } : null;
  } catch (error) {
    handleFirestoreError(error, OperationType.GET, path);
  }
}

export async function createOrgDoc(orgId, subcollection, payload) {
  const path = `organizations/${orgId}/${subcollection}`;
  try {
    const ref = await addDoc(orgCol(orgId, subcollection), {
      ...payload,
      orgId,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
    return ref.id;
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, path);
  }
}

export async function setOrgDoc(orgId, subcollection, id, payload, merge = false) {
  const path = `organizations/${orgId}/${subcollection}/${id}`;
  try {
    await setDoc(
      orgDoc(orgId, subcollection, id),
      {
        ...payload,
        orgId,
        updatedAt: serverTimestamp(),
      },
      { merge }
    );
    return id;
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, path);
  }
}

export async function updateOrgDoc(orgId, subcollection, id, patch) {
  const path = `organizations/${orgId}/${subcollection}/${id}`;
  try {
    await updateDoc(orgDoc(orgId, subcollection, id), {
      ...patch,
      updatedAt: serverTimestamp(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, path);
  }
}

export async function deleteOrgDoc(orgId, subcollection, id) {
  const path = `organizations/${orgId}/${subcollection}/${id}`;
  try {
    await deleteDoc(orgDoc(orgId, subcollection, id));
  } catch (error) {
    handleFirestoreError(error, OperationType.DELETE, path);
  }
}

export async function logOrgAudit({
  orgId,
  action,
  entityType,
  entityId,
  details = '',
  before = null,
  after = null,
}) {
  const user = auth.currentUser;
  const targetOrg = orgId || getState().activeOrgId;
  if (!user || !targetOrg) return;
  const state = getState();
  try {
    await addDoc(orgCol(targetOrg, 'auditLogs'), {
      orgId: targetOrg,
      actorUid: user.uid,
      actorEmail: user.email || '',
      actorName: state.activeMember?.name || state.userProfile?.name || user.displayName || '',
      actorDesignation: state.activeMember?.designationName || state.resolvedTier || 'member',
      action: String(action || 'UNKNOWN').slice(0, 80),
      entityType: String(entityType || 'unknown').slice(0, 60),
      entityId: String(entityId || '').slice(0, 128),
      details: String(details || '').slice(0, 500),
      before: before ? JSON.stringify(before).slice(0, 1200) : '',
      after: after ? JSON.stringify(after).slice(0, 1200) : '',
      timestamp: serverTimestamp(),
    });
  } catch (err) {
    console.warn('Org audit log write skipped:', err.message);
  }
}

export async function createOrgNotification({
  orgId,
  userId,
  title,
  message,
  type = 'notice',
  linkView = 'overview',
}) {
  const targetOrg = orgId || getState().activeOrgId;
  if (!userId || !targetOrg) return;
  try {
    await addDoc(orgCol(targetOrg, 'notifications'), {
      orgId: targetOrg,
      userId,
      title: String(title).slice(0, 140),
      message: String(message).slice(0, 500),
      type,
      read: false,
      linkView,
      createdAt: serverTimestamp(),
    });
  } catch (err) {
    console.warn('Notification creation skipped:', err.message);
  }
}

export async function createPublicContactInquiry({ name, email, orgName, orgType, message }) {
  try {
    const ref = await addDoc(collection(db, 'contactInquiries'), {
      name: String(name || '').trim().slice(0, 100),
      email: String(email || '').trim().toLowerCase().slice(0, 160),
      orgName: String(orgName || '').trim().slice(0, 140),
      orgType: String(orgType || 'other').trim().slice(0, 60),
      message: String(message || '').trim().slice(0, 2000),
      createdAt: serverTimestamp(),
    });
    return ref.id;
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, 'contactInquiries');
  }
}

export { where, orderBy, limit };
