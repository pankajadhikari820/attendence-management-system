import { Chart, registerables } from 'chart.js';
import { fetchOrgCollection } from '../services/firestoreService.js';
import { filterMembersByManagerScope } from '../services/hierarchyService.js';
import {
  reviewOrgLeaveRequest,
  reviewOrgCorrectionRequest,
} from '../services/attendanceService.js';
import {
  exportAttendancePdf,
  exportAttendanceExcel,
  exportAttendanceCsv,
} from '../services/reportService.js';
import {
  calculateAttendanceSummary,
  escapeHtml,
  todayIsoDate,
} from '../utils/attendanceMath.js';
import { icon } from '../utils/icons.js';
import { showToast, renderEmptyState, renderTableSkeleton } from '../utils/ui.js';
import { getState } from '../state/store.js';
import { renderScannerWorkspace, renderManualBatchWorkspace, cleanupScannerStreams } from './scanAttendanceView.js';
import { renderMemberView } from './memberView.js';
import { renderProfileView, renderNotificationsView } from './sharedViews.js';

Chart.register(...registerables);

let activeCharts = [];
export function cleanupManagerListeners() {
  cleanupScannerStreams();
  activeCharts.forEach((c) => c.destroy());
  activeCharts = [];
}

export async function renderManagerView(container, viewKey) {
  cleanupManagerListeners();
  const { resolvedPermissions } = getState();
  const perms = resolvedPermissions || {};

  switch (viewKey) {
    case 'overview':
      return renderManagerOverview(container);
    case 'scanner':
      if (!perms.canTakeAttendance) return renderManagerOverview(container);
      return renderScannerWorkspace(container);
    case 'manual':
      if (!perms.canTakeAttendance) return renderManagerOverview(container);
      return renderManualBatchWorkspace(container);
    case 'members':
      return renderManagerScopedMembers(container);
    case 'requests':
      if (!perms.canApproveLeaves && !perms.canApproveCorrections) return renderManagerOverview(container);
      return renderManagerScopedRequests(container);
    case 'reports':
      if (!perms.canViewReports) return renderManagerOverview(container);
      return renderManagerScopedReports(container);
    case 'my-attendance':
      return renderMemberView(container, 'overview');
    case 'my-qr':
      return renderMemberView(container, 'my-qr');
    case 'notifications':
      return renderNotificationsView(container);
    case 'profile':
      return renderProfileView(container);
    default:
      return renderManagerOverview(container);
  }
}

async function renderManagerOverview(container) {
  const { activeOrgId, activeOrg, activeMember, resolvedPermissions, settings } = getState();
  const threshold = Number(settings?.thresholdPct || 75);

  container.innerHTML = `
    <div class="stack-lg">
      <div class="page-header">
        <div>
          <h1 class="page-title">${escapeHtml(activeMember?.designationName || 'Supervisor')} Dashboard</h1>
          <p class="page-subtitle">
            ${escapeHtml(activeOrg?.name)} · Scope: <strong style="text-transform:capitalize;">${escapeHtml(resolvedPermissions?.scope || 'team')}</strong>
            · <span class="mono">${escapeHtml(activeMember?.memberPublicId || '')}</span>
          </p>
        </div>
        <div class="page-actions">
          ${
            resolvedPermissions?.canTakeAttendance
              ? `<button type="button" class="btn btn-secondary" id="mgr-go-manual">Manual Batch</button>
                 <button type="button" class="btn btn-primary" id="mgr-go-scan">${icon('qr', 16)} Scan Member QR</button>`
              : `<button type="button" class="btn btn-primary" id="mgr-go-myqr">${icon('qr', 16)} My QR Card</button>`
          }
        </div>
      </div>
      <div id="mgr-overview-body">${renderTableSkeleton(4, 4)}</div>
    </div>
  `;

  container.querySelector('#mgr-go-scan')?.addEventListener('click', () => {
    window.dispatchEvent(new CustomEvent('smartattend:navigate', { detail: 'scanner' }));
  });
  container.querySelector('#mgr-go-manual')?.addEventListener('click', () => {
    window.dispatchEvent(new CustomEvent('smartattend:navigate', { detail: 'manual' }));
  });
  container.querySelector('#mgr-go-myqr')?.addEventListener('click', () => {
    window.dispatchEvent(new CustomEvent('smartattend:navigate', { detail: 'my-qr' }));
  });

  const body = container.querySelector('#mgr-overview-body');
  try {
    const [allMembers, records, leaves, corrections] = await Promise.all([
      fetchOrgCollection(activeOrgId, 'members'),
      fetchOrgCollection(activeOrgId, 'attendanceRecords'),
      fetchOrgCollection(activeOrgId, 'leaveRequests'),
      fetchOrgCollection(activeOrgId, 'correctionRequests'),
    ]);

    const scopedMembers = filterMembersByManagerScope(allMembers, activeMember, resolvedPermissions).filter(
      (m) => m.status === 'active'
    );
    const scopedUids = new Set(scopedMembers.map((m) => m.uid));
    const scopedRecords = records.filter((r) => scopedUids.has(r.memberUid));
    const summary = calculateAttendanceSummary(scopedRecords, settings);
    const today = todayIsoDate();
    const presentToday = scopedRecords.filter(
      (r) => r.date === today && ['present', 'late'].includes(r.status)
    ).length;

    const pendingLeaves = leaves.filter((l) => l.status === 'pending' && scopedUids.has(l.memberUid)).length;
    const pendingCorr = corrections.filter((c) => c.status === 'pending' && scopedUids.has(c.memberUid)).length;

    body.innerHTML = `
      <div class="stack-lg">
        <div class="grid-kpi">
          <div class="kpi-card">
            <span class="kpi-label">Team / Scope Members</span>
            <span class="kpi-value">${scopedMembers.length}</span>
            <span class="kpi-foot">Authorized ${escapeHtml(resolvedPermissions?.scope || 'team')} view</span>
          </div>
          <div class="kpi-card">
            <span class="kpi-label">Present Today</span>
            <span class="kpi-value">${presentToday}</span>
            <span class="kpi-foot">Out of ${scopedMembers.length} active</span>
          </div>
          <div class="kpi-card">
            <span class="kpi-label">Team Attendance %</span>
            <span class="kpi-value">${scopedRecords.length ? summary.percentage + '%' : '—'}</span>
            <span class="kpi-foot">Policy threshold: ${threshold}%</span>
          </div>
          <div class="kpi-card">
            <span class="kpi-label">Pending Reviews</span>
            <span class="kpi-value">${pendingLeaves + pendingCorr}</span>
            <span class="kpi-foot">${pendingLeaves} leaves · ${pendingCorr} corrections</span>
          </div>
        </div>

        <section class="panel stack-md">
          <div class="panel-header">
            <h2 class="panel-title">Scoped Team Attendance Trend</h2>
            <span class="panel-meta">Recent dates</span>
          </div>
          <div class="chart-box"><canvas id="chart-mgr-trend"></canvas></div>
        </section>
      </div>
    `;

    const byDate = new Map();
    for (const r of scopedRecords) {
      if (!r.date) continue;
      const arr = byDate.get(r.date) || [];
      arr.push(r);
      byDate.set(r.date, arr);
    }
    const dates = [...byDate.keys()].sort().slice(-10);
    const vals = dates.map((d) => calculateAttendanceSummary(byDate.get(d), settings).percentage);

    const ctx = body.querySelector('#chart-mgr-trend');
    if (ctx) {
      activeCharts.push(
        new Chart(ctx, {
          type: 'line',
          data: {
            labels: dates.length ? dates : ['No Data'],
            datasets: [{ label: 'Team Attendance %', data: vals.length ? vals : [0], borderColor: '#1d4ed8', fill: false, tension: 0.25 }],
          },
          options: { responsive: true, maintainAspectRatio: false, scales: { y: { min: 0, max: 100 } } },
        })
      );
    }
  } catch (err) {
    body.innerHTML = `<div class="notice notice-danger">${escapeHtml(err.message)}</div>`;
  }
}

async function renderManagerScopedMembers(container) {
  const { activeOrgId, activeMember, resolvedPermissions, settings } = getState();
  const [allMembers, records, depts] = await Promise.all([
    fetchOrgCollection(activeOrgId, 'members'),
    fetchOrgCollection(activeOrgId, 'attendanceRecords'),
    fetchOrgCollection(activeOrgId, 'departments'),
  ]);
  const scoped = filterMembersByManagerScope(allMembers, activeMember, resolvedPermissions);
  const deptMap = new Map(depts.map((d) => [d.id, d.name]));

  container.innerHTML = `
    <div class="stack-lg">
      <div class="page-header">
        <div>
          <h1 class="page-title">Scoped Team Roster (${scoped.length})</h1>
          <p class="page-subtitle">Members within your authorized ${escapeHtml(resolvedPermissions?.scope || 'team')} scope.</p>
        </div>
      </div>
      <div class="panel">
        ${
          scoped.length === 0
            ? renderEmptyState({ title: 'No members in your scope', description: 'Subordinates or department members assigned to you appear here.' })
            : `<div class="table-wrap"><table class="data-table">
                <thead><tr><th>Member</th><th>Member ID</th><th>Designation</th><th>Department</th><th class="num">Attendance %</th></tr></thead>
                <tbody>
                  ${scoped
                    .map((m) => {
                      const recs = records.filter((r) => r.memberUid === m.uid);
                      const sum = calculateAttendanceSummary(recs, settings);
                      return `
                        <tr>
                          <td><strong>${escapeHtml(m.name)}</strong><br><span style="font-size:0.75rem;color:var(--text-muted);">${escapeHtml(m.email)}</span></td>
                          <td class="mono">${escapeHtml(m.memberPublicId)}</td>
                          <td>${escapeHtml(m.designationName || 'Member')}</td>
                          <td>${escapeHtml(deptMap.get(m.departmentId) || 'General')}</td>
                          <td class="num"><strong>${recs.length ? sum.percentage + '%' : '—'}</strong></td>
                        </tr>
                      `;
                    })
                    .join('')}
                </tbody>
              </table></div>`
        }
      </div>
    </div>
  `;
}

async function renderManagerScopedRequests(container) {
  const { activeOrgId, activeMember, resolvedPermissions, firebaseUser } = getState();
  container.innerHTML = `
    <div class="stack-lg">
      <div class="page-header">
        <div>
          <h1 class="page-title">Team Leaves &amp; Corrections</h1>
          <p class="page-subtitle">Review pending requests from members in your authorized scope.</p>
        </div>
      </div>
      <div id="mgr-req-body">${renderTableSkeleton(4, 4)}</div>
    </div>
  `;

  async function load() {
    const [allMembers, leaves, corrs] = await Promise.all([
      fetchOrgCollection(activeOrgId, 'members'),
      fetchOrgCollection(activeOrgId, 'leaveRequests'),
      fetchOrgCollection(activeOrgId, 'correctionRequests'),
    ]);
    const scopedUids = new Set(filterMembersByManagerScope(allMembers, activeMember, resolvedPermissions).map((m) => m.uid));
    const scopedLeaves = leaves.filter((l) => scopedUids.has(l.memberUid));
    const scopedCorrs = corrs.filter((c) => scopedUids.has(c.memberUid));
    const reviewerName = activeMember?.name || firebaseUser.displayName || '';

    const body = container.querySelector('#mgr-req-body');
    body.innerHTML = `
      <div class="grid-2">
        ${
          resolvedPermissions?.canApproveLeaves
            ? `<section class="panel stack-md">
                <h2 class="panel-title">Leave Queue</h2>
                ${
                  scopedLeaves.length === 0
                    ? renderEmptyState({ title: 'No leave requests', description: 'Team leave requests appear here.' })
                    : `<div class="table-wrap"><table class="data-table"><thead><tr><th>Member</th><th>Dates</th><th>Status</th><th>Action</th></tr></thead><tbody>
                        ${scopedLeaves
                          .map(
                            (l) => `<tr><td><strong>${escapeHtml(l.memberName)}</strong></td><td class="mono">${escapeHtml(l.startDate)} → ${escapeHtml(l.endDate)}</td><td>${escapeHtml(l.status)}</td><td>${l.status === 'pending' ? `<button type="button" class="btn btn-primary btn-sm" data-ml-app="${escapeHtml(l.id)}">Approve</button> <button type="button" class="btn btn-danger btn-sm" data-ml-rej="${escapeHtml(l.id)}">Reject</button>` : '—'}</td></tr>`
                          )
                          .join('')}
                      </tbody></table></div>`
                }
              </section>`
            : ''
        }
        ${
          resolvedPermissions?.canApproveCorrections
            ? `<section class="panel stack-md">
                <h2 class="panel-title">Correction Queue</h2>
                ${
                  scopedCorrs.length === 0
                    ? renderEmptyState({ title: 'No correction requests', description: 'Team attendance corrections appear here.' })
                    : `<div class="table-wrap"><table class="data-table"><thead><tr><th>Member</th><th>Date</th><th>Status</th><th>Action</th></tr></thead><tbody>
                        ${scopedCorrs
                          .map(
                            (c) => `<tr><td><strong>${escapeHtml(c.memberName)}</strong></td><td class="mono">${escapeHtml(c.date)}</td><td>${escapeHtml(c.status)}</td><td>${c.status === 'pending' ? `<button type="button" class="btn btn-primary btn-sm" data-mc-app="${escapeHtml(c.id)}">Approve</button> <button type="button" class="btn btn-danger btn-sm" data-mc-rej="${escapeHtml(c.id)}">Reject</button>` : '—'}</td></tr>`
                          )
                          .join('')}
                      </tbody></table></div>`
                }
              </section>`
            : ''
        }
      </div>
    `;

    body.querySelectorAll('[data-ml-app]').forEach((b) =>
      b.addEventListener('click', async () => {
        await reviewOrgLeaveRequest({ orgId: activeOrgId, leaveId: b.getAttribute('data-ml-app'), decision: 'approved', reviewerUid: firebaseUser.uid, reviewerName });
        showToast('Leave approved.', 'success');
        load();
      })
    );
    body.querySelectorAll('[data-ml-rej]').forEach((b) =>
      b.addEventListener('click', async () => {
        await reviewOrgLeaveRequest({ orgId: activeOrgId, leaveId: b.getAttribute('data-ml-rej'), decision: 'rejected', reviewerUid: firebaseUser.uid, reviewerName });
        showToast('Leave rejected.', 'info');
        load();
      })
    );
    body.querySelectorAll('[data-mc-app]').forEach((b) =>
      b.addEventListener('click', async () => {
        await reviewOrgCorrectionRequest({ orgId: activeOrgId, requestId: b.getAttribute('data-mc-app'), decision: 'approved', reviewerUid: firebaseUser.uid, reviewerName });
        showToast('Correction approved.', 'success');
        load();
      })
    );
    body.querySelectorAll('[data-mc-rej]').forEach((b) =>
      b.addEventListener('click', async () => {
        await reviewOrgCorrectionRequest({ orgId: activeOrgId, requestId: b.getAttribute('data-mc-rej'), decision: 'rejected', reviewerUid: firebaseUser.uid, reviewerName });
        showToast('Correction rejected.', 'info');
        load();
      })
    );
  }

  load();
}

async function renderManagerScopedReports(container) {
  const { activeOrgId, activeOrg, activeMember, resolvedPermissions, settings } = getState();
  const [allMembers, records] = await Promise.all([
    fetchOrgCollection(activeOrgId, 'members'),
    fetchOrgCollection(activeOrgId, 'attendanceRecords'),
  ]);
  const scoped = filterMembersByManagerScope(allMembers, activeMember, resolvedPermissions);

  const cols = ['Member', 'Member ID', 'Designation', 'Present', 'Late', 'Half Day', 'Absent', 'On Leave', 'Attendance %'];
  const rows = scoped.map((m) => {
    const sum = calculateAttendanceSummary(
      records.filter((r) => r.memberUid === m.uid),
      settings
    );
    return [m.name, m.memberPublicId, m.designationName || 'Member', sum.present, sum.late, sum.halfDay, sum.absent, sum.onLeave, `${sum.percentage}%`];
  });

  container.innerHTML = `
    <div class="stack-lg">
      <div class="page-header">
        <div>
          <h1 class="page-title">Scoped Team Reports</h1>
          <p class="page-subtitle">Export attendance summaries for your ${escapeHtml(resolvedPermissions?.scope || 'team')} scope.</p>
        </div>
        <div class="page-actions">
          <button type="button" class="btn btn-secondary btn-sm" id="mr-csv">CSV</button>
          <button type="button" class="btn btn-secondary btn-sm" id="mr-xlsx">Excel</button>
          <button type="button" class="btn btn-primary btn-sm" id="mr-pdf">PDF</button>
        </div>
      </div>
      <div class="panel">
        <div class="table-wrap"><table class="data-table">
          <thead><tr>${cols.map((c) => `<th>${escapeHtml(c)}</th>`).join('')}</tr></thead>
          <tbody>
            ${rows.map((r) => `<tr>${r.map((cell) => `<td>${escapeHtml(cell)}</td>`).join('')}</tr>`).join('')}
          </tbody>
        </table></div>
      </div>
    </div>
  `;

  container.querySelector('#mr-csv').addEventListener('click', () => exportAttendanceCsv({ columns: cols, rows, fileName: `${activeOrgId}-team-report.csv` }));
  container.querySelector('#mr-xlsx').addEventListener('click', () => exportAttendanceExcel({ columns: cols, rows, fileName: `${activeOrgId}-team-report.xlsx` }));
  container.querySelector('#mr-pdf').addEventListener('click', () =>
    exportAttendancePdf({
      orgName: activeOrg?.name,
      title: `Team Attendance Report — ${activeMember?.name}`,
      subtitle: `Scope: ${resolvedPermissions?.scope || 'team'}`,
      columns: cols,
      rows,
      fileName: `${activeOrgId}-team-report.pdf`,
    })
  );
}
