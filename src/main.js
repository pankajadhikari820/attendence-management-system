import { onAuthStateChanged } from 'firebase/auth';
import { collection, query, where, onSnapshot } from 'firebase/firestore';
import { auth, db, testFirestoreConnection } from './firebase/config.js';
import {
  fetchVerifiedUserProfile,
  isAuthFlowInProgress,
  loadRoleDocument,
  logoutUser,
} from './services/authService.js';
import { loadAcademicSettings } from './services/firestoreService.js';
import { initForegroundMessaging } from './services/messagingService.js';
import { resolveDashboardRoute, parseHashRoute } from './utils/authRouting.js';
import { escapeHtml, getInitials } from './utils/attendanceMath.js';
import { icon } from './utils/icons.js';
import { getCurrentTheme, toggleTheme, showToast, closeModal } from './utils/ui.js';
import { getState, setState } from './state/store.js';
import { renderAuthView } from './views/authView.js';
import { renderAdminView } from './views/adminView.js';
import { renderTeacherView, cleanupTeacherListeners } from './views/teacherView.js';
import { renderStudentView, cleanupStudentListeners } from './views/studentView.js';

const NAV_BY_ROLE = {
  admin: [
    { key: 'overview', label: 'Overview', icon: 'dashboard' },
    { key: 'academic', label: 'Sessions & Policy', icon: 'settings' },
    { key: 'departments', label: 'Departments & Courses', icon: 'building' },
    { key: 'subjects', label: 'Subjects & Classes', icon: 'book' },
    { key: 'teachers', label: 'Teachers', icon: 'users' },
    { key: 'students', label: 'Students', icon: 'users' },
    { key: 'timetable', label: 'Timetable & Holidays', icon: 'calendar' },
    { key: 'requests', label: 'Leaves & Corrections', icon: 'check' },
    { key: 'announcements', label: 'Announcements', icon: 'megaphone' },
    { key: 'reports', label: 'Reports (PDF/Excel)', icon: 'download' },
    { key: 'auditLogs', label: 'Audit Logs', icon: 'shield' },
    { key: 'notifications', label: 'Notifications', icon: 'bell' },
    { key: 'profile', label: 'Profile', icon: 'settings' },
  ],
  teacher: [
    { key: 'overview', label: 'Dashboard', icon: 'dashboard' },
    { key: 'qr-session', label: 'QR Attendance', icon: 'qr' },
    { key: 'manual-attendance', label: 'Manual Attendance', icon: 'check' },
    { key: 'corrections', label: 'Corrections Queue', icon: 'edit' },
    { key: 'leaves', label: 'Leave Requests', icon: 'file' },
    { key: 'students-analytics', label: 'Student Analytics', icon: 'alert' },
    { key: 'reports', label: 'Reports (PDF/Excel)', icon: 'download' },
    { key: 'timetable', label: 'Timetable & Holidays', icon: 'calendar' },
    { key: 'announcements', label: 'Announcements', icon: 'megaphone' },
    { key: 'notifications', label: 'Notifications', icon: 'bell' },
    { key: 'profile', label: 'Profile', icon: 'settings' },
  ],
  student: [
    { key: 'overview', label: 'Dashboard', icon: 'dashboard' },
    { key: 'scan-qr', label: 'Scan QR Code', icon: 'qr' },
    { key: 'shortage', label: 'Shortage Calculator', icon: 'alert' },
    { key: 'history', label: 'Attendance History', icon: 'clock' },
    { key: 'leaves', label: 'Leave Requests', icon: 'file' },
    { key: 'corrections', label: 'Correction Requests', icon: 'edit' },
    { key: 'timetable', label: 'Timetable & Holidays', icon: 'calendar' },
    { key: 'announcements', label: 'Announcements', icon: 'megaphone' },
    { key: 'notifications', label: 'Notifications', icon: 'bell' },
    { key: 'profile', label: 'Profile', icon: 'settings' },
  ],
};

let notifUnsub = null;

function stopNotifListener() {
  if (notifUnsub) {
    notifUnsub();
    notifUnsub = null;
  }
}

function startNotifListener(uid) {
  stopNotifListener();
  const q = query(collection(db, 'notifications'), where('userId', '==', uid));
  notifUnsub = onSnapshot(
    q,
    (snap) => {
      const list = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      const unread = list.filter((n) => !n.read).length;
      setState({ notifications: list, unreadNotifications: unread });
      const badge = document.getElementById('topbar-notif-count');
      if (badge) {
        badge.textContent = unread > 0 ? String(unread) : '';
        badge.style.display = unread > 0 ? 'inline-flex' : 'none';
      }
      const sideBadge = document.querySelector('[data-nav="notifications"] .nav-count');
      if (sideBadge) {
        sideBadge.textContent = unread > 0 ? String(unread) : '';
      }
    },
    (err) => {
      console.warn('Notification listener error:', err.message);
    }
  );
}

function setHashSilently(nextHash) {
  if (window.location.hash !== nextHash) {
    window.history.replaceState(null, '', nextHash);
  }
}

function renderWorkspaceShell(authError = '') {
  const appRoot = document.getElementById('app');
  const state = getState();
  const { firebaseUser, profile } = state;

  if (!firebaseUser) {
    cleanupTeacherListeners();
    cleanupStudentListeners();
    stopNotifListener();
    closeModal();
    setHashSilently('#/login');
    renderAuthView(appRoot, null, authError);
    return;
  }

  if (!firebaseUser.emailVerified) {
    cleanupTeacherListeners();
    cleanupStudentListeners();
    stopNotifListener();
    closeModal();
    setHashSilently('#/verify-email');
    renderAuthView(appRoot, firebaseUser, authError);
    return;
  }

  if (!profile) {
    cleanupTeacherListeners();
    cleanupStudentListeners();
    stopNotifListener();
    closeModal();
    setHashSilently('#/login');
    renderAuthView(
      appRoot,
      null,
      authError || 'User profile could not be loaded from Firestore. Please sign in again.'
    );
    return;
  }

  let routeInfo;
  try {
    routeInfo = resolveDashboardRoute(profile, firebaseUser.uid);
  } catch (roleErr) {
    cleanupTeacherListeners();
    cleanupStudentListeners();
    stopNotifListener();
    closeModal();
    setHashSilently('#/login');
    renderAuthView(appRoot, null, roleErr.message);
    return;
  }

  const role = routeInfo.role;
  const navItems = NAV_BY_ROLE[role];
  if (!navItems.some((i) => i.key === state.activeView)) {
    state.activeView = 'overview';
  }
  setHashSilently(`#/${role}/${state.activeView}`);
  const activeItem = navItems.find((i) => i.key === state.activeView) || navItems[0];
  const theme = getCurrentTheme();

  appRoot.innerHTML = `
    <div class="workspace-layout">
      <div class="sidebar-backdrop ${state.sidebarOpen ? 'open' : ''}" id="sidebar-backdrop"></div>
      <aside class="sidebar ${state.sidebarOpen ? 'open' : ''}" id="app-sidebar" aria-label="Primary Navigation">
        <div class="sidebar-brand">
          <div class="brand-wordmark">
            <span class="brand-mark">${icon('qr', 16)}</span>
            <span>SmartAttend</span>
          </div>
          <button type="button" class="icon-btn sidebar-close-btn" id="sidebar-close-btn" aria-label="Close navigation">
            ${icon('close', 16)}
          </button>
        </div>

        <nav class="sidebar-nav">
          <div class="nav-section-label" style="text-transform:capitalize;">${escapeHtml(role)} Portal</div>
          ${navItems
            .map(
              (item) => `
            <button
              type="button"
              class="nav-item ${state.activeView === item.key ? 'active' : ''}"
              data-nav="${escapeHtml(item.key)}"
            >
              ${icon(item.icon, 17)}
              <span class="truncate">${escapeHtml(item.label)}</span>
              ${
                item.key === 'notifications'
                  ? `<span class="nav-count">${state.unreadNotifications > 0 ? state.unreadNotifications : ''}</span>`
                  : ''
              }
            </button>
          `
            )
            .join('')}
        </nav>

        <div class="sidebar-footer">
          <div class="avatar-circle">
            ${
              profile.avatarUrl
                ? `<img src="${escapeHtml(profile.avatarUrl)}" alt="${escapeHtml(profile.name)}" referrerpolicy="no-referrer" />`
                : escapeHtml(getInitials(profile.name))
            }
          </div>
          <div style="min-width:0;flex:1;">
            <div class="truncate" style="font-size:0.875rem;font-weight:600;">${escapeHtml(profile.name)}</div>
            <div class="truncate" style="font-size:0.75rem;color:var(--text-muted);text-transform:capitalize;">${escapeHtml(role)}</div>
          </div>
          <button type="button" class="icon-btn" id="logout-btn" title="Sign Out" aria-label="Sign Out">
            ${icon('logout', 16)}
          </button>
        </div>
      </aside>

      <div class="main-column">
        <header class="topbar">
          <div class="topbar-left">
            <button type="button" class="icon-btn mobile-menu-btn" id="mobile-menu-btn" aria-label="Open navigation menu">
              ${icon('menu', 18)}
            </button>
            <div class="topbar-breadcrumb">
              <span style="text-transform:capitalize;">${escapeHtml(role)}</span>
              <span aria-hidden="true">/</span>
              <strong>${escapeHtml(activeItem.label)}</strong>
            </div>
          </div>
          <div class="topbar-actions">
            <button type="button" class="icon-btn" id="topbar-notif-btn" aria-label="Notifications" title="Notifications">
              ${icon('bell', 17)}
              <span id="topbar-notif-count" style="display:${state.unreadNotifications > 0 ? 'inline-flex' : 'none'};position:absolute;top:2px;right:4px;font-size:0.65rem;font-weight:700;color:var(--danger);font-family:var(--font-mono);">
                ${state.unreadNotifications > 0 ? state.unreadNotifications : ''}
              </span>
            </button>
            <button type="button" class="icon-btn" id="topbar-theme-btn" aria-label="Toggle theme" title="Toggle Dark/Light Mode">
              ${icon(theme === 'dark' ? 'sun' : 'moon', 17)}
            </button>
          </div>
        </header>

        <main id="main-content" class="main-viewport"></main>
      </div>
    </div>
  `;

  const closeDrawer = () => {
    setState({ sidebarOpen: false });
    document.getElementById('app-sidebar')?.classList.remove('open');
    document.getElementById('sidebar-backdrop')?.classList.remove('open');
  };

  document.getElementById('mobile-menu-btn')?.addEventListener('click', () => {
    document.getElementById('app-sidebar')?.classList.add('open');
    document.getElementById('sidebar-backdrop')?.classList.add('open');
  });
  document.getElementById('sidebar-close-btn')?.addEventListener('click', closeDrawer);
  document.getElementById('sidebar-backdrop')?.addEventListener('click', closeDrawer);

  document.getElementById('topbar-theme-btn')?.addEventListener('click', () => {
    toggleTheme();
    renderWorkspaceShell();
  });

  document.getElementById('topbar-notif-btn')?.addEventListener('click', () => {
    navigateTo('notifications');
  });

  document.getElementById('logout-btn')?.addEventListener('click', async () => {
    cleanupTeacherListeners();
    cleanupStudentListeners();
    stopNotifListener();
    await logoutUser();
    showToast('Signed out.', 'info');
  });

  document.querySelectorAll('[data-nav]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const target = btn.getAttribute('data-nav');
      closeDrawer();
      navigateTo(target);
    });
  });

  renderActiveRouteContent();
}

function renderActiveRouteContent() {
  const viewport = document.getElementById('main-content');
  if (!viewport) return;
  const { firebaseUser, profile, activeView } = getState();
  if (!firebaseUser || !firebaseUser.emailVerified || !profile) return;

  const { role } = resolveDashboardRoute(profile, firebaseUser.uid);
  if (role === 'admin') {
    renderAdminView(viewport, activeView);
  } else if (role === 'teacher') {
    renderTeacherView(viewport, activeView);
  } else {
    renderStudentView(viewport, activeView);
  }
}

function navigateTo(viewKey) {
  const { profile } = getState();
  if (!profile) {
    renderWorkspaceShell();
    return;
  }
  const role = profile.role;
  const navItems = NAV_BY_ROLE[role] || [];
  const validView = navItems.some((i) => i.key === viewKey) ? viewKey : 'overview';
  setState({ activeView: validView, sidebarOpen: false });
  if (window.location.hash !== `#/${role}/${validView}`) {
    window.location.hash = `#/${role}/${validView}`;
  } else {
    renderWorkspaceShell();
  }
}

window.addEventListener('smartattend:navigate', (e) => {
  if (e.detail) navigateTo(String(e.detail));
});

window.addEventListener('hashchange', () => {
  const { firebaseUser, profile } = getState();
  if (!firebaseUser || !firebaseUser.emailVerified || !profile) {
    renderWorkspaceShell();
    return;
  }
  const parsed = parseHashRoute(window.location.hash);
  const role = profile.role;
  const navItems = NAV_BY_ROLE[role] || [];
  if (parsed.type === 'dashboard' && parsed.role === role && navItems.some((i) => i.key === parsed.view)) {
    setState({ activeView: parsed.view, sidebarOpen: false });
    renderWorkspaceShell();
  } else {
    setHashSilently(`#/${role}/${getState().activeView || 'overview'}`);
    renderWorkspaceShell();
  }
});

async function activateVerifiedSession({ user, profile, roleData }, announceLogin = false) {
  const route = resolveDashboardRoute(profile, user.uid);

  if (!user.emailVerified) {
    setState({
      authReady: true,
      firebaseUser: user,
      profile,
      roleData: roleData || null,
      activeView: 'overview',
    });
    if (announceLogin) {
      showToast(`Account signed in (${route.role}). Verify your email to enter your dashboard.`, 'warning', 5500);
    }
    renderWorkspaceShell();
    return;
  }

  await loadAcademicSettings();
  const parsedHash = parseHashRoute(window.location.hash);
  const navItems = NAV_BY_ROLE[route.role] || [];
  const initialView =
    parsedHash.type === 'dashboard' &&
    parsedHash.role === route.role &&
    navItems.some((i) => i.key === parsedHash.view)
      ? parsedHash.view
      : route.view;

  setState({
    authReady: true,
    firebaseUser: user,
    profile,
    roleData: roleData || null,
    activeView: initialView,
  });

  startNotifListener(profile.uid);
  initForegroundMessaging();
  window.history.replaceState(null, '', `#/${route.role}/${initialView}`);
  renderWorkspaceShell();

  if (announceLogin) {
    const label = route.role.charAt(0).toUpperCase() + route.role.slice(1);
    showToast(`Signed in as ${profile.name} (${label} Dashboard).`, 'success');
  }
}

async function handleAuthSync(firebaseUser) {
  if (!firebaseUser) {
    setState({ authReady: true, firebaseUser: null, profile: null, roleData: null, activeView: 'overview' });
    renderWorkspaceShell();
    return;
  }

  if (!firebaseUser.emailVerified) {
    setState({ authReady: true, firebaseUser, profile: null, roleData: null });
    renderWorkspaceShell();
    return;
  }

  try {
    const profile = await fetchVerifiedUserProfile(firebaseUser, {
      allowBootstrapCreate: false,
    });
    const roleData = await loadRoleDocument(profile);
    await activateVerifiedSession({ user: firebaseUser, profile, roleData }, false);
  } catch (err) {
    console.error('Auth initialization error:', err);
    const message = err?.message || 'Failed to load user profile and role from Firestore.';
    await logoutUser().catch(() => {});
    setState({ authReady: true, firebaseUser: null, profile: null, roleData: null, activeView: 'overview' });
    showToast(message, 'danger', 7000);
    renderWorkspaceShell(message);
  }
}

window.addEventListener('smartattend:session-ready', async (e) => {
  const detail = e.detail;
  if (!detail?.user || !detail?.profile) return;
  try {
    await activateVerifiedSession(detail, true);
  } catch (err) {
    const msg = err?.message || 'Unable to open dashboard for your account.';
    await logoutUser().catch(() => {});
    setState({ authReady: true, firebaseUser: null, profile: null, roleData: null });
    showToast(msg, 'danger', 7000);
    renderWorkspaceShell(msg);
  }
});

window.addEventListener('smartattend:auth-refresh', () => {
  handleAuthSync(auth.currentUser);
});

async function boot() {
  testFirestoreConnection();
  onAuthStateChanged(auth, (user) => {
    if (isAuthFlowInProgress()) return;
    handleAuthSync(user);
  });
}

boot();
