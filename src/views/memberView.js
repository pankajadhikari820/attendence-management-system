import QRCode from 'qrcode';
import { Chart, registerables } from 'chart.js';
import {
  fetchOrgCollection,
  fetchOrgDoc,
  createOrgDoc,
  where,
} from '../services/firestoreService.js';
import { revokeAndRegenerateMemberQr } from '../services/hierarchyService.js';
import { scanMemberQrForAttendance } from '../services/attendanceService.js';
import { uploadAttachment } from '../services/storageService.js';
import {
  exportAttendancePdf,
  exportAttendanceExcel,
  exportAttendanceCsv,
} from '../services/reportService.js';
import {
  calculateAttendanceSummary,
  calculateShortage,
  escapeHtml,
  paginateItems,
  todayIsoDate,
  isDateHolidayOrWeeklyOff,
} from '../utils/attendanceMath.js';
import { encodeMemberQrPayload } from '../utils/orgIds.js';
import { icon } from '../utils/icons.js';
import {
  showToast,
  showConfirm,
  renderEmptyState,
  renderTableSkeleton,
} from '../utils/ui.js';
import { getState, setState } from '../state/store.js';
import { renderProfileView, renderNotificationsView } from './sharedViews.js';

Chart.register(...registerables);

let activeCharts = [];

export function cleanupMemberListeners() {
  activeCharts.forEach((c) => c.destroy());
  activeCharts = [];
}

export async function renderMemberView(container, viewKey) {
  cleanupMemberListeners();
  switch (viewKey) {
    case 'overview':
      return renderMemberOverview(container);
    case 'my-qr':
      return renderMemberQrCardView(container);
    case 'history':
      return renderMemberHistoryView(container);
    case 'shortage':
      return renderMemberShortageView(container);
    case 'leaves':
      return renderMemberLeavesView(container);
    case 'corrections':
      return renderMemberCorrectionsView(container);
    case 'holidays':
      return renderMemberHolidaysView(container);
    case 'notifications':
      return renderNotificationsView(container);
    case 'profile':
      return renderProfileView(container);
    default:
      return renderMemberOverview(container);
  }
}

async function renderMemberQrIntoCanvas(canvas, orgId, member) {
  if (!canvas || !member?.qrTokenId) return;
  const payload = encodeMemberQrPayload(orgId, member.qrTokenId);
  await QRCode.toCanvas(canvas, payload, {
    width: 220,
    margin: 2,
    color: { dark: '#0f172a', light: '#ffffff' },
  });
}

function downloadCanvasQrPng(canvas, member, orgName) {
  const exportCanvas = document.createElement('canvas');
  exportCanvas.width = 400;
  exportCanvas.height = 480;
  const ctx = exportCanvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, 400, 480);

  ctx.fillStyle = '#1d4ed8';
  ctx.fillRect(0, 0, 400, 64);
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 18px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(orgName || 'SmartAttend', 200, 38);

  ctx.drawImage(canvas, 70, 84, 260, 260);

  ctx.fillStyle = '#0f172a';
  ctx.font = 'bold 17px sans-serif';
  ctx.fillText(member.name || 'Member', 200, 376);
  ctx.fillStyle = '#475569';
  ctx.font = '14px sans-serif';
  ctx.fillText(member.designationName || 'Member', 200, 400);
  ctx.fillStyle = '#1d4ed8';
  ctx.font = 'bold 15px monospace';
  ctx.fillText(member.memberPublicId || '', 200, 434);

  const link = document.createElement('a');
  link.download = `SmartAttend-QR-${member.memberPublicId || 'member'}.png`;
  link.href = exportCanvas.toDataURL('image/png');
  link.click();
}

async function renderMemberOverview(container) {
  const { activeOrgId, activeOrg, activeMember, settings, firebaseUser } = getState();
  const threshold = Number(settings?.thresholdPct || 75);

  container.innerHTML = `
    <div class="stack-lg">
      <div class="page-header">
        <div>
          <h1 class="page-title">Member Workspace</h1>
          <p class="page-subtitle">
            ${escapeHtml(activeOrg?.name || activeOrgId)} · ${escapeHtml(activeMember?.designationName || 'Member')}
            · <span class="mono">${escapeHtml(activeMember?.memberPublicId || '')}</span>
          </p>
        </div>
        <div class="page-actions">
          <button type="button" class="btn btn-secondary" id="mem-go-qr">${icon('qr', 16)} My QR Card</button>
          <button type="button" class="btn btn-primary" id="mem-go-leave">${icon('file', 16)} Request Leave</button>
        </div>
      </div>
      <div id="mem-overview-body">${renderTableSkeleton(4, 4)}</div>
    </div>
  `;

  container.querySelector('#mem-go-qr').addEventListener('click', () => {
    window.dispatchEvent(new CustomEvent('smartattend:navigate', { detail: 'my-qr' }));
  });
  container.querySelector('#mem-go-leave').addEventListener('click', () => {
    window.dispatchEvent(new CustomEvent('smartattend:navigate', { detail: 'leaves' }));
  });

  const body = container.querySelector('#mem-overview-body');
  try {
    const [records, holidays, deptDoc, branchDoc, managerDoc] = await Promise.all([
      fetchOrgCollection(activeOrgId, 'attendanceRecords', [where('memberUid', '==', firebaseUser.uid)]),
      fetchOrgCollection(activeOrgId, 'holidays'),
      activeMember?.departmentId ? fetchOrgDoc(activeOrgId, 'departments', activeMember.departmentId) : null,
      activeMember?.branchId ? fetchOrgDoc(activeOrgId, 'branches', activeMember.branchId) : null,
      activeMember?.parentMemberId ? fetchOrgDoc(activeOrgId, 'members', activeMember.parentMemberId).catch(() => null) : null,
    ]);

    const summary = calculateAttendanceSummary(records, settings);
    const shortage = calculateShortage(summary.effectiveAttended, summary.workingDaysRecorded, threshold);
    const isLow = summary.workingDaysRecorded > 0 && shortage.isBelowThreshold;

    const nowDate = new Date();
    let calYear = nowDate.getFullYear();
    let calMonth = nowDate.getMonth();

    body.innerHTML = `
      <div class="stack-lg">
        ${
          isLow
            ? `<div class="notice notice-danger notice-row" role="alert">
                <div>
                  <strong style="color:var(--danger);">Low Attendance Warning (Below ${threshold}%)</strong>
                  <p style="font-size:0.875rem;color:var(--text-secondary);margin-top:2px;">
                    Your attendance is ${summary.percentage}% (${summary.effectiveAttended}/${summary.workingDaysRecorded}). ${escapeHtml(shortage.statusLabel)}.
                  </p>
                </div>
                <button type="button" class="btn btn-secondary btn-sm" id="mem-warn-calc">Open Calculator</button>
              </div>`
            : ''
        }

        <div class="grid-kpi">
          <div class="kpi-card">
            <span class="kpi-label">Attendance %</span>
            <span class="kpi-value ${isLow ? 'status-danger' : 'status-success'}">${summary.workingDaysRecorded ? summary.percentage + '%' : '—'}</span>
            <span class="kpi-foot">${summary.effectiveAttended} / ${summary.workingDaysRecorded} working days</span>
          </div>
          <div class="kpi-card">
            <span class="kpi-label">Present / Late / Half-Day</span>
            <span class="kpi-value">${summary.present + summary.late + summary.halfDay}</span>
            <span class="kpi-foot">${summary.present} present · ${summary.late} late · ${summary.halfDay} half</span>
          </div>
          <div class="kpi-card">
            <span class="kpi-label">Absent / On Leave</span>
            <span class="kpi-value">${summary.absent}</span>
            <span class="kpi-foot">${summary.onLeave} approved leave · holidays excluded</span>
          </div>
          <div class="kpi-card">
            <span class="kpi-label">Working Hours &amp; OT</span>
            <span class="kpi-value">${summary.totalWorkingHours}h</span>
            <span class="kpi-foot">${summary.totalOvertimeHours}h overtime logged</span>
          </div>
        </div>

        <div class="grid-2">
          <section class="member-id-card">
            <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:1rem;">
              <div>
                <h2 class="panel-title">Digital Attendance ID</h2>
                <p class="panel-meta">${escapeHtml(activeOrg?.name)} (${escapeHtml(activeOrgId)})</p>
              </div>
              <span class="mono" style="font-size:0.8125rem;font-weight:700;color:var(--accent-text);">${escapeHtml(activeMember?.memberPublicId || '')}</span>
            </div>

            <div style="display:flex;flex-wrap:wrap;gap:1.25rem;align-items:center;">
              <div class="qr-frame">
                <canvas id="ov-member-qr" width="160" height="160" aria-label="Member QR Code"></canvas>
              </div>
              <div class="stack-sm" style="flex:1;min-width:190px;font-size:0.875rem;">
                <div><strong>Name:</strong> ${escapeHtml(activeMember?.name || firebaseUser.displayName)}</div>
                <div><strong>Designation:</strong> ${escapeHtml(activeMember?.designationName || 'Member')}</div>
                <div><strong>Department:</strong> ${escapeHtml(deptDoc?.name || 'General')}</div>
                <div><strong>Branch:</strong> ${escapeHtml(branchDoc?.name || 'Main')}</div>
                <div><strong>Reporting To:</strong> ${escapeHtml(managerDoc?.name || 'Organization Head')}</div>
                <div style="display:flex;gap:0.5rem;flex-wrap:wrap;padding-top:0.35rem;">
                  <button type="button" class="btn btn-primary btn-sm" id="ov-dl-qr">${icon('download', 14)} Download QR PNG</button>
                  ${
                    activeOrg?.policies?.allowSelfCheckIn
                      ? `<button type="button" class="btn btn-secondary btn-sm" id="ov-self-checkin">${icon('check', 14)} Self Check-In</button>`
                      : ''
                  }
                </div>
              </div>
            </div>
          </section>

          <section class="panel stack-md">
            <div class="panel-header">
              <h2 class="panel-title">Status Breakdown</h2>
              <span class="panel-meta">Policy target ${threshold}%</span>
            </div>
            <div class="chart-box"><canvas id="chart-mem-dist"></canvas></div>
          </section>
        </div>

        <section class="panel stack-md">
          <div class="panel-header">
            <h2 class="panel-title" id="cal-month-title">Monthly Attendance Calendar</h2>
            <div style="display:flex;gap:0.375rem;">
              <button type="button" class="btn btn-secondary btn-sm" id="cal-prev">Prev</button>
              <button type="button" class="btn btn-secondary btn-sm" id="cal-next">Next</button>
            </div>
          </div>
          <div id="mem-calendar-slot"></div>
        </section>
      </div>
    `;

    body.querySelector('#mem-warn-calc')?.addEventListener('click', () => {
      window.dispatchEvent(new CustomEvent('smartattend:navigate', { detail: 'shortage' }));
    });

    const qrCanvas = body.querySelector('#ov-member-qr');
    await renderMemberQrIntoCanvas(qrCanvas, activeOrgId, activeMember);

    body.querySelector('#ov-dl-qr')?.addEventListener('click', () => {
      downloadCanvasQrPng(qrCanvas, activeMember, activeOrg?.name);
    });

    body.querySelector('#ov-self-checkin')?.addEventListener('click', async () => {
      try {
        let coords = null;
        if (activeOrg?.policies?.geofence?.enabled && navigator.geolocation) {
          coords = await new Promise((resolve, reject) =>
            navigator.geolocation.getCurrentPosition(
              (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude }),
              (err) => reject(new Error(`Location required for self check-in: ${err.message}`)),
              { enableHighAccuracy: true, timeout: 8000 }
            )
          );
        }
        const res = await scanMemberQrForAttendance({
          orgId: activeOrgId,
          rawScanInput: activeMember.memberPublicId,
          scannerUid: firebaseUser.uid,
          scannerName: activeMember.name,
          shiftId: activeMember.shiftId || 'shift_standard',
          actionType: 'check_in',
          date: todayIsoDate(),
          coords,
        });
        showToast(`Self check-in recorded (${res.status}).`, 'success');
        renderMemberOverview(container);
      } catch (err) {
        showToast(err.message || 'Self check-in failed.', 'danger');
      }
    });

    const recordByDate = new Map(records.map((r) => [r.date, r]));
    function renderCalendar() {
      const monthName = new Date(calYear, calMonth, 1).toLocaleString(undefined, { month: 'long', year: 'numeric' });
      body.querySelector('#cal-month-title').textContent = `Attendance Calendar · ${monthName}`;
      const firstDay = new Date(calYear, calMonth, 1).getDay();
      const daysInMonth = new Date(calYear, calMonth + 1, 0).getDate();
      const headers = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
        .map((d) => `<div class="cal-head">${d}</div>`)
        .join('');

      const blanks = Array.from({ length: firstDay })
        .map(() => `<div class="cal-cell empty"></div>`)
        .join('');

      const cells = Array.from({ length: daysInMonth })
        .map((_, idx) => {
          const dayNum = idx + 1;
          const iso = `${calYear}-${String(calMonth + 1).padStart(2, '0')}-${String(dayNum).padStart(2, '0')}`;
          const rec = recordByDate.get(iso);
          const off = isDateHolidayOrWeeklyOff(iso, holidays, settings?.weeklyOffDays || [0], activeMember?.departmentId);
          const st = rec?.status || (off.isOff ? off.reason : '');
          const label = rec?.status
            ? rec.status.replace('_', ' ')
            : off.isOff
            ? off.label
            : '';
          return `
            <div class="cal-cell ${st ? 'status-' + escapeHtml(st) : ''}">
              <strong>${dayNum}</strong>
              <span style="font-size:0.65rem;text-transform:capitalize;color:var(--text-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(label)}</span>
            </div>
          `;
        })
        .join('');

      body.querySelector('#mem-calendar-slot').innerHTML = `<div class="cal-grid">${headers}${blanks}${cells}</div>`;
    }

    body.querySelector('#cal-prev').addEventListener('click', () => {
      calMonth -= 1;
      if (calMonth < 0) {
        calMonth = 11;
        calYear -= 1;
      }
      renderCalendar();
    });
    body.querySelector('#cal-next').addEventListener('click', () => {
      calMonth += 1;
      if (calMonth > 11) {
        calMonth = 0;
        calYear += 1;
      }
      renderCalendar();
    });
    renderCalendar();

    const chartCtx = body.querySelector('#chart-mem-dist');
    if (chartCtx) {
      activeCharts.push(
        new Chart(chartCtx, {
          type: 'bar',
          data: {
            labels: ['Present', 'Late', 'Half Day', 'On Leave', 'Absent'],
            datasets: [
              {
                label: 'Days',
                data: [summary.present, summary.late, summary.halfDay, summary.onLeave, summary.absent],
                backgroundColor: ['#16a34a', '#d97706', '#f59e0b', '#3b82f6', '#dc2626'],
                borderRadius: 6,
              },
            ],
          },
          options: { responsive: true, maintainAspectRatio: false, scales: { y: { beginAtZero: true } } },
        })
      );
    }
  } catch (err) {
    body.innerHTML = `<div class="notice notice-danger">${escapeHtml(err.message)}</div>`;
  }
}

async function renderMemberQrCardView(container) {
  const { activeOrgId, activeOrg, activeMember } = getState();
  container.innerHTML = `
    <div class="stack-lg">
      <div class="page-header">
        <div>
          <h1 class="page-title">My Personal QR Attendance Card</h1>
          <p class="page-subtitle">Present this QR code to your authorized supervisor/scanner. Contains zero sensitive personal details.</p>
        </div>
      </div>

      <div class="grid-2">
        <section class="panel stack-md" style="align-items:center;text-align:center;">
          <div class="qr-frame">
            <canvas id="big-member-qr" width="240" height="240"></canvas>
          </div>
          <div>
            <strong style="font-size:1.125rem;display:block;">${escapeHtml(activeMember?.name || '')}</strong>
            <span class="mono" style="color:var(--accent-text);font-weight:700;">${escapeHtml(activeMember?.memberPublicId || '')}</span>
          </div>
          <div style="display:flex;gap:0.5rem;flex-wrap:wrap;justify-content:center;">
            <button type="button" class="btn btn-primary" id="qr-dl-btn">${icon('download', 16)} Download QR PNG</button>
            <button type="button" class="btn btn-secondary" id="qr-copy-id">${icon('copy', 16)} Copy Member ID</button>
            <button type="button" class="btn btn-ghost" id="qr-rotate-btn">${icon('refresh', 16)} Revoke &amp; Regenerate QR</button>
          </div>
        </section>

        <section class="panel stack-md">
          <h2 class="panel-title">Security &amp; Verification</h2>
          <div class="notice">
            <strong style="font-size:0.875rem;">Opaque Revocable Token</strong>
            <span style="font-size:0.8125rem;color:var(--text-secondary);">
              Your QR embeds only <span class="mono">{ v: 2, type: "member_id", orgId: "${escapeHtml(activeOrgId)}", token: "..." }</span>. If your printed badge is lost, click "Revoke &amp; Regenerate QR" to invalidate the old code immediately.
            </span>
          </div>
          <div style="font-size:0.875rem;color:var(--text-secondary);" class="stack-sm">
            <div><strong>Organization:</strong> ${escapeHtml(activeOrg?.name)} (<span class="mono">${escapeHtml(activeOrgId)}</span>)</div>
            <div><strong>Designation:</strong> ${escapeHtml(activeMember?.designationName || 'Member')}</div>
            <div><strong>External / Roll / Emp ID:</strong> <span class="mono">${escapeHtml(activeMember?.externalId || '—')}</span></div>
            <div><strong>Status:</strong> <span class="status-text status-success" style="text-transform:capitalize;">${escapeHtml(activeMember?.status || 'active')}</span></div>
          </div>
        </section>
      </div>
    </div>
  `;

  const canvas = container.querySelector('#big-member-qr');
  await renderMemberQrIntoCanvas(canvas, activeOrgId, activeMember);

  container.querySelector('#qr-dl-btn').addEventListener('click', () => {
    downloadCanvasQrPng(canvas, activeMember, activeOrg?.name);
  });

  container.querySelector('#qr-copy-id').addEventListener('click', async () => {
    await navigator.clipboard.writeText(activeMember?.memberPublicId || '').catch(() => {});
    showToast('Member ID copied to clipboard.', 'success');
  });

  container.querySelector('#qr-rotate-btn').addEventListener('click', async () => {
    const ok = await showConfirm({
      title: 'Revoke & Regenerate QR Token?',
      message: 'Your previous QR badge will stop working immediately once a new token is generated.',
      confirmLabel: 'Regenerate QR',
    });
    if (!ok) return;
    try {
      const newToken = await revokeAndRegenerateMemberQr(activeOrgId, activeMember);
      const updated = { ...activeMember, qrTokenId: newToken };
      setState({ activeMember: updated });
      await renderMemberQrIntoCanvas(canvas, activeOrgId, updated);
      showToast('New QR code generated; previous token revoked.', 'success');
    } catch (err) {
      showToast(err.message || 'Failed to rotate QR token.', 'danger');
    }
  });
}

async function renderMemberHistoryView(container) {
  const { activeOrgId, activeOrg, activeMember, settings, firebaseUser } = getState();
  let statusFilter = 'all';
  let page = 1;

  container.innerHTML = `
    <div class="stack-lg">
      <div class="page-header">
        <div>
          <h1 class="page-title">My Attendance History</h1>
          <p class="page-subtitle">Filter your recorded attendance and download personal CSV, Excel, or PDF statements.</p>
        </div>
        <div class="page-actions">
          <button type="button" class="btn btn-secondary btn-sm" id="mh-csv">CSV</button>
          <button type="button" class="btn btn-secondary btn-sm" id="mh-excel">Excel</button>
          <button type="button" class="btn btn-primary btn-sm" id="mh-pdf">PDF</button>
        </div>
      </div>
      <div class="panel stack-md">
        <div class="toolbar">
          <div class="segmented-bar" id="mh-status-tabs">
            ${['all', 'present', 'late', 'half_day', 'on_leave', 'absent']
              .map((s) => `<button type="button" class="segmented-btn ${s === 'all' ? 'active' : ''}" data-st="${s}">${s.replace('_', ' ')}</button>`)
              .join('')}
          </div>
        </div>
        <div id="mh-table-slot">${renderTableSkeleton(5, 5)}</div>
      </div>
    </div>
  `;

  const records = await fetchOrgCollection(activeOrgId, 'attendanceRecords', [
    where('memberUid', '==', firebaseUser.uid),
  ]);
  records.sort((a, b) => String(b.date).localeCompare(String(a.date)));

  function filtered() {
    return statusFilter === 'all' ? records : records.filter((r) => r.status === statusFilter);
  }

  function renderTable() {
    const list = filtered();
    const paged = paginateItems(list, page, 12);
    const slot = container.querySelector('#mh-table-slot');
    if (paged.totalItems === 0) {
      slot.innerHTML = renderEmptyState({
        title: 'No attendance records match this filter',
        description: 'Recorded check-ins, manual marks, and approved leaves will appear here.',
      });
      return;
    }

    slot.innerHTML = `
      <div class="table-wrap">
        <table class="data-table">
          <thead><tr><th>Date</th><th>Status</th><th>Method</th><th class="num">Worked</th><th class="num">Overtime</th><th>Marked By</th></tr></thead>
          <tbody>
            ${paged.items
              .map(
                (r) => `
              <tr>
                <td class="mono">${escapeHtml(r.date)}</td>
                <td><span class="status-text ${r.status === 'present' ? 'status-success' : r.status === 'absent' ? 'status-danger' : 'status-warning'}" style="text-transform:capitalize;">${escapeHtml((r.status || '').replace('_', ' '))}</span></td>
                <td style="text-transform:capitalize;">${escapeHtml((r.method || 'scan').replace('_', ' '))}</td>
                <td class="num">${r.workingMinutes ? `${Math.floor(r.workingMinutes / 60)}h ${r.workingMinutes % 60}m` : '—'}</td>
                <td class="num">${r.overtimeMinutes ? `${r.overtimeMinutes}m` : '—'}</td>
                <td>${escapeHtml(r.markedByName || 'System')}</td>
              </tr>
            `
              )
              .join('')}
          </tbody>
        </table>
      </div>
      <div class="pagination">
        <span>Showing ${paged.items.length} of ${paged.totalItems} records</span>
        <div class="pagination-controls">
          <button type="button" class="btn btn-secondary btn-sm" id="mh-prev" ${paged.page <= 1 ? 'disabled' : ''}>Prev</button>
          <span class="mono">${paged.page}/${paged.totalPages}</span>
          <button type="button" class="btn btn-secondary btn-sm" id="mh-next" ${paged.page >= paged.totalPages ? 'disabled' : ''}>Next</button>
        </div>
      </div>
    `;

    slot.querySelector('#mh-prev')?.addEventListener('click', () => {
      page = Math.max(1, page - 1);
      renderTable();
    });
    slot.querySelector('#mh-next')?.addEventListener('click', () => {
      page = Math.min(paged.totalPages, page + 1);
      renderTable();
    });
  }

  container.querySelectorAll('[data-st]').forEach((btn) => {
    btn.addEventListener('click', () => {
      statusFilter = btn.getAttribute('data-st');
      page = 1;
      container.querySelectorAll('[data-st]').forEach((b) => b.classList.toggle('active', b === btn));
      renderTable();
    });
  });

  const exportRows = () =>
    filtered().map((r) => [
      r.date,
      r.status,
      r.method || 'scan',
      r.workingMinutes ? `${r.workingMinutes} min` : '0',
      r.overtimeMinutes ? `${r.overtimeMinutes} min` : '0',
      r.markedByName || 'System',
    ]);
  const cols = ['Date', 'Status', 'Method', 'Worked', 'Overtime', 'Marked By'];

  container.querySelector('#mh-csv').addEventListener('click', () => {
    exportAttendanceCsv({ columns: cols, rows: exportRows(), fileName: `attendance-${activeMember?.memberPublicId}.csv` });
  });
  container.querySelector('#mh-excel').addEventListener('click', () => {
    exportAttendanceExcel({ columns: cols, rows: exportRows(), fileName: `attendance-${activeMember?.memberPublicId}.xlsx` });
  });
  container.querySelector('#mh-pdf').addEventListener('click', () => {
    const sum = calculateAttendanceSummary(records, settings);
    exportAttendancePdf({
      orgName: activeOrg?.name,
      title: `Attendance History — ${activeMember?.name}`,
      subtitle: `${activeMember?.memberPublicId} · Overall ${sum.percentage}%`,
      columns: cols,
      rows: exportRows(),
      fileName: `attendance-${activeMember?.memberPublicId}.pdf`,
    });
  });

  renderTable();
}

async function renderMemberShortageView(container) {
  const { activeOrgId, settings, firebaseUser } = getState();
  const threshold = Number(settings?.thresholdPct || 75);
  const records = await fetchOrgCollection(activeOrgId, 'attendanceRecords', [
    where('memberUid', '==', firebaseUser.uid),
  ]);
  const summary = calculateAttendanceSummary(records, settings);
  const shortage = calculateShortage(summary.effectiveAttended, summary.workingDaysRecorded, threshold);

  container.innerHTML = `
    <div class="stack-lg">
      <div class="page-header">
        <div>
          <h1 class="page-title">Attendance Shortage &amp; Goal Calculator</h1>
          <p class="page-subtitle">Measure exact days required to stay above your organization's ${threshold}% policy.</p>
        </div>
      </div>

      <div class="grid-2">
        <section class="panel stack-md">
          <h2 class="panel-title">Your Live Status</h2>
          <div class="kpi-value ${shortage.isBelowThreshold ? 'status-danger' : 'status-success'}">${summary.percentage}%</div>
          <p style="font-size:0.9375rem;color:var(--text-secondary);">
            Attended <strong>${summary.effectiveAttended}</strong> out of <strong>${summary.workingDaysRecorded}</strong> working days.
          </p>
          <div class="notice ${shortage.isBelowThreshold ? 'notice-danger' : 'notice-success'}">
            <strong>${escapeHtml(shortage.statusLabel)}</strong>
          </div>
        </section>

        <section class="panel stack-md">
          <h2 class="panel-title">Interactive What-If Simulator</h2>
          <div class="form-grid form-grid-3">
            <div class="field">
              <label class="field-label" for="sim-att">Attended</label>
              <input class="input mono" id="sim-att" type="number" min="0" step="0.5" value="${summary.effectiveAttended}" />
            </div>
            <div class="field">
              <label class="field-label" for="sim-tot">Total Working</label>
              <input class="input mono" id="sim-tot" type="number" min="0" value="${summary.workingDaysRecorded}" />
            </div>
            <div class="field">
              <label class="field-label" for="sim-tgt">Target %</label>
              <input class="input mono" id="sim-tgt" type="number" min="1" max="99" value="${threshold}" />
            </div>
          </div>
          <div id="sim-out" class="notice"></div>
        </section>
      </div>
    </div>
  `;

  function updateSim() {
    const att = Number(container.querySelector('#sim-att').value);
    const tot = Number(container.querySelector('#sim-tot').value);
    const tgt = Number(container.querySelector('#sim-tgt').value);
    const res = calculateShortage(att, tot, tgt);
    const out = container.querySelector('#sim-out');
    out.className = `notice ${res.isBelowThreshold ? 'notice-warning' : 'notice-success'}`;
    out.innerHTML = `<strong>${res.currentPct}% current</strong><span style="font-size:0.875rem;">${escapeHtml(res.statusLabel)}</span>`;
  }
  ['#sim-att', '#sim-tot', '#sim-tgt'].forEach((sel) => {
    container.querySelector(sel).addEventListener('input', updateSim);
  });
  updateSim();
}

async function renderMemberLeavesView(container) {
  const { activeOrgId, activeMember, firebaseUser } = getState();
  const bal = activeMember?.leaveBalance || { annual: 12, sick: 8, casual: 6 };

  container.innerHTML = `
    <div class="stack-lg">
      <div class="page-header">
        <div>
          <h1 class="page-title">Leave Requests &amp; Balances</h1>
          <p class="page-subtitle">Approved leaves are automatically reflected in your attendance without absence penalties.</p>
        </div>
      </div>

      <div class="grid-kpi">
        <div class="kpi-card"><span class="kpi-label">Annual Leave Balance</span><span class="kpi-value">${bal.annual ?? 12}</span><span class="kpi-foot">days allocation</span></div>
        <div class="kpi-card"><span class="kpi-label">Sick Leave Balance</span><span class="kpi-value">${bal.sick ?? 8}</span><span class="kpi-foot">days allocation</span></div>
        <div class="kpi-card"><span class="kpi-label">Casual Leave Balance</span><span class="kpi-value">${bal.casual ?? 6}</span><span class="kpi-foot">days allocation</span></div>
      </div>

      <div class="grid-2">
        <section class="panel stack-md">
          <h2 class="panel-title">Apply for Leave</h2>
          <form id="mem-leave-form" class="stack-md">
            <div class="field">
              <label class="field-label" for="lv-type">Leave Category</label>
              <select class="select" id="lv-type" name="leaveType">
                <option value="annual">Annual / General Leave</option>
                <option value="sick">Medical / Sick Leave</option>
                <option value="casual">Casual / Personal Leave</option>
                <option value="academic">Academic / Official Duty</option>
              </select>
            </div>
            <div class="form-grid form-grid-2">
              <div class="field">
                <label class="field-label" for="lv-start">Start Date</label>
                <input class="input mono" id="lv-start" name="startDate" type="date" required value="${todayIsoDate()}" />
              </div>
              <div class="field">
                <label class="field-label" for="lv-end">End Date</label>
                <input class="input mono" id="lv-end" name="endDate" type="date" required value="${todayIsoDate()}" />
              </div>
            </div>
            <div class="field">
              <label class="field-label" for="lv-reason">Reason</label>
              <textarea class="textarea" id="lv-reason" name="reason" required maxlength="600" placeholder="Provide brief context for your manager..."></textarea>
            </div>
            <div class="field">
              <label class="field-label" for="lv-file">Supporting Document (Optional, max 5MB)</label>
              <input class="input" id="lv-file" name="attachment" type="file" accept="image/*,application/pdf" />
            </div>
            <button type="submit" class="btn btn-primary" id="lv-submit-btn">Submit Leave Request</button>
          </form>
        </section>

        <section class="panel stack-md">
          <h2 class="panel-title">Submitted Leave History</h2>
          <div id="lv-list-slot">${renderTableSkeleton(4, 4)}</div>
        </section>
      </div>
    </div>
  `;

  async function loadLeaves() {
    const list = await fetchOrgCollection(activeOrgId, 'leaveRequests', [
      where('memberUid', '==', firebaseUser.uid),
    ]);
    list.sort((a, b) => (b.createdAt?.toMillis?.() || 0) - (a.createdAt?.toMillis?.() || 0));
    const slot = container.querySelector('#lv-list-slot');
    if (list.length === 0) {
      slot.innerHTML = renderEmptyState({ title: 'No leave requests yet', description: 'Submit a leave request on the left.' });
      return;
    }
    slot.innerHTML = `
      <div class="table-wrap">
        <table class="data-table">
          <thead><tr><th>Dates</th><th>Type</th><th>Status</th><th>Review Note</th></tr></thead>
          <tbody>
            ${list
              .map(
                (l) => `
              <tr>
                <td class="mono">${escapeHtml(l.startDate)} → ${escapeHtml(l.endDate)}</td>
                <td style="text-transform:capitalize;">${escapeHtml(l.leaveType || 'leave')}</td>
                <td><span class="status-text ${l.status === 'approved' ? 'status-success' : l.status === 'rejected' ? 'status-danger' : 'status-warning'}" style="text-transform:capitalize;">${escapeHtml(l.status)}</span></td>
                <td style="font-size:0.8125rem;color:var(--text-secondary);">${escapeHtml(l.reviewNote || '—')}</td>
              </tr>
            `
              )
              .join('')}
          </tbody>
        </table>
      </div>
    `;
  }

  container.querySelector('#mem-leave-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = container.querySelector('#lv-submit-btn');
    btn.disabled = true;
    btn.textContent = 'Submitting...';
    try {
      const fd = new FormData(e.target);
      const startDate = String(fd.get('startDate'));
      const endDate = String(fd.get('endDate'));
      if (endDate < startDate) throw new Error('End date must be on or after start date.');
      const file = fd.get('attachment');
      let attachmentUrl = '';
      if (file && file.size > 0) {
        const up = await uploadAttachment(`orgs/${activeOrgId}/leave-attachments`, firebaseUser.uid, file);
        attachmentUrl = up.downloadUrl;
      }
      await createOrgDoc(activeOrgId, 'leaveRequests', {
        memberUid: firebaseUser.uid,
        memberName: activeMember?.name || firebaseUser.displayName || '',
        memberPublicId: activeMember?.memberPublicId || '',
        departmentId: activeMember?.departmentId || '',
        branchId: activeMember?.branchId || '',
        leaveType: String(fd.get('leaveType')),
        startDate,
        endDate,
        reason: String(fd.get('reason')).trim(),
        attachmentUrl,
        status: 'pending',
      });
      e.target.reset();
      showToast('Leave request submitted.', 'success');
      loadLeaves();
    } catch (err) {
      showToast(err.message || 'Leave submission failed.', 'danger');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Submit Leave Request';
    }
  });

  loadLeaves();
}

async function renderMemberCorrectionsView(container) {
  const { activeOrgId, activeMember, firebaseUser } = getState();
  container.innerHTML = `
    <div class="stack-lg">
      <div class="page-header">
        <div>
          <h1 class="page-title">Attendance Correction Requests</h1>
          <p class="page-subtitle">Request adjustments for missed scans or erroneous marks with manager approval.</p>
        </div>
      </div>
      <div class="grid-2">
        <section class="panel stack-md">
          <h2 class="panel-title">Submit Correction Request</h2>
          <form id="mem-corr-form" class="stack-md">
            <div class="field">
              <label class="field-label" for="cr-rec">Select Attendance Record (or leave blank &amp; pick date)</label>
              <select class="select" id="cr-rec" name="recordId">
                <option value="">— Select existing record —</option>
              </select>
            </div>
            <div class="form-grid form-grid-2">
              <div class="field">
                <label class="field-label" for="cr-date">Date</label>
                <input class="input mono" id="cr-date" name="date" type="date" required value="${todayIsoDate()}" />
              </div>
              <div class="field">
                <label class="field-label" for="cr-status">Requested Status</label>
                <select class="select" id="cr-status" name="requestedStatus">
                  <option value="present">Present</option>
                  <option value="late">Late</option>
                  <option value="half_day">Half Day</option>
                  <option value="on_leave">On Leave</option>
                </select>
              </div>
            </div>
            <div class="field">
              <label class="field-label" for="cr-reason">Explanation</label>
              <textarea class="textarea" id="cr-reason" name="reason" required maxlength="600" placeholder="Explain why the attendance record needs correction..."></textarea>
            </div>
            <button type="submit" class="btn btn-primary" id="cr-submit">Submit Correction</button>
          </form>
        </section>

        <section class="panel stack-md">
          <h2 class="panel-title">My Correction Requests</h2>
          <div id="cr-list-slot">${renderTableSkeleton(4, 4)}</div>
        </section>
      </div>
    </div>
  `;

  const [records, corrs] = await Promise.all([
    fetchOrgCollection(activeOrgId, 'attendanceRecords', [where('memberUid', '==', firebaseUser.uid)]),
    fetchOrgCollection(activeOrgId, 'correctionRequests', [where('memberUid', '==', firebaseUser.uid)]),
  ]);

  const recSel = container.querySelector('#cr-rec');
  records
    .sort((a, b) => String(b.date).localeCompare(String(a.date)))
    .forEach((r) => {
      const opt = document.createElement('option');
      opt.value = r.id;
      opt.textContent = `${r.date} · ${r.status}`;
      opt.setAttribute('data-date', r.date);
      recSel.appendChild(opt);
    });

  recSel.addEventListener('change', () => {
    const opt = recSel.options[recSel.selectedIndex];
    const dt = opt?.getAttribute('data-date');
    if (dt) container.querySelector('#cr-date').value = dt;
  });

  function renderCorrList(items) {
    const slot = container.querySelector('#cr-list-slot');
    if (items.length === 0) {
      slot.innerHTML = renderEmptyState({ title: 'No correction requests', description: 'Submitted correction requests appear here.' });
      return;
    }
    slot.innerHTML = `
      <div class="table-wrap">
        <table class="data-table">
          <thead><tr><th>Date</th><th>Requested</th><th>Status</th><th>Note</th></tr></thead>
          <tbody>
            ${items
              .sort((a, b) => (b.createdAt?.toMillis?.() || 0) - (a.createdAt?.toMillis?.() || 0))
              .map(
                (c) => `
              <tr>
                <td class="mono">${escapeHtml(c.date)}</td>
                <td style="text-transform:capitalize;">${escapeHtml((c.requestedStatus || '').replace('_', ' '))}</td>
                <td><span class="status-text ${c.status === 'approved' ? 'status-success' : c.status === 'rejected' ? 'status-danger' : 'status-warning'}" style="text-transform:capitalize;">${escapeHtml(c.status)}</span></td>
                <td style="font-size:0.8125rem;color:var(--text-secondary);">${escapeHtml(c.reviewNote || '—')}</td>
              </tr>
            `
              )
              .join('')}
          </tbody>
        </table>
      </div>
    `;
  }
  renderCorrList(corrs);

  container.querySelector('#mem-corr-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = container.querySelector('#cr-submit');
    btn.disabled = true;
    try {
      const fd = new FormData(e.target);
      const date = String(fd.get('date'));
      const recordId = String(fd.get('recordId') || `${date}__daily__${firebaseUser.uid}`);
      await createOrgDoc(activeOrgId, 'correctionRequests', {
        memberUid: firebaseUser.uid,
        memberName: activeMember?.name || firebaseUser.displayName || '',
        memberPublicId: activeMember?.memberPublicId || '',
        departmentId: activeMember?.departmentId || '',
        branchId: activeMember?.branchId || '',
        recordId,
        date,
        requestedStatus: String(fd.get('requestedStatus')),
        reason: String(fd.get('reason')).trim(),
        status: 'pending',
      });
      e.target.reset();
      showToast('Correction request submitted.', 'success');
      const fresh = await fetchOrgCollection(activeOrgId, 'correctionRequests', [where('memberUid', '==', firebaseUser.uid)]);
      renderCorrList(fresh);
    } catch (err) {
      showToast(err.message || 'Failed to submit correction.', 'danger');
    } finally {
      btn.disabled = false;
    }
  });
}

async function renderMemberHolidaysView(container) {
  const { activeOrgId, settings } = getState();
  const holidays = await fetchOrgCollection(activeOrgId, 'holidays');
  const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const offs = (settings?.weeklyOffDays || [0]).map((d) => dayNames[d]).filter(Boolean);

  container.innerHTML = `
    <div class="stack-lg">
      <div class="page-header">
        <div>
          <h1 class="page-title">Holidays &amp; Weekly Offs</h1>
          <p class="page-subtitle">Configured weekly off schedule: <strong>${escapeHtml(offs.join(', ') || 'None')}</strong></p>
        </div>
      </div>
      <div class="panel">
        ${
          holidays.length === 0
            ? renderEmptyState({ title: 'No holidays scheduled', description: 'Organization and department holidays appear here.' })
            : `<div class="table-wrap"><table class="data-table"><thead><tr><th>Date</th><th>Holiday</th><th>Scope</th><th>Notes</th></tr></thead><tbody>
                ${holidays
                  .sort((a, b) => String(a.date).localeCompare(String(b.date)))
                  .map(
                    (h) => `<tr><td class="mono">${escapeHtml(h.date)}</td><td><strong>${escapeHtml(h.title)}</strong></td><td>${escapeHtml(h.departmentId === 'all' || !h.departmentId ? 'All Departments' : h.departmentId)}</td><td>${escapeHtml(h.description || '—')}</td></tr>`
                  )
                  .join('')}
              </tbody></table></div>`
        }
      </div>
    </div>
  `;
}
