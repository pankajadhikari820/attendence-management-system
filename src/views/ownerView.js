import { Chart, registerables } from 'chart.js';
import {
  fetchOrgCollection,
  createOrgDoc,
  deleteOrgDoc,
  logOrgAudit,
} from '../services/firestoreService.js';
import {
  ORG_TYPES,
  SUBSCRIPTION_PLANS,
  getOrgTypeMeta,
  updateOrganizationPolicies,
  createOrgInvitation,
  reviewPendingMember,
  exportFullOrganizationData,
} from '../services/orgService.js';
import {
  createDesignation,
  updateDesignation,
  createBranch,
  createDepartment,
  provisionOrgMember,
  updateOrgMemberHierarchy,
  buildOrgHierarchyTree,
  parseBulkMembersCsv,
} from '../services/hierarchyService.js';
import {
  reviewOrgLeaveRequest,
  reviewOrgCorrectionRequest,
} from '../services/attendanceService.js';
import { uploadAttachment } from '../services/storageService.js';
import {
  exportAttendancePdf,
  exportAttendanceExcel,
  exportAttendanceCsv,
  downloadJsonBackup,
} from '../services/reportService.js';
import {
  calculateAttendanceSummary,
  escapeHtml,
  formatDateTime,
  paginateItems,
  todayIsoDate,
} from '../utils/attendanceMath.js';
import { DEFAULT_PERMISSIONS_MEMBER } from '../utils/authRouting.js';
import { icon } from '../utils/icons.js';
import {
  showToast,
  showConfirm,
  openModal,
  closeModal,
  renderEmptyState,
  renderTableSkeleton,
} from '../utils/ui.js';
import { getState, setState } from '../state/store.js';
import { renderScannerWorkspace, renderManualBatchWorkspace, cleanupScannerStreams } from './scanAttendanceView.js';
import { renderMemberView } from './memberView.js';
import { renderProfileView, renderNotificationsView } from './sharedViews.js';

Chart.register(...registerables);

let activeCharts = [];
export function cleanupOwnerListeners() {
  cleanupScannerStreams();
  activeCharts.forEach((c) => c.destroy());
  activeCharts = [];
}

export async function renderOwnerView(container, viewKey) {
  cleanupOwnerListeners();
  switch (viewKey) {
    case 'overview':
      return renderOwnerOverview(container);
    case 'org-settings':
      return renderOwnerOrgSettings(container);
    case 'hierarchy':
      return renderOwnerHierarchy(container);
    case 'branches-depts':
      return renderOwnerBranchesAndDepts(container);
    case 'shifts-holidays':
      return renderOwnerShiftsAndHolidays(container);
    case 'members':
      return renderOwnerMembers(container);
    case 'scanner':
      return renderScannerWorkspace(container);
    case 'manual':
      return renderManualBatchWorkspace(container);
    case 'requests':
      return renderOwnerRequests(container);
    case 'reports':
      return renderOwnerReports(container);
    case 'auditLogs':
      return renderOwnerAuditAndAnomalies(container);
    case 'my-qr':
      return renderMemberView(container, 'my-qr');
    case 'notifications':
      return renderNotificationsView(container);
    case 'profile':
      return renderProfileView(container);
    default:
      return renderOwnerOverview(container);
  }
}

async function renderOwnerOverview(container) {
  const { activeOrgId, activeOrg, settings } = getState();
  const threshold = Number(settings?.thresholdPct || 75);
  const typeMeta = getOrgTypeMeta(activeOrg?.type);

  container.innerHTML = `
    <div class="stack-lg">
      <div class="page-header">
        <div>
          <h1 class="page-title">${escapeHtml(activeOrg?.name || 'Organization Overview')}</h1>
          <p class="page-subtitle">
            <span class="mono">${escapeHtml(activeOrgId)}</span> · ${escapeHtml(typeMeta.label)} · Plan: <strong style="text-transform:capitalize;">${escapeHtml(activeOrg?.plan || 'free')}</strong> · Threshold ${threshold}%
          </p>
        </div>
        <div class="page-actions">
          <button type="button" class="btn btn-secondary" id="own-go-members">${icon('users', 16)} Manage ${escapeHtml(typeMeta.memberLabel)}s</button>
          <button type="button" class="btn btn-primary" id="own-go-scan">${icon('qr', 16)} Open QR Scanner</button>
        </div>
      </div>
      <div id="own-overview-body">${renderTableSkeleton(4, 4)}</div>
    </div>
  `;

  container.querySelector('#own-go-members').addEventListener('click', () => {
    window.dispatchEvent(new CustomEvent('smartattend:navigate', { detail: 'members' }));
  });
  container.querySelector('#own-go-scan').addEventListener('click', () => {
    window.dispatchEvent(new CustomEvent('smartattend:navigate', { detail: 'scanner' }));
  });

  const body = container.querySelector('#own-overview-body');
  try {
    const [members, branches, depts, records, leaves, corrections, anomalies, audits] = await Promise.all([
      fetchOrgCollection(activeOrgId, 'members'),
      fetchOrgCollection(activeOrgId, 'branches'),
      fetchOrgCollection(activeOrgId, 'departments'),
      fetchOrgCollection(activeOrgId, 'attendanceRecords'),
      fetchOrgCollection(activeOrgId, 'leaveRequests'),
      fetchOrgCollection(activeOrgId, 'correctionRequests'),
      fetchOrgCollection(activeOrgId, 'anomalies'),
      fetchOrgCollection(activeOrgId, 'auditLogs'),
    ]);

    const activeMembers = members.filter((m) => m.status === 'active');
    const pendingJoin = members.filter((m) => m.status === 'pending').length;
    const summary = calculateAttendanceSummary(records, settings);
    const today = todayIsoDate();
    const todayPresent = records.filter(
      (r) => r.date === today && ['present', 'late'].includes(r.status)
    ).length;

    const pendingLeaves = leaves.filter((l) => l.status === 'pending').length;
    const pendingCorr = corrections.filter((c) => c.status === 'pending').length;
    const openAnomalies = anomalies.filter((a) => !a.resolved).length;

    const byMember = new Map();
    for (const r of records) {
      const arr = byMember.get(r.memberUid) || [];
      arr.push(r);
      byMember.set(r.memberUid, arr);
    }
    const lowWatchlist = [];
    for (const m of activeMembers) {
      const recs = byMember.get(m.uid) || [];
      if (!recs.length) continue;
      const sum = calculateAttendanceSummary(recs, settings);
      if (sum.workingDaysRecorded > 0 && sum.percentage < threshold) {
        lowWatchlist.push({ member: m, sum });
      }
    }

    body.innerHTML = `
      <div class="stack-lg">
        <div class="grid-kpi">
          <div class="kpi-card">
            <span class="kpi-label">Active ${escapeHtml(typeMeta.memberLabel)}s</span>
            <span class="kpi-value">${activeMembers.length}</span>
            <span class="kpi-foot">${branches.length} branch(es) · ${depts.length} dept(s)${pendingJoin ? ` · ${pendingJoin} pending` : ''}</span>
          </div>
          <div class="kpi-card">
            <span class="kpi-label">Present Today</span>
            <span class="kpi-value">${todayPresent}</span>
            <span class="kpi-foot">Overall org rate: ${records.length ? summary.percentage + '%' : '—'}</span>
          </div>
          <div class="kpi-card">
            <span class="kpi-label">Pending Approvals</span>
            <span class="kpi-value">${pendingLeaves + pendingCorr + pendingJoin}</span>
            <span class="kpi-foot">${pendingLeaves} leaves · ${pendingCorr} corrections</span>
          </div>
          <div class="kpi-card">
            <span class="kpi-label">Watchlist &amp; Anomalies</span>
            <span class="kpi-value ${lowWatchlist.length + openAnomalies > 0 ? 'status-danger' : ''}">${lowWatchlist.length}</span>
            <span class="kpi-foot">${lowWatchlist.length} below ${threshold}% · ${openAnomalies} scan anomalies</span>
          </div>
        </div>

        <div class="grid-2">
          <section class="panel stack-md">
            <div class="panel-header">
              <h2 class="panel-title">Attendance Trend by Date</h2>
              <span class="panel-meta">Percentage across recent dates</span>
            </div>
            <div class="chart-box"><canvas id="chart-own-trend"></canvas></div>
          </section>

          <section class="panel stack-md">
            <div class="panel-header">
              <h2 class="panel-title">Department Attendance %</h2>
              <span class="panel-meta">Comparison across departments</span>
            </div>
            <div class="chart-box"><canvas id="chart-own-depts"></canvas></div>
          </section>
        </div>

        <div class="grid-2">
          <section class="panel stack-md">
            <div class="panel-header">
              <h2 class="panel-title">Low Attendance Watchlist (&lt; ${threshold}%)</h2>
              <span class="panel-meta">${lowWatchlist.length} flagged</span>
            </div>
            ${
              lowWatchlist.length === 0
                ? renderEmptyState({
                    title: 'All members meet threshold',
                    description: 'Members falling below the organization attendance policy appear here.',
                  })
                : `<div class="table-wrap"><table class="data-table">
                    <thead><tr><th>Member</th><th>ID</th><th class="num">Worked</th><th class="num">Pct</th></tr></thead>
                    <tbody>
                      ${lowWatchlist
                        .slice(0, 8)
                        .map(
                          (row) => `
                        <tr>
                          <td><strong>${escapeHtml(row.member.name)}</strong></td>
                          <td class="mono">${escapeHtml(row.member.memberPublicId)}</td>
                          <td class="num">${row.sum.effectiveAttended}/${row.sum.workingDaysRecorded}</td>
                          <td class="num status-danger"><strong>${row.sum.percentage}%</strong></td>
                        </tr>
                      `
                        )
                        .join('')}
                    </tbody>
                  </table></div>`
            }
          </section>

          <section class="panel stack-md">
            <div class="panel-header">
              <h2 class="panel-title">Recent Audit Events</h2>
              <span class="panel-meta">Immutable activity trail</span>
            </div>
            ${
              audits.length === 0
                ? renderEmptyState({ title: 'No audit events', description: 'Organization actions are recorded here.' })
                : `<div class="table-wrap"><table class="data-table">
                    <thead><tr><th>Action</th><th>Actor</th><th>Time</th></tr></thead>
                    <tbody>
                      ${[...audits]
                        .sort((a, b) => (b.timestamp?.toMillis?.() || 0) - (a.timestamp?.toMillis?.() || 0))
                        .slice(0, 6)
                        .map(
                          (a) => `
                        <tr>
                          <td><strong>${escapeHtml(a.action)}</strong><br><span style="font-size:0.75rem;color:var(--text-muted);">${escapeHtml(a.details || '')}</span></td>
                          <td>${escapeHtml(a.actorName || a.actorEmail)}</td>
                          <td class="mono" style="font-size:0.75rem;">${escapeHtml(formatDateTime(a.timestamp))}</td>
                        </tr>
                      `
                        )
                        .join('')}
                    </tbody>
                  </table></div>`
            }
          </section>
        </div>
      </div>
    `;

    // Build Trend Chart
    const byDate = new Map();
    for (const r of records) {
      if (!r.date) continue;
      const arr = byDate.get(r.date) || [];
      arr.push(r);
      byDate.set(r.date, arr);
    }
    const dates = [...byDate.keys()].sort().slice(-10);
    const trendPct = dates.map((d) => calculateAttendanceSummary(byDate.get(d), settings).percentage);

    const trendCtx = body.querySelector('#chart-own-trend');
    if (trendCtx) {
      activeCharts.push(
        new Chart(trendCtx, {
          type: 'line',
          data: {
            labels: dates.length ? dates : ['No Data'],
            datasets: [
              {
                label: 'Attendance %',
                data: trendPct.length ? trendPct : [0],
                borderColor: '#1d4ed8',
                backgroundColor: 'rgba(29, 78, 216, 0.12)',
                fill: true,
                tension: 0.3,
              },
            ],
          },
          options: { responsive: true, maintainAspectRatio: false, scales: { y: { min: 0, max: 100 } } },
        })
      );
    }

    // Build Department Chart
    const deptLabels = [];
    const deptVals = [];
    for (const d of depts.slice(0, 8)) {
      const dRecs = records.filter((r) => r.departmentId === d.id);
      if (dRecs.length > 0) {
        deptLabels.push(d.code || d.name);
        deptVals.push(calculateAttendanceSummary(dRecs, settings).percentage);
      }
    }
    const deptCtx = body.querySelector('#chart-own-depts');
    if (deptCtx) {
      activeCharts.push(
        new Chart(deptCtx, {
          type: 'bar',
          data: {
            labels: deptLabels.length ? deptLabels : ['No Records'],
            datasets: [{ label: 'Attendance %', data: deptVals.length ? deptVals : [0], backgroundColor: '#16a34a', borderRadius: 6 }],
          },
          options: { responsive: true, maintainAspectRatio: false, scales: { y: { min: 0, max: 100 } } },
        })
      );
    }
  } catch (err) {
    body.innerHTML = `<div class="notice notice-danger">${escapeHtml(err.message)}</div>`;
  }
}

async function renderOwnerOrgSettings(container) {
  const { activeOrgId, activeOrg, settings } = getState();
  const pol = activeOrg?.policies || settings || {};
  const geo = pol.geofence || { enabled: false, lat: 0, lng: 0, radiusMeters: 150 };
  const weeklyOffDays = Array.isArray(pol.weeklyOffDays) ? pol.weeklyOffDays : [0];

  const dayOptions = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

  container.innerHTML = `
    <div class="stack-lg">
      <div class="page-header">
        <div>
          <h1 class="page-title">Organization Profile, Policies &amp; Plan</h1>
          <p class="page-subtitle">Workspace ID: <span class="mono">${escapeHtml(activeOrgId)}</span> · Configure attendance rules, geofencing, security, and subscription tier.</p>
        </div>
      </div>

      <div class="grid-2">
        <section class="panel stack-md">
          <h2 class="panel-title">Organization Profile</h2>
          <form id="org-profile-form" class="stack-md">
            <div class="form-grid form-grid-2">
              <div class="field">
                <label class="field-label" for="os-name">Organization Name</label>
                <input class="input" id="os-name" name="name" required value="${escapeHtml(activeOrg?.name || '')}" />
              </div>
              <div class="field">
                <label class="field-label" for="os-type">Organization Type</label>
                <select class="select" id="os-type" name="type">
                  ${ORG_TYPES.map((t) => `<option value="${t.id}" ${activeOrg?.type === t.id ? 'selected' : ''}>${escapeHtml(t.label)}</option>`).join('')}
                </select>
              </div>
            </div>
            <div class="form-grid form-grid-2">
              <div class="field">
                <label class="field-label" for="os-phone">Phone</label>
                <input class="input" id="os-phone" name="phone" value="${escapeHtml(activeOrg?.phone || '')}" />
              </div>
              <div class="field">
                <label class="field-label" for="os-country">Country</label>
                <input class="input" id="os-country" name="country" value="${escapeHtml(activeOrg?.country || '')}" />
              </div>
            </div>
            <div class="form-grid form-grid-2">
              <div class="field">
                <label class="field-label" for="os-tz">Timezone</label>
                <input class="input mono" id="os-tz" name="timezone" value="${escapeHtml(activeOrg?.timezone || 'UTC')}" />
              </div>
              <div class="field">
                <label class="field-label" for="os-logo">Organization Logo (JPG/PNG/WebP)</label>
                <input class="input" id="os-logo" name="logo" type="file" accept="image/*" />
              </div>
            </div>
            <div class="field">
              <label class="field-label" for="os-addr">Address</label>
              <input class="input" id="os-addr" name="address" value="${escapeHtml(activeOrg?.address || '')}" />
            </div>
            <div class="field">
              <label class="field-label" for="os-desc">Description</label>
              <textarea class="textarea" id="os-desc" name="description">${escapeHtml(activeOrg?.description || '')}</textarea>
            </div>
            <button type="submit" class="btn btn-primary" id="os-prof-save">Save Organization Profile</button>
          </form>
        </section>

        <section class="panel stack-md">
          <h2 class="panel-title">Attendance Calculation &amp; Check-In Policies</h2>
          <form id="org-policy-form" class="stack-md">
            <div class="form-grid form-grid-3">
              <div class="field">
                <label class="field-label" for="pol-thresh">Min Threshold %</label>
                <input class="input mono" id="pol-thresh" name="thresholdPct" type="number" min="1" max="99" value="${pol.thresholdPct ?? 75}" />
              </div>
              <div class="field">
                <label class="field-label" for="pol-grace">Late Grace (min)</label>
                <input class="input mono" id="pol-grace" name="lateGraceMinutes" type="number" min="0" max="180" value="${pol.lateGraceMinutes ?? 15}" />
              </div>
              <div class="field">
                <label class="field-label" for="pol-half">Half-Day Min (min)</label>
                <input class="input mono" id="pol-half" name="halfDayThresholdMinutes" type="number" min="30" max="600" value="${pol.halfDayThresholdMinutes ?? 240}" />
              </div>
            </div>

            <div class="form-grid form-grid-2">
              <div class="field">
                <label class="field-label" for="pol-leave">Approved Leave Calculation</label>
                <select class="select" id="pol-leave" name="approvedLeavePolicy">
                  <option value="neutral" ${pol.approvedLeavePolicy === 'neutral' ? 'selected' : ''}>Neutral (Exclude from working days)</option>
                  <option value="present" ${pol.approvedLeavePolicy === 'present' ? 'selected' : ''}>Count as Present</option>
                  <option value="absent" ${pol.approvedLeavePolicy === 'absent' ? 'selected' : ''}>Count against attendance %</option>
                </select>
              </div>
              <div class="field">
                <label class="field-label" for="pol-halfw">Half-Day Weight</label>
                <select class="select" id="pol-halfw" name="halfDayWeight">
                  <option value="0.5" ${Number(pol.halfDayWeight ?? 0.5) === 0.5 ? 'selected' : ''}>0.5 Day Credit</option>
                  <option value="0" ${Number(pol.halfDayWeight) === 0 ? 'selected' : ''}>0 Day Credit</option>
                  <option value="1" ${Number(pol.halfDayWeight) === 1 ? 'selected' : ''}>1.0 Day Credit</option>
                </select>
              </div>
            </div>

            <div class="field">
              <span class="field-label">Weekly Off Days (Never counted as absences)</span>
              <div style="display:flex;flex-wrap:wrap;gap:0.5rem;">
                ${dayOptions
                  .map(
                    (dName, idx) => `
                  <label class="perm-check" style="padding:0.35rem 0.6rem;">
                    <input type="checkbox" name="weeklyOff" value="${idx}" ${weeklyOffDays.includes(idx) ? 'checked' : ''} />
                    <span>${dName.slice(0, 3)}</span>
                  </label>`
                  )
                  .join('')}
              </div>
            </div>

            <div class="stack-sm">
              <label class="perm-check">
                <input type="checkbox" name="lateCountsAsPresent" ${pol.lateCountsAsPresent !== false ? 'checked' : ''} />
                <span>Count Late arrivals toward present attendance %</span>
              </label>
              <label class="perm-check">
                <input type="checkbox" name="allowSelfCheckIn" ${pol.allowSelfCheckIn ? 'checked' : ''} />
                <span>Allow members to Self Check-In from their dashboard</span>
              </label>
              <label class="perm-check">
                <input type="checkbox" name="requireJoinApproval" ${pol.requireJoinApproval !== false ? 'checked' : ''} />
                <span>Require owner/admin approval for Org ID join requests</span>
              </label>
              <label class="perm-check">
                <input type="checkbox" name="useCloudFunctions" ${pol.useCloudFunctions ? 'checked' : ''} />
                <span>Use deployed Firebase Cloud Functions (Blaze plan)</span>
              </label>
            </div>

            <div class="panel" style="background:var(--bg-subtle);padding:0.875rem;" class="stack-sm">
              <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:0.5rem;">
                <strong style="font-size:0.875rem;">Optional Geofencing Verification</strong>
                <button type="button" class="btn btn-secondary btn-sm" id="geo-capture-btn">${icon('mapPin', 14)} Use Current Location</button>
              </div>
              <label class="perm-check" style="margin-bottom:0.5rem;">
                <input type="checkbox" name="geoEnabled" id="geo-enabled" ${geo.enabled ? 'checked' : ''} />
                <span>Require GPS proximity verification on attendance scans</span>
              </label>
              <div class="form-grid form-grid-3">
                <div class="field"><label class="field-label">Latitude</label><input class="input mono" id="geo-lat" name="geoLat" type="number" step="any" value="${geo.lat ?? 0}" /></div>
                <div class="field"><label class="field-label">Longitude</label><input class="input mono" id="geo-lng" name="geoLng" type="number" step="any" value="${geo.lng ?? 0}" /></div>
                <div class="field"><label class="field-label">Radius (meters)</label><input class="input mono" id="geo-rad" name="geoRad" type="number" min="25" max="10000" value="${geo.radiusMeters ?? 150}" /></div>
              </div>
            </div>

            <button type="submit" class="btn btn-primary" id="os-pol-save">Save Policies</button>
          </form>
        </section>
      </div>

      <div class="grid-2">
        <section class="panel stack-md">
          <h2 class="panel-title">Subscription Plan &amp; Workspace Limits</h2>
          <p class="panel-meta">Architecture enforces member and branch limits per tier. Select active tier metadata below.</p>
          <div class="saas-card-grid saas-card-grid-3">
            ${Object.values(SUBSCRIPTION_PLANS)
              .map(
                (p) => `
              <div class="saas-card" style="${activeOrg?.plan === p.id ? 'border-color:var(--accent);' : ''}">
                <strong>${escapeHtml(p.name)} (${escapeHtml(p.priceMonthly)})</strong>
                <span style="font-size:0.8125rem;color:var(--text-muted);">Up to ${p.maxMembers.toLocaleString()} members · ${p.maxBranches} branches</span>
                <button type="button" class="btn ${activeOrg?.plan === p.id ? 'btn-primary' : 'btn-secondary'} btn-sm" data-set-plan="${p.id}" ${activeOrg?.plan === p.id ? 'disabled' : ''}>
                  ${activeOrg?.plan === p.id ? 'Current Plan' : 'Activate Tier'}
                </button>
              </div>
            `
              )
              .join('')}
          </div>
        </section>
      </div>
    </div>
  `;

  container.querySelector('#geo-capture-btn').addEventListener('click', () => {
    if (!navigator.geolocation) {
      showToast('Browser geolocation unavailable.', 'warning');
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        container.querySelector('#geo-lat').value = pos.coords.latitude.toFixed(6);
        container.querySelector('#geo-lng').value = pos.coords.longitude.toFixed(6);
        showToast('Coordinates captured.', 'success');
      },
      (err) => showToast(`Location failed: ${err.message}`, 'danger'),
      { enableHighAccuracy: true }
    );
  });

  container.querySelector('#org-profile-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = container.querySelector('#os-prof-save');
    btn.disabled = true;
    try {
      const fd = new FormData(e.target);
      let logoUrl = activeOrg?.logoUrl || '';
      const logoFile = fd.get('logo');
      if (logoFile && logoFile.size > 0) {
        const up = await uploadAttachment(`orgs/${activeOrgId}/logos`, activeOrgId, logoFile);
        logoUrl = up.downloadUrl;
      }
      const patch = {
        name: String(fd.get('name')).trim(),
        type: String(fd.get('type')),
        phone: String(fd.get('phone') || '').trim(),
        country: String(fd.get('country') || '').trim(),
        timezone: String(fd.get('timezone') || 'UTC').trim(),
        address: String(fd.get('address') || '').trim(),
        description: String(fd.get('description') || '').trim(),
        logoUrl,
      };
      await updateOrganizationPolicies(activeOrgId, patch, { name: activeOrg?.name, type: activeOrg?.type });
      setState({ activeOrg: { ...activeOrg, ...patch } });
      showToast('Organization profile saved.', 'success');
    } catch (err) {
      showToast(err.message || 'Save failed.', 'danger');
    } finally {
      btn.disabled = false;
    }
  });

  container.querySelector('#org-policy-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = container.querySelector('#os-pol-save');
    btn.disabled = true;
    try {
      const fd = new FormData(e.target);
      const weeklyOff = fd.getAll('weeklyOff').map((v) => Number(v));
      const newPolicies = {
        ...pol,
        thresholdPct: Math.min(99, Math.max(1, Number(fd.get('thresholdPct')) || 75)),
        lateGraceMinutes: Math.max(0, Number(fd.get('lateGraceMinutes')) || 0),
        halfDayThresholdMinutes: Math.max(30, Number(fd.get('halfDayThresholdMinutes')) || 240),
        approvedLeavePolicy: String(fd.get('approvedLeavePolicy') || 'neutral'),
        halfDayWeight: Number(fd.get('halfDayWeight') ?? 0.5),
        weeklyOffDays: weeklyOff,
        lateCountsAsPresent: fd.get('lateCountsAsPresent') === 'on',
        allowSelfCheckIn: fd.get('allowSelfCheckIn') === 'on',
        requireJoinApproval: fd.get('requireJoinApproval') === 'on',
        useCloudFunctions: fd.get('useCloudFunctions') === 'on',
        geofence: {
          enabled: fd.get('geoEnabled') === 'on',
          lat: Number(fd.get('geoLat')) || 0,
          lng: Number(fd.get('geoLng')) || 0,
          radiusMeters: Math.max(25, Number(fd.get('geoRad')) || 150),
        },
      };
      await updateOrganizationPolicies(activeOrgId, { policies: newPolicies }, pol);
      setState({
        activeOrg: { ...activeOrg, policies: newPolicies },
        settings: newPolicies,
      });
      showToast('Attendance policies updated.', 'success');
    } catch (err) {
      showToast(err.message || 'Policy update failed.', 'danger');
    } finally {
      btn.disabled = false;
    }
  });

  container.querySelectorAll('[data-set-plan]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const planId = btn.getAttribute('data-set-plan');
      const plan = SUBSCRIPTION_PLANS[planId];
      if (!plan) return;
      btn.disabled = true;
      try {
        const patch = {
          plan: plan.id,
          memberLimit: plan.maxMembers,
          branchLimit: plan.maxBranches,
        };
        await updateOrganizationPolicies(activeOrgId, patch, { plan: activeOrg?.plan });
        setState({ activeOrg: { ...activeOrg, ...patch } });
        showToast(`Subscription tier set to ${plan.name}.`, 'success');
        renderOwnerOrgSettings(container);
      } catch (err) {
        showToast(err.message || 'Unable to update subscription plan.', 'danger');
        btn.disabled = false;
      }
    });
  });
}

const PERMISSION_LABELS = [
  ['canTakeAttendance', 'Scan QR / Mark Attendance'],
  ['canEditAttendance', 'Edit Past Attendance'],
  ['canApproveLeaves', 'Approve / Reject Leaves'],
  ['canApproveCorrections', 'Approve Corrections'],
  ['canManageMembers', 'Add / Edit Members'],
  ['canManageDepartments', 'Manage Departments'],
  ['canManageBranches', 'Manage Branches'],
  ['canManageShifts', 'Manage Shifts'],
  ['canManageHolidays', 'Manage Holidays'],
  ['canViewReports', 'View Reports & Analytics'],
  ['canExportData', 'Export CSV / Excel / PDF'],
  ['canViewAuditLogs', 'View Audit Logs'],
  ['canManageHierarchy', 'Manage Designations'],
  ['canManageOrg', 'Full Org Admin (Co-Owner)'],
];

async function renderOwnerHierarchy(container) {
  const { activeOrgId } = getState();
  container.innerHTML = `
    <div class="stack-lg">
      <div class="page-header">
        <div>
          <h1 class="page-title">Custom Hierarchy &amp; Organization Tree</h1>
          <p class="page-subtitle">Define unlimited designation levels, explicit permission flags, and parent-child reporting lines.</p>
        </div>
        <div class="page-actions">
          <button type="button" class="btn btn-primary" id="hier-add-des-btn">${icon('plus', 16)} New Designation</button>
        </div>
      </div>
      <div id="hier-body">${renderTableSkeleton(4, 4)}</div>
    </div>
  `;

  async function load() {
    const body = container.querySelector('#hier-body');
    const [designations, members, depts] = await Promise.all([
      fetchOrgCollection(activeOrgId, 'designations'),
      fetchOrgCollection(activeOrgId, 'members'),
      fetchOrgCollection(activeOrgId, 'departments'),
    ]);
    designations.sort((a, b) => (a.level || 99) - (b.level || 99));
    const deptMap = new Map(depts.map((d) => [d.id, d.name]));
    const activeMembers = members.filter((m) => m.status === 'active');
    const treeRoots = buildOrgHierarchyTree(activeMembers);

    function renderTreeNodes(nodes) {
      if (!nodes.length) return '';
      return nodes
        .map(
          (n) => `
        <div>
          <div class="org-tree-node">
            <div>
              <strong>${escapeHtml(n.name)}</strong>
              <div class="meta-line">
                <span>${escapeHtml(n.designationName || 'Member')}</span>
                <span aria-hidden="true">·</span>
                <span class="mono">${escapeHtml(n.memberPublicId)}</span>
                <span aria-hidden="true">·</span>
                <span>${escapeHtml(deptMap.get(n.departmentId) || 'General')}</span>
              </div>
            </div>
            <button type="button" class="btn btn-secondary btn-sm" data-tree-edit="${escapeHtml(n.uid)}">Set Manager / Role</button>
          </div>
          ${n.children?.length ? `<div class="org-tree-children">${renderTreeNodes(n.children)}</div>` : ''}
        </div>
      `
        )
        .join('');
    }

    body.innerHTML = `
      <div class="stack-lg">
        <section class="panel stack-md">
          <div class="panel-header">
            <h2 class="panel-title">Designations &amp; Capability Permissions</h2>
            <span class="panel-meta">${designations.length} level(s) configured</span>
          </div>
          <div class="table-wrap">
            <table class="data-table">
              <thead><tr><th>Level</th><th>Designation</th><th>Scope</th><th>Enabled Permissions</th><th>Actions</th></tr></thead>
              <tbody>
                ${designations
                  .map((d) => {
                    const enabledCount = Object.entries(d.permissions || {}).filter(
                      ([k, v]) => k.startsWith('can') && v === true
                    ).length;
                    return `
                      <tr>
                        <td class="mono">L${d.level || 1}</td>
                        <td><strong>${escapeHtml(d.name)}</strong></td>
                        <td style="text-transform:capitalize;">${escapeHtml(d.permissions?.scope || 'self')}</td>
                        <td class="mono">${enabledCount} permissions</td>
                        <td>
                          <div style="display:flex;gap:0.375rem;">
                            <button type="button" class="btn btn-secondary btn-sm" data-edit-des="${escapeHtml(d.id)}">Edit Permissions</button>
                            ${
                              !d.isSystemOwner
                                ? `<button type="button" class="btn btn-ghost btn-sm" data-del-des="${escapeHtml(d.id)}">${icon('trash', 14)}</button>`
                                : ''
                            }
                          </div>
                        </td>
                      </tr>
                    `;
                  })
                  .join('')}
              </tbody>
            </table>
          </div>
        </section>

        <section class="panel stack-md">
          <div class="panel-header">
            <h2 class="panel-title">Interactive Organization Hierarchy Tree</h2>
            <span class="panel-meta">${activeMembers.length} active nodes</span>
          </div>
          ${
            treeRoots.length === 0
              ? renderEmptyState({ title: 'No members in hierarchy', description: 'Add members to populate the visual organization tree.' })
              : `<div class="org-tree">${renderTreeNodes(treeRoots)}</div>`
          }
        </section>
      </div>
    `;

    function openDesignationModal(existing = null) {
      const perms = existing?.permissions || { ...DEFAULT_PERMISSIONS_MEMBER };
      openModal({
        title: existing ? `Edit Designation: ${existing.name}` : 'Create Custom Designation',
        bodyHtml: `
          <form id="des-modal-form" class="stack-md">
            <div class="form-grid form-grid-2">
              <div class="field">
                <label class="field-label" for="dm-name">Designation Name</label>
                <input class="input" id="dm-name" name="name" required value="${escapeHtml(existing?.name || '')}" placeholder="e.g. HOD / Shift Lead / Intern" />
              </div>
              <div class="field">
                <label class="field-label" for="dm-level">Hierarchy Level (1 = Top)</label>
                <input class="input mono" id="dm-level" name="level" type="number" min="1" max="20" value="${existing?.level || 3}" />
              </div>
            </div>
            <div class="form-grid form-grid-2">
              <div class="field">
                <label class="field-label" for="dm-parent">Parent Designation</label>
                <select class="select" id="dm-parent" name="parentDesignationId">
                  <option value="">None (Top Level)</option>
                  ${designations
                    .filter((d) => d.id !== existing?.id)
                    .map((d) => `<option value="${escapeHtml(d.id)}" ${existing?.parentDesignationId === d.id ? 'selected' : ''}>${escapeHtml(d.name)}</option>`)
                    .join('')}
                </select>
              </div>
              <div class="field">
                <label class="field-label" for="dm-scope">Data Visibility Scope</label>
                <select class="select" id="dm-scope" name="scope">
                  <option value="self" ${perms.scope === 'self' ? 'selected' : ''}>Self Only (Base Member)</option>
                  <option value="team" ${perms.scope === 'team' ? 'selected' : ''}>Direct &amp; Sub-Team</option>
                  <option value="department" ${perms.scope === 'department' ? 'selected' : ''}>Department Scope</option>
                  <option value="branch" ${perms.scope === 'branch' ? 'selected' : ''}>Branch Scope</option>
                  <option value="org" ${perms.scope === 'org' ? 'selected' : ''}>Full Organization</option>
                </select>
              </div>
            </div>
            <div class="field">
              <span class="field-label">Explicit Capabilities</span>
              <div class="perm-grid">
                ${PERMISSION_LABELS.map(
                  ([key, label]) => `
                  <label class="perm-check">
                    <input type="checkbox" name="${key}" ${perms[key] ? 'checked' : ''} />
                    <span>${escapeHtml(label)}</span>
                  </label>
                `
                ).join('')}
              </div>
            </div>
            <button type="submit" class="btn btn-primary">${existing ? 'Update Designation' : 'Create Designation'}</button>
          </form>
        `,
        onMount(dialog) {
          dialog.querySelector('#des-modal-form').addEventListener('submit', async (e) => {
            e.preventDefault();
            const fd = new FormData(e.target);
            const nextPerms = { scope: String(fd.get('scope') || 'self') };
            for (const [key] of PERMISSION_LABELS) {
              nextPerms[key] = fd.get(key) === 'on';
            }
            const payload = {
              name: String(fd.get('name')).trim(),
              level: Number(fd.get('level')) || 3,
              parentDesignationId: String(fd.get('parentDesignationId') || ''),
              permissions: nextPerms,
            };
            if (existing) {
              await updateDesignation(activeOrgId, existing.id, payload, existing);
              showToast('Designation updated.', 'success');
            } else {
              await createDesignation(activeOrgId, payload);
              showToast('Designation created.', 'success');
            }
            closeModal();
            load();
          });
        },
      });
    }

    container.querySelector('#hier-add-des-btn').onclick = () => openDesignationModal(null);

    body.querySelectorAll('[data-edit-des]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const d = designations.find((x) => x.id === btn.getAttribute('data-edit-des'));
        if (d) openDesignationModal(d);
      });
    });

    body.querySelectorAll('[data-del-des]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const desId = btn.getAttribute('data-del-des');
        if (members.some((m) => m.designationId === desId)) {
          showToast('Reassign members using this designation before deleting it.', 'warning');
          return;
        }
        const ok = await showConfirm({ title: 'Delete Designation?', message: 'This designation will be permanently removed.', danger: true });
        if (!ok) return;
        await deleteOrgDoc(activeOrgId, 'designations', desId);
        showToast('Designation deleted.', 'success');
        load();
      });
    });

    body.querySelectorAll('[data-tree-edit]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const m = activeMembers.find((x) => x.uid === btn.getAttribute('data-tree-edit'));
        if (!m) return;
        openModal({
          title: `Edit Hierarchy: ${m.name}`,
          bodyHtml: `
            <form id="tree-node-form" class="stack-md">
              <div class="field">
                <label class="field-label">Designation</label>
                <select class="select" name="designationId">
                  ${designations.map((d) => `<option value="${escapeHtml(d.id)}" ${m.designationId === d.id ? 'selected' : ''}>${escapeHtml(d.name)}</option>`).join('')}
                </select>
              </div>
              <div class="field">
                <label class="field-label">Reporting Manager (Parent Node)</label>
                <select class="select" name="parentMemberId">
                  <option value="">Top Level (Reports to Root)</option>
                  ${activeMembers
                    .filter((other) => other.uid !== m.uid)
                    .map((other) => `<option value="${escapeHtml(other.uid)}" ${m.parentMemberId === other.uid ? 'selected' : ''}>${escapeHtml(other.name)} (${escapeHtml(other.designationName)})</option>`)
                    .join('')}
                </select>
              </div>
              <button type="submit" class="btn btn-primary">Save Reporting Line</button>
            </form>
          `,
          onMount(dialog) {
            dialog.querySelector('#tree-node-form').addEventListener('submit', async (e) => {
              e.preventDefault();
              const fd = new FormData(e.target);
              await updateOrgMemberHierarchy(
                activeOrgId,
                m.uid,
                {
                  designationId: String(fd.get('designationId')),
                  parentMemberId: String(fd.get('parentMemberId') || ''),
                },
                m,
                designations
              );
              closeModal();
              showToast('Reporting hierarchy updated.', 'success');
              load();
            });
          },
        });
      });
    });
  }

  load();
}

async function renderOwnerBranchesAndDepts(container) {
  const { activeOrgId, activeOrg } = getState();
  container.innerHTML = `
    <div class="stack-lg">
      <div class="page-header">
        <div>
          <h1 class="page-title">Branches &amp; Departments</h1>
          <p class="page-subtitle">Organize locations, campuses, plants, and functional departments.</p>
        </div>
      </div>
      <div id="bd-body">${renderTableSkeleton(4, 4)}</div>
    </div>
  `;

  async function load() {
    const [branches, depts, members] = await Promise.all([
      fetchOrgCollection(activeOrgId, 'branches'),
      fetchOrgCollection(activeOrgId, 'departments'),
      fetchOrgCollection(activeOrgId, 'members'),
    ]);
    const memberMap = new Map(members.map((m) => [m.uid, m.name]));
    const branchMap = new Map(branches.map((b) => [b.id, b.name]));

    const body = container.querySelector('#bd-body');
    body.innerHTML = `
      <div class="grid-2">
        <section class="panel stack-md">
          <h2 class="panel-title">Branches / Campuses (${branches.length}/${activeOrg?.branchLimit || 1})</h2>
          <form id="add-branch-form" class="stack-sm">
            <div class="form-grid form-grid-2">
              <input class="input" name="name" required placeholder="Branch Name (e.g. North Campus)" />
              <input class="input mono" name="code" required placeholder="Code (e.g. BR-02)" />
            </div>
            <div class="form-grid form-grid-2">
              <input class="input" name="address" placeholder="Address / City" />
              <select class="select" name="managerUid">
                <option value="">Assign Branch Manager</option>
                ${members.map((m) => `<option value="${escapeHtml(m.uid)}">${escapeHtml(m.name)}</option>`).join('')}
              </select>
            </div>
            <button type="submit" class="btn btn-primary btn-sm">Add Branch</button>
          </form>
          <div class="table-wrap">
            <table class="data-table">
              <thead><tr><th>Code</th><th>Branch</th><th>Manager</th><th></th></tr></thead>
              <tbody>
                ${branches
                  .map(
                    (b) => `
                  <tr>
                    <td class="mono">${escapeHtml(b.code)}</td>
                    <td><strong>${escapeHtml(b.name)}</strong><br><span style="font-size:0.75rem;color:var(--text-muted);">${escapeHtml(b.address || '')}</span></td>
                    <td>${escapeHtml(memberMap.get(b.managerUid) || 'Unassigned')}</td>
                    <td>${b.id !== 'branch_hq' ? `<button type="button" class="btn btn-ghost btn-sm" data-del-br="${escapeHtml(b.id)}">${icon('trash', 14)}</button>` : ''}</td>
                  </tr>
                `
                  )
                  .join('')}
              </tbody>
            </table>
          </div>
        </section>

        <section class="panel stack-md">
          <h2 class="panel-title">Departments (${depts.length})</h2>
          <form id="add-dept-form" class="stack-sm">
            <div class="form-grid form-grid-2">
              <input class="input" name="name" required placeholder="Department Name (e.g. Engineering)" />
              <input class="input mono" name="code" required placeholder="Code (e.g. ENG)" />
            </div>
            <div class="form-grid form-grid-2">
              <select class="select" name="branchId">
                ${branches.map((b) => `<option value="${escapeHtml(b.id)}">${escapeHtml(b.name)}</option>`).join('')}
              </select>
              <select class="select" name="headUid">
                <option value="">Assign Department Head</option>
                ${members.map((m) => `<option value="${escapeHtml(m.uid)}">${escapeHtml(m.name)}</option>`).join('')}
              </select>
            </div>
            <button type="submit" class="btn btn-primary btn-sm">Add Department</button>
          </form>
          <div class="table-wrap">
            <table class="data-table">
              <thead><tr><th>Code</th><th>Department</th><th>Branch / Head</th><th></th></tr></thead>
              <tbody>
                ${depts
                  .map(
                    (d) => `
                  <tr>
                    <td class="mono">${escapeHtml(d.code)}</td>
                    <td><strong>${escapeHtml(d.name)}</strong></td>
                    <td>${escapeHtml(branchMap.get(d.branchId) || 'Main')}<br><span style="font-size:0.75rem;color:var(--text-muted);">${escapeHtml(memberMap.get(d.headUid) || 'No Head')}</span></td>
                    <td>${d.id !== 'dept_general' ? `<button type="button" class="btn btn-ghost btn-sm" data-del-dp="${escapeHtml(d.id)}">${icon('trash', 14)}</button>` : ''}</td>
                  </tr>
                `
                  )
                  .join('')}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    `;

    body.querySelector('#add-branch-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        const fd = new FormData(e.target);
        await createBranch(activeOrgId, activeOrg, {
          name: fd.get('name'),
          code: fd.get('code'),
          address: fd.get('address'),
          managerUid: fd.get('managerUid'),
        });
        showToast('Branch added.', 'success');
        load();
      } catch (err) {
        showToast(err.message, 'danger');
      }
    });

    body.querySelector('#add-dept-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        const fd = new FormData(e.target);
        await createDepartment(activeOrgId, {
          name: fd.get('name'),
          code: fd.get('code'),
          branchId: fd.get('branchId'),
          headUid: fd.get('headUid'),
        });
        showToast('Department added.', 'success');
        load();
      } catch (err) {
        showToast(err.message, 'danger');
      }
    });

    body.querySelectorAll('[data-del-br]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        await deleteOrgDoc(activeOrgId, 'branches', btn.getAttribute('data-del-br'));
        load();
      });
    });
    body.querySelectorAll('[data-del-dp]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        await deleteOrgDoc(activeOrgId, 'departments', btn.getAttribute('data-del-dp'));
        load();
      });
    });
  }

  load();
}

async function renderOwnerShiftsAndHolidays(container) {
  const { activeOrgId } = getState();
  container.innerHTML = `
    <div class="stack-lg">
      <div class="page-header">
        <div>
          <h1 class="page-title">Shifts &amp; Holidays</h1>
          <p class="page-subtitle">Configure rotational shifts, grace windows, and org/department holidays.</p>
        </div>
      </div>
      <div id="sh-body">${renderTableSkeleton(4, 4)}</div>
    </div>
  `;

  async function load() {
    const [shifts, holidays, depts] = await Promise.all([
      fetchOrgCollection(activeOrgId, 'shifts'),
      fetchOrgCollection(activeOrgId, 'holidays'),
      fetchOrgCollection(activeOrgId, 'departments'),
    ]);
    const deptMap = new Map(depts.map((d) => [d.id, d.name]));

    const body = container.querySelector('#sh-body');
    body.innerHTML = `
      <div class="grid-2">
        <section class="panel stack-md">
          <h2 class="panel-title">Work / Academic Shifts</h2>
          <form id="add-shift-form" class="stack-sm">
            <input class="input" name="name" required placeholder="Shift Name (e.g. Evening Batch / Night Shift)" />
            <div class="form-grid form-grid-2">
              <div class="field"><label class="field-label">Start Time</label><input class="input mono" name="startTime" type="time" required value="09:00" /></div>
              <div class="field"><label class="field-label">End Time</label><input class="input mono" name="endTime" type="time" required value="17:00" /></div>
            </div>
            <div class="form-grid form-grid-2">
              <div class="field"><label class="field-label">Late Grace (min)</label><input class="input mono" name="lateGraceMinutes" type="number" value="15" /></div>
              <div class="field"><label class="field-label">Half-Day Min (min)</label><input class="input mono" name="halfDayThresholdMinutes" type="number" value="240" /></div>
            </div>
            <button type="submit" class="btn btn-primary btn-sm">Add Shift</button>
          </form>
          <div class="table-wrap">
            <table class="data-table">
              <thead><tr><th>Shift</th><th>Window</th><th>Grace</th><th></th></tr></thead>
              <tbody>
                ${shifts
                  .map(
                    (s) => `
                  <tr>
                    <td><strong>${escapeHtml(s.name)}</strong></td>
                    <td class="mono">${escapeHtml(s.startTime)}–${escapeHtml(s.endTime)}</td>
                    <td class="mono">${s.lateGraceMinutes ?? 15}m</td>
                    <td>${s.id !== 'shift_standard' ? `<button type="button" class="btn btn-ghost btn-sm" data-del-sh="${escapeHtml(s.id)}">${icon('trash', 14)}</button>` : ''}</td>
                  </tr>
                `
                  )
                  .join('')}
              </tbody>
            </table>
          </div>
        </section>

        <section class="panel stack-md">
          <h2 class="panel-title">Holidays (Never counted as absences)</h2>
          <form id="add-hol-form" class="stack-sm">
            <div class="form-grid form-grid-2">
              <input class="input mono" name="date" type="date" required value="${todayIsoDate()}" />
              <input class="input" name="title" required placeholder="Holiday Title" />
            </div>
            <div class="form-grid form-grid-2">
              <select class="select" name="departmentId">
                <option value="all">All Departments (Organization-Wide)</option>
                ${depts.map((d) => `<option value="${escapeHtml(d.id)}">${escapeHtml(d.name)} Only</option>`).join('')}
              </select>
              <input class="input" name="description" placeholder="Optional note" />
            </div>
            <button type="submit" class="btn btn-primary btn-sm">Add Holiday</button>
          </form>
          <div class="table-wrap">
            <table class="data-table">
              <thead><tr><th>Date</th><th>Holiday</th><th>Scope</th><th></th></tr></thead>
              <tbody>
                ${holidays
                  .sort((a, b) => String(a.date).localeCompare(String(b.date)))
                  .map(
                    (h) => `
                  <tr>
                    <td class="mono">${escapeHtml(h.date)}</td>
                    <td><strong>${escapeHtml(h.title)}</strong></td>
                    <td>${escapeHtml(h.departmentId === 'all' || !h.departmentId ? 'All Org' : deptMap.get(h.departmentId) || h.departmentId)}</td>
                    <td><button type="button" class="btn btn-ghost btn-sm" data-del-hol="${escapeHtml(h.id)}">${icon('trash', 14)}</button></td>
                  </tr>
                `
                  )
                  .join('')}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    `;

    body.querySelector('#add-shift-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      await createOrgDoc(activeOrgId, 'shifts', {
        name: String(fd.get('name')).trim(),
        startTime: String(fd.get('startTime')),
        endTime: String(fd.get('endTime')),
        lateGraceMinutes: Number(fd.get('lateGraceMinutes')) || 15,
        halfDayThresholdMinutes: Number(fd.get('halfDayThresholdMinutes')) || 240,
        isDefault: false,
      });
      showToast('Shift created.', 'success');
      load();
    });

    body.querySelector('#add-hol-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      await createOrgDoc(activeOrgId, 'holidays', {
        date: String(fd.get('date')),
        title: String(fd.get('title')).trim(),
        departmentId: String(fd.get('departmentId') || 'all'),
        description: String(fd.get('description') || '').trim(),
      });
      showToast('Holiday scheduled.', 'success');
      load();
    });

    body.querySelectorAll('[data-del-sh]').forEach((b) =>
      b.addEventListener('click', async () => {
        await deleteOrgDoc(activeOrgId, 'shifts', b.getAttribute('data-del-sh'));
        load();
      })
    );
    body.querySelectorAll('[data-del-hol]').forEach((b) =>
      b.addEventListener('click', async () => {
        await deleteOrgDoc(activeOrgId, 'holidays', b.getAttribute('data-del-hol'));
        load();
      })
    );
  }

  load();
}

async function renderOwnerMembers(container) {
  const { activeOrgId, activeOrg, firebaseUser } = getState();
  const typeMeta = getOrgTypeMeta(activeOrg?.type);
  let search = '';
  let statusFilter = 'all';
  let page = 1;

  container.innerHTML = `
    <div class="stack-lg">
      <div class="page-header">
        <div>
          <h1 class="page-title">${escapeHtml(typeMeta.memberLabel)}s &amp; Invitations</h1>
          <p class="page-subtitle">Add individual members, import CSV rosters with duplicate checks, generate invites, and approve requests.</p>
        </div>
        <div class="page-actions">
          <button type="button" class="btn btn-secondary" id="mem-invite-btn">Create Invite Link</button>
          <button type="button" class="btn btn-secondary" id="mem-csv-btn">${icon('upload', 16)} Bulk CSV Import</button>
          <button type="button" class="btn btn-primary" id="mem-add-btn">${icon('plus', 16)} Add ${escapeHtml(typeMeta.memberLabel)}</button>
        </div>
      </div>
      <div id="own-members-body">${renderTableSkeleton(6, 5)}</div>
    </div>
  `;

  async function load() {
    const [members, designations, depts, branches, shifts, invitations] = await Promise.all([
      fetchOrgCollection(activeOrgId, 'members'),
      fetchOrgCollection(activeOrgId, 'designations'),
      fetchOrgCollection(activeOrgId, 'departments'),
      fetchOrgCollection(activeOrgId, 'branches'),
      fetchOrgCollection(activeOrgId, 'shifts'),
      fetchOrgCollection(activeOrgId, 'invitations'),
    ]);

    const deptMap = new Map(depts.map((d) => [d.id, d.name]));
    const pendingList = members.filter((m) => m.status === 'pending');

    function renderList() {
      const filtered = members.filter((m) => {
        if (statusFilter !== 'all' && m.status !== statusFilter) return false;
        if (search) {
          const hay = `${m.name} ${m.email} ${m.memberPublicId} ${m.externalId} ${m.designationName}`.toLowerCase();
          if (!hay.includes(search.toLowerCase())) return false;
        }
        return true;
      });
      const paged = paginateItems(filtered, page, 12);
      const body = container.querySelector('#own-members-body');

      body.innerHTML = `
        <div class="stack-lg">
          ${
            pendingList.length > 0
              ? `<section class="panel stack-sm">
                  <h2 class="panel-title">Pending Join Approvals (${pendingList.length})</h2>
                  <div class="table-wrap"><table class="data-table">
                    <thead><tr><th>Name</th><th>Email</th><th>Reference ID</th><th>Action</th></tr></thead>
                    <tbody>
                      ${pendingList
                        .map(
                          (p) => `
                        <tr>
                          <td><strong>${escapeHtml(p.name)}</strong></td>
                          <td>${escapeHtml(p.email)}</td>
                          <td class="mono">${escapeHtml(p.externalId || '—')}</td>
                          <td>
                            <div style="display:flex;gap:0.375rem;">
                              <button type="button" class="btn btn-primary btn-sm" data-approve-mem="${escapeHtml(p.uid)}">Approve</button>
                              <button type="button" class="btn btn-danger btn-sm" data-reject-mem="${escapeHtml(p.uid)}">Decline</button>
                            </div>
                          </td>
                        </tr>
                      `
                        )
                        .join('')}
                    </tbody>
                  </table></div>
                </section>`
              : ''
          }

          <section class="panel stack-md">
            <div class="toolbar">
              <div class="toolbar-group">
                <input class="input" id="mem-search-inp" value="${escapeHtml(search)}" placeholder="Search name, email, SA-ORG ID..." style="min-width:240px;" />
                <div class="segmented-bar">
                  ${['all', 'active', 'inactive', 'pending']
                    .map((st) => `<button type="button" class="segmented-btn ${statusFilter === st ? 'active' : ''}" data-mst="${st}">${st}</button>`)
                    .join('')}
                </div>
              </div>
              <span class="panel-meta">${members.filter((m) => m.status === 'active').length} / ${activeOrg?.memberLimit || 50} plan seats</span>
            </div>

            ${
              paged.totalItems === 0
                ? renderEmptyState({ title: 'No members match filter', description: 'Add members or invite via link.' })
                : `<div class="table-wrap">
                    <table class="data-table">
                      <thead>
                        <tr>
                          <th>Name &amp; Email</th>
                          <th>SmartAttend ID</th>
                          <th>${escapeHtml(typeMeta.idFieldLabel)}</th>
                          <th>Designation</th>
                          <th>Department</th>
                          <th>Status</th>
                          <th>Actions</th>
                        </tr>
                      </thead>
                      <tbody>
                        ${paged.items
                          .map(
                            (m) => `
                          <tr>
                            <td><strong>${escapeHtml(m.name)}</strong><br><span style="font-size:0.75rem;color:var(--text-muted);">${escapeHtml(m.email)}</span></td>
                            <td class="mono" style="font-size:0.8125rem;">${escapeHtml(m.memberPublicId)}</td>
                            <td class="mono">${escapeHtml(m.externalId || '—')}</td>
                            <td>${escapeHtml(m.designationName || 'Member')}</td>
                            <td>${escapeHtml(deptMap.get(m.departmentId) || 'General')}</td>
                            <td><span class="status-text ${m.status === 'active' ? 'status-success' : 'status-warning'}" style="text-transform:capitalize;">${escapeHtml(m.status)}</span></td>
                            <td>
                              <div style="display:flex;gap:0.35rem;">
                                <button type="button" class="btn btn-secondary btn-sm" data-edit-mem="${escapeHtml(m.uid)}">Edit</button>
                                ${
                                  !m.isOwner
                                    ? `<button type="button" class="btn btn-ghost btn-sm" data-toggle-mem="${escapeHtml(m.uid)}">${m.status === 'active' ? 'Suspend' : 'Activate'}</button>`
                                    : ''
                                }
                              </div>
                            </td>
                          </tr>
                        `
                          )
                          .join('')}
                      </tbody>
                    </table>
                  </div>
                  <div class="pagination">
                    <span>Showing ${paged.items.length} of ${paged.totalItems} members</span>
                    <div class="pagination-controls">
                      <button type="button" class="btn btn-secondary btn-sm" id="mem-prev" ${paged.page <= 1 ? 'disabled' : ''}>Prev</button>
                      <span class="mono">${paged.page}/${paged.totalPages}</span>
                      <button type="button" class="btn btn-secondary btn-sm" id="mem-next" ${paged.page >= paged.totalPages ? 'disabled' : ''}>Next</button>
                    </div>
                  </div>`
            }
          </section>

          ${
            invitations.length > 0
              ? `<section class="panel stack-sm">
                  <h2 class="panel-title">Active &amp; Recent Invitations</h2>
                  <div class="table-wrap"><table class="data-table">
                    <thead><tr><th>Code</th><th>Email</th><th>Designation</th><th>Status</th><th>Invite Link</th></tr></thead>
                    <tbody>
                      ${invitations
                        .slice(0, 8)
                        .map(
                          (inv) => `
                        <tr>
                          <td class="mono">${escapeHtml(inv.inviteCode)}</td>
                          <td>${escapeHtml(inv.email || 'Open Link')}</td>
                          <td>${escapeHtml(inv.designationName)}</td>
                          <td style="text-transform:capitalize;">${escapeHtml(inv.status)}</td>
                          <td><button type="button" class="btn btn-ghost btn-sm" data-copy-inv="${escapeHtml(inv.inviteCode)}">${icon('copy', 14)} Copy Link</button></td>
                        </tr>
                      `
                        )
                        .join('')}
                    </tbody>
                  </table></div>
                </section>`
              : ''
          }
        </div>
      `;

      body.querySelector('#mem-search-inp')?.addEventListener('input', (e) => {
        search = e.target.value;
        page = 1;
        renderList();
      });
      body.querySelectorAll('[data-mst]').forEach((b) =>
        b.addEventListener('click', () => {
          statusFilter = b.getAttribute('data-mst');
          page = 1;
          renderList();
        })
      );
      body.querySelector('#mem-prev')?.addEventListener('click', () => {
        page = Math.max(1, page - 1);
        renderList();
      });
      body.querySelector('#mem-next')?.addEventListener('click', () => {
        page = Math.min(paged.totalPages, page + 1);
        renderList();
      });
      body.querySelectorAll('[data-approve-mem]').forEach((b) =>
        b.addEventListener('click', async () => {
          await reviewPendingMember(activeOrgId, b.getAttribute('data-approve-mem'), 'approve');
          showToast('Member approved.', 'success');
          load();
        })
      );
      body.querySelectorAll('[data-reject-mem]').forEach((b) =>
        b.addEventListener('click', async () => {
          await reviewPendingMember(activeOrgId, b.getAttribute('data-reject-mem'), 'reject');
          showToast('Join request declined.', 'info');
          load();
        })
      );
      body.querySelectorAll('[data-copy-inv]').forEach((b) =>
        b.addEventListener('click', async () => {
          const code = b.getAttribute('data-copy-inv');
          const url = `${window.location.origin}/#/join/${code}`;
          await navigator.clipboard.writeText(url).catch(() => {});
          showToast(`Copied invite link (${code}).`, 'success');
        })
      );
      body.querySelectorAll('[data-toggle-mem]').forEach((b) =>
        b.addEventListener('click', async () => {
          const m = members.find((x) => x.uid === b.getAttribute('data-toggle-mem'));
          if (!m) return;
          const next = m.status === 'active' ? 'inactive' : 'active';
          await updateOrgMemberHierarchy(activeOrgId, m.uid, { status: next }, m, designations);
          showToast(`${m.name} marked ${next}.`, 'success');
          load();
        })
      );
      body.querySelectorAll('[data-edit-mem]').forEach((b) =>
        b.addEventListener('click', () => {
          const m = members.find((x) => x.uid === b.getAttribute('data-edit-mem'));
          if (!m) return;
          openModal({
            title: `Edit Member: ${m.name}`,
            bodyHtml: `
              <form id="edit-mem-form" class="stack-md">
                <div class="form-grid form-grid-2">
                  <div class="field"><label class="field-label">Full Name</label><input class="input" name="name" required value="${escapeHtml(m.name)}" /></div>
                  <div class="field"><label class="field-label">${escapeHtml(typeMeta.idFieldLabel)}</label><input class="input mono" name="externalId" value="${escapeHtml(m.externalId || '')}" /></div>
                </div>
                <div class="form-grid form-grid-2">
                  <div class="field">
                    <label class="field-label">Designation</label>
                    <select class="select" name="designationId" ${m.isOwner ? 'disabled' : ''}>
                      ${designations.map((d) => `<option value="${escapeHtml(d.id)}" ${m.designationId === d.id ? 'selected' : ''}>${escapeHtml(d.name)}</option>`).join('')}
                    </select>
                  </div>
                  <div class="field">
                    <label class="field-label">Reporting Manager</label>
                    <select class="select" name="parentMemberId">
                      <option value="">None (Root)</option>
                      ${members.filter((o) => o.uid !== m.uid).map((o) => `<option value="${escapeHtml(o.uid)}" ${m.parentMemberId === o.uid ? 'selected' : ''}>${escapeHtml(o.name)}</option>`).join('')}
                    </select>
                  </div>
                </div>
                <div class="form-grid form-grid-3">
                  <div class="field">
                    <label class="field-label">Branch</label>
                    <select class="select" name="branchId">
                      ${branches.map((br) => `<option value="${escapeHtml(br.id)}" ${m.branchId === br.id ? 'selected' : ''}>${escapeHtml(br.name)}</option>`).join('')}
                    </select>
                  </div>
                  <div class="field">
                    <label class="field-label">Department</label>
                    <select class="select" name="departmentId">
                      ${depts.map((dp) => `<option value="${escapeHtml(dp.id)}" ${m.departmentId === dp.id ? 'selected' : ''}>${escapeHtml(dp.name)}</option>`).join('')}
                    </select>
                  </div>
                  <div class="field">
                    <label class="field-label">Shift</label>
                    <select class="select" name="shiftId">
                      ${shifts.map((sh) => `<option value="${escapeHtml(sh.id)}" ${m.shiftId === sh.id ? 'selected' : ''}>${escapeHtml(sh.name)}</option>`).join('')}
                    </select>
                  </div>
                </div>
                <button type="submit" class="btn btn-primary">Save Changes</button>
              </form>
            `,
            onMount(dialog) {
              dialog.querySelector('#edit-mem-form').addEventListener('submit', async (ev) => {
                ev.preventDefault();
                const submitBtn = dialog.querySelector('#edit-mem-form button[type="submit"]');
                const fd = new FormData(ev.target);
                const ext = String(fd.get('externalId') || '').trim();
                if (
                  ext &&
                  members.some(
                    (o) => o.uid !== m.uid && (o.externalId || '').trim().toLowerCase() === ext.toLowerCase()
                  )
                ) {
                  showToast(`Duplicate ID "${ext}" already exists.`, 'danger');
                  return;
                }
                if (submitBtn) submitBtn.disabled = true;
                try {
                  await updateOrgMemberHierarchy(
                    activeOrgId,
                    m.uid,
                    {
                      name: String(fd.get('name')).trim(),
                      externalId: ext,
                      designationId: m.isOwner ? m.designationId : String(fd.get('designationId')),
                      parentMemberId: String(fd.get('parentMemberId') || ''),
                      branchId: String(fd.get('branchId')),
                      departmentId: String(fd.get('departmentId')),
                      shiftId: String(fd.get('shiftId')),
                    },
                    m,
                    designations
                  );
                  closeModal();
                  showToast('Member updated.', 'success');
                  load();
                } catch (err) {
                  showToast(err.message || 'Member update failed.', 'danger');
                  if (submitBtn) submitBtn.disabled = false;
                }
              });
            },
          });
        })
      );
    }

    container.querySelector('#mem-add-btn').onclick = () => {
      openModal({
        title: `Add ${typeMeta.memberLabel}`,
        bodyHtml: `
          <form id="add-mem-form" class="stack-md">
            <div class="form-grid form-grid-2">
              <div class="field"><label class="field-label">Full Name</label><input class="input" name="name" required /></div>
              <div class="field"><label class="field-label">Email</label><input class="input" name="email" type="email" required /></div>
            </div>
            <div class="form-grid form-grid-2">
              <div class="field"><label class="field-label">Initial Password (min 6)</label><input class="input" name="password" type="password" required minlength="6" /></div>
              <div class="field"><label class="field-label">${escapeHtml(typeMeta.idFieldLabel)}</label><input class="input mono" name="externalId" placeholder="Optional unique ID" /></div>
            </div>
            <div class="form-grid form-grid-2">
              <div class="field">
                <label class="field-label">Designation</label>
                <select class="select" name="designationId">
                  ${designations.filter((d) => !d.isSystemOwner).map((d) => `<option value="${escapeHtml(d.id)}" ${d.id === 'des_member' ? 'selected' : ''}>${escapeHtml(d.name)}</option>`).join('')}
                </select>
              </div>
              <div class="field">
                <label class="field-label">Reporting Manager</label>
                <select class="select" name="parentMemberId">
                  <option value="">Organization Head</option>
                  ${members.map((m) => `<option value="${escapeHtml(m.uid)}">${escapeHtml(m.name)}</option>`).join('')}
                </select>
              </div>
            </div>
            <div class="form-grid form-grid-3">
              <div class="field"><label class="field-label">Branch</label><select class="select" name="branchId">${branches.map((b) => `<option value="${escapeHtml(b.id)}">${escapeHtml(b.name)}</option>`).join('')}</select></div>
              <div class="field"><label class="field-label">Department</label><select class="select" name="departmentId">${depts.map((d) => `<option value="${escapeHtml(d.id)}">${escapeHtml(d.name)}</option>`).join('')}</select></div>
              <div class="field"><label class="field-label">Shift</label><select class="select" name="shiftId">${shifts.map((s) => `<option value="${escapeHtml(s.id)}">${escapeHtml(s.name)}</option>`).join('')}</select></div>
            </div>
            <button type="submit" class="btn btn-primary" id="add-mem-sub">Create Member &amp; Issue QR ID</button>
          </form>
        `,
        onMount(dialog) {
          dialog.querySelector('#add-mem-form').addEventListener('submit', async (e) => {
            e.preventDefault();
            const btn = dialog.querySelector('#add-mem-sub');
            btn.disabled = true;
            btn.textContent = 'Provisioning...';
            try {
              const fd = new FormData(e.target);
              const created = await provisionOrgMember({
                orgId: activeOrgId,
                orgDocData: activeOrg,
                existingMembers: members,
                designations,
                name: fd.get('name'),
                email: fd.get('email'),
                password: fd.get('password'),
                externalId: fd.get('externalId'),
                designationId: fd.get('designationId'),
                parentMemberId: fd.get('parentMemberId'),
                branchId: fd.get('branchId'),
                departmentId: fd.get('departmentId'),
                shiftId: fd.get('shiftId'),
              });
              closeModal();
              showToast(`Member created with ID ${created.memberPublicId}.`, 'success');
              load();
            } catch (err) {
              showToast(err.message || 'Member creation failed.', 'danger');
              btn.disabled = false;
              btn.textContent = 'Create Member & Issue QR ID';
            }
          });
        },
      });
    };

    container.querySelector('#mem-invite-btn').onclick = () => {
      openModal({
        title: 'Create Member Invitation Link',
        bodyHtml: `
          <form id="inv-form" class="stack-md">
            <div class="field"><label class="field-label">Recipient Email (Leave blank for multi-use open link)</label><input class="input" name="email" type="email" placeholder="optional@org.com" /></div>
            <div class="form-grid form-grid-2">
              <div class="field"><label class="field-label">Designation</label><select class="select" name="designationId">${designations.filter((d) => !d.isSystemOwner).map((d) => `<option value="${escapeHtml(d.id)}">${escapeHtml(d.name)}</option>`).join('')}</select></div>
              <div class="field"><label class="field-label">Department</label><select class="select" name="departmentId">${depts.map((d) => `<option value="${escapeHtml(d.id)}">${escapeHtml(d.name)}</option>`).join('')}</select></div>
            </div>
            <button type="submit" class="btn btn-primary">Generate Invitation</button>
          </form>
        `,
        onMount(dialog) {
          dialog.querySelector('#inv-form').addEventListener('submit', async (e) => {
            e.preventDefault();
            const submitBtn = dialog.querySelector('#inv-form button[type="submit"]');
            if (submitBtn) submitBtn.disabled = true;
            try {
              const fd = new FormData(e.target);
              const desId = String(fd.get('designationId'));
              const des = designations.find((d) => d.id === desId);
              const inv = await createOrgInvitation(activeOrgId, {
                email: fd.get('email'),
                designationId: desId,
                designationName: des?.name || 'Member',
                departmentId: String(fd.get('departmentId')),
                branchId: branches[0]?.id || 'branch_hq',
                createdByUid: firebaseUser.uid,
              });
              closeModal();
              const url = `${window.location.origin}/#/join/${inv.inviteCode}`;
              await navigator.clipboard.writeText(url).catch(() => {});
              showToast(`Invitation ${inv.inviteCode} created & link copied!`, 'success', 5500);
              load();
            } catch (err) {
              showToast(err.message || 'Unable to generate invitation.', 'danger');
              if (submitBtn) submitBtn.disabled = false;
            }
          });
        },
      });
    };

    container.querySelector('#mem-csv-btn').onclick = () => {
      let parsed = null;
      openModal({
        title: 'Bulk CSV Member Import',
        bodyHtml: `
          <div class="stack-md">
            <p style="font-size:0.875rem;color:var(--text-secondary);">
              Upload or paste CSV with columns: <code>name,email,externalId,phone,designation,department,branch,tempPassword</code>
            </p>
            <div style="display:flex;gap:0.5rem;flex-wrap:wrap;">
              <button type="button" class="btn btn-secondary btn-sm" id="csv-dl-tpl">${icon('download', 14)} Download CSV Template</button>
              <input type="file" id="csv-file-inp" accept=".csv,text/csv" class="input" style="max-width:260px;min-height:36px;" />
            </div>
            <textarea class="textarea mono" id="csv-raw-text" placeholder="name,email,externalId,phone,designation,department,branch,tempPassword&#10;Riya Sen,riya@org.com,ID-101,+919876543210,Student,General,Main,Pass@1234"></textarea>
            <button type="button" class="btn btn-secondary" id="csv-validate-btn">Validate &amp; Preview CSV</button>
            <div id="csv-preview-slot"></div>
          </div>
        `,
        onMount(dialog) {
          dialog.querySelector('#csv-dl-tpl').addEventListener('click', () => {
            exportAttendanceCsv({
              columns: ['name', 'email', 'externalId', 'phone', 'designation', 'department', 'branch', 'tempPassword'],
              rows: [['Aarav Mehta', 'aarav@org.com', 'ID-101', '+919999999999', designations[designations.length - 1]?.name || 'Member', depts[0]?.name || 'General', branches[0]?.name || 'HQ', 'Smart@2026']],
              fileName: 'smartattend-members-template.csv',
            });
          });
          dialog.querySelector('#csv-file-inp').addEventListener('change', async (ev) => {
            const file = ev.target.files?.[0];
            if (file) {
              dialog.querySelector('#csv-raw-text').value = await file.text();
            }
          });
          dialog.querySelector('#csv-validate-btn').addEventListener('click', () => {
            parsed = parseBulkMembersCsv(dialog.querySelector('#csv-raw-text').value, members);
            const slot = dialog.querySelector('#csv-preview-slot');
            slot.innerHTML = `
              <div class="stack-sm">
                <div class="notice ${parsed.errors.length ? 'notice-warning' : 'notice-success'}">
                  <strong>${parsed.validRows.length} valid row(s) · ${parsed.errors.length} error(s)</strong>
                  ${parsed.errors.slice(0, 5).map((er) => `<span style="font-size:0.75rem;">Row ${er.row}: ${escapeHtml(er.message)}</span>`).join('')}
                </div>
                ${
                  parsed.validRows.length > 0
                    ? `<button type="button" class="btn btn-primary" id="csv-commit-btn">Import ${parsed.validRows.length} Valid Member(s)</button>`
                    : ''
                }
              </div>
            `;
            slot.querySelector('#csv-commit-btn')?.addEventListener('click', async () => {
              const cbtn = slot.querySelector('#csv-commit-btn');
              cbtn.disabled = true;
              cbtn.textContent = 'Importing...';
              let imported = 0;
              let failed = 0;
              for (const row of parsed.validRows) {
                try {
                  const desMatch = designations.find((d) => d.name.toLowerCase() === row.designationName.toLowerCase()) || designations.find((d) => d.id === 'des_member') || designations[0];
                  const deptMatch = depts.find((d) => d.name.toLowerCase() === row.departmentName.toLowerCase()) || depts[0];
                  const branchMatch = branches.find((b) => b.name.toLowerCase() === row.branchName.toLowerCase()) || branches[0];
                  await provisionOrgMember({
                    orgId: activeOrgId,
                    orgDocData: activeOrg,
                    existingMembers: members,
                    designations,
                    name: row.name,
                    email: row.email,
                    password: row.password,
                    externalId: row.externalId,
                    phone: row.phone,
                    designationId: desMatch?.id || 'des_member',
                    departmentId: deptMatch?.id || 'dept_general',
                    branchId: branchMatch?.id || 'branch_hq',
                  });
                  imported += 1;
                } catch {
                  failed += 1;
                }
              }
              closeModal();
              showToast(`Imported ${imported} member(s)${failed ? `, ${failed} skipped` : ''}.`, 'success', 5500);
              load();
            });
          });
        },
      });
    };

    renderList();
  }

  load();
}

async function renderOwnerRequests(container) {
  const { activeOrgId, activeMember, firebaseUser } = getState();
  container.innerHTML = `
    <div class="stack-lg">
      <div class="page-header">
        <div>
          <h1 class="page-title">Leaves &amp; Correction Requests</h1>
          <p class="page-subtitle">Approve or reject member leave applications and attendance correction requests.</p>
        </div>
      </div>
      <div id="own-req-body">${renderTableSkeleton(5, 4)}</div>
    </div>
  `;

  async function load() {
    const [leaves, corrs] = await Promise.all([
      fetchOrgCollection(activeOrgId, 'leaveRequests'),
      fetchOrgCollection(activeOrgId, 'correctionRequests'),
    ]);

    leaves.sort((a, b) => (b.createdAt?.toMillis?.() || 0) - (a.createdAt?.toMillis?.() || 0));
    corrs.sort((a, b) => (b.createdAt?.toMillis?.() || 0) - (a.createdAt?.toMillis?.() || 0));

    const body = container.querySelector('#own-req-body');
    body.innerHTML = `
      <div class="grid-2">
        <section class="panel stack-md">
          <h2 class="panel-title">Leave Requests (${leaves.filter((l) => l.status === 'pending').length} pending)</h2>
          ${
            leaves.length === 0
              ? renderEmptyState({ title: 'No leave requests', description: 'Member leave submissions appear here.' })
              : `<div class="table-wrap"><table class="data-table">
                  <thead><tr><th>Member</th><th>Dates &amp; Reason</th><th>Status</th><th>Action</th></tr></thead>
                  <tbody>
                    ${leaves
                      .map(
                        (l) => `
                      <tr>
                        <td><strong>${escapeHtml(l.memberName)}</strong><br><span class="mono" style="font-size:0.75rem;">${escapeHtml(l.memberPublicId || '')}</span></td>
                        <td><span class="mono">${escapeHtml(l.startDate)} → ${escapeHtml(l.endDate)}</span><br><span style="font-size:0.75rem;color:var(--text-secondary);">${escapeHtml(l.reason)}</span>${l.attachmentUrl ? `<br><a href="${escapeHtml(l.attachmentUrl)}" target="_blank" rel="noopener">View Attachment</a>` : ''}</td>
                        <td><span class="status-text ${l.status === 'approved' ? 'status-success' : l.status === 'rejected' ? 'status-danger' : 'status-warning'}" style="text-transform:capitalize;">${escapeHtml(l.status)}</span></td>
                        <td>
                          ${
                            l.status === 'pending'
                              ? `<div style="display:flex;gap:0.3rem;"><button type="button" class="btn btn-primary btn-sm" data-lv-app="${escapeHtml(l.id)}">Approve</button><button type="button" class="btn btn-danger btn-sm" data-lv-rej="${escapeHtml(l.id)}">Reject</button></div>`
                              : '—'
                          }
                        </td>
                      </tr>
                    `
                      )
                      .join('')}
                  </tbody>
                </table></div>`
          }
        </section>

        <section class="panel stack-md">
          <h2 class="panel-title">Correction Requests (${corrs.filter((c) => c.status === 'pending').length} pending)</h2>
          ${
            corrs.length === 0
              ? renderEmptyState({ title: 'No correction requests', description: 'Attendance correction submissions appear here.' })
              : `<div class="table-wrap"><table class="data-table">
                  <thead><tr><th>Member</th><th>Date &amp; Request</th><th>Status</th><th>Action</th></tr></thead>
                  <tbody>
                    ${corrs
                      .map(
                        (c) => `
                      <tr>
                        <td><strong>${escapeHtml(c.memberName)}</strong></td>
                        <td><span class="mono">${escapeHtml(c.date)}</span> → <strong>${escapeHtml((c.requestedStatus || '').replace('_', ' '))}</strong><br><span style="font-size:0.75rem;color:var(--text-secondary);">${escapeHtml(c.reason)}</span></td>
                        <td><span class="status-text ${c.status === 'approved' ? 'status-success' : c.status === 'rejected' ? 'status-danger' : 'status-warning'}" style="text-transform:capitalize;">${escapeHtml(c.status)}</span></td>
                        <td>
                          ${
                            c.status === 'pending'
                              ? `<div style="display:flex;gap:0.3rem;"><button type="button" class="btn btn-primary btn-sm" data-cr-app="${escapeHtml(c.id)}">Approve</button><button type="button" class="btn btn-danger btn-sm" data-cr-rej="${escapeHtml(c.id)}">Reject</button></div>`
                              : '—'
                          }
                        </td>
                      </tr>
                    `
                      )
                      .join('')}
                  </tbody>
                </table></div>`
          }
        </section>
      </div>
    `;

    const reviewerName = activeMember?.name || firebaseUser.displayName || '';
    body.querySelectorAll('[data-lv-app]').forEach((b) =>
      b.addEventListener('click', async () => {
        await reviewOrgLeaveRequest({ orgId: activeOrgId, leaveId: b.getAttribute('data-lv-app'), decision: 'approved', reviewerUid: firebaseUser.uid, reviewerName });
        showToast('Leave approved & attendance updated.', 'success');
        load();
      })
    );
    body.querySelectorAll('[data-lv-rej]').forEach((b) =>
      b.addEventListener('click', async () => {
        await reviewOrgLeaveRequest({ orgId: activeOrgId, leaveId: b.getAttribute('data-lv-rej'), decision: 'rejected', reviewerUid: firebaseUser.uid, reviewerName });
        showToast('Leave rejected.', 'info');
        load();
      })
    );
    body.querySelectorAll('[data-cr-app]').forEach((b) =>
      b.addEventListener('click', async () => {
        await reviewOrgCorrectionRequest({ orgId: activeOrgId, requestId: b.getAttribute('data-cr-app'), decision: 'approved', reviewerUid: firebaseUser.uid, reviewerName });
        showToast('Correction approved & attendance updated.', 'success');
        load();
      })
    );
    body.querySelectorAll('[data-cr-rej]').forEach((b) =>
      b.addEventListener('click', async () => {
        await reviewOrgCorrectionRequest({ orgId: activeOrgId, requestId: b.getAttribute('data-cr-rej'), decision: 'rejected', reviewerUid: firebaseUser.uid, reviewerName });
        showToast('Correction rejected.', 'info');
        load();
      })
    );
  }

  load();
}

async function renderOwnerReports(container) {
  const { activeOrgId, activeOrg, settings } = getState();
  container.innerHTML = `
    <div class="stack-lg">
      <div class="page-header">
        <div>
          <h1 class="page-title">Reports &amp; Organization Data Export</h1>
          <p class="page-subtitle">Filter attendance by date range, branch, department, or member and export CSV, Excel, PDF, or JSON Backup.</p>
        </div>
        <div class="page-actions">
          <button type="button" class="btn btn-secondary" id="rep-json-backup">${icon('download', 16)} Full Org JSON Backup</button>
        </div>
      </div>
      <div id="own-rep-body">${renderTableSkeleton(6, 5)}</div>
    </div>
  `;

  const [members, branches, depts, records] = await Promise.all([
    fetchOrgCollection(activeOrgId, 'members'),
    fetchOrgCollection(activeOrgId, 'branches'),
    fetchOrgCollection(activeOrgId, 'departments'),
    fetchOrgCollection(activeOrgId, 'attendanceRecords'),
  ]);

  const deptMap = new Map(depts.map((d) => [d.id, d.name]));
  const body = container.querySelector('#own-rep-body');
  const today = todayIsoDate();
  const monthStart = `${today.slice(0, 8)}01`;

  body.innerHTML = `
    <section class="panel stack-md">
      <div class="form-grid form-grid-3">
        <div class="field"><label class="field-label">From Date</label><input class="input mono" id="rep-from" type="date" value="${monthStart}" /></div>
        <div class="field"><label class="field-label">To Date</label><input class="input mono" id="rep-to" type="date" value="${today}" /></div>
        <div class="field">
          <label class="field-label">Department</label>
          <select class="select" id="rep-dept">
            <option value="all">All Departments</option>
            ${depts.map((d) => `<option value="${escapeHtml(d.id)}">${escapeHtml(d.name)}</option>`).join('')}
          </select>
        </div>
      </div>
      <div class="form-grid form-grid-3">
        <div class="field">
          <label class="field-label">Branch</label>
          <select class="select" id="rep-branch">
            <option value="all">All Branches</option>
            ${branches.map((b) => `<option value="${escapeHtml(b.id)}">${escapeHtml(b.name)}</option>`).join('')}
          </select>
        </div>
        <div class="field">
          <label class="field-label">Member</label>
          <select class="select" id="rep-member">
            <option value="all">All Members</option>
            ${members.map((m) => `<option value="${escapeHtml(m.uid)}">${escapeHtml(m.name)} (${escapeHtml(m.memberPublicId)})</option>`).join('')}
          </select>
        </div>
        <div class="field" style="justify-content:flex-end;">
          <div style="display:flex;gap:0.5rem;flex-wrap:wrap;">
            <button type="button" class="btn btn-secondary btn-sm" id="rep-csv">CSV</button>
            <button type="button" class="btn btn-secondary btn-sm" id="rep-excel">Excel (.xlsx)</button>
            <button type="button" class="btn btn-primary btn-sm" id="rep-pdf">PDF Report</button>
          </div>
        </div>
      </div>

      <div id="rep-preview-slot"></div>
    </section>
  `;

  function computeRows() {
    const from = body.querySelector('#rep-from').value;
    const to = body.querySelector('#rep-to').value;
    const deptId = body.querySelector('#rep-dept').value;
    const branchId = body.querySelector('#rep-branch').value;
    const memberUid = body.querySelector('#rep-member').value;

    const filteredMembers = members.filter((m) => {
      if (deptId !== 'all' && m.departmentId !== deptId) return false;
      if (branchId !== 'all' && m.branchId !== branchId) return false;
      if (memberUid !== 'all' && m.uid !== memberUid) return false;
      return true;
    });

    return filteredMembers.map((m) => {
      const mRecs = records.filter(
        (r) => r.memberUid === m.uid && (!from || r.date >= from) && (!to || r.date <= to)
      );
      const sum = calculateAttendanceSummary(mRecs, settings);
      return {
        member: m,
        sum,
        dept: deptMap.get(m.departmentId) || 'General',
      };
    });
  }

  function renderPreview() {
    const rows = computeRows();
    const slot = body.querySelector('#rep-preview-slot');
    if (rows.length === 0) {
      slot.innerHTML = renderEmptyState({ title: 'No members match filter', description: 'Adjust branch, department, or member filter.' });
      return;
    }
    slot.innerHTML = `
      <div class="table-wrap">
        <table class="data-table">
          <thead><tr><th>Member</th><th>ID</th><th>Department</th><th class="num">Present</th><th class="num">Late</th><th class="num">Half</th><th class="num">Absent</th><th class="num">Leave</th><th class="num">Hours</th><th class="num">%</th></tr></thead>
          <tbody>
            ${rows
              .map(
                (r) => `
              <tr>
                <td><strong>${escapeHtml(r.member.name)}</strong></td>
                <td class="mono">${escapeHtml(r.member.memberPublicId)}</td>
                <td>${escapeHtml(r.dept)}</td>
                <td class="num">${r.sum.present}</td>
                <td class="num">${r.sum.late}</td>
                <td class="num">${r.sum.halfDay}</td>
                <td class="num">${r.sum.absent}</td>
                <td class="num">${r.sum.onLeave}</td>
                <td class="num">${r.sum.totalWorkingHours}h</td>
                <td class="num"><strong>${r.sum.percentage}%</strong></td>
              </tr>
            `
              )
              .join('')}
          </tbody>
        </table>
      </div>
    `;
  }

  ['#rep-from', '#rep-to', '#rep-dept', '#rep-branch', '#rep-member'].forEach((s) =>
    body.querySelector(s).addEventListener('change', renderPreview)
  );

  const cols = ['Name', 'Member ID', 'Designation', 'Department', 'Present', 'Late', 'Half Day', 'Absent', 'On Leave', 'Working Hours', 'Attendance %'];
  const toArrayRows = () =>
    computeRows().map((r) => [
      r.member.name,
      r.member.memberPublicId,
      r.member.designationName || 'Member',
      r.dept,
      r.sum.present,
      r.sum.late,
      r.sum.halfDay,
      r.sum.absent,
      r.sum.onLeave,
      `${r.sum.totalWorkingHours}h`,
      `${r.sum.percentage}%`,
    ]);

  body.querySelector('#rep-csv').addEventListener('click', () => {
    exportAttendanceCsv({ columns: cols, rows: toArrayRows(), fileName: `${activeOrgId}-attendance-report.csv` });
  });
  body.querySelector('#rep-excel').addEventListener('click', () => {
    exportAttendanceExcel({ columns: cols, rows: toArrayRows(), fileName: `${activeOrgId}-attendance-report.xlsx` });
  });
  body.querySelector('#rep-pdf').addEventListener('click', () => {
    const from = body.querySelector('#rep-from').value;
    const to = body.querySelector('#rep-to').value;
    exportAttendancePdf({
      orgName: activeOrg?.name,
      title: `Attendance Summary Report (${from} to ${to})`,
      subtitle: `Org ID: ${activeOrgId}`,
      columns: cols,
      rows: toArrayRows(),
      fileName: `${activeOrgId}-attendance-report.pdf`,
    });
  });

  container.querySelector('#rep-json-backup').addEventListener('click', async () => {
    try {
      const data = await exportFullOrganizationData(activeOrgId);
      downloadJsonBackup(data, `${activeOrgId}-full-backup-${todayIsoDate()}.json`);
      await logOrgAudit({
        orgId: activeOrgId,
        action: 'EXPORT_ORG_BACKUP',
        entityType: 'organizations',
        entityId: activeOrgId,
        details: 'Exported full JSON organization backup',
      });
      showToast('Full organization JSON backup downloaded.', 'success');
    } catch (err) {
      showToast(err.message || 'Export failed.', 'danger');
    }
  });

  renderPreview();
}

async function renderOwnerAuditAndAnomalies(container) {
  const { activeOrgId } = getState();
  const [audits, anomalies] = await Promise.all([
    fetchOrgCollection(activeOrgId, 'auditLogs'),
    fetchOrgCollection(activeOrgId, 'anomalies'),
  ]);
  audits.sort((a, b) => (b.timestamp?.toMillis?.() || 0) - (a.timestamp?.toMillis?.() || 0));
  anomalies.sort((a, b) => (b.createdAt?.toMillis?.() || 0) - (a.createdAt?.toMillis?.() || 0));

  container.innerHTML = `
    <div class="stack-lg">
      <div class="page-header">
        <div>
          <h1 class="page-title">Audit Logs &amp; Anomaly Detection</h1>
          <p class="page-subtitle">Immutable change history and automated scan anomaly alerts.</p>
        </div>
      </div>

      <section class="panel stack-md">
        <h2 class="panel-title">Detected Attendance Anomalies (${anomalies.length})</h2>
        ${
          anomalies.length === 0
            ? renderEmptyState({ title: 'No anomalies detected', description: 'Duplicate scans, revoked QR attempts, cross-org scans, and geofence violations appear here.' })
            : `<div class="table-wrap"><table class="data-table">
                <thead><tr><th>Type</th><th>Details</th><th>Time</th></tr></thead>
                <tbody>
                  ${anomalies
                    .slice(0, 30)
                    .map(
                      (an) => `<tr><td class="mono">${escapeHtml(an.type)}</td><td>${escapeHtml(an.details)}</td><td class="mono">${escapeHtml(formatDateTime(an.createdAt))}</td></tr>`
                    )
                    .join('')}
                </tbody>
              </table></div>`
        }
      </section>

      <section class="panel stack-md">
        <h2 class="panel-title">Immutable Organization Audit Trail (${audits.length})</h2>
        ${
          audits.length === 0
            ? renderEmptyState({ title: 'No audit events', description: 'Administrative and attendance edits are logged here.' })
            : `<div class="table-wrap"><table class="data-table">
                <thead><tr><th>Action</th><th>Actor</th><th>Details</th><th>Before / After</th><th>Time</th></tr></thead>
                <tbody>
                  ${audits
                    .slice(0, 50)
                    .map(
                      (a) => `
                    <tr>
                      <td><strong>${escapeHtml(a.action)}</strong><br><span class="mono" style="font-size:0.75rem;">${escapeHtml(a.entityType)}</span></td>
                      <td>${escapeHtml(a.actorName || a.actorEmail)}<br><span style="font-size:0.75rem;color:var(--text-muted);">${escapeHtml(a.actorDesignation || '')}</span></td>
                      <td style="font-size:0.8125rem;">${escapeHtml(a.details || '')}</td>
                      <td class="mono" style="font-size:0.7rem;max-width:220px;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(a.after || a.before || '—')}</td>
                      <td class="mono" style="font-size:0.75rem;">${escapeHtml(formatDateTime(a.timestamp))}</td>
                    </tr>
                  `
                    )
                    .join('')}
                </tbody>
              </table></div>`
        }
      </section>
    </div>
  `;
}
