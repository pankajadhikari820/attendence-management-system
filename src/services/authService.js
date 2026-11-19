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
import { validateUserProfile } from '../utils/authRouting.js';

export const BOOTSTRAPPED_ADMIN_EMAIL = 'pankajadhikari820@gmail.com';

let authFlowInProgress = false;
export function isAuthFlowInProgress() {
  return authFlowInProgress;
}

function isBootstrappedAdminEmail(email) {
  return String(email || '').trim().toLowerCase() === BOOTSTRAPPED_ADMIN_EMAIL.toLowerCase();
}

export async function loginWithEmail(email, password) {
  authFlowInProgress = true;
  try {
    const cred = await signInWithEmailAndPassword(auth, email.trim(), password);
    await reload(cred.user).catch(() => {});
    try {
      const profile = await fetchVerifiedUserProfile(cred.user, {
        allowBootstrapCreate: isBootstrappedAdminEmail(cred.user.email),
      });
      const roleData = await loadRoleDocument(profile);
      return { user: cred.user, profile, roleData };
    } catch (profileErr) {
      await signOut(auth).catch(() => {});
      throw profileErr;
    }
  } finally {
    authFlowInProgress = false;
  }
}

export async function loginWithGoogle() {
  authFlowInProgress = true;
  try {
    const provider = new GoogleAuthProvider();
    provider.setCustomParameters({ prompt: 'select_account' });
    const cred = await signInWithPopup(auth, provider);
    try {
      const profile = await fetchVerifiedUserProfile(cred.user, { allowBootstrapCreate: true });
      const roleData = await loadRoleDocument(profile);
      return { user: cred.user, profile, roleData };
    } catch (profileErr) {
      await signOut(auth).catch(() => {});
      throw profileErr;
    }
  } finally {
    authFlowInProgress = false;
  }
}

export async function registerStudentAccount({ name, email, password, rollNumber, departmentId = '', classId = '' }) {
  authFlowInProgress = true;
  try {
    const cred = await createUserWithEmailAndPassword(auth, email.trim(), password);
    await updateProfile(cred.user, { displayName: name.trim() });
    await sendEmailVerification(cred.user).catch(() => {});

    const role = isBootstrappedAdminEmail(email) && cred.user.emailVerified ? 'admin' : 'student';
    const cleanRoll = (rollNumber || `STU-${cred.user.uid.slice(0, 6).toUpperCase()}`).trim();

    const userProfile = {
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
    };
    await setDoc(doc(db, 'users', cred.user.uid), userProfile);

    let roleData = null;
    if (role === 'student') {
      roleData = {
        uid: cred.user.uid,
        rollNumber: cleanRoll,
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
      };
      await setDoc(doc(db, 'students', cred.user.uid), roleData);
    }

    return { user: cred.user, profile: { id: cred.user.uid, ...userProfile }, roleData };
  } finally {
    authFlowInProgress = false;
  }
}

export async function fetchVerifiedUserProfile(firebaseUser, { allowBootstrapCreate = false } = {}) {
  if (!firebaseUser) return null;
  const userRef = doc(db, 'users', firebaseUser.uid);
  let snap;
  try {
    snap = await getDoc(userRef);
  } catch (error) {
    handleFirestoreError(error, OperationType.GET, `users/${firebaseUser.uid}`);
  }

  if (snap.exists()) {
    const data = snap.data();
    const shouldPromoteBootstrap =
      isBootstrappedAdminEmail(firebaseUser.email) &&
      firebaseUser.emailVerified &&
      data.role !== 'admin';
    if (shouldPromoteBootstrap) {
      await updateDocById('users', firebaseUser.uid, {
        role: 'admin',
        emailVerified: true,
      }).catch(() => {});
      data.role = 'admin';
    }
    const validated = validateUserProfile({ id: snap.id, ...data }, firebaseUser.uid);
    if (data.emailVerified !== firebaseUser.emailVerified) {
      await updateDocById('users', firebaseUser.uid, { emailVerified: firebaseUser.emailVerified }).catch(() => {});
    }
    return { ...validated, emailVerified: firebaseUser.emailVerified };
  }

  if (!allowBootstrapCreate) {
    // Throws descriptive error: "User profile not found in Firestore (users/<uid>)..."
    validateUserProfile(null, firebaseUser.uid);
  }

  const role = isBootstrappedAdminEmail(firebaseUser.email) ? 'admin' : 'student';
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

  try {
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
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, `users/${firebaseUser.uid}`);
  }

  return { id: firebaseUser.uid, ...profile };
}

export async function ensureUserProfileExists(firebaseUser) {
  return fetchVerifiedUserProfile(firebaseUser, {
    allowBootstrapCreate: isBootstrappedAdminEmail(firebaseUser?.email),
  });
}

export async function loadRoleDocument(profile) {
  if (!profile) return null;
  try {
    if (profile.role === 'student') {
      const snap = await getDoc(doc(db, 'students', profile.uid));
      return snap.exists() ? { id: snap.id, ...snap.data() } : null;
    }
    if (profile.role === 'teacher') {
      const snap = await getDoc(doc(db, 'teachers', profile.uid));
      return snap.exists() ? { id: snap.id, ...snap.data() } : null;
    }
  } catch (err) {
    console.warn('Role detail document fetch warning:', err.message);
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
