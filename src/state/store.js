import { DEFAULT_ATTENDANCE_POLICY } from '../utils/attendanceMath.js';

const initialState = {
  authReady: false,
  firebaseUser: null,
  userProfile: null,
  memberships: [], // [{ orgId, orgName, orgType, portalTier, designationId, designationName, isOwner, status, permissions, memberPublicId }]
  activeOrgId: '',
  activeOrg: null, // organizations/{orgId}
  activeMembership: null, // users/{uid}/memberships/{orgId}
  activeMember: null, // organizations/{orgId}/members/{uid}
  activeDesignation: null, // organizations/{orgId}/designations/{designationId}
  resolvedTier: 'member', // 'owner' | 'manager' | 'member'
  resolvedPermissions: null,
  settings: { ...DEFAULT_ATTENDANCE_POLICY },
  activeView: 'overview',
  unreadNotifications: 0,
  notifications: [],
  sidebarOpen: false,
  isOnline: true,
};

const state = { ...initialState };
const listeners = new Set();

export function getState() {
  return state;
}

export function setState(patch) {
  Object.assign(state, patch);
  for (const fn of listeners) {
    try {
      fn(state);
    } catch (err) {
      console.error('Store listener error:', err);
    }
  }
}

export function resetWorkspaceState() {
  setState({
    userProfile: null,
    memberships: [],
    activeOrgId: '',
    activeOrg: null,
    activeMembership: null,
    activeMember: null,
    activeDesignation: null,
    resolvedTier: 'member',
    resolvedPermissions: null,
    unreadNotifications: 0,
    notifications: [],
    activeView: 'overview',
    sidebarOpen: false,
  });
}

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
