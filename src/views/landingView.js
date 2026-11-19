import { createPublicContactInquiry } from '../services/firestoreService.js';
import { SUBSCRIPTION_PLANS } from '../services/orgService.js';
import { escapeHtml } from '../utils/attendanceMath.js';
import { icon } from '../utils/icons.js';
import { canInstallPwa, isIosSafari, isRunningStandalone, triggerPwaInstall } from '../utils/pwa.js';
import { getCurrentTheme, showToast, toggleTheme } from '../utils/ui.js';

const HIERARCHY_EXAMPLES = {
  college: {
    label: 'College / University',
    nodes: [
      { level: 'Level 1', title: 'Principal / Dean', scope: 'Full institution policies, branches, reports' },
      { level: 'Level 2', title: 'Head of Department (HOD)', scope: 'Department faculty, timetable, approvals' },
      { level: 'Level 3', title: 'Faculty / Teacher', scope: 'Scan student QR IDs, manual attendance, corrections' },
      { level: 'Level 4', title: 'Student', scope: 'Personal QR ID, attendance history, leave requests' },
    ],
  },
  company: {
    label: 'Company / Startup',
    nodes: [
      { level: 'Level 1', title: 'Founder / HR Director', scope: 'Org policies, shifts, branches, audit logs' },
      { level: 'Level 2', title: 'Department Manager', scope: 'Team attendance, leave approvals, overtime' },
      { level: 'Level 3', title: 'Team Lead / Supervisor', scope: 'Daily QR check-in/out & team analytics' },
      { level: 'Level 4', title: 'Employee', scope: 'Digital QR badge, shift calendar, leave balance' },
    ],
  },
  factory: {
    label: 'Factory / Operations',
    nodes: [
      { level: 'Level 1', title: 'Plant Director', scope: 'Multi-plant shifts, holidays, compliance exports' },
      { level: 'Level 2', title: 'Shift Superintendent', scope: 'Rotational shift rosters & geofence rules' },
      { level: 'Level 3', title: 'Floor Supervisor', scope: 'Gate QR scanner check-in/out & overtime tracking' },
      { level: 'Level 4', title: 'Technician / Operator', scope: 'Printable QR ID card, shift history, leaves' },
    ],
  },
};

const FAQ_ITEMS = [
  {
    q: 'Can we customize roles beyond Teacher and Student?',
    a: 'Yes. Every organization builds its own designation tree (Principal → HOD → Teacher → Student, Founder → Manager → Lead → Employee, or a flat Owner → Member setup) with granular permissions per level.',
  },
  {
    q: 'How is tenant data isolated between organizations?',
    a: 'Each organization operates under an isolated Firestore path (organizations/{orgId}/...) enforced by security rules checking users/{uid}/memberships/{orgId}. Members of one organization can never read or scan another organization.',
  },
  {
    q: 'What does a Member QR Code contain?',
    a: 'Only an opaque revocable token ID and organization reference ({ v: 2, type: "member_id", orgId, token }). Sensitive details like email, phone, or attendance records are never encoded inside the QR string.',
  },
  {
    q: 'Does SmartAttend count holidays or weekly offs as absences?',
    a: 'No. Organization-wide and department-specific holidays, weekly off days, and approved leaves are explicitly excluded from absence penalties under configurable policy formulas.',
  },
  {
    q: 'Can members mark attendance while offline?',
    a: 'To protect data integrity and prevent clock tampering or duplicate check-ins, live QR scanning and attendance submissions require an active network connection. Cached views display a clear offline banner.',
  },
];

let previewTab = 'college';

function go(hash) {
  window.location.hash = hash;
}

function renderSaasHeader(activePage) {
  const theme = getCurrentTheme();
  const showInstall = !isRunningStandalone() && (canInstallPwa() || isIosSafari());
  const navLinks = [
    { page: 'features', label: 'Features', hash: '#/features' },
    { page: 'solutions', label: 'Solutions', hash: '#/solutions' },
    { page: 'how-it-works', label: 'How It Works', hash: '#/how-it-works' },
    { page: 'pricing', label: 'Pricing', hash: '#/pricing' },
    { page: 'contact', label: 'Contact', hash: '#/contact' },
  ];

  return `
    <header class="saas-header">
      <div class="saas-header-inner">
        <a href="#/" class="brand-wordmark" style="text-decoration:none;">
          <span class="brand-mark">${icon('qr', 16)}</span>
          <span>SmartAttend</span>
        </a>

        <nav class="saas-nav" aria-label="Public Navigation">
          ${navLinks
            .map(
              (n) => `<button type="button" class="saas-nav-link ${activePage === n.page ? 'active' : ''}" data-go="${n.hash}">${n.label}</button>`
            )
            .join('')}
        </nav>

        <div class="saas-header-cta">
          ${
            showInstall
              ? `<button type="button" class="btn btn-secondary btn-sm" id="saas-install-btn">${icon('smartphone', 15)} Install App</button>`
              : ''
          }
          <button type="button" class="icon-btn" id="saas-theme-btn" aria-label="Toggle color theme" title="Toggle Dark/Light Mode">
            ${icon(theme === 'dark' ? 'sun' : 'moon', 17)}
          </button>
          <button type="button" class="btn btn-ghost btn-sm" data-go="#/login">Login</button>
          <button type="button" class="btn btn-primary btn-sm" data-go="#/org-register">Get Started Free</button>
          <button type="button" class="icon-btn saas-mobile-toggle" id="saas-mobile-btn" aria-label="Toggle Menu">
            ${icon('menu', 18)}
          </button>
        </div>
      </div>

      <div class="saas-mobile-menu" id="saas-mobile-menu" style="display:none;">
        ${navLinks
          .map(
            (n) => `<button type="button" class="btn btn-ghost" style="justify-content:flex-start;" data-go="${n.hash}">${n.label}</button>`
          )
          .join('')}
      </div>
    </header>
  `;
}

function renderSaasFooter() {
  return `
    <footer class="saas-footer">
      <div class="saas-container">
        <div class="saas-footer-grid">
          <div class="stack-sm">
            <div class="brand-wordmark">
              <span class="brand-mark">${icon('qr', 16)}</span>
              <span>SmartAttend</span>
            </div>
            <p style="font-size:0.875rem;color:var(--text-secondary);max-width:34ch;">
              Universal multi-organization attendance management SaaS built for schools, colleges, startups, offices, and operations teams.
            </p>
          </div>
          <div class="stack-sm">
            <strong style="font-size:0.875rem;">Platform</strong>
            <button type="button" class="saas-footer-link" data-go="#/features">Features</button>
            <button type="button" class="saas-footer-link" data-go="#/solutions">Solutions</button>
            <button type="button" class="saas-footer-link" data-go="#/how-it-works">How It Works</button>
            <button type="button" class="saas-footer-link" data-go="#/pricing">Pricing</button>
          </div>
          <div class="stack-sm">
            <strong style="font-size:0.875rem;">Access</strong>
            <button type="button" class="saas-footer-link" data-go="#/org-register">Create Organization</button>
            <button type="button" class="saas-footer-link" data-go="#/join">Join Organization</button>
            <button type="button" class="saas-footer-link" data-go="#/login">Member Login</button>
            <button type="button" class="saas-footer-link" data-go="#/contact">Contact Us</button>
          </div>
          <div class="stack-sm">
            <strong style="font-size:0.875rem;">Legal &amp; Security</strong>
            <button type="button" class="saas-footer-link" data-go="#/privacy">Privacy Policy</button>
            <button type="button" class="saas-footer-link" data-go="#/terms">Terms of Service</button>
          </div>
        </div>
        <div style="margin-top:2rem;padding-top:1.25rem;border-top:1px solid var(--border-hairline);display:flex;flex-wrap:wrap;justify-content:space-between;gap:0.75rem;font-size:0.8125rem;color:var(--text-muted);">
          <span>&copy; ${new Date().getFullYear()} SmartAttend Platform. All rights reserved.</span>
          <span>Multi-Tenant Firebase Architecture · PWA Ready</span>
        </div>
      </div>
    </footer>
  `;
}

function renderHomeSections() {
  const ex = HIERARCHY_EXAMPLES[previewTab] || HIERARCHY_EXAMPLES.college;

  return `
    <!-- Section 2: Hero -->
    <section class="saas-hero">
      <div class="saas-container">
        <div class="saas-hero-grid">
          <div class="stack-md">
            <p class="saas-eyebrow">Multi-Organization Attendance Infrastructure</p>
            <h1 class="saas-h1">Attendance Management, Simplified for Every Organization.</h1>
            <p class="saas-lead">
              Launch an isolated attendance workspace for your school, college, coaching center, office, or factory in under two minutes. Build custom designation hierarchies, issue scannable member QR IDs, track shifts, and export audit-ready reports.
            </p>
            <div class="page-actions" style="padding-top:0.5rem;">
              <button type="button" class="btn btn-primary" data-go="#/org-register">
                Get Started Free ${icon('arrowRight', 16)}
              </button>
              <button type="button" class="btn btn-secondary" data-go="#/features">Explore Features</button>
              <button type="button" class="btn btn-ghost" data-go="#/join">Join Existing Org</button>
            </div>
            <div class="meta-line" style="padding-top:0.25rem;">
              <span>Isolated org workspaces</span>
              <span aria-hidden="true">·</span>
              <span>Custom hierarchy &amp; permissions</span>
              <span aria-hidden="true">·</span>
              <span>CSV, Excel &amp; PDF exports</span>
            </div>
          </div>

          <!-- Realistic Product Preview Frame -->
          <div class="saas-preview-frame" aria-label="SmartAttend Workspace Preview">
            <div class="saas-preview-bar">
              <span>ORG-7K9P2 · Universal Workspace</span>
              <span>Live Policy Engine</span>
            </div>
            <div style="padding:1.125rem;" class="stack-md">
              <div style="display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:0.625rem;">
                <div style="padding:0.75rem;border:1px solid var(--border-hairline);border-radius:var(--radius-sm);">
                  <div style="font-size:0.75rem;color:var(--text-muted);">Working Policy</div>
                  <div class="mono" style="font-size:1.125rem;font-weight:700;">75% Min</div>
                </div>
                <div style="padding:0.75rem;border:1px solid var(--border-hairline);border-radius:var(--radius-sm);">
                  <div style="font-size:0.75rem;color:var(--text-muted);">Member QR ID</div>
                  <div class="mono" style="font-size:0.9rem;font-weight:700;">Opaque Token</div>
                </div>
                <div style="padding:0.75rem;border:1px solid var(--border-hairline);border-radius:var(--radius-sm);">
                  <div style="font-size:0.75rem;color:var(--text-muted);">Shift Mode</div>
                  <div class="mono" style="font-size:1.125rem;font-weight:700;">In / Out</div>
                </div>
              </div>
              <div class="stack-sm" style="padding:0.875rem;border:1px solid var(--border-hairline);border-radius:var(--radius-sm);background:var(--bg-subtle);">
                <div style="display:flex;justify-content:space-between;font-size:0.8125rem;">
                  <strong>Hierarchy Verification</strong>
                  <span class="mono" style="color:var(--accent-text);">Owner → Dept → Team</span>
                </div>
                <div style="font-size:0.8125rem;color:var(--text-secondary);">
                  Managers only view branches, departments, and subordinates explicitly granted in their designation permissions.
                </div>
              </div>
              <div style="display:flex;justify-content:space-between;align-items:center;font-size:0.8125rem;color:var(--text-muted);">
                <span>Holidays &amp; weekly offs excluded automatically</span>
                <span class="status-text status-success">${icon('shield', 14)} Tenant Isolated</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>

    <!-- Section 3: Problem vs Solution -->
    <section class="saas-section saas-section-alt">
      <div class="saas-container">
        <div class="saas-section-head">
          <h2 class="saas-h2">Built to replace rigid spreadsheets and single-purpose portals</h2>
          <p class="saas-sub">Most attendance tools force every organization into fixed "Teacher / Student" or "HR / Staff" boxes. SmartAttend adapts to your structure.</p>
        </div>
        <div class="saas-card-grid saas-card-grid-2">
          <div class="saas-card">
            <strong style="color:var(--danger);">Legacy Attendance Challenges</strong>
            <ul style="margin:0;padding-left:1.2rem;color:var(--text-secondary);font-size:0.9rem;display:flex;flex-direction:column;gap:0.45rem;">
              <li>Rigid hardcoded roles that break multi-branch hierarchies</li>
              <li>Duplicate paper registers or spoofable check-in links</li>
              <li>Holidays and approved leaves wrongly lowering percentages</li>
              <li>Mixed data across branches without immutable audit trails</li>
            </ul>
          </div>
          <div class="saas-card" style="border-color:var(--accent);">
            <strong style="color:var(--accent-text);">The SmartAttend Architecture</strong>
            <ul style="margin:0;padding-left:1.2rem;color:var(--text-secondary);font-size:0.9rem;display:flex;flex-direction:column;gap:0.45rem;">
              <li>Unlimited custom designations with fine-grained permissions</li>
              <li>Cryptographic Member QR IDs verified by authorized scanners</li>
              <li>Configurable shift grace, half-day, overtime, and leave rules</li>
              <li>Strict per-organization Firestore isolation with audit logs</li>
            </ul>
          </div>
        </div>
      </div>
    </section>

    <!-- Section 4: Universal Organization Support -->
    <section class="saas-section">
      <div class="saas-container">
        <div class="saas-section-head">
          <h2 class="saas-h2">One platform across education, corporate, and operations</h2>
          <p class="saas-sub">Choose your organization type on signup to pre-configure sensible labels—then customize everything anytime.</p>
        </div>
        <div class="saas-card-grid saas-card-grid-3">
          ${[
            { icon: 'book', title: 'Schools & Colleges', desc: 'Track classes, departments, roll numbers, threshold alerts, and parent/academic leave approvals.' },
            { icon: 'layers', title: 'Universities & Coaching', desc: 'Multi-campus branches, faculty coordinators, batch rosters, and CSV bulk enrollment.' },
            { icon: 'briefcase', title: 'Companies & Offices', desc: 'Employee ID badges, reporting managers, check-in/out working hours, and leave balances.' },
            { icon: 'globe', title: 'Startups & Hybrid Teams', desc: 'Flat or growing team trees with optional geofenced self check-in and rapid CSV/PDF reports.' },
            { icon: 'building', title: 'Factories & Plants', desc: 'Rotational shifts, late grace windows, overtime calculation, and floor supervisor QR scanning.' },
            { icon: 'users', title: 'Training Centers & NGOs', desc: 'Cohort tracking, trainee QR cards, invitation links, and full JSON/CSV compliance exports.' },
          ]
            .map(
              (item) => `
            <article class="saas-card">
              <div class="saas-icon-box">${icon(item.icon, 18)}</div>
              <h3 style="font-size:1.05rem;">${item.title}</h3>
              <p style="font-size:0.875rem;color:var(--text-secondary);">${item.desc}</p>
            </article>
          `
            )
            .join('')}
        </div>
      </div>
    </section>

    <!-- Section 5: Custom Hierarchy Showcase -->
    <section class="saas-section saas-section-alt">
      <div class="saas-container">
        <div class="saas-section-head">
          <h2 class="saas-h2">Unlimited Custom Organization Hierarchy</h2>
          <p class="saas-sub">Define levels, reporting managers, branch heads, and exact permission checkboxes without writing code.</p>
        </div>

        <div class="stack-md">
          <div class="segmented-bar" id="landing-hierarchy-tabs">
            ${Object.entries(HIERARCHY_EXAMPLES)
              .map(
                ([key, cfg]) => `<button type="button" class="segmented-btn ${previewTab === key ? 'active' : ''}" data-htab="${key}">${cfg.label}</button>`
              )
              .join('')}
          </div>

          <div class="saas-card-grid saas-card-grid-4" id="landing-hierarchy-cards">
            ${ex.nodes
              .map(
                (n) => `
              <div class="saas-card">
                <span class="saas-step-num">${n.level}</span>
                <strong style="font-size:1rem;">${n.title}</strong>
                <span style="font-size:0.8125rem;color:var(--text-secondary);">${n.scope}</span>
              </div>
            `
              )
              .join('')}
          </div>
        </div>
      </div>
    </section>

    <!-- Section 6: Core Features Grid -->
    <section class="saas-section">
      <div class="saas-container">
        <div class="saas-section-head">
          <h2 class="saas-h2">Everything required for serious attendance operations</h2>
          <p class="saas-sub">Real backend workflows powered by Firebase Authentication, Firestore transactions, Realtime Database, and Storage.</p>
        </div>
        <div class="saas-card-grid saas-card-grid-3">
          ${[
            { icon: 'qr', title: 'Member QR IDs & Scanner', desc: 'Every member receives an immutable ID (SA-ORG...) and downloadable revocable QR PNG. Heads scan via camera or ID.' },
            { icon: 'clock', title: 'Shifts, Grace & Overtime', desc: 'Configure multiple shifts, late arrival grace minutes, half-day thresholds, and automatic overtime minutes.' },
            { icon: 'calendar', title: 'Holidays & Weekly Offs', desc: 'Department-specific holidays and weekly offs are automatically excluded so working days stay accurate.' },
            { icon: 'upload', title: 'CSV Bulk Member Import', desc: 'Upload member rosters with automated email and Roll/Employee ID duplicate detection before saving.' },
            { icon: 'file', title: 'Leaves & Corrections', desc: 'Members submit leave requests with attachments or attendance corrections; managers approve with audit logs.' },
            { icon: 'download', title: 'PDF, Excel, CSV & JSON Backup', desc: 'Filter daily, weekly, monthly, or custom date ranges by branch, department, or member and export immediately.' },
          ]
            .map(
              (f) => `
            <article class="saas-card">
              <div class="saas-icon-box">${icon(f.icon, 18)}</div>
              <h3 style="font-size:1.05rem;">${f.title}</h3>
              <p style="font-size:0.875rem;color:var(--text-secondary);">${f.desc}</p>
            </article>
          `
            )
            .join('')}
        </div>
      </div>
    </section>

    <!-- Section 7: How It Works -->
    <section class="saas-section saas-section-alt">
      <div class="saas-container">
        <div class="saas-section-head">
          <h2 class="saas-h2">Up and running in four steps</h2>
        </div>
        <div class="saas-card-grid saas-card-grid-4">
          ${[
            { step: '01', title: 'Register Organization', desc: 'Create your organization workspace and receive your unique ORG ID.' },
            { step: '02', title: 'Design Hierarchy & Policies', desc: 'Set custom designations, shifts, branches, holidays, and threshold %.' },
            { step: '03', title: 'Onboard Members', desc: 'Add individually, send invite links, approve requests, or bulk import CSV.' },
            { step: '04', title: 'Scan & Analyze Live', desc: 'Mark QR/manual attendance, review anomalies, and export reports.' },
          ]
            .map(
              (s) => `
            <div class="saas-card">
              <span class="saas-step-num">STEP ${s.step}</span>
              <h3 style="font-size:1.05rem;">${s.title}</h3>
              <p style="font-size:0.875rem;color:var(--text-secondary);">${s.desc}</p>
            </div>
          `
            )
            .join('')}
        </div>
      </div>
    </section>

    <!-- Section 8: Security & Multi-Tenant Architecture -->
    <section class="saas-section">
      <div class="saas-container">
        <div class="saas-section-head">
          <h2 class="saas-h2">Security-first multi-tenant architecture</h2>
          <p class="saas-sub">Engineered so members cannot escalate roles, fake attendance offline, or view other organizations.</p>
        </div>
        <div class="saas-card-grid saas-card-grid-3">
          <div class="saas-card">
            <div class="saas-icon-box">${icon('shield', 18)}</div>
            <strong>Tenant-Isolated Rules</strong>
            <p style="font-size:0.875rem;color:var(--text-secondary);">All organization records live inside <code>organizations/{orgId}/...</code> guarded by verified membership lookups.</p>
          </div>
          <div class="saas-card">
            <div class="saas-icon-box">${icon('qr', 18)}</div>
            <strong>Zero-PII Revocable QR Tokens</strong>
            <p style="font-size:0.875rem;color:var(--text-secondary);">QR payloads hold only an opaque token ID and org reference. Owners or members can revoke and rotate tokens anytime.</p>
          </div>
          <div class="saas-card">
            <div class="saas-icon-box">${icon('alert', 18)}</div>
            <strong>Duplicate &amp; Anomaly Guards</strong>
            <p style="font-size:0.875rem;color:var(--text-secondary);">Deterministic record keys reject duplicate scans, detect cross-org QR scans, and record immutable audit logs.</p>
          </div>
        </div>
      </div>
    </section>

    <!-- Section 9: Pricing Tiers -->
    <section class="saas-section saas-section-alt">
      <div class="saas-container">
        <div class="saas-section-head">
          <h2 class="saas-h2">Transparent plans ready to scale with your organization</h2>
          <p class="saas-sub">Subscription-ready limits enforced directly inside your workspace architecture. Start free with full core features.</p>
        </div>
        <div class="saas-card-grid saas-card-grid-3">
          ${Object.values(SUBSCRIPTION_PLANS)
            .map(
              (p) => `
            <div class="pricing-card ${p.id === 'pro' ? 'featured' : ''}">
              <div>
                <div style="font-size:0.8125rem;font-weight:600;color:var(--accent-text);text-transform:uppercase;">${escapeHtml(p.name)}</div>
                <div class="pricing-price" style="margin-top:0.375rem;">${escapeHtml(p.priceMonthly)}<span style="font-size:0.875rem;font-weight:400;color:var(--text-muted);">${p.priceMonthly.startsWith('$') ? ' / month' : ''}</span></div>
              </div>
              <ul style="margin:0;padding-left:1.2rem;color:var(--text-secondary);font-size:0.875rem;display:flex;flex-direction:column;gap:0.4rem;flex:1;">
                ${p.features.map((ft) => `<li>${escapeHtml(ft)}</li>`).join('')}
              </ul>
              <button type="button" class="btn ${p.id === 'pro' ? 'btn-primary' : 'btn-secondary'}" data-go="${p.id === 'enterprise' ? '#/contact' : '#/org-register'}">
                ${p.id === 'enterprise' ? 'Contact Sales' : 'Start Free Workspace'}
              </button>
            </div>
          `
            )
            .join('')}
        </div>
      </div>
    </section>

    <!-- Section 10: FAQ -->
    <section class="saas-section">
      <div class="saas-container" style="max-width:860px;">
        <div class="saas-section-head">
          <h2 class="saas-h2">Frequently Asked Questions</h2>
        </div>
        <div class="stack-sm" id="landing-faq-list">
          ${FAQ_ITEMS.map(
            (item, i) => `
            <div class="faq-item ${i === 0 ? 'open' : ''}">
              <button type="button" class="faq-btn" aria-expanded="${i === 0 ? 'true' : 'false'}">
                <span>${escapeHtml(item.q)}</span>
                <span>${icon('plus', 16)}</span>
              </button>
              <div class="faq-body">${escapeHtml(item.a)}</div>
            </div>
          `
          ).join('')}
        </div>
      </div>
    </section>

    <!-- Section 11: Final CTA -->
    <section class="saas-section saas-section-alt">
      <div class="saas-container" style="text-align:center;max-width:720px;">
        <h2 class="saas-h2">Launch your organization's attendance workspace today</h2>
        <p class="saas-sub" style="margin-bottom:1.5rem;">Create an isolated multi-branch organization or sign in to an existing workspace.</p>
        <div style="display:flex;flex-wrap:wrap;justify-content:center;gap:0.75rem;">
          <button type="button" class="btn btn-primary" data-go="#/org-register">Create Organization Free</button>
          <button type="button" class="btn btn-secondary" data-go="#/login">Sign In to Workspace</button>
        </div>
      </div>
    </section>
  `;
}

function renderSubPage(page) {
  if (page === 'features') {
    return `
      <section class="saas-section">
        <div class="saas-container stack-lg">
          <div class="saas-section-head">
            <p class="saas-eyebrow">Platform Capabilities</p>
            <h1 class="saas-h1" style="font-size:clamp(1.85rem,3.5vw,2.75rem);">Complete Feature Matrix</h1>
            <p class="saas-lead">Designed from the ground up for multi-year organizational scale across education and enterprise teams.</p>
          </div>
          <div class="saas-card-grid saas-card-grid-3">
            ${[
              ['Multi-Organization Isolation', 'Every organization has an isolated workspace ID (ORG-XXXXX) and strict tenant-scoped Firestore paths.'],
              ['Dynamic Custom Hierarchy', 'Create unlimited designations, hierarchy levels, parent-child reporting lines, and explicit permissions.'],
              ['Member QR Badges & Scanner', 'Members carry downloadable opaque QR PNGs (SA-ORG...). Heads scan via webcam/mobile camera or enter IDs.'],
              ['Check-In / Check-Out & Overtime', 'Automatic late arrival classification via shift grace windows plus working hours and overtime tracking.'],
              ['Optional Geofencing', 'Require GPS radius verification when enabled by branch or organization policy, with explicit consent.'],
              ['Smart Holiday & Off Engine', 'Org-wide and department holidays plus weekly offs are never miscounted as absences.'],
              ['Leave Balances & Approvals', 'Track annual, sick, and casual leave balances; approved leaves automatically populate attendance records.'],
              ['CSV Bulk Member Import', 'Validate hundreds of members cleanly with intra-file and org-level duplicate ID/email detection.'],
              ['Audit Logs & Full Export', 'Immutable before/after audit records alongside PDF, Excel (.xlsx), CSV, and full JSON org backups.'],
            ]
              .map(
                ([title, desc]) => `
              <article class="saas-card">
                <h2 style="font-size:1.0625rem;">${title}</h2>
                <p style="font-size:0.875rem;color:var(--text-secondary);">${desc}</p>
              </article>
            `
              )
              .join('')}
          </div>
        </div>
      </section>
    `;
  }

  if (page === 'solutions' || page === 'how-it-works' || page === 'pricing') {
    return renderHomeSections();
  }

  if (page === 'contact') {
    return `
      <section class="saas-section">
        <div class="saas-container" style="max-width:680px;">
          <div class="stack-lg">
            <div>
              <p class="saas-eyebrow">Contact SmartAttend</p>
              <h1 class="saas-h1" style="font-size:clamp(1.75rem,3vw,2.45rem);">Talk with our team</h1>
              <p class="saas-sub">Questions about Enterprise onboarding, Cloud Functions deployment, or multi-campus migration? Send an inquiry below.</p>
            </div>
            <form id="saas-contact-form" class="panel stack-md">
              <div class="form-grid form-grid-2">
                <div class="field">
                  <label class="field-label" for="ct-name">Your Name</label>
                  <input class="input" id="ct-name" name="name" required placeholder="Priya Verma" maxlength="100" />
                </div>
                <div class="field">
                  <label class="field-label" for="ct-email">Work / Institutional Email</label>
                  <input class="input" id="ct-email" name="email" type="email" required placeholder="priya@organization.com" maxlength="160" />
                </div>
              </div>
              <div class="form-grid form-grid-2">
                <div class="field">
                  <label class="field-label" for="ct-org">Organization Name</label>
                  <input class="input" id="ct-org" name="orgName" required placeholder="Horizon Institute" maxlength="140" />
                </div>
                <div class="field">
                  <label class="field-label" for="ct-type">Organization Type</label>
                  <select class="select" id="ct-type" name="orgType">
                    <option value="college">College / University</option>
                    <option value="school">School</option>
                    <option value="company">Company / Office</option>
                    <option value="factory">Factory / Operations</option>
                    <option value="other">Other</option>
                  </select>
                </div>
              </div>
              <div class="field">
                <label class="field-label" for="ct-msg">How can we help?</label>
                <textarea class="textarea" id="ct-msg" name="message" required placeholder="Tell us about your team size, branches, or deployment requirements." maxlength="2000"></textarea>
              </div>
              <button type="submit" class="btn btn-primary" id="ct-submit">Send Inquiry</button>
            </form>
          </div>
        </div>
      </section>
    `;
  }

  if (page === 'privacy') {
    return `
      <section class="saas-section">
        <div class="saas-container stack-md" style="max-width:820px;">
          <h1 class="saas-h1" style="font-size:2rem;">Privacy Policy</h1>
          <p class="saas-sub">Effective Date: ${new Date().getFullYear()}</p>
          <div class="panel stack-md" style="color:var(--text-secondary);font-size:0.9375rem;">
            <p><strong>1. Organization Tenant Isolation:</strong> SmartAttend stores attendance, member, shift, and leave data inside strictly isolated organization workspaces (<code>organizations/{orgId}</code>). Only authenticated and verified members of that organization can access records permitted by their assigned designation.</p>
            <p><strong>2. QR Code Privacy:</strong> Member QR codes encode only an opaque revocable token ID and organization ID. Personal contact information, emails, and attendance history are never embedded inside QR payloads.</p>
            <p><strong>3. Optional Location Data:</strong> GPS coordinates are requested only when an organization explicitly enables Geofencing and triggers an attendance scan. Coordinates are used strictly to verify proximity to the configured branch radius.</p>
            <p><strong>4. Data Export &amp; Retention:</strong> Organization Owners may export full JSON/CSV/Excel/PDF archives of their organization data at any time.</p>
          </div>
        </div>
      </section>
    `;
  }

  return `
    <section class="saas-section">
      <div class="saas-container stack-md" style="max-width:820px;">
        <h1 class="saas-h1" style="font-size:2rem;">Terms of Service</h1>
        <p class="saas-sub">Effective Date: ${new Date().getFullYear()}</p>
        <div class="panel stack-md" style="color:var(--text-secondary);font-size:0.9375rem;">
          <p><strong>1. Workspace Administration:</strong> The individual creating an organization workspace acts as the initial Organization Owner and is responsible for configuring member permissions, attendance policies, and compliance with local labor or academic regulations.</p>
          <p><strong>2. Account Security:</strong> Users must verify their email address and maintain strong credentials. Passwords are managed exclusively through Firebase Authentication and are never stored in Firestore.</p>
          <p><strong>3. Acceptable Use:</strong> Attempting to tamper with QR tokens, bypass organization boundaries, or submit falsified attendance records is prohibited and logged in immutable audit trails.</p>
        </div>
      </div>
    </section>
  `;
}

export function renderLandingView(container, page = 'home') {
  container.innerHTML = `
    <div class="saas-page">
      ${renderSaasHeader(page)}
      <main id="main-content">
        ${page === 'home' ? renderHomeSections() : renderSubPage(page)}
      </main>
      ${renderSaasFooter()}
    </div>
  `;

  container.querySelectorAll('[data-go]').forEach((el) => {
    el.addEventListener('click', () => {
      go(el.getAttribute('data-go'));
    });
  });

  container.querySelector('#saas-theme-btn')?.addEventListener('click', () => {
    toggleTheme();
    renderLandingView(container, page);
  });

  container.querySelector('#saas-install-btn')?.addEventListener('click', () => {
    triggerPwaInstall();
  });

  container.querySelector('#saas-mobile-btn')?.addEventListener('click', () => {
    const menu = container.querySelector('#saas-mobile-menu');
    if (menu) menu.style.display = menu.style.display === 'none' ? 'flex' : 'none';
  });

  container.querySelectorAll('[data-htab]').forEach((btn) => {
    btn.addEventListener('click', () => {
      previewTab = btn.getAttribute('data-htab');
      const ex = HIERARCHY_EXAMPLES[previewTab] || HIERARCHY_EXAMPLES.college;
      container.querySelectorAll('[data-htab]').forEach((b) => b.classList.toggle('active', b === btn));
      const cardsEl = container.querySelector('#landing-hierarchy-cards');
      if (cardsEl) {
        cardsEl.innerHTML = ex.nodes
          .map(
            (n) => `
          <div class="saas-card">
            <span class="saas-step-num">${n.level}</span>
            <strong style="font-size:1rem;">${n.title}</strong>
            <span style="font-size:0.8125rem;color:var(--text-secondary);">${n.scope}</span>
          </div>
        `
          )
          .join('');
      }
    });
  });

  container.querySelectorAll('.faq-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const parent = btn.closest('.faq-item');
      const open = parent.classList.toggle('open');
      btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
  });

  const contactForm = container.querySelector('#saas-contact-form');
  if (contactForm) {
    contactForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = container.querySelector('#ct-submit');
      btn.disabled = true;
      btn.textContent = 'Sending...';
      try {
        const fd = new FormData(contactForm);
        await createPublicContactInquiry({
          name: fd.get('name'),
          email: fd.get('email'),
          orgName: fd.get('orgName'),
          orgType: fd.get('orgType'),
          message: fd.get('message'),
        });
        contactForm.reset();
        showToast('Inquiry submitted! Our team will respond via email.', 'success');
      } catch (err) {
        showToast(err.message || 'Could not submit inquiry right now.', 'danger');
      } finally {
        btn.disabled = false;
        btn.textContent = 'Send Inquiry';
      }
    });
  }
}
