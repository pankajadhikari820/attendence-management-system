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
import { doc, updateDoc, serverTimestamp } from 'firebase/firestore';
import { auth, db } from '../firebase/config.js';
import {
  provisionOrganizationDocuments,
  fetchUserProfileAndMemberships,
  loadOrganizationContext,
  joinOrganizationWithCodeOrId,
  ensureGlobalUserProfile,
} from './orgService.js';
import {
  BOOTSTRAPPED_ADMIN_EMAIL,
  isBootstrapAdminEmail,
  validateUserProfile,
} from '../utils/authRouting.js';

export { BOOTSTRAPPED_ADMIN_EMAIL, isBootstrapAdminEmail };

let authFlowInProgress = false;
export function isAuthFlowInProgress() {
  return authFlowInProgress;
}

const INVALID_SESSION_TOKENS = [
  'auth/user-token-expired',
  'auth/invalid-user-token',
  'auth/user-not-found',
  'auth/user-disabled',
  'INVALID_ID_TOKEN',
  'USER_NOT_FOUND',
  'USER_DISABLED',
  'TOKEN_EXPIRED',
];

export function isInvalidSessionError(err) {
  const code = String(err?.code || '');
  const msg = String(err?.message || '');
  return INVALID_SESSION_TOKENS.some((tok) => code.includes(tok) || msg.includes(tok));
}

export function formatAuthError(err, fallback = 'Authentication request failed.') {
  const code = String(err?.code || '');
  const raw = String(err?.message || '');

  if (code === 'auth/invalid-credential' || code === 'auth/wrong-password' || code === 'auth/user-not-found') {
    return new Error('Incorrect email or password. Please verify your credentials and try again.');
  }
  if (code === 'auth/email-already-in-use' || raw.includes('EMAIL_EXISTS')) {
    return new Error('An account with this email already exists. Please sign in or reset your password.');
  }
  if (code === 'auth/weak-password') {
    return new Error('Password must be at least 6 characters long.');
  }
  if (code === 'auth/invalid-email') {
    return new Error('Please enter a valid email address.');
  }
  if (code === 'auth/too-many-requests') {
    return new Error('Too many authentication attempts. Please wait a few minutes and try again.');
  }
  if (code === 'auth/unauthorized-domain') {
    const host = typeof window !== 'undefined' ? window.location.hostname : 'this domain';
    return new Error(
      `Domain "${host}" is not authorized in Firebase Authentication settings. Add it under Firebase Console -> Authentication -> Settings -> Authorized domains.`
    );
  }
  if (code === 'auth/popup-closed-by-user' || code === 'auth/cancelled-popup-request') {
    return new Error('Google sign-in popup was closed before completing authentication.');
  }
  if (code === 'auth/popup-blocked') {
    return new Error('Browser blocked the Google sign-in popup. Please allow popups and try again.');
  }
  if (code === 'auth/user-disabled') {
    return new Error('This user account has been disabled in Firebase Authentication.');
  }
  if (isInvalidSessionError(err)) {
    const out = new Error('Your authentication session expired or is no longer valid. Please sign in again.');
    out.isInvalidSession = true;
    out.code = code || 'auth/invalid-user-token';
    return out;
  }
  if (code === 'auth/network-request-failed') {
    return new Error('Network error reaching Firebase Authentication. Check your internet connection.');
  }
  return err instanceof Error ? err : new Error(raw || fallback);
}

export async function validateAndRefreshAuthUser(
  user,
  { forceReload = false, forceTokenRefresh = false } = {}
) {
  if (!user) return null;

  if (forceReload) {
    try {
      await reload(user);
    } catch (err) {
      if (isInvalidSessionError(err)) {
        throw formatAuthError(err);
      }
      if (err?.code !== 'auth/network-request-failed') {
        console.warn('Auth reload warning:', err?.code || err?.message);
      }
    }
  }

  try {
    await user.getIdToken(forceTokenRefresh);
  } catch (err) {
    if (isInvalidSessionError(err)) {
      throw formatAuthError(err);
    }
    if (err?.code !== 'auth/network-request-failed') {
      console.warn('ID token refresh warning:', err?.code || err?.message);
    }
  }

  return user;
}

function assertValidEmailInput(email) {
  const clean = String(email || '').trim().toLowerCase();
  if (!clean || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean)) {
    throw new Error('Please enter a valid email address.');
  }
  return clean;
}

export async function resolvePostLoginSession(firebaseUser, preferredOrgId = '') {
  const { userProfile, memberships } = await fetchUserProfileAndMemberships(firebaseUser.uid);
  const bootstrapAdmin = Boolean(
    firebaseUser.emailVerified && isBootstrapAdminEmail(firebaseUser.email)
  );

  let resolvedProfile = userProfile;
  if (!resolvedProfile) {
    await ensureGlobalUserProfile({
      uid: firebaseUser.uid,
      name: firebaseUser.displayName || 'SmartAttend User',
      email: firebaseUser.email || '',
      emailVerified: firebaseUser.emailVerified,
      activeOrgId: memberships[0]?.orgId || '',
    });
    resolvedProfile = {
      id: firebaseUser.uid,
      uid: firebaseUser.uid,
      name: firebaseUser.displayName || 'SmartAttend User',
      email: String(firebaseUser.email || '').trim().toLowerCase(),
      avatarUrl: firebaseUser.photoURL || '',
      emailVerified: Boolean(firebaseUser.emailVerified),
      lastActiveOrgId: memberships[0]?.orgId || '',
      status: 'active',
    };
  }

  validateUserProfile(resolvedProfile, firebaseUser.uid);
  if (resolvedProfile.emailVerified !== firebaseUser.emailVerified) {
    await updateDoc(doc(db, 'users', firebaseUser.uid), {
      emailVerified: firebaseUser.emailVerified,
      updatedAt: serverTimestamp(),
    }).catch(() => {});
    resolvedProfile = { ...resolvedProfile, emailVerified: firebaseUser.emailVerified };
  }

  if (memberships.length === 0) {
    return {
      user: firebaseUser,
      userProfile: resolvedProfile,
      memberships: [],
      isBootstrapAdmin: bootstrapAdmin,
      needsOrgOnboarding: true,
    };
  }

  const activeMemberships = memberships.filter((m) => m.status === 'active');
  const pendingMemberships = memberships.filter((m) => m.status === 'pending');

  if (activeMemberships.length === 0) {
    if (pendingMemberships.length > 0) {
      throw new Error(
        `Your join request to "${pendingMemberships[0].orgName}" (${pendingMemberships[0].orgId}) is still awaiting organization admin approval.`
      );
    }
    return {
      user: firebaseUser,
      userProfile: resolvedProfile,
      memberships,
      isBootstrapAdmin: bootstrapAdmin,
      needsOrgOnboarding: true,
    };
  }

  const targetOrgId =
    (preferredOrgId && activeMemberships.some((m) => m.orgId === preferredOrgId) && preferredOrgId) ||
    (resolvedProfile?.lastActiveOrgId && activeMemberships.some((m) => m.orgId === resolvedProfile.lastActiveOrgId)
      ? resolvedProfile.lastActiveOrgId
      : '');

  if (activeMemberships.length > 1 && !targetOrgId) {
    return {
      user: firebaseUser,
      userProfile: resolvedProfile,
      memberships: activeMemberships,
      isBootstrapAdmin: bootstrapAdmin,
      needsOrgSelection: true,
    };
  }

  const chosenOrgId = targetOrgId || activeMemberships[0].orgId;
  const orgContext = await loadOrganizationContext(firebaseUser.uid, chosenOrgId);

  return {
    user: firebaseUser,
    userProfile: resolvedProfile,
    memberships: activeMemberships,
    activeOrgId: chosenOrgId,
    isBootstrapAdmin: bootstrapAdmin,
    ...orgContext,
  };
}

export async function loginWithEmail(email, password) {
  const cleanEmail = assertValidEmailInput(email);
  if (!password || String(password).length < 1) {
    throw new Error('Please enter your password.');
  }

  authFlowInProgress = true;
  try {
    let cred;
    try {
      cred = await signInWithEmailAndPassword(auth, cleanEmail, String(password));
    } catch (err) {
      throw formatAuthError(err, 'Sign-in failed.');
    }

    if (!cred.user.emailVerified) {
      return { user: cred.user, requiresVerification: true, isBootstrapAdmin: false };
    }
    await validateAndRefreshAuthUser(cred.user, { forceReload: false, forceTokenRefresh: true });
    return await resolvePostLoginSession(cred.user);
  } finally {
    authFlowInProgress = false;
  }
}

export async function loginWithGoogle() {
  authFlowInProgress = true;
  try {
    const provider = new GoogleAuthProvider();
    provider.setCustomParameters({ prompt: 'select_account' });
    let cred;
    try {
      cred = await signInWithPopup(auth, provider);
    } catch (err) {
      throw formatAuthError(err, 'Google sign-in failed.');
    }
    await validateAndRefreshAuthUser(cred.user, { forceReload: false, forceTokenRefresh: true });
    return await resolvePostLoginSession(cred.user);
  } finally {
    authFlowInProgress = false;
  }
}

export async function registerOrganizationOwner({
  ownerName,
  email,
  password,
  orgName,
  orgType,
  country,
  timezone,
  phone = '',
  address = '',
  description = '',
}) {
  if (!orgName || String(orgName).trim().length < 2) {
    throw new Error('Organization name must be at least 2 characters.');
  }
  if (!ownerName || String(ownerName).trim().length < 2) {
    throw new Error('Owner / Primary Head name must be at least 2 characters.');
  }

  authFlowInProgress = true;
  try {
    let firebaseUser = auth.currentUser;
    if (!firebaseUser) {
      const cleanEmail = assertValidEmailInput(email);
      if (!password || String(password).length < 6) {
        throw new Error('Password must be at least 6 characters.');
      }
      try {
        const cred = await createUserWithEmailAndPassword(auth, cleanEmail, String(password));
        firebaseUser = cred.user;
      } catch (err) {
        throw formatAuthError(err, 'Account registration failed.');
      }
      await updateProfile(firebaseUser, { displayName: ownerName.trim() }).catch(() => {});
      await sendEmailVerification(firebaseUser).catch(() => {});
      await validateAndRefreshAuthUser(firebaseUser, { forceReload: false, forceTokenRefresh: true });
    } else {
      await validateAndRefreshAuthUser(firebaseUser, { forceReload: true, forceTokenRefresh: true });
    }

    const created = await provisionOrganizationDocuments({
      ownerUid: firebaseUser.uid,
      ownerName: ownerName || firebaseUser.displayName || 'Organization Owner',
      ownerEmail: email || firebaseUser.email,
      orgName,
      orgType,
      country,
      timezone,
      phone,
      address,
      description,
      emailVerified: firebaseUser.emailVerified,
    });

    if (!firebaseUser.emailVerified) {
      return { user: firebaseUser, requiresVerification: true, isBootstrapAdmin: false, created };
    }

    return await resolvePostLoginSession(firebaseUser, created.orgId);
  } finally {
    authFlowInProgress = false;
  }
}

export async function registerAndJoinOrganization({
  name,
  email,
  password,
  phone = '',
  externalId = '',
  inviteCode = '',
  orgIdInput = '',
}) {
  if (!String(inviteCode || '').trim() && !String(orgIdInput || '').trim()) {
    throw new Error('Enter either an Invitation Code or an Organization ID.');
  }
  if (!name || String(name).trim().length < 2) {
    throw new Error('Full name must be at least 2 characters.');
  }

  authFlowInProgress = true;
  try {
    let firebaseUser = auth.currentUser;
    if (!firebaseUser) {
      const cleanEmail = assertValidEmailInput(email);
      if (!password || String(password).length < 6) {
        throw new Error('Password must be at least 6 characters.');
      }
      try {
        const cred = await createUserWithEmailAndPassword(auth, cleanEmail, String(password));
        firebaseUser = cred.user;
      } catch (err) {
        throw formatAuthError(err, 'Member registration failed.');
      }
      await updateProfile(firebaseUser, { displayName: name.trim() }).catch(() => {});
      await sendEmailVerification(firebaseUser).catch(() => {});
      await validateAndRefreshAuthUser(firebaseUser, { forceReload: false, forceTokenRefresh: true });
    } else {
      await validateAndRefreshAuthUser(firebaseUser, { forceReload: true, forceTokenRefresh: true });
    }

    const joined = await joinOrganizationWithCodeOrId({
      uid: firebaseUser.uid,
      name: name || firebaseUser.displayName || 'Member',
      email: email || firebaseUser.email,
      phone,
      externalId,
      inviteCode,
      orgIdInput,
      emailVerified: firebaseUser.emailVerified,
    });

    if (!firebaseUser.emailVerified) {
      return { user: firebaseUser, requiresVerification: true, isBootstrapAdmin: false, joined };
    }

    if (joined.status === 'pending') {
      return {
        user: firebaseUser,
        pendingApproval: true,
        isBootstrapAdmin: isBootstrapAdminEmail(firebaseUser.email),
        joined,
      };
    }

    return await resolvePostLoginSession(firebaseUser, joined.orgId);
  } finally {
    authFlowInProgress = false;
  }
}

export async function resendVerificationEmail() {
  if (!auth.currentUser) throw new Error('No signed-in user.');
  try {
    await sendEmailVerification(auth.currentUser);
  } catch (err) {
    throw formatAuthError(err, 'Unable to resend verification email right now.');
  }
}

export async function refreshVerificationStatus() {
  if (!auth.currentUser) return false;
  await validateAndRefreshAuthUser(auth.currentUser, { forceReload: true, forceTokenRefresh: true });
  if (auth.currentUser.emailVerified) {
    await ensureGlobalUserProfile({
      uid: auth.currentUser.uid,
      name: auth.currentUser.displayName || 'SmartAttend User',
      email: auth.currentUser.email || '',
      emailVerified: true,
      activeOrgId: '',
    }).catch(() => {});
  }
  return auth.currentUser.emailVerified;
}

export async function requestPasswordReset(email) {
  const cleanEmail = assertValidEmailInput(email);
  try {
    await sendPasswordResetEmail(auth, cleanEmail);
  } catch (err) {
    throw formatAuthError(err, 'Unable to send reset email.');
  }
}

export async function logoutUser() {
  await signOut(auth);
}
