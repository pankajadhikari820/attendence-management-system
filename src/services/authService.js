import {
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signInWithPopup,
  GoogleAuthProvider,
  sendEmailVerification,
  sendPasswordResetEmail,
  updateProfile,
  signOut,
  reload,
} from 'firebase/auth';
import { doc, getDoc, setDoc, serverTimestamp } from 'firebase/firestore';
import { httpsCallable } from 'firebase/functions';
import { auth, db, functions, getSecondaryAuth } from '../firebase/config.js';
import { OperationType, handleFirestoreError } from '../firebase/errors.js';
import { logAudit, setDocById, updateDocById } from './firestoreService.js';
import { getState } from '../state/store.js';

export const BOOTSTRAPPED_ADMIN_EMAIL = 'pankajadhikari820@gmail.com';

export async function loginWithEmail(email, password) {
  const cred = await signInWithEmailAndPassword(auth, email.trim(), password);
  return cred.user;
}

export async function loginWithGoogle() {
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ prompt: 'select_account' });
  const cred = await signInWithPopup(auth, provider);
  await ensureUserProfileExists(cred.user);
  return cred.user;
}

export async function registerStudentAccount({ name, email, password, rollNumber, departmentId = '', classId = '' }) {
  const cred = await createUserWithEmailAndPassword(auth, email.trim(), password);
  await updateProfile(cred.user, { displayName: name.trim() });
  await sendEmailVerification(cred.user);

  const isBootstrapAdmin = email.trim().toLowerCase() === BOOTSTRAPPED_ADMIN_EMAIL.toLowerCase();
  const role = isBootstrapAdmin ? 'admin' : 'student';

  await setDoc(doc(db, 'users', cred.user.uid), {
    uid: cred.user.uid,
    name: name.trim(),
    email: email.trim().toLowerCase(),
    role,
    departmentId,
    status: 'active',
    avatarUrl: '',
    emailVerified: cred.user.emailVerified,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });

  if (role === 'student') {
    await setDoc(doc(db, 'students', cred.user.uid), {
      uid: cred.user.uid,
      rollNumber: (rollNumber || `STU-${cred.user.uid.slice(0, 6).toUpperCase()}`).trim(),
      name: name.trim(),
      email: email.trim().toLowerCase(),
      departmentId,
      courseId: '',
      classId,
      semester: 1,
      guardianPhone: '',
      status: 'active',
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
  }

  return cred.user;
}

export async function ensureUserProfileExists(firebaseUser) {
  if (!firebaseUser) return null;
  const userRef = doc(db, 'users', firebaseUser.uid);
  try {
    const snap = await getDoc(userRef);
    if (snap.exists()) {
      const data = snap.data();
      if (data.emailVerified !== firebaseUser.emailVerified) {
        await updateDocById('users', firebaseUser.uid, { emailVerified: firebaseUser.emailVerified }).catch(() => {});
      }
      return { id: snap.id, ...data, emailVerified: firebaseUser.emailVerified };
    }

    const isBootstrapAdmin =
      (firebaseUser.email || '').toLowerCase() === BOOTSTRAPPED_ADMIN_EMAIL.toLowerCase();
    const role = isBootstrapAdmin ? 'admin' : 'student';
    const profile = {
      uid: firebaseUser.uid,
      name: firebaseUser.displayName || firebaseUser.email?.split('@')[0] || 'User',
      email: (firebaseUser.email || '').toLowerCase(),
      role,
      departmentId: '',
      status: 'active',
      avatarUrl: firebaseUser.photoURL || '',
      emailVerified: firebaseUser.emailVerified,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    };
    await setDoc(userRef, profile);

    if (role === 'student') {
      await setDoc(doc(db, 'students', firebaseUser.uid), {
        uid: firebaseUser.uid,
        rollNumber: `STU-${firebaseUser.uid.slice(0, 6).toUpperCase()}`,
        name: profile.name,
        email: profile.email,
        departmentId: '',
        courseId: '',
        classId: '',
        semester: 1,
        guardianPhone: '',
        status: 'active',
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    }
    return { id: firebaseUser.uid, ...profile };
  } catch (error) {
    handleFirestoreError(error, OperationType.GET, `users/${firebaseUser.uid}`);
  }
}

export async function loadRoleDocument(profile) {
  if (!profile) return null;
  if (profile.role === 'student') {
    const snap = await getDoc(doc(db, 'students', profile.uid));
    return snap.exists() ? { id: snap.id, ...snap.data() } : null;
  }
  if (profile.role === 'teacher') {
    const snap = await getDoc(doc(db, 'teachers', profile.uid));
    return snap.exists() ? { id: snap.id, ...snap.data() } : null;
  }
  return null;
}

export async function resendVerificationEmail() {
  if (!auth.currentUser) throw new Error('No signed-in user.');
  await sendEmailVerification(auth.currentUser);
}

export async function refreshVerificationStatus() {
  if (!auth.currentUser) return false;
  await reload(auth.currentUser);
  if (auth.currentUser.emailVerified) {
    await updateDocById('users', auth.currentUser.uid, { emailVerified: true }).catch(() => {});
  }
  return auth.currentUser.emailVerified;
}

export async function requestPasswordReset(email) {
  await sendPasswordResetEmail(auth, email.trim());
}

export async function logoutUser() {
  await signOut(auth);
}

/**
 * Admin creates a Teacher or Student account.
 * Uses Cloud Function `createManagedUser` if enabled; otherwise uses secondary Firebase Auth instance
 * so the Admin remains authenticated while creating the new user & sending email verification.
 * Passwords are NEVER stored in Firestore.
 */
export async function adminCreateUserAccount(payload) {
  const { settings } = getState();
  const {
    name,
    email,
    password,
    role,
    departmentId = '',
    courseId = '',
    classId = '',
    semester = 1,
    rollNumber = '',
    employeeId = '',
    designation = 'Lecturer',
    guardianPhone = '',
  } = payload;

  if (!name || !email || !password || !['teacher', 'student', 'admin'].includes(role)) {
    throw new Error('Name, valid email, temporary password, and role are required.');
  }

  if (settings.useCloudFunctions) {
    try {
      const fn = httpsCallable(functions, 'createManagedUser');
      const res = await fn({
        name: name.trim(),
        email: email.trim().toLowerCase(),
        password,
        role,
        departmentId,
        courseId,
        classId,
        semester: Number(semester) || 1,
        rollNumber,
        employeeId,
        designation,
        guardianPhone,
      });
      return res.data;
    } catch (fnErr) {
      console.warn('Cloud Function createManagedUser unavailable, falling back to secondary Auth client:', fnErr.message);
    }
  }

  const secondaryAuth = getSecondaryAuth();
  let newUid = '';
  try {
    const cred = await createUserWithEmailAndPassword(secondaryAuth, email.trim().toLowerCase(), password);
    newUid = cred.user.uid;
    await updateProfile(cred.user, { displayName: name.trim() });
    await sendEmailVerification(cred.user).catch(() => {});
  } finally {
    await signOut(secondaryAuth).catch(() => {});
  }

  // Write user profile as authenticated Admin (passwords are NEVER persisted to Firestore)
  await setDocById('users', newUid, {
    uid: newUid,
    name: name.trim(),
    email: email.trim().toLowerCase(),
    role,
    departmentId,
    status: 'active',
    avatarUrl: '',
    emailVerified: false,
    createdAt: serverTimestamp(),
  });

  if (role === 'student') {
    await setDocById('students', newUid, {
      uid: newUid,
      rollNumber: rollNumber.trim() || `STU-${newUid.slice(0, 6).toUpperCase()}`,
      name: name.trim(),
      email: email.trim().toLowerCase(),
      departmentId,
      courseId,
      classId,
      semester: Number(semester) || 1,
      guardianPhone: guardianPhone.trim(),
      status: 'active',
      createdAt: serverTimestamp(),
    });
  } else if (role === 'teacher') {
    await setDocById('teachers', newUid, {
      uid: newUid,
      employeeId: employeeId.trim() || `EMP-${newUid.slice(0, 6).toUpperCase()}`,
      name: name.trim(),
      email: email.trim().toLowerCase(),
      departmentId,
      designation: designation.trim() || 'Faculty',
      subjectIds: [],
      status: 'active',
      createdAt: serverTimestamp(),
    });
  }

  await logAudit('CREATE_USER', 'users', newUid, `Created ${role} account for ${email}`);
  return { uid: newUid, role, email };
}
