export const VALID_ROLES = Object.freeze(['owner', 'manager', 'member', 'admin', 'teacher', 'student']);

export const PUBLIC_ROUTES = Object.freeze([
  'home',
  'features',
  'solutions',
  'how-it-works',
  'pricing',
  'contact',
  'privacy',
  'terms',
]);

export const AUTH_ROUTES = Object.freeze([
  'login',
  'signup',
  'org-register',
  'join',
  'forgot-password',
  'verify-email',
  'select-org',
]);

export const DEFAULT_PERMISSIONS_OWNER = Object.freeze({
  canManageOrg: true,
  canManageHierarchy: true,
  canManageBranches: true,
  canManageDepartments: true,
  canManageMembers: true,
  canTakeAttendance: true,
  canEditAttendance: true,
  canApproveLeaves: true,
  canApproveCorrections: true,
  canManageShifts: true,
  canManageHolidays: true,
  canViewReports: true,
  canExportData: true,
  canViewAuditLogs: true,
  scope: 'org',
});

export const DEFAULT_PERMISSIONS_MEMBER = Object.freeze({
  canManageOrg: false,
  canManageHierarchy: false,
  canManageBranches: false,
  canManageDepartments: false,
  canManageMembers: false,
  canTakeAttendance: false,
  canEditAttendance: false,
  canApproveLeaves: false,
  canApproveCorrections: false,
  canManageShifts: false,
  canManageHolidays: false,
  canViewReports: false,
  canExportData: false,
  canViewAuditLogs: false,
  scope: 'self',
});

/**
 * Resolves exact trusted permissions from Firestore membership + designation records.
 * Never trusts designation label names (e.g. calling someone "Manager" without permission flags does not grant privilege).
 */
export function resolveMembershipPermissions(membership, designation = null, memberDoc = null) {
  if (!membership || membership.status !== 'active') {
    throw new Error('Your organization membership is inactive or pending approval.');
  }

  if (membership.isOwner === true || membership.portalTier === 'owner') {
    return {
      tier: 'owner',
      permissions: { ...DEFAULT_PERMISSIONS_OWNER },
    };
  }

  const base = { ...DEFAULT_PERMISSIONS_MEMBER };
  const desPerms = designation?.permissions || {};
  const memPerms = membership?.permissions || memberDoc?.permissions || {};

  const merged = {
    ...base,
    ...desPerms,
    ...memPerms,
  };

  const hasElevated = Boolean(
    merged.canManageOrg ||
      merged.canManageHierarchy ||
      merged.canManageBranches ||
      merged.canManageDepartments ||
      merged.canManageMembers ||
      merged.canTakeAttendance ||
      merged.canEditAttendance ||
      merged.canApproveLeaves ||
      merged.canApproveCorrections ||
      merged.canManageShifts ||
      merged.canManageHolidays ||
      merged.canViewReports ||
      merged.canExportData ||
      merged.canViewAuditLogs
  );

  if (merged.canManageOrg) {
    return { tier: 'owner', permissions: merged };
  }
  if (hasElevated) {
    return {
      tier: 'manager',
      permissions: {
        ...merged,
        scope: merged.scope && merged.scope !== 'self' ? merged.scope : 'team',
      },
    };
  }
  return { tier: 'member', permissions: merged };
}

export function validateUserProfile(profile, uid = '') {
  if (!profile || typeof profile !== 'object') {
    throw new Error(
      `User profile not found in Firestore (users/${uid || 'unknown'}). Please create an organization or join one via invitation.`
    );
  }
  if (profile.status === 'inactive' || profile.status === 'suspended') {
    throw new Error('Your account is currently suspended or inactive. Contact your organization administrator.');
  }
  return profile;
}

export function resolveDashboardRoute(membershipOrTier, uid = '') {
  if (!membershipOrTier) {
    throw new Error(`No active organization membership found for user (${uid || 'unknown'}).`);
  }
  const tier =
    typeof membershipOrTier === 'string'
      ? membershipOrTier
      : membershipOrTier.tier || membershipOrTier.portalTier || 'member';
  const normalized = ['owner', 'manager', 'member'].includes(tier) ? tier : 'member';
  return {
    role: normalized,
    view: 'overview',
    hash: `#/${normalized}/overview`,
  };
}

export function parseHashRoute(hashStr = '') {
  const clean = String(hashStr || '')
    .replace(/^#\/?/, '')
    .trim()
    .toLowerCase();

  if (!clean || clean === 'home') {
    return { type: 'public', page: 'home', role: null, view: null };
  }
  if (PUBLIC_ROUTES.includes(clean)) {
    return { type: 'public', page: clean, role: null, view: null };
  }
  if (AUTH_ROUTES.includes(clean)) {
    return { type: 'auth', page: clean, role: null, view: null };
  }
  if (clean.startsWith('join/')) {
    return { type: 'auth', page: 'join', inviteCode: clean.split('/')[1] || '', role: null, view: null };
  }

  const [rolePart, viewPart] = clean.split('/');
  if (['owner', 'manager', 'member'].includes(rolePart)) {
    return {
      type: 'dashboard',
      role: rolePart,
      view: viewPart || 'overview',
    };
  }

  return { type: 'unknown', page: 'home', role: null, view: null };
}
