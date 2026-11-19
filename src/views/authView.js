import {
  loginWithEmail,
  loginWithGoogle,
  registerStudentAccount,
  requestPasswordReset,
  resendVerificationEmail,
  refreshVerificationStatus,
  logoutUser,
} from '../services/authService.js';
import { escapeHtml } from '../utils/attendanceMath.js';
import { icon } from '../utils/icons.js';
import { showToast, toggleTheme, getCurrentTheme } from '../utils/ui.js';

let currentTab = 'signin';

export function renderAuthView(container, firebaseUser) {
  if (firebaseUser && !firebaseUser.emailVerified) {
    renderVerificationGate(container, firebaseUser);
    return;
  }

  const theme = getCurrentTheme();
  container.innerHTML = `
    <div class="auth-page">
      <section class="auth-hero" aria-label="SmartAttend Platform Highlights">
        <div style="display:flex;align-items:center;justify-content:space-between;">
          <div class="brand-wordmark">
            <span class="brand-mark">${icon('qr', 16)}</span>
            <span>SmartAttend</span>
          </div>
          <button type="button" class="icon-btn" id="auth-theme-btn" aria-label="Toggle color theme">
            ${icon(theme === 'dark' ? 'sun' : 'moon', 17)}
          </button>
        </div>

        <div class="stack-lg" style="max-width:460px;">
          <h1 style="font-size:clamp(2rem,3vw,2.65rem);line-height:1.12;">
            Verified academic attendance, engineered for clarity.
          </h1>
          <p style="color:var(--text-secondary);font-size:1rem;">
            Role-isolated Admin, Teacher, and Student portals backed by Firebase Authentication, deterministic Firestore transactions, rotating QR validation, and instant shortage analytics.
          </p>
          <div class="stack-md" style="padding-top:0.5rem;border-top:1px solid var(--border-hairline);">
            <div>
              <strong style="display:block;font-size:0.9375rem;">Dynamic Expiring QR Sessions</strong>
              <span style="font-size:0.875rem;color:var(--text-muted);">Auto-rotating tokens with duplicate scan prevention and live Realtime Database check-in stream.</span>
            </div>
            <div>
              <strong style="display:block;font-size:0.9375rem;">Shortage &amp; Threshold Alerts</strong>
              <span style="font-size:0.875rem;color:var(--text-muted);">Automated low-attendance notifications and interactive recovery planning per subject.</span>
            </div>
            <div>
              <strong style="display:block;font-size:0.9375rem;">Audit-Ready PDF &amp; Excel Reports</strong>
              <span style="font-size:0.875rem;color:var(--text-muted);">One-click institutional and subject-level exports with leave and correction tracking.</span>
            </div>
          </div>
        </div>

        <p style="font-size:0.8125rem;color:var(--text-muted);">
          SmartAttend Academic Operations · Firebase Project <span class="mono">attendence-system-867c1</span>
        </p>
      </section>

      <main id="main-content" class="auth-main">
        <div class="auth-card">
          <div style="display:flex;align-items:center;justify-content:space-between;">
            <div class="brand-wordmark">
              <span class="brand-mark">${icon('qr', 16)}</span>
              <span>SmartAttend</span>
            </div>
            <button type="button" class="icon-btn" id="auth-theme-mobile-btn" aria-label="Toggle color theme">
              ${icon(theme === 'dark' ? 'sun' : 'moon', 17)}
            </button>
          </div>

          <div class="segmented-bar" role="tablist" aria-label="Authentication mode">
            <button type="button" class="segmented-btn ${currentTab === 'signin' ? 'active' : ''}" data-auth-tab="signin">Sign In</button>
            <button type="button" class="segmented-btn ${currentTab === 'signup' ? 'active' : ''}" data-auth-tab="signup">Register</button>
            <button type="button" class="segmented-btn ${currentTab === 'reset' ? 'active' : ''}" data-auth-tab="reset">Reset Password</button>
          </div>

          <div id="auth-form-slot"></div>
        </div>
      </main>
    </div>
  `;

  const onThemeToggle = () => {
    toggleTheme();
    renderAuthView(container, firebaseUser);
  };
  container.querySelector('#auth-theme-btn')?.addEventListener('click', onThemeToggle);
  container.querySelector('#auth-theme-mobile-btn')?.addEventListener('click', onThemeToggle);

  container.querySelectorAll('[data-auth-tab]').forEach((btn) => {
    btn.addEventListener('click', () => {
      currentTab = btn.getAttribute('data-auth-tab');
      renderAuthView(container, firebaseUser);
    });
  });

  const slot = container.querySelector('#auth-form-slot');
  if (currentTab === 'signin') renderSignInForm(slot);
  else if (currentTab === 'signup') renderSignUpForm(slot);
  else renderResetForm(slot);
}

function renderSignInForm(slot) {
  slot.innerHTML = `
    <form id="signin-form" class="stack-md">
      <div>
        <h2 style="font-size:1.25rem;">Sign in to your portal</h2>
        <p style="font-size:0.875rem;color:var(--text-muted);margin-top:0.25rem;">Access your Admin, Teacher, or Student workspace.</p>
      </div>
      <div class="field">
        <label class="field-label" for="signin-email">Institutional Email</label>
        <input class="input" id="signin-email" name="email" type="email" autocomplete="email" required placeholder="name@institution.edu" />
      </div>
      <div class="field">
        <label class="field-label" for="signin-password">Password</label>
        <input class="input" id="signin-password" name="password" type="password" autocomplete="current-password" required placeholder="Enter your password" />
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

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errEl.style.display = 'none';
    submitBtn.disabled = true;
    submitBtn.textContent = 'Signing in...';
    try {
      const fd = new FormData(form);
      await loginWithEmail(fd.get('email'), fd.get('password'));
      showToast('Signed in successfully.', 'success');
    } catch (err) {
      errEl.textContent = err.message || 'Invalid credentials.';
      errEl.style.display = 'block';
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = 'Sign In';
    }
  });

  slot.querySelector('#google-signin-btn').addEventListener('click', async () => {
    errEl.style.display = 'none';
    try {
      await loginWithGoogle();
      showToast('Signed in with Google.', 'success');
    } catch (err) {
      errEl.textContent = err.message || 'Google sign-in failed.';
      errEl.style.display = 'block';
    }
  });
}

function renderSignUpForm(slot) {
  slot.innerHTML = `
    <form id="signup-form" class="stack-md">
      <div>
        <h2 style="font-size:1.25rem;">Create Student Account</h2>
        <p style="font-size:0.875rem;color:var(--text-muted);margin-top:0.25rem;">Teacher &amp; Admin accounts are provisioned by your institution administrator.</p>
      </div>
      <div class="field">
        <label class="field-label" for="signup-name">Full Name</label>
        <input class="input" id="signup-name" name="name" type="text" required minlength="2" maxlength="80" placeholder="Aarav Sharma" />
      </div>
      <div class="field">
        <label class="field-label" for="signup-roll">Roll Number / Student ID</label>
        <input class="input" id="signup-roll" name="rollNumber" type="text" required maxlength="32" placeholder="CSE26-042" />
      </div>
      <div class="field">
        <label class="field-label" for="signup-email">Email Address</label>
        <input class="input" id="signup-email" name="email" type="email" required placeholder="student@institution.edu" />
      </div>
      <div class="field">
        <label class="field-label" for="signup-password">Password (min 6 characters)</label>
        <input class="input" id="signup-password" name="password" type="password" required minlength="6" placeholder="Create a strong password" />
      </div>
      <p id="signup-error" class="status-text status-danger" style="display:none;white-space:normal;"></p>
      <button type="submit" class="btn btn-primary" id="signup-submit-btn">Create Account &amp; Send Verification</button>
    </form>
  `;

  const form = slot.querySelector('#signup-form');
  const errEl = slot.querySelector('#signup-error');
  const submitBtn = slot.querySelector('#signup-submit-btn');

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errEl.style.display = 'none';
    submitBtn.disabled = true;
    submitBtn.textContent = 'Creating account...';
    try {
      const fd = new FormData(form);
      await registerStudentAccount({
        name: fd.get('name'),
        rollNumber: fd.get('rollNumber'),
        email: fd.get('email'),
        password: fd.get('password'),
      });
      showToast('Account created. Verification link sent to your email.', 'success');
    } catch (err) {
      errEl.textContent = err.message || 'Registration failed.';
      errEl.style.display = 'block';
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = 'Create Account & Send Verification';
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
        <input class="input" id="reset-email" name="email" type="email" required placeholder="name@institution.edu" />
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
      const fd = new FormData(form);
      await requestPasswordReset(fd.get('email'));
      msgEl.className = 'status-text status-success';
      msgEl.textContent = 'Password reset email sent. Check your inbox.';
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
          SmartAttend security rules require a verified email before granting access to attendance records.
          We sent a verification link to <strong>${escapeHtml(firebaseUser.email)}</strong>.
        </p>
        <div class="notice">
          <strong style="font-size:0.875rem;">Next steps</strong>
          <span style="font-size:0.8125rem;color:var(--text-secondary);">
            1. Open the verification email (check spam/promotions if needed).<br />
            2. Click the verification link.<br />
            3. Return here and select "I've Verified — Refresh".
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

  container.querySelector('#verify-refresh-btn').addEventListener('click', async () => {
    const ok = await refreshVerificationStatus();
    if (ok) {
      showToast('Email verified! Loading workspace...', 'success');
      window.dispatchEvent(new CustomEvent('smartattend:auth-refresh'));
    } else {
      showToast('Email is not verified yet. Please click the link in your inbox.', 'warning');
    }
  });

  container.querySelector('#verify-resend-btn').addEventListener('click', async () => {
    try {
      await resendVerificationEmail();
      showToast('Verification email resent.', 'success');
    } catch (err) {
      showToast(err.message || 'Please wait a moment before resending.', 'danger');
    }
  });

  container.querySelector('#verify-logout-btn').addEventListener('click', () => logoutUser());
}
