import { onAuthStateChanged } from 'firebase/auth';
import { query, where, onSnapshot } from 'firebase/firestore';
import { auth, initFirebaseAppCheck, testFirestoreConnection } from './firebase/config.js';
import {
  isAuthFlowInProgress,
  resolvePostLoginSession,
  logoutUser,
} from './services/authService.js';
import { loadOrganizationContext } from './services/orgService.js';
import { orgCol } from './services/firestoreService.js';
import { initForegroundMessaging } from './services/messagingService.js';
import { resolveDashboardRoute, parseHashRoute } from './utils/authRouting.js';
import { escapeHtml, getInitials } from './utils/attendanceMath.js';
import { icon } from './utils/icons.js';
import { initPwaAndNetwork, canInstallPwa, isIosSafari, isRunningStandalone, triggerPwaInstall } from './utils/pwa.js';
import { getCurrentTheme, toggleTheme, showToast, closeModal } from './utils/ui.js';
import { getState, setState, resetWorkspaceState } from './state/store.js';
import { renderLandingView } from './views/landingView.js';
import { renderAuthView } from './views/authView.js';
import { renderOwnerView, cleanupOwnerListeners } from './views/ownerView.js';
import { renderManagerView, cleanupManagerListeners } from './views/managerView.js';
import { renderMemberView, cleanupMemberListeners } from './views/memberView.js';

function getNavItemsForSession(tier, permissions = {}) {
  if (tier === 'owner') {
    return [
      { key: 'overview', label: 'Org Overview', icon: 'dashboard' },
      { key: 'scanner', label: 'QR Scanner', icon: 'qr' },
      { key: 'manual', label: 'Manual Attendance', icon: 'check' },
      { key: 'members', label: 'Members & CSV', icon: 'users' },
      { key: 'hierarchy', label: 'Hierarchy & Tree', icon: 'tree' },
      { key: 'branches-depts', label: 'Branches & Depts', icon: 'building' },
      { key: 'shifts-holidays', label: 'Shifts & Holidays', icon: 'calendar' },
      { key: 'requests', label: 'Leaves & Corrections', icon: 'file' },
      { key: 'reports', label: 'Reports & Backup', icon: 'download' },
      { key: 'auditLogs', label: 'Audit & Anomalies', icon: 'shield' },
      { key: 'org-settings', label: 'Org Settings & Plan', icon: 'settings' },
      { key: 'my-qr', label: 'My QR ID Card', icon: 'qr' },
      { key: 'notifications', label: 'Notifications', icon: 'bell' },
      { key: 'profile', label: 'Profile', icon: 'settings' },
    ];
  }

  if (tier === 'manager') {
    const items = [{ key: 'overview', label: 'Team Dashboard', icon: 'dashboard' }];
    if (permissions.canTakeAttendance) {
      items.push({ key: 'scanner', label: 'QR Scanner', icon: 'qr' });
      items.push({ key: 'manual', label: 'Manual Batch', icon: 'check' });
    }
    items.push({ key: 'members', label: 'Team Roster', icon: 'users' });
    if (permissions.canApproveLeaves || permissions.canApproveCorrections) {
      items.push({ key: 'requests', label: 'Leaves & Corrections', icon: 'file' });
    }
    if (permissions.canViewReports) {
      items.push({ key: 'reports', label: 'Team Reports', icon: 'download' });
    }
    items.push(
      { key: 'my-attendance', label: 'My Attendance', icon: 'clock' },
      { key: 'my-qr', label: 'My QR ID Card', icon: 'qr' },
      { key: 'notifications', label: 'Notifications', icon: 'bell' },
      { key: 'profile', label: 'Profile', icon: 'settings' }
    );
    return items;
  }

  return [
    { key: 'overview', label: 'My Dashboard', icon: 'dashboard' },
    { key: 'my-qr', label: 'My QR ID Card', icon: 'qr' },
    { key: 'history', label: 'Attendance History', icon: 'clock' },
    { key: 'shortage', label: 'Shortage Calculator', icon: 'alert' },
    { key: 'leaves', label: 'Leave Requests', icon: 'file' },
    { key: 'corrections', label: 'Correction Requests', icon: 'edit' },
    { key: 'holidays', label: 'Holidays & Offs', icon: 'calendar' },
    { key: 'notifications', label: 'Notifications', icon: 'bell' },
    { key: 'profile', label: 'Profile', icon: 'settings' },
  ];
}

let notifUnsub = null;
function stopNotifListener() {
  if (notifUnsub) {
    notifUnsub();
    notifUnsub = null;
  }
}

function startOrgNotifListener(orgId, uid) {
  stopNotifListener();
  if (!orgId || !uid) return;
  const q = query(orgCol(orgId, 'notifications'), where('userId', '==', uid));
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
      console.warn('Org notification listener warning:', err.message);
    }
  );
}

function cleanupAllWorkspaceListeners() {
  cleanupOwnerListeners();
  cleanupManagerListeners();
  cleanupMemberListeners();
  stopNotifListener();
  closeModal();
}

function setHashSilently(nextHash) {
  if (window.location.hash !== nextHash) {
    window.history.replaceState(null, '', nextHash);
  }
}

function renderWorkspaceShell(authError = '') {
  const appRoot = document.getElementById('app');
  const state = getState();
  const { firebaseUser, activeOrgId, activeOrg, activeMember, memberships, resolvedTier, resolvedPermissions } = state;
  const parsed = parseHashRoute(window.location.hash);

  // Public SaaS pages accessible anytime when unauthenticated (or explicitly navigated to)
  if (!firebaseUser) {
    cleanupAllWorkspaceListeners();
    if (parsed.type === 'auth') {
      renderAuthView(appRoot, {
        mode: parsed.page,
        inviteCode: parsed.inviteCode || '',
        authError,
      });
      return;
    }
    const publicPage = parsed.type === 'public' ? parsed.page : 'home';
    renderLandingView(appRoot, publicPage);
    return;
  }

  // Signed in, but email not verified yet
  if (!firebaseUser.emailVerified) {
    cleanupAllWorkspaceListeners();
    setHashSilently('#/verify-email');
    renderAuthView(appRoot, { mode: 'verify-email', firebaseUser, authError });
    return;
  }

  // Allow explicitly visiting org-register / join even while signed in (to create/join another org)
  if (parsed.type === 'auth' && ['org-register', 'join'].includes(parsed.page)) {
    cleanupAllWorkspaceListeners();
    renderAuthView(appRoot, {
      mode: parsed.page,
      firebaseUser,
      inviteCode: parsed.inviteCode || '',
      authError,
    });
    return;
  }

  // Multiple orgs or no active org chosen yet
  if (!activeOrgId || !activeOrg || parsed.page === 'select-org') {
    cleanupAllWorkspaceListeners();
    if (memberships.length > 0) {
      setHashSilently('#/select-org');
      renderAuthView(appRoot, { mode: 'select-org', firebaseUser, memberships, authError });
    } else {
      setHashSilently('#/org-register');
      renderAuthView(appRoot, { mode: 'org-register', firebaseUser, authError });
    }
    return;
  }

  const routeInfo = resolveDashboardRoute(resolvedTier, firebaseUser.uid);
  const tier = routeInfo.role;
  const navItems = getNavItemsForSession(tier, resolvedPermissions);
  if (!navItems.some((i) => i.key === state.activeView)) {
    state.activeView = 'overview';
  }
  setHashSilently(`#/${tier}/${state.activeView}`);
  const activeItem = navItems.find((i) => i.key === state.activeView) || navItems[0];
  const theme = getCurrentTheme();
  const displayName = activeMember?.name || state.userProfile?.name || firebaseUser.displayName || 'Member';
  const showInstall = !isRunningStandalone() && (canInstallPwa() || isIosSafari());

  appRoot.innerHTML = `
    <div class="workspace-layout">
      <div class="sidebar-backdrop ${state.sidebarOpen ? 'open' : ''}" id="sidebar-backdrop"></div>
      <aside class="sidebar ${state.sidebarOpen ? 'open' : ''}" id="app-sidebar" aria-label="Workspace Navigation">
        <div class="sidebar-brand">
          <div class="brand-wordmark">
            <span class="brand-mark">${icon('qr', 16)}</span>
            <span>SmartAttend</span>
          </div>
          <button type="button" class="icon-btn sidebar-close-btn" id="sidebar-close-btn" aria-label="Close menu">
            ${icon('close', 16)}
          </button>
        </div>

        <div style="padding:0.75rem 0.75rem 0;">
          <div style="padding:0.55rem 0.75rem;border:1px solid var(--border-hairline);border-radius:var(--radius-sm);background:var(--bg-subtle);">
            <div class="truncate" style="font-size:0.8125rem;font-weight:600;">${escapeHtml(activeOrg.name)}</div>
            <div style="display:flex;justify-content:space-between;align-items:center;font-size:0.72rem;color:var(--text-muted);margin-top:2px;">
              <span class="mono">${escapeHtml(activeOrgId)}</span>
              ${
                memberships.length > 1
                  ? `<button type="button" id="switch-org-btn" style="background:transparent;border:0;padding:0;color:var(--accent-text);font-weight:600;">Switch</button>`
                  : `<span style="text-transform:capitalize;">${escapeHtml(activeOrg.plan || 'free')}</span>`
              }
            </div>
          </div>
        </div>

        <nav class="sidebar-nav">
          <div class="nav-section-label">${escapeHtml(activeMember?.designationName || tier)}</div>
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
              state.userProfile?.avatarUrl
                ? `<img src="${escapeHtml(state.userProfile.avatarUrl)}" alt="${escapeHtml(displayName)}" referrerpolicy="no-referrer" />`
                : escapeHtml(getInitials(displayName))
            }
          </div>
          <div style="min-width:0;flex:1;">
            <div class="truncate" style="font-size:0.875rem;font-weight:600;">${escapeHtml(displayName)}</div>
            <div class="truncate mono" style="font-size:0.72rem;color:var(--text-muted);">${escapeHtml(activeMember?.memberPublicId || '')}</div>
          </div>
          <button type="button" class="icon-btn" id="logout-btn" title="Sign Out" aria-label="Sign Out">
            ${icon('logout', 16)}
          </button>
        </div>
      </aside>

      <div class="main-column">
        <header class="topbar">
          <div class="topbar-left">
            <button type="button" class="icon-btn mobile-menu-btn" id="mobile-menu-btn" aria-label="Open menu">
              ${icon('menu', 18)}
            </button>
            <div class="topbar-breadcrumb">
              <span class="truncate">${escapeHtml(activeOrg.name)}</span>
              <span aria-hidden="true">/</span>
              <strong>${escapeHtml(activeItem.label)}</strong>
            </div>
          </div>
          <div class="topbar-actions">
            ${
              showInstall
                ? `<button type="button" class="btn btn-secondary btn-sm" id="topbar-install-btn">${icon('smartphone', 15)} Install App</button>`
                : ''
            }
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

  document.getElementById('switch-org-btn')?.addEventListener('click', () => {
    window.location.hash = '#/select-org';
  });

  document.getElementById('topbar-install-btn')?.addEventListener('click', () => triggerPwaInstall());

  document.getElementById('topbar-theme-btn')?.addEventListener('click', () => {
    toggleTheme();
    renderWorkspaceShell();
  });

  document.getElementById('topbar-notif-btn')?.addEventListener('click', () => {
    navigateTo('notifications');
  });

  document.getElementById('logout-btn')?.addEventListener('click', async () => {
    cleanupAllWorkspaceListeners();
    await logoutUser();
    resetWorkspaceState();
    window.location.hash = '#/';
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
  const { firebaseUser, activeOrgId, resolvedTier, activeView } = getState();
  if (!firebaseUser || !firebaseUser.emailVerified || !activeOrgId) return;

  if (resolvedTier === 'owner') {
    renderOwnerView(viewport, activeView);
  } else if (resolvedTier === 'manager') {
    renderManagerView(viewport, activeView);
  } else {
    renderMemberView(viewport, activeView);
  }
}

function navigateTo(viewKey) {
  const { activeOrgId, resolvedTier, resolvedPermissions } = getState();
  if (!activeOrgId) {
    renderWorkspaceShell();
    return;
  }
  const navItems = getNavItemsForSession(resolvedTier, resolvedPermissions);
  const validView = navItems.some((i) => i.key === viewKey) ? viewKey : 'overview';
  setState({ activeView: validView, sidebarOpen: false });
  if (window.location.hash !== `#/${resolvedTier}/${validView}`) {
    window.location.hash = `#/${resolvedTier}/${validView}`;
  } else {
    renderWorkspaceShell();
  }
}

window.addEventListener('smartattend:navigate', (e) => {
  if (e.detail) navigateTo(String(e.detail));
});

window.addEventListener('hashchange', () => {
  const { firebaseUser, activeOrgId, resolvedTier, resolvedPermissions } = getState();
  if (!firebaseUser || !firebaseUser.emailVerified || !activeOrgId) {
    renderWorkspaceShell();
    return;
  }
  const parsed = parseHashRoute(window.location.hash);
  if (parsed.type === 'auth' && ['org-register', 'join', 'select-org'].includes(parsed.page)) {
    renderWorkspaceShell();
    return;
  }
  const navItems = getNavItemsForSession(resolvedTier, resolvedPermissions);
  if (parsed.type === 'dashboard' && parsed.role === resolvedTier && navItems.some((i) => i.key === parsed.view)) {
    setState({ activeView: parsed.view, sidebarOpen: false });
    renderWorkspaceShell();
  } else {
    setHashSilently(`#/${resolvedTier}/${getState().activeView || 'overview'}`);
    renderWorkspaceShell();
  }
});

async function activateSessionPayload(sessionPayload, announce = false) {
  const { user } = sessionPayload;

  if (sessionPayload.requiresVerification || !user.emailVerified) {
    setState({ authReady: true, firebaseUser: user });
    renderWorkspaceShell();
    return;
  }

  if (sessionPayload.needsOrgOnboarding) {
    setState({
      authReady: true,
      firebaseUser: user,
      userProfile: sessionPayload.userProfile || null,
      memberships: [],
      activeOrgId: '',
      activeOrg: null,
    });
    window.location.hash = '#/org-register';
    renderWorkspaceShell('Complete organization setup or join an organization using an invite code.');
    return;
  }

  if (sessionPayload.needsOrgSelection) {
    setState({
      authReady: true,
      firebaseUser: user,
      userProfile: sessionPayload.userProfile || null,
      memberships: sessionPayload.memberships || [],
      activeOrgId: '',
      activeOrg: null,
    });
    window.location.hash = '#/select-org';
    renderWorkspaceShell();
    return;
  }

  const tier = sessionPayload.resolvedTier || 'member';
  const navItems = getNavItemsForSession(tier, sessionPayload.resolvedPermissions);
  const parsedHash = parseHashRoute(window.location.hash);
  const initialView =
    parsedHash.type === 'dashboard' &&
    parsedHash.role === tier &&
    navItems.some((i) => i.key === parsedHash.view)
      ? parsedHash.view
      : 'overview';

  setState({
    authReady: true,
    firebaseUser: user,
    userProfile: sessionPayload.userProfile || getState().userProfile,
    memberships: sessionPayload.memberships || getState().memberships,
    activeOrgId: sessionPayload.activeOrgId,
    activeOrg: sessionPayload.activeOrg,
    activeMembership: sessionPayload.activeMembership,
    activeMember: sessionPayload.activeMember,
    activeDesignation: sessionPayload.activeDesignation,
    resolvedTier: tier,
    resolvedPermissions: sessionPayload.resolvedPermissions,
    settings: sessionPayload.settings,
    activeView: initialView,
  });

  startOrgNotifListener(sessionPayload.activeOrgId, user.uid);
  initForegroundMessaging();
  window.history.replaceState(null, '', `#/${tier}/${initialView}`);
  renderWorkspaceShell();

  if (announce) {
    showToast(`Opened ${sessionPayload.activeOrg?.name} (${sessionPayload.activeMember?.designationName || tier}).`, 'success');
  }
}

async function handleAuthSync(firebaseUser) {
  if (!firebaseUser) {
    resetWorkspaceState();
    setState({ authReady: true, firebaseUser: null });
    renderWorkspaceShell();
    return;
  }

  if (!firebaseUser.emailVerified) {
    setState({ authReady: true, firebaseUser });
    renderWorkspaceShell();
    return;
  }

  try {
    const session = await resolvePostLoginSession(firebaseUser);
    await activateSessionPayload(session, false);
  } catch (err) {
    console.error('Session initialization error:', err);
    const msg = err?.message || 'Unable to verify organization membership.';
    await logoutUser().catch(() => {});
    resetWorkspaceState();
    setState({ authReady: true, firebaseUser: null });
    showToast(msg, 'danger', 7000);
    window.location.hash = '#/login';
    renderWorkspaceShell(msg);
  }
}

window.addEventListener('smartattend:session-ready', async (e) => {
  const detail = e.detail;
  if (!detail?.user) return;
  try {
    await activateSessionPayload(detail, true);
  } catch (err) {
    const msg = err?.message || 'Unable to launch workspace.';
    await logoutUser().catch(() => {});
    resetWorkspaceState();
    setState({ authReady: true, firebaseUser: null });
    showToast(msg, 'danger', 7000);
    window.location.hash = '#/login';
    renderWorkspaceShell(msg);
  }
});

window.addEventListener('smartattend:auth-refresh', () => {
  handleAuthSync(auth.currentUser);
});

window.addEventListener('smartattend:switch-org', async (e) => {
  const targetOrgId = e.detail;
  const user = auth.currentUser;
  if (!user || !targetOrgId) return;
  try {
    const ctx = await loadOrganizationContext(user.uid, targetOrgId);
    await activateSessionPayload({ user, memberships: getState().memberships, activeOrgId: targetOrgId, ...ctx }, true);
  } catch (err) {
    showToast(err.message || 'Unable to switch organization.', 'danger');
  }
});

async function boot() {
  initFirebaseAppCheck();
  initPwaAndNetwork((online) => setState({ isOnline: online }));
  testFirestoreConnection();
  onAuthStateChanged(auth, (user) => {
    if (isAuthFlowInProgress()) return;
    handleAuthSync(user);
  });
}

boot();
