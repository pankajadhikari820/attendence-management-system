const initialState = {
  authReady: false,
  firebaseUser: null,
  profile: null,
  roleData: null, // student or teacher doc
  settings: {
    currentAcademicSession: '2026-2027 Fall',
    academicSessions: ['2026-2027 Fall', '2026-2027 Spring'],
    defaultAttendanceThreshold: 75,
    qrRotationSeconds: 15,
    lateGraceMinutes: 10,
    useCloudFunctions: false, // Toggleable in Admin Settings when Blaze Functions are deployed
  },
  activeView: 'overview',
  unreadNotifications: 0,
  notifications: [],
  sidebarOpen: false,
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

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
