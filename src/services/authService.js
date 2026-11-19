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
import { validateUserProfile } from '../utils/authRouting.js';

export const BOOTSTRAPPED_ADMIN_EMAIL = 'pankajadhikari820@gmail.com';

let authFlowInProgress = false;
export function isAuthFlowInProgress() {
  return authFlowInProgress;
}

async function syncFreshAuthToken(user) {
  if (!user) return;
  await reload(user).catch(() => {});
  await user.getIdToken(true).catch(() => {});
}

export async function resolvePostLoginSession(firebaseUser, preferredOrgId = '') {
  const { userProfile, memberships } = await fetchUserProfileAndMemberships(firebaseUser.uid);

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
    ...orgContext,
  };
}

export async function loginWithEmail(email, password) {
  authFlowInProgress = true;
  try {
    const cred = await signInWithEmailAndPassword(auth, email.trim(), password);
    await syncFreshAuthToken(cred.user);
    if (!cred.user.emailVerified) {
      return { user: cred.user, requiresVerification: true };
    }
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
    const cred = await signInWithPopup(auth, provider);
    await cred.user.getIdToken(true).catch(() => {});
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
  authFlowInProgress = true;
  try {
    let firebaseUser = auth.currentUser;
    if (!firebaseUser) {
      const cred = await createUserWithEmailAndPassword(auth, email.trim().toLowerCase(), password);
      firebaseUser = cred.user;
      await updateProfile(firebaseUser, { displayName: ownerName.trim() });
      await sendEmailVerification(firebaseUser).catch(() => {});
      await firebaseUser.getIdToken(true).catch(() => {});
    } else {
      await syncFreshAuthToken(firebaseUser);
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
      return { user: firebaseUser, requiresVerification: true, created };
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
  authFlowInProgress = true;
  try {
    let firebaseUser = auth.currentUser;
    if (!firebaseUser) {
      const cred = await createUserWithEmailAndPassword(auth, email.trim().toLowerCase(), password);
      firebaseUser = cred.user;
      await updateProfile(firebaseUser, { displayName: name.trim() });
      await sendEmailVerification(firebaseUser).catch(() => {});
      await firebaseUser.getIdToken(true).catch(() => {});
    } else {
      await syncFreshAuthToken(firebaseUser);
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
      return { user: firebaseUser, requiresVerification: true, joined };
    }

    if (joined.status === 'pending') {
      return {
        user: firebaseUser,
        pendingApproval: true,
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
  await sendEmailVerification(auth.currentUser);
}

export async function refreshVerificationStatus() {
  if (!auth.currentUser) return false;
  await reload(auth.currentUser);
  if (auth.currentUser.emailVerified) {
    await auth.currentUser.getIdToken(true).catch(() => {});
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
  await sendPasswordResetEmail(auth, email.trim());
}

export async function logoutUser() {
  await signOut(auth);
}
