import {
  loginWithEmail,
  loginWithGoogle,
  registerOrganizationOwner,
  registerAndJoinOrganization,
  requestPasswordReset,
  resendVerificationEmail,
  refreshVerificationStatus,
  logoutUser,
} from '../services/authService.js';
import { ORG_TYPES, lookupInvitationByCode, loadOrganizationContext } from '../services/orgService.js';
import { escapeHtml } from '../utils/attendanceMath.js';
import { icon } from '../utils/icons.js';
import { showToast, toggleTheme, getCurrentTheme } from '../utils/ui.js';

export function renderAuthView(container, options = {}) {
  const {
    mode = 'login', // 'login' | 'org-register' | 'join' | 'forgot-password' | 'verify-email' | 'select-org'
    firebaseUser = null,
    memberships = [],
    isBootstrapAdmin = false,
    inviteCode = '',
    authError = '',
  } = options;

  if (mode === 'verify-email' && firebaseUser && !firebaseUser.emailVerified) {
    renderVerificationGate(container, firebaseUser);
    return;
  }

  if (mode === 'select-org' && firebaseUser) {
    renderOrgSelectorGate(container, firebaseUser, memberships);
    return;
  }

  const activeTab = ['login', 'org-register', 'join', 'forgot-password'].includes(mode) ? mode : 'login';
  const theme = getCurrentTheme();

  container.innerHTML = `
    <div class="auth-page">
      <section class="auth-hero" aria-label="SmartAttend SaaS Overview">
        <div style="display:flex;align-items:center;justify-content:space-between;">
          <a href="#/" class="brand-wordmark" style="text-decoration:none;">
            <span class="brand-mark">${icon('qr', 16)}</span>
            <span>SmartAttend</span>
          </a>
          <div style="display:flex;gap:0.5rem;align-items:center;">
            <a href="#/" class="btn btn-ghost btn-sm">Back to Website</a>
            <button type="button" class="icon-btn" id="auth-theme-btn" aria-label="Toggle theme">
              ${icon(theme === 'dark' ? 'sun' : 'moon', 17)}
            </button>
          </div>
        </div>

        <div class="stack-lg" style="max-width:460px;">
          <h1 style="font-size:clamp(1.9rem,2.8vw,2.5rem);line-height:1.12;">
            Universal attendance workspaces for every organization.
          </h1>
          <p style="color:var(--text-secondary);font-size:1rem;">
            Create an isolated workspace for your school, college, office, startup, or factory—or join your organization using an invite code or Organization ID.
          </p>
          <div class="stack-md" style="padding-top:0.5rem;border-top:1px solid var(--border-hairline);">
            <div>
              <strong style="display:block;font-size:0.9375rem;">Isolated Multi-Tenant Security</strong>
              <span style="font-size:0.875rem;color:var(--text-muted);">Strict per-organization Firestore boundaries with verified membership resolution.</span>
            </div>
            <div>
              <strong style="display:block;font-size:0.9375rem;">Custom Hierarchy &amp; Permissions</strong>
              <span style="font-size:0.875rem;color:var(--text-muted);">Define unlimited designations, reporting trees, branches, shifts, and leave rules.</span>
            </div>
            <div>
              <strong style="display:block;font-size:0.9375rem;">Personal Member QR IDs</strong>
              <span style="font-size:0.875rem;color:var(--text-muted);">Opaque revocable QR badges scanned by authorized heads or managers.</span>
            </div>
          </div>
        </div>

        <p style="font-size:0.8125rem;color:var(--text-muted);">
          SmartAttend SaaS Platform · Firebase Backend
        </p>
      </section>

      <main id="main-content" class="auth-main">
        <div class="auth-card" style="max-width:490px;">
          <div style="display:flex;align-items:center;justify-content:space-between;">
            <a href="#/" class="brand-wordmark" style="text-decoration:none;">
              <span class="brand-mark">${icon('qr', 16)}</span>
              <span>SmartAttend</span>
            </a>
            <div style="display:flex;gap:0.375rem;align-items:center;">
              <a href="#/" class="btn btn-ghost btn-sm">Home</a>
              <button type="button" class="icon-btn" id="auth-theme-mobile-btn" aria-label="Toggle theme">
                ${icon(theme === 'dark' ? 'sun' : 'moon', 17)}
              </button>
            </div>
          </div>

          ${
            authError
              ? `<div class="notice notice-danger" role="alert">
                  <strong style="color:var(--danger);font-size:0.875rem;">Access Notice</strong>
                  <span style="font-size:0.8125rem;color:var(--text-secondary);">${escapeHtml(authError)}</span>
                </div>`
              : ''
          }

          <div class="segmented-bar" role="tablist" aria-label="Authentication mode">
            <button type="button" class="segmented-btn ${activeTab === 'login' ? 'active' : ''}" data-auth-tab="login">Sign In</button>
            <button type="button" class="segmented-btn ${activeTab === 'org-register' ? 'active' : ''}" data-auth-tab="org-register">Create Org</button>
            <button type="button" class="segmented-btn ${activeTab === 'join' ? 'active' : ''}" data-auth-tab="join">Join Org</button>
            <button type="button" class="segmented-btn ${activeTab === 'forgot-password' ? 'active' : ''}" data-auth-tab="forgot-password">Reset</button>
          </div>

          <div id="auth-form-slot"></div>
        </div>
      </main>
    </div>
  `;

  const onTheme = () => {
    toggleTheme();
    renderAuthView(container, options);
  };
  container.querySelector('#auth-theme-btn')?.addEventListener('click', onTheme);
  container.querySelector('#auth-theme-mobile-btn')?.addEventListener('click', onTheme);

  container.querySelectorAll('[data-auth-tab]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const nextMode = btn.getAttribute('data-auth-tab');
      window.location.hash = `#/${nextMode}`;
    });
  });

  const slot = container.querySelector('#auth-form-slot');
  if (activeTab === 'login') renderSignInForm(slot);
  else if (activeTab === 'org-register') renderOrgRegisterForm(slot, firebaseUser, isBootstrapAdmin);
  else if (activeTab === 'join') renderJoinOrgForm(slot, firebaseUser, inviteCode);
  else renderResetForm(slot);
}

function dispatchSessionReady(result) {
  window.dispatchEvent(new CustomEvent('smartattend:session-ready', { detail: result }));
}

function renderSignInForm(slot) {
  slot.innerHTML = `
    <form id="signin-form" class="stack-md">
      <div>
        <h2 style="font-size:1.25rem;">Sign in to your workspace</h2>
        <p style="font-size:0.875rem;color:var(--text-muted);margin-top:0.25rem;">Your organization &amp; permissions load automatically from Firestore.</p>
      </div>
      <div class="field">
        <label class="field-label" for="signin-email">Email Address</label>
        <input class="input" id="signin-email" name="email" type="email" autocomplete="email" required placeholder="name@organization.com" />
      </div>
      <div class="field">
        <label class="field-label" for="signin-password">Password</label>
        <input class="input" id="signin-password" name="password" type="password" autocomplete="current-password" required placeholder="Enter password" />
      </div>
      <p id="signin-error" class="status-text status-danger" style="display:none;white-space:normal;"></p>
      <button type="submit" class="btn btn-primary" id="signin-submit-btn">Sign In</button>
      <div style="display:flex;align-items:center;gap:0.75rem;color:var(--text-muted);font-size:0.75rem;">
        <span style="flex:1;height:1px;background:var(--border-hairline);"></span>
        <span>or</span>
        <span style="flex:1;height:1px;background:var(--border-hairline);"></span>
      </div>
      <button type="button" class="btn btn-secondary" id="google-signin-btn">Continue with Google</button>
    </form>
  `;

  const form = slot.querySelector('#signin-form');
  const errEl = slot.querySelector('#signin-error');
  const submitBtn = slot.querySelector('#signin-submit-btn');
  const googleBtn = slot.querySelector('#google-signin-btn');

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errEl.style.display = 'none';
    submitBtn.disabled = true;
    googleBtn.disabled = true;
    submitBtn.textContent = 'Verifying workspace...';
    try {
      const fd = new FormData(form);
      const res = await loginWithEmail(fd.get('email'), fd.get('password'));
      dispatchSessionReady(res);
    } catch (err) {
      errEl.textContent = err.message || 'Sign-in failed.';
      errEl.style.display = 'block';
      showToast(err.message || 'Sign-in failed.', 'danger');
    } finally {
      if (submitBtn.isConnected) {
        submitBtn.disabled = false;
        submitBtn.textContent = 'Sign In';
      }
      if (googleBtn.isConnected) {
        googleBtn.disabled = false;
      }
    }
  });

  googleBtn.addEventListener('click', async () => {
    errEl.style.display = 'none';
    submitBtn.disabled = true;
    googleBtn.disabled = true;
    googleBtn.textContent = 'Connecting Google...';
    try {
      const res = await loginWithGoogle();
      dispatchSessionReady(res);
    } catch (err) {
      errEl.textContent = err.message || 'Google sign-in failed.';
      errEl.style.display = 'block';
      showToast(err.message || 'Google sign-in failed.', 'danger');
    } finally {
      if (submitBtn.isConnected) {
        submitBtn.disabled = false;
      }
      if (googleBtn.isConnected) {
        googleBtn.disabled = false;
        googleBtn.textContent = 'Continue with Google';
      }
    }
  });
}

function renderOrgRegisterForm(slot, existingUser, isBootstrapAdmin = false) {
  const defaultTz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  slot.innerHTML = `
    <form id="org-reg-form" class="stack-md">
      <div>
        <h2 style="font-size:1.25rem;">Create Organization Workspace</h2>
        <p style="font-size:0.875rem;color:var(--text-muted);margin-top:0.25rem;">Generates an isolated workspace with custom hierarchy &amp; free starter plan.</p>
      </div>
      <div class="field">
        <label class="field-label" for="org-name">Organization Name</label>
        <input class="input" id="org-name" name="orgName" required maxlength="120" placeholder="Apex Institute / Acme Corp" />
      </div>
      <div class="form-grid form-grid-2">
        <div class="field">
          <label class="field-label" for="org-type">Organization Type</label>
          <select class="select" id="org-type" name="orgType" required>
            ${ORG_TYPES.map((t) => `<option value="${t.id}">${escapeHtml(t.label)}</option>`).join('')}
          </select>
        </div>
        <div class="field">
          <label class="field-label" for="org-country">Country</label>
          <input class="input" id="org-country" name="country" required value="India" maxlength="60" />
        </div>
      </div>
      <div class="field">
        <label class="field-label" for="org-tz">Timezone</label>
        <input class="input mono" id="org-tz" name="timezone" required value="${escapeHtml(defaultTz)}" maxlength="80" />
      </div>
      <div class="field">
        <label class="field-label" for="owner-name">Owner / Primary Head Name</label>
        <input class="input" id="owner-name" name="ownerName" required value="${escapeHtml(existingUser?.displayName || '')}" placeholder="Full Name" maxlength="80" />
      </div>
      ${
        existingUser
          ? `<div class="notice ${isBootstrapAdmin ? 'notice-success' : ''}"><span style="font-size:0.8125rem;color:var(--text-secondary);">Provisioning workspace under ${isBootstrapAdmin ? 'bootstrapped admin ' : 'signed-in '}account <strong>${escapeHtml(existingUser.email)}</strong>.</span></div>`
          : `
        <div class="form-grid form-grid-2">
          <div class="field">
            <label class="field-label" for="owner-email">Owner Email</label>
            <input class="input" id="owner-email" name="email" type="email" required placeholder="owner@org.com" />
          </div>
          <div class="field">
            <label class="field-label" for="owner-pass">Password (min 6)</label>
            <input class="input" id="owner-pass" name="password" type="password" required minlength="6" placeholder="Create password" />
          </div>
        </div>`
      }
      <p id="org-reg-err" class="status-text status-danger" style="display:none;white-space:normal;"></p>
      <button type="submit" class="btn btn-primary" id="org-reg-btn">Create Organization Workspace</button>
    </form>
  `;

  const form = slot.querySelector('#org-reg-form');
  const errEl = slot.querySelector('#org-reg-err');
  const btn = slot.querySelector('#org-reg-btn');

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errEl.style.display = 'none';
    btn.disabled = true;
    btn.textContent = 'Provisioning isolated workspace...';
    try {
      const fd = new FormData(form);
      const res = await registerOrganizationOwner({
        orgName: fd.get('orgName'),
        orgType: fd.get('orgType'),
        country: fd.get('country'),
        timezone: fd.get('timezone'),
        ownerName: fd.get('ownerName'),
        email: fd.get('email') || existingUser?.email,
        password: fd.get('password') || '',
      });
      showToast('Organization workspace created!', 'success');
      dispatchSessionReady(res);
    } catch (err) {
      errEl.textContent = err.message || 'Organization creation failed.';
      errEl.style.display = 'block';
      btn.disabled = false;
      btn.textContent = 'Create Organization Workspace';
    }
  });
}

function renderJoinOrgForm(slot, existingUser, initialInviteCode = '') {
  slot.innerHTML = `
    <form id="join-org-form" class="stack-md">
      <div>
        <h2 style="font-size:1.25rem;">Join an Organization</h2>
        <p style="font-size:0.875rem;color:var(--text-muted);margin-top:0.25rem;">Use an Invitation Code (instant access) or enter an Organization ID to request approval.</p>
      </div>
      <div class="form-grid form-grid-2">
        <div class="field">
          <label class="field-label" for="join-invite">Invitation Code</label>
          <input class="input mono" id="join-invite" name="inviteCode" value="${escapeHtml(initialInviteCode)}" placeholder="e.g. A1B2C3D4E5" />
        </div>
        <div class="field">
          <label class="field-label" for="join-orgid">OR Organization ID</label>
          <input class="input mono" id="join-orgid" name="orgIdInput" placeholder="e.g. ORG-7K9P2" />
        </div>
      </div>
      <div id="invite-preview" style="display:none;" class="notice notice-success"></div>
      <div class="form-grid form-grid-2">
        <div class="field">
          <label class="field-label" for="join-name">Full Name</label>
          <input class="input" id="join-name" name="name" required value="${escapeHtml(existingUser?.displayName || '')}" placeholder="Your full name" />
        </div>
        <div class="field">
          <label class="field-label" for="join-ext">Roll / Employee ID (Optional)</label>
          <input class="input mono" id="join-ext" name="externalId" placeholder="EMP-104 / ROLL-22" />
        </div>
      </div>
      ${
        existingUser
          ? `<div class="notice"><span style="font-size:0.8125rem;">Joining as <strong>${escapeHtml(existingUser.email)}</strong>.</span></div>`
          : `
        <div class="form-grid form-grid-2">
          <div class="field">
            <label class="field-label" for="join-email">Email Address</label>
            <input class="input" id="join-email" name="email" type="email" required placeholder="member@organization.com" />
          </div>
          <div class="field">
            <label class="field-label" for="join-pass">Password (min 6)</label>
            <input class="input" id="join-pass" name="password" type="password" required minlength="6" placeholder="Create password" />
          </div>
        </div>`
      }
      <p id="join-err" class="status-text status-danger" style="display:none;white-space:normal;"></p>
      <button type="submit" class="btn btn-primary" id="join-submit-btn">Join Organization</button>
    </form>
  `;

  const inviteInput = slot.querySelector('#join-invite');
  const preview = slot.querySelector('#invite-preview');
  async function checkInvite() {
    const code = inviteInput.value.trim();
    if (!code) {
      preview.style.display = 'none';
      return;
    }
    try {
      const info = await lookupInvitationByCode(code);
      preview.innerHTML = `<span style="font-size:0.8125rem;">Valid invite for <strong>${escapeHtml(info.orgName)}</strong> (${escapeHtml(info.orgId)}) · Role: ${escapeHtml(info.designationName)}</span>`;
      preview.style.display = 'block';
    } catch {
      preview.style.display = 'none';
    }
  }
  if (initialInviteCode) checkInvite();
  inviteInput.addEventListener('blur', checkInvite);

  const form = slot.querySelector('#join-org-form');
  const errEl = slot.querySelector('#join-err');
  const btn = slot.querySelector('#join-submit-btn');

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errEl.style.display = 'none';
    btn.disabled = true;
    btn.textContent = 'Submitting membership...';
    try {
      const fd = new FormData(form);
      const res = await registerAndJoinOrganization({
        inviteCode: String(fd.get('inviteCode') || ''),
        orgIdInput: String(fd.get('orgIdInput') || ''),
        name: String(fd.get('name') || ''),
        externalId: String(fd.get('externalId') || ''),
        email: String(fd.get('email') || existingUser?.email || ''),
        password: String(fd.get('password') || ''),
      });
      if (res.pendingApproval) {
        showToast(`Join request sent to ${res.joined.orgName}. Awaiting admin approval.`, 'info', 6000);
        window.location.hash = '#/login';
        return;
      }
      dispatchSessionReady(res);
    } catch (err) {
      errEl.textContent = err.message || 'Unable to join organization.';
      errEl.style.display = 'block';
      btn.disabled = false;
      btn.textContent = 'Join Organization';
    }
  });
}

function renderResetForm(slot) {
  slot.innerHTML = `
    <form id="reset-form" class="stack-md">
      <div>
        <h2 style="font-size:1.25rem;">Reset Password</h2>
        <p style="font-size:0.875rem;color:var(--text-muted);margin-top:0.25rem;">Receive a Firebase password reset link in your inbox.</p>
      </div>
      <div class="field">
        <label class="field-label" for="reset-email">Registered Email</label>
        <input class="input" id="reset-email" name="email" type="email" required placeholder="name@organization.com" />
      </div>
      <p id="reset-msg" style="display:none;font-size:0.875rem;"></p>
      <button type="submit" class="btn btn-primary" id="reset-submit-btn">Send Reset Link</button>
    </form>
  `;

  const form = slot.querySelector('#reset-form');
  const msgEl = slot.querySelector('#reset-msg');
  const btn = slot.querySelector('#reset-submit-btn');

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    msgEl.style.display = 'none';
    btn.disabled = true;
    try {
      await requestPasswordReset(new FormData(form).get('email'));
      msgEl.className = 'status-text status-success';
      msgEl.textContent = 'Password reset link sent. Check your inbox.';
      msgEl.style.display = 'block';
    } catch (err) {
      msgEl.className = 'status-text status-danger';
      msgEl.textContent = err.message || 'Unable to send reset email.';
      msgEl.style.display = 'block';
    } finally {
      btn.disabled = false;
    }
  });
}

function renderVerificationGate(container, firebaseUser) {
  container.innerHTML = `
    <main id="main-content" class="auth-main" style="min-height:100vh;">
      <div class="auth-card" style="max-width:480px;">
        <div class="brand-wordmark">
          <span class="brand-mark">${icon('shield', 16)}</span>
          <span>Email Verification Required</span>
        </div>
        <p style="color:var(--text-secondary);">
          SmartAttend security rules require a verified email before unlocking your organization workspace.
          We sent a verification link to <strong>${escapeHtml(firebaseUser.email)}</strong>.
        </p>
        <div class="notice">
          <strong style="font-size:0.875rem;">Verification steps</strong>
          <span style="font-size:0.8125rem;color:var(--text-secondary);">
            1. Open your inbox (check spam if missing) and click the link.<br />
            2. Click "I've Verified — Refresh" below.
          </span>
        </div>
        <div class="stack-sm">
          <button type="button" class="btn btn-primary" id="verify-refresh-btn">I've Verified — Refresh</button>
          <button type="button" class="btn btn-secondary" id="verify-resend-btn">Resend Verification Email</button>
          <button type="button" class="btn btn-ghost" id="verify-logout-btn">Sign Out</button>
        </div>
      </div>
    </main>
  `;

  const refreshBtn = container.querySelector('#verify-refresh-btn');
  refreshBtn.addEventListener('click', async () => {
    refreshBtn.disabled = true;
    refreshBtn.textContent = 'Checking verification...';
    try {
      const ok = await refreshVerificationStatus();
      if (ok) {
        showToast('Email verified! Opening workspace...', 'success');
        window.dispatchEvent(new CustomEvent('smartattend:auth-refresh'));
      } else {
        showToast('Email is not verified yet. Click the link in your inbox first.', 'warning');
      }
    } catch (err) {
      showToast(err.message || 'Unable to refresh verification status.', 'danger');
    } finally {
      if (refreshBtn.isConnected) {
        refreshBtn.disabled = false;
        refreshBtn.textContent = "I've Verified — Refresh";
      }
    }
  });

  container.querySelector('#verify-resend-btn').addEventListener('click', async () => {
    try {
      await resendVerificationEmail();
      showToast('Verification email resent.', 'success');
    } catch (err) {
      showToast(err.message || 'Please wait before resending.', 'danger');
    }
  });

  container.querySelector('#verify-logout-btn').addEventListener('click', async () => {
    await logoutUser().catch(() => {});
    window.location.hash = '#/';
  });
}

function renderOrgSelectorGate(container, firebaseUser, memberships = []) {
  container.innerHTML = `
    <main id="main-content" class="auth-main" style="min-height:100vh;">
      <div class="auth-card" style="max-width:540px;">
        <div style="display:flex;justify-content:space-between;align-items:center;">
          <div class="brand-wordmark">
            <span class="brand-mark">${icon('building', 16)}</span>
            <span>Select Organization Workspace</span>
          </div>
          <button type="button" class="btn btn-ghost btn-sm" id="orgsel-logout">Sign Out</button>
        </div>
        <p style="font-size:0.875rem;color:var(--text-secondary);">
          Signed in as <strong>${escapeHtml(firebaseUser.email)}</strong>. Choose an authorized workspace to continue:
        </p>
        <div class="stack-sm" id="orgsel-list">
          ${memberships
            .map(
              (m) => `
            <button type="button" class="panel" data-select-org="${escapeHtml(m.orgId)}" style="text-align:left;display:flex;justify-content:space-between;align-items:center;cursor:pointer;">
              <div>
                <strong style="display:block;">${escapeHtml(m.orgName)}</strong>
                <span style="font-size:0.8125rem;color:var(--text-muted);">${escapeHtml(m.designationName || m.portalTier)} · <span class="mono">${escapeHtml(m.orgId)}</span></span>
              </div>
              <span>${icon('arrowRight', 16)}</span>
            </button>
          `
            )
            .join('')}
        </div>
        <div style="display:flex;gap:0.5rem;flex-wrap:wrap;padding-top:0.5rem;border-top:1px solid var(--border-hairline);">
          <button type="button" class="btn btn-secondary btn-sm" id="orgsel-create">Create New Organization</button>
          <button type="button" class="btn btn-ghost btn-sm" id="orgsel-join">Join Another Organization</button>
        </div>
      </div>
    </main>
  `;

  container.querySelector('#orgsel-logout').addEventListener('click', async () => {
    await logoutUser().catch(() => {});
    window.location.hash = '#/';
  });
  container.querySelector('#orgsel-create').addEventListener('click', () => {
    window.location.hash = '#/org-register';
  });
  container.querySelector('#orgsel-join').addEventListener('click', () => {
    window.location.hash = '#/join';
  });

  container.querySelectorAll('[data-select-org]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const orgId = btn.getAttribute('data-select-org');
      btn.disabled = true;
      try {
        const ctx = await loadOrganizationContext(firebaseUser.uid, orgId);
        dispatchSessionReady({
          user: firebaseUser,
          memberships,
          activeOrgId: orgId,
          ...ctx,
        });
      } catch (err) {
        showToast(err.message || 'Unable to load workspace.', 'danger');
        btn.disabled = false;
      }
    });
  });
}
