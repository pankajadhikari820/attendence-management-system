export const VALID_ROLES = Object.freeze(['admin', 'teacher', 'student']);

export function validateUserProfile(profile, uid = '') {
  if (!profile || typeof profile !== 'object') {
    throw new Error(
      `User profile not found in Firestore (users/${uid || 'unknown'}). Please register or ask your administrator to provision your account.`
    );
  }

  const role = typeof profile.role === 'string' ? profile.role.trim().toLowerCase() : '';
  if (!VALID_ROLES.includes(role)) {
    throw new Error(
      `User profile in Firestore (users/${profile.uid || uid}) is missing a valid role (expected admin, teacher, or student).`
    );
  }

  if (profile.status === 'inactive') {
    throw new Error('Your account is currently inactive. Please contact your institution administrator.');
  }

  return {
    ...profile,
    role,
  };
}

export function resolveDashboardRoute(profile, uid = '') {
  const validated = validateUserProfile(profile, uid);
  return {
    role: validated.role,
    view: 'overview',
    hash: `#/${validated.role}/overview`,
  };
}

export function parseHashRoute(hashStr = '') {
  const clean = String(hashStr || '').replace(/^#\/?/, '').trim();
  if (!clean) return { type: 'root', role: null, view: null };
  if (clean === 'login') return { type: 'login', role: null, view: null };
  if (clean === 'verify-email') return { type: 'verify-email', role: null, view: null };

  const [rolePart, viewPart] = clean.split('/');
  const role = rolePart?.toLowerCase();
  if (VALID_ROLES.includes(role)) {
    return {
      type: 'dashboard',
      role,
      view: viewPart || 'overview',
    };
  }

  return { type: 'unknown', role: null, view: null };
}
