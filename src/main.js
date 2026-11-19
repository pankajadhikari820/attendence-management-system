import { onAuthStateChanged } from 'firebase/auth';
import { collection, query, where, onSnapshot } from 'firebase/firestore';
import { auth, db, testFirestoreConnection } from './firebase/config.js';
import {
  ensureUserProfileExists,
  loadRoleDocument,
  logoutUser,
} from './services/authService.js';
import { loadAcademicSettings } from './services/firestoreService.js';
import { initForegroundMessaging } from './services/messagingService.js';
import { escapeHtml, getInitials } from './utils/attendanceMath.js';
import { icon } from './utils/icons.js';
import { getCurrentTheme, toggleTheme, showToast } from './utils/ui.js';
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

function renderWorkspaceShell() {
  const appRoot = document.getElementById('app');
  const state = getState();
  const { firebaseUser, profile } = state;

  if (!firebaseUser || !firebaseUser.emailVerified || !profile) {
    cleanupTeacherListeners();
    cleanupStudentListeners();
    stopNotifListener();
    renderAuthView(appRoot, firebaseUser);
    return;
  }

  const role = profile.role || 'student';
  const navItems = NAV_BY_ROLE[role] || NAV_BY_ROLE.student;
  if (!navItems.some((i) => i.key === state.activeView)) {
    state.activeView = 'overview';
  }
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
  const { profile, activeView } = getState();
  const role = profile?.role || 'student';

  if (role === 'admin') {
    renderAdminView(viewport, activeView);
  } else if (role === 'teacher') {
    renderTeacherView(viewport, activeView);
  } else {
    renderStudentView(viewport, activeView);
  }
}

function navigateTo(viewKey) {
  setState({ activeView: viewKey, sidebarOpen: false });
  renderWorkspaceShell();
}

window.addEventListener('smartattend:navigate', (e) => {
  if (e.detail) navigateTo(String(e.detail));
});

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
    await loadAcademicSettings();
    const profile = await ensureUserProfileExists(firebaseUser);
    const roleData = await loadRoleDocument(profile);
    setState({ authReady: true, firebaseUser, profile, roleData, activeView: 'overview' });
    startNotifListener(profile.uid);
    initForegroundMessaging();
    renderWorkspaceShell();
  } catch (err) {
    console.error('Auth initialization error:', err);
    showToast(err.message || 'Failed to load user profile. Check Firestore security rules.', 'danger', 7000);
    setState({ authReady: true, firebaseUser, profile: null, roleData: null });
    renderAuthView(document.getElementById('app'), firebaseUser);
  }
}

window.addEventListener('smartattend:auth-refresh', () => {
  handleAuthSync(auth.currentUser);
});

async function boot() {
  testFirestoreConnection();
  onAuthStateChanged(auth, (user) => {
    handleAuthSync(user);
  });
}

boot();
