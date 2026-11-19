import jsQR from 'jsqr';
import { Chart, registerables } from 'chart.js';
import {
  fetchCollection,
  createDoc,
  where,
} from '../services/firestoreService.js';
import { markQrAttendance } from '../services/attendanceService.js';
import { uploadAttachment } from '../services/storageService.js';
import { exportAttendancePdf, exportAttendanceExcel } from '../services/reportService.js';
import {
  calculateAttendanceSummary,
  calculateShortage,
  escapeHtml,
  paginateItems,
  parseQrPayload,
  todayIsoDate,
} from '../utils/attendanceMath.js';
import { icon } from '../utils/icons.js';
import {
  showToast,
  renderEmptyState,
  renderTableSkeleton,
} from '../utils/ui.js';
import { getState } from '../state/store.js';
import {
  renderProfileView,
  renderNotificationsView,
  renderAnnouncementsFeedView,
  renderScheduleAndHolidaysView,
} from './sharedViews.js';

Chart.register(...registerables);

let cameraStream = null;
let scanFrameId = null;
let activeCharts = [];

export function cleanupStudentListeners() {
  if (scanFrameId) {
    cancelAnimationFrame(scanFrameId);
    scanFrameId = null;
  }
  if (cameraStream) {
    cameraStream.getTracks().forEach((t) => t.stop());
    cameraStream = null;
  }
  activeCharts.forEach((c) => c.destroy());
  activeCharts = [];
}

export async function renderStudentView(container, viewKey) {
  cleanupStudentListeners();
  switch (viewKey) {
    case 'overview':
      return renderStudentOverview(container);
    case 'scan-qr':
      return renderStudentScanQr(container);
    case 'shortage':
      return renderStudentShortageCalculator(container);
    case 'history':
      return renderStudentHistory(container);
    case 'leaves':
      return renderStudentLeaves(container);
    case 'corrections':
      return renderStudentCorrections(container);
    case 'timetable':
      return renderScheduleAndHolidaysView(container, 'student');
    case 'announcements':
      return renderAnnouncementsFeedView(container);
    case 'notifications':
      return renderNotificationsView(container);
    case 'profile':
      return renderProfileView(container);
    default:
      return renderStudentOverview(container);
  }
}

async function renderStudentOverview(container) {
  const { profile, roleData, settings } = getState();
  const threshold = Number(settings.defaultAttendanceThreshold || 75);

  container.innerHTML = `
    <div class="stack-lg">
      <div class="page-header">
        <div>
          <h1 class="page-title">Student Attendance Portal</h1>
          <p class="page-subtitle">${escapeHtml(profile.name)}${roleData?.rollNumber ? ' · ' + escapeHtml(roleData.rollNumber) : ''} · Threshold ${threshold}%</p>
        </div>
        <div class="page-actions">
          <button type="button" class="btn btn-secondary" id="stu-go-shortage">Shortage Calculator</button>
          <button type="button" class="btn btn-primary" id="stu-go-scan">${icon('qr', 16)} Scan QR Attendance</button>
        </div>
      </div>
      <div id="stu-overview-body">${renderTableSkeleton(4, 4)}</div>
    </div>
  `;

  container.querySelector('#stu-go-scan').addEventListener('click', () => {
    window.dispatchEvent(new CustomEvent('smartattend:navigate', { detail: 'scan-qr' }));
  });
  container.querySelector('#stu-go-shortage').addEventListener('click', () => {
    window.dispatchEvent(new CustomEvent('smartattend:navigate', { detail: 'shortage' }));
  });

  const body = container.querySelector('#stu-overview-body');
  try {
    const [records, subjects] = await Promise.all([
      fetchCollection('attendanceRecords', [where('studentUid', '==', profile.uid)]),
      fetchCollection('subjects'),
    ]);

    const overall = calculateAttendanceSummary(records);
    const subMap = new Map(subjects.map((s) => [s.id, s]));

    // Group by subject
    const bySub = new Map();
    for (const r of records) {
      const list = bySub.get(r.subjectId) || [];
      list.push(r);
      bySub.set(r.subjectId, list);
    }

    const subjectStats = [...bySub.entries()].map(([subjectId, recs]) => {
      const sub = subMap.get(subjectId);
      const sum = calculateAttendanceSummary(recs);
      const subThresh = Number(sub?.minAttendancePct || threshold);
      const shortage = calculateShortage(sum.effectiveAttended, sum.total, subThresh);
      return { subjectId, sub, sum, subThresh, shortage };
    });

    const lowSubjects = subjectStats.filter((s) => s.shortage.isBelowThreshold);
    const isOverallLow = overall.total > 0 && overall.percentage < threshold;

    body.innerHTML = `
      <div class="stack-lg">
        ${
          isOverallLow || lowSubjects.length > 0
            ? `<div class="notice notice-danger notice-row" role="alert">
                <div>
                  <strong style="color:var(--danger);">Low Attendance Warning (Below ${threshold}%)</strong>
                  <p style="font-size:0.875rem;color:var(--text-secondary);margin-top:2px;">
                    ${
                      isOverallLow
                        ? `Your overall attendance is ${overall.percentage}%. `
                        : ''
                    }${lowSubjects.length > 0 ? `${lowSubjects.length} subject(s) are currently below required minimum.` : ''}
                  </p>
                </div>
                <button type="button" class="btn btn-secondary btn-sm" id="warn-calc-btn">View Recovery Plan</button>
              </div>`
            : ''
        }

        <div class="grid-kpi">
          <div class="kpi-card">
            <span class="kpi-label">Overall Attendance</span>
            <span class="kpi-value ${isOverallLow ? 'status-danger' : ''}">${overall.total ? overall.percentage + '%' : '—'}</span>
            <span class="kpi-foot">${overall.effectiveAttended} / ${overall.total} sessions</span>
          </div>
          <div class="kpi-card">
            <span class="kpi-label">Present / Late</span>
            <span class="kpi-value">${overall.present + overall.late}</span>
            <span class="kpi-foot">${overall.present} present · ${overall.late} late</span>
          </div>
          <div class="kpi-card">
            <span class="kpi-label">Absent / Excused</span>
            <span class="kpi-value">${overall.absent}</span>
            <span class="kpi-foot">${overall.excused} excused</span>
          </div>
          <div class="kpi-card">
            <span class="kpi-label">Subjects Below ${threshold}%</span>
            <span class="kpi-value ${lowSubjects.length ? 'status-danger' : 'status-success'}">${lowSubjects.length}</span>
            <span class="kpi-foot">Out of ${subjectStats.length} active subjects</span>
          </div>
        </div>

        <div class="grid-2">
          <section class="panel stack-md">
            <div class="panel-header">
              <h2 class="panel-title">Subject-wise Attendance</h2>
              <span class="panel-meta">Minimum ${threshold}% required</span>
            </div>
            ${
              subjectStats.length === 0
                ? renderEmptyState({
                    title: 'No attendance records yet',
                    description: 'Scan a teacher QR code or attend a session to see your subject percentages.',
                  })
                : `<div class="stack-md">
                    ${subjectStats
                      .map(({ subjectId, sub, sum, subThresh, shortage }) => {
                        const cls = shortage.isBelowThreshold ? 'danger' : sum.percentage < subThresh + 5 ? 'warning' : 'success';
                        return `
                          <div class="stack-sm">
                            <div style="display:flex;justify-content:space-between;align-items:baseline;gap:0.5rem;">
                              <strong>${escapeHtml(sub ? `${sub.code} · ${sub.name}` : subjectId)}</strong>
                              <span class="mono ${shortage.isBelowThreshold ? 'status-danger' : ''}"><strong>${sum.percentage}%</strong> (${sum.effectiveAttended}/${sum.total})</span>
                            </div>
                            <div class="progress-track"><div class="progress-fill ${cls}" style="width:${Math.min(100, sum.percentage)}%;"></div></div>
                            <span style="font-size:0.75rem;color:var(--text-muted);">${escapeHtml(shortage.statusLabel)}</span>
                          </div>
                        `;
                      })
                      .join('')}
                  </div>`
            }
          </section>

          <section class="panel stack-md">
            <div class="panel-header">
              <h2 class="panel-title">Subject Comparison Chart</h2>
            </div>
            <div class="chart-box"><canvas id="chart-stu-subjects"></canvas></div>
          </section>
        </div>
      </div>
    `;

    body.querySelector('#warn-calc-btn')?.addEventListener('click', () => {
      window.dispatchEvent(new CustomEvent('smartattend:navigate', { detail: 'shortage' }));
    });

    const ctx = body.querySelector('#chart-stu-subjects');
    if (ctx) {
      activeCharts.push(
        new Chart(ctx, {
          type: 'bar',
          data: {
            labels: subjectStats.length ? subjectStats.map((s) => s.sub?.code || s.subjectId) : ['No Data'],
            datasets: [
              {
                label: 'Attendance %',
                data: subjectStats.length ? subjectStats.map((s) => s.sum.percentage) : [0],
                backgroundColor: subjectStats.map((s) => (s.shortage.isBelowThreshold ? '#dc2626' : '#16a34a')),
                borderRadius: 6,
              },
            ],
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            scales: { y: { min: 0, max: 100 } },
          },
        })
      );
    }
  } catch (err) {
    body.innerHTML = `<div class="notice notice-danger">${escapeHtml(err.message)}</div>`;
  }
}

async function renderStudentScanQr(container) {
  const { profile, roleData, settings } = getState();

  container.innerHTML = `
    <div class="stack-lg">
      <div class="page-header">
        <div>
          <h1 class="page-title">Scan Attendance QR Code</h1>
          <p class="page-subtitle">Point your camera at the instructor's live rotating QR code or enter the session check-in code.</p>
        </div>
      </div>

      <div class="grid-2">
        <section class="panel stack-md">
          <div class="panel-header">
            <h2 class="panel-title">Live Camera Scanner</h2>
            <div class="toolbar-group">
              <button type="button" class="btn btn-primary btn-sm" id="cam-start-btn">${icon('camera', 15)} Start Camera</button>
              <button type="button" class="btn btn-secondary btn-sm" id="cam-stop-btn" disabled>Stop</button>
            </div>
          </div>

          <div class="scanner-box">
            <video id="qr-video" playsinline muted></video>
            <div class="scanner-reticle"></div>
            <p id="cam-placeholder" style="position:absolute;color:#cbd5e1;font-size:0.875rem;padding:1rem;text-align:center;">
              Camera inactive. Click "Start Camera" to scan a QR code.
            </p>
          </div>
          <canvas id="qr-hidden-canvas" style="display:none;"></canvas>
          <p id="cam-status" class="field-hint">Works on mobile and laptop cameras. If camera access is restricted, use the manual code input.</p>
        </section>

        <section class="panel stack-md">
          <h2 class="panel-title">Direct Code / Payload Check-In</h2>
          <p class="panel-meta">Paste the QR JSON payload or <span class="mono">sessionId:token</span> code displayed on the instructor's screen.</p>
          <form id="manual-qr-form" class="stack-md">
            <div class="field">
              <label class="field-label" for="qr-code-input">Session QR Payload or Code</label>
              <input class="input mono" id="qr-code-input" name="payload" required placeholder='sessionId:token or {"sessionId":...}' />
            </div>
            <button type="submit" class="btn btn-primary" id="submit-qr-btn">Verify &amp; Mark Present</button>
          </form>

          <div id="scan-result-banner" style="display:none;"></div>
        </section>
      </div>
    </div>
  `;

  const video = container.querySelector('#qr-video');
  const hiddenCanvas = container.querySelector('#qr-hidden-canvas');
  const placeholder = container.querySelector('#cam-placeholder');
  const camStatus = container.querySelector('#cam-status');
  const startBtn = container.querySelector('#cam-start-btn');
  const stopBtn = container.querySelector('#cam-stop-btn');
  const resultBanner = container.querySelector('#scan-result-banner');

  let processing = false;

  async function processQrText(rawText) {
    if (processing) return;
    const parsed = parseQrPayload(rawText);
    if (!parsed) {
      resultBanner.style.display = 'block';
      resultBanner.className = 'notice notice-danger';
      resultBanner.innerHTML = '<strong>Invalid QR Format</strong><span>The scanned code is not a valid SmartAttend session token.</span>';
      return;
    }

    processing = true;
    resultBanner.style.display = 'block';
    resultBanner.className = 'notice';
    resultBanner.innerHTML = '<strong>Validating token...</strong><span>Checking session status, expiration, and duplicate prevention.</span>';

    try {
      await markQrAttendance({
        sessionId: parsed.sessionId,
        token: parsed.token,
        studentUid: profile.uid,
        studentName: profile.name,
        rollNumber: roleData?.rollNumber || '',
        thresholdPct: settings.defaultAttendanceThreshold,
      });
      cleanupStudentListeners();
      startBtn.disabled = false;
      stopBtn.disabled = true;
      resultBanner.className = 'notice notice-success';
      resultBanner.innerHTML = '<strong>Attendance Recorded!</strong><span>Your Present record has been saved with server timestamp.</span>';
      showToast('Attendance marked Present!', 'success');
    } catch (err) {
      resultBanner.className = 'notice notice-danger';
      resultBanner.innerHTML = `<strong>Attendance Rejected</strong><span>${escapeHtml(err.message)}</span>`;
      showToast(err.message || 'Scan rejected.', 'danger');
    } finally {
      processing = false;
    }
  }

  startBtn.addEventListener('click', async () => {
    if (!navigator.mediaDevices?.getUserMedia) {
      camStatus.textContent = 'Camera API unavailable in this browser context. Use Direct Code Check-In.';
      return;
    }
    try {
      cameraStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
      video.srcObject = cameraStream;
      await video.play();
      placeholder.style.display = 'none';
      startBtn.disabled = true;
      stopBtn.disabled = false;
      camStatus.textContent = 'Scanning for QR code...';

      const ctx = hiddenCanvas.getContext('2d', { willReadFrequently: true });
      const tick = () => {
        if (!cameraStream) return;
        if (video.readyState === video.HAVE_ENOUGH_DATA) {
          hiddenCanvas.width = video.videoWidth;
          hiddenCanvas.height = video.videoHeight;
          ctx.drawImage(video, 0, 0, hiddenCanvas.width, hiddenCanvas.height);
          const imageData = ctx.getImageData(0, 0, hiddenCanvas.width, hiddenCanvas.height);
          const code = jsQR(imageData.data, imageData.width, imageData.height, { inversionAttempts: 'dontInvert' });
          if (code && code.data) {
            processQrText(code.data);
          }
        }
        scanFrameId = requestAnimationFrame(tick);
      };
      scanFrameId = requestAnimationFrame(tick);
    } catch (err) {
      camStatus.textContent = `Camera permission denied or unavailable (${err.message}). Use Direct Code Check-In.`;
    }
  });

  stopBtn.addEventListener('click', () => {
    cleanupStudentListeners();
    video.srcObject = null;
    placeholder.style.display = 'block';
    startBtn.disabled = false;
    stopBtn.disabled = true;
    camStatus.textContent = 'Camera stopped.';
  });

  container.querySelector('#manual-qr-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const raw = new FormData(e.target).get('payload');
    await processQrText(raw);
  });
}

async function renderStudentShortageCalculator(container) {
  const { profile, settings } = getState();
  let targetPct = Number(settings.defaultAttendanceThreshold || 75);

  container.innerHTML = `
    <div class="stack-lg">
      <div class="page-header">
        <div>
          <h1 class="page-title">Attendance Shortage Calculator</h1>
          <p class="page-subtitle">Calculate exact classes needed to meet your target threshold or safe absences remaining.</p>
        </div>
      </div>

      <section class="panel stack-md">
        <div class="form-grid form-grid-2" style="align-items:end;">
          <div class="field">
            <label class="field-label" for="calc-target">Target Attendance Threshold (%)</label>
            <input class="input mono" id="calc-target" type="number" min="50" max="99" value="${targetPct}" />
          </div>
          <div class="field">
            <label class="field-label" for="calc-range">Adjust Target Slider</label>
            <input id="calc-range" type="range" min="50" max="95" value="${targetPct}" />
          </div>
        </div>
        <div id="shortage-subjects-slot">${renderTableSkeleton(5, 3)}</div>
      </section>

      <section class="panel stack-md">
        <h2 class="panel-title">Custom What-If Simulator</h2>
        <div class="form-grid form-grid-3">
          <div class="field"><label class="field-label">Attended Classes</label><input class="input mono" id="sim-att" type="number" min="0" value="14" /></div>
          <div class="field"><label class="field-label">Total Classes Held</label><input class="input mono" id="sim-tot" type="number" min="1" value="20" /></div>
          <div class="field"><label class="field-label">Target %</label><input class="input mono" id="sim-tgt" type="number" min="50" max="99" value="${targetPct}" /></div>
        </div>
        <div id="sim-output" class="notice"></div>
      </section>
    </div>
  `;

  const [records, subjects] = await Promise.all([
    fetchCollection('attendanceRecords', [where('studentUid', '==', profile.uid)]),
    fetchCollection('subjects'),
  ]);
  const subMap = new Map(subjects.map((s) => [s.id, s]));

  const bySub = new Map();
  for (const r of records) {
    const list = bySub.get(r.subjectId) || [];
    list.push(r);
    bySub.set(r.subjectId, list);
  }

  function renderSubjectsTable() {
    const slot = container.querySelector('#shortage-subjects-slot');
    if (bySub.size === 0) {
      slot.innerHTML = renderEmptyState({
        title: 'No attendance records yet',
        description: 'Use the Custom What-If Simulator below or attend sessions to compute live shortage metrics.',
      });
      return;
    }

    slot.innerHTML = `
      <div class="table-wrap"><table class="data-table"><thead><tr><th>Subject</th><th class="num">Attended</th><th class="num">Total</th><th class="num">Current %</th><th>Recovery / Margin</th></tr></thead><tbody>
        ${[...bySub.entries()]
          .map(([subId, recs]) => {
            const sub = subMap.get(subId);
            const sum = calculateAttendanceSummary(recs);
            const calc = calculateShortage(sum.effectiveAttended, sum.total, targetPct);
            return `<tr>
              <td><strong>${escapeHtml(sub ? `${sub.code} · ${sub.name}` : subId)}</strong></td>
              <td class="num">${sum.effectiveAttended}</td>
              <td class="num">${sum.total}</td>
              <td class="num"><strong>${sum.percentage}%</strong></td>
              <td><span class="status-text ${calc.isBelowThreshold ? 'status-danger' : 'status-success'}">${escapeHtml(calc.statusLabel)}</span></td>
            </tr>`;
          })
          .join('')}
      </tbody></table></div>
    `;
  }

  function updateSimulator() {
    const att = Number(container.querySelector('#sim-att').value || 0);
    const tot = Number(container.querySelector('#sim-tot').value || 0);
    const tgt = Number(container.querySelector('#sim-tgt').value || 75);
    const res = calculateShortage(att, Math.max(att, tot), tgt);
    const out = container.querySelector('#sim-output');
    out.className = `notice ${res.isBelowThreshold ? 'notice-warning' : 'notice-success'}`;
    out.innerHTML = `<strong>Current: ${res.currentPct}% (Target: ${res.targetPct}%)</strong><span>${escapeHtml(res.statusLabel)}</span>`;
  }

  const targetInput = container.querySelector('#calc-target');
  const targetRange = container.querySelector('#calc-range');
  targetInput.addEventListener('input', () => {
    targetPct = Number(targetInput.value || 75);
    targetRange.value = String(targetPct);
    renderSubjectsTable();
  });
  targetRange.addEventListener('input', () => {
    targetPct = Number(targetRange.value || 75);
    targetInput.value = String(targetPct);
    renderSubjectsTable();
  });

  ['#sim-att', '#sim-tot', '#sim-tgt'].forEach((sel) => {
    container.querySelector(sel).addEventListener('input', updateSimulator);
  });

  renderSubjectsTable();
  updateSimulator();
}

async function renderStudentHistory(container) {
  const { profile } = getState();
  let subFilter = 'all';
  let statusFilter = 'all';
  let page = 1;

  container.innerHTML = `
    <div class="stack-lg">
      <div class="page-header">
        <div>
          <h1 class="page-title">Attendance History</h1>
          <p class="page-subtitle">Complete log of every recorded session with subject and status filters.</p>
        </div>
        <div class="page-actions">
          <button type="button" class="btn btn-secondary" id="stu-exp-xlsx">${icon('download', 16)} Excel</button>
          <button type="button" class="btn btn-primary" id="stu-exp-pdf">${icon('file', 16)} PDF Transcript</button>
        </div>
      </div>
      <section class="panel stack-md">
        <div class="toolbar">
          <select class="select" style="max-width:240px;" id="hist-sub"><option value="all">All Subjects</option></select>
          <select class="select" style="max-width:180px;" id="hist-status">
            <option value="all">All Statuses</option>
            <option value="present">Present</option>
            <option value="absent">Absent</option>
            <option value="late">Late</option>
            <option value="excused">Excused</option>
          </select>
        </div>
        <div id="hist-slot">${renderTableSkeleton(5, 5)}</div>
      </section>
    </div>
  `;

  const [records, subjects] = await Promise.all([
    fetchCollection('attendanceRecords', [where('studentUid', '==', profile.uid)]),
    fetchCollection('subjects'),
  ]);
  const subMap = new Map(subjects.map((s) => [s.id, s]));
  const subSel = container.querySelector('#hist-sub');
  subSel.innerHTML = '<option value="all">All Subjects</option>' + subjects.map((s) => `<option value="${escapeHtml(s.id)}">${escapeHtml(s.code + ' · ' + s.name)}</option>`).join('');

  records.sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
  let filtered = records;

  function render() {
    filtered = records.filter((r) => {
      if (subFilter !== 'all' && r.subjectId !== subFilter) return false;
      if (statusFilter !== 'all' && r.status !== statusFilter) return false;
      return true;
    });
    const paged = paginateItems(filtered, page, 12);
    const slot = container.querySelector('#hist-slot');
    if (paged.totalItems === 0) {
      slot.innerHTML = renderEmptyState({ title: 'No attendance history matches filters', description: 'Your session attendance records will appear here.' });
      return;
    }

    slot.innerHTML = `
      <div class="table-wrap"><table class="data-table"><thead><tr><th>Date</th><th>Subject</th><th>Method</th><th>Status</th></tr></thead><tbody>
        ${paged.items
          .map((r) => {
            const sub = subMap.get(r.subjectId);
            const cls = r.status === 'present' || r.status === 'excused' ? 'status-success' : r.status === 'late' ? 'status-warning' : 'status-danger';
            return `<tr>
              <td class="mono">${escapeHtml(r.date)}</td>
              <td>${escapeHtml(sub ? `${sub.code} · ${sub.name}` : r.subjectId)}</td>
              <td style="text-transform:uppercase;">${escapeHtml(r.method || 'manual')}</td>
              <td><span class="status-text ${cls}" style="text-transform:capitalize;">${escapeHtml(r.status)}</span></td>
            </tr>`;
          })
          .join('')}
      </tbody></table></div>
      <div class="pagination">
        <span>Showing ${paged.items.length} of ${paged.totalItems}</span>
        <div class="pagination-controls">
          <button type="button" class="btn btn-secondary btn-sm" id="h-prev" ${paged.page <= 1 ? 'disabled' : ''}>Prev</button>
          <span>Page ${paged.page}/${paged.totalPages}</span>
          <button type="button" class="btn btn-secondary btn-sm" id="h-next" ${paged.page >= paged.totalPages ? 'disabled' : ''}>Next</button>
        </div>
      </div>
    `;
    slot.querySelector('#h-prev')?.addEventListener('click', () => {
      page -= 1;
      render();
    });
    slot.querySelector('#h-next')?.addEventListener('click', () => {
      page += 1;
      render();
    });
  }

  subSel.addEventListener('change', (e) => {
    subFilter = e.target.value;
    page = 1;
    render();
  });
  container.querySelector('#hist-status').addEventListener('change', (e) => {
    statusFilter = e.target.value;
    page = 1;
    render();
  });

  container.querySelector('#stu-exp-pdf').addEventListener('click', () => {
    if (filtered.length === 0) return showToast('No records to export.', 'warning');
    exportAttendancePdf({
      title: `Attendance Transcript — ${profile.name}`,
      subtitle: `Student ID: ${getState().roleData?.rollNumber || profile.uid}`,
      columns: ['Date', 'Subject', 'Method', 'Status'],
      rows: filtered.map((r) => {
        const sub = subMap.get(r.subjectId);
        return [r.date, sub ? `${sub.code} · ${sub.name}` : r.subjectId, r.method || 'manual', r.status];
      }),
      fileName: `my-attendance-${todayIsoDate()}.pdf`,
    });
  });

  container.querySelector('#stu-exp-xlsx').addEventListener('click', () => {
    if (filtered.length === 0) return showToast('No records to export.', 'warning');
    exportAttendanceExcel({
      sheetName: 'My Attendance',
      columns: ['Date', 'Subject', 'Method', 'Status'],
      rows: filtered.map((r) => {
        const sub = subMap.get(r.subjectId);
        return [r.date, sub ? `${sub.code} · ${sub.name}` : r.subjectId, r.method || 'manual', r.status];
      }),
      fileName: `my-attendance-${todayIsoDate()}.xlsx`,
    });
  });

  render();
}

async function renderStudentLeaves(container) {
  const { profile, roleData } = getState();
  container.innerHTML = `
    <div class="stack-lg">
      <div class="page-header">
        <div>
          <h1 class="page-title">Leave Requests</h1>
          <p class="page-subtitle">Apply for medical or academic leave with optional supporting documents.</p>
        </div>
      </div>

      <div class="grid-2">
        <section class="panel stack-md">
          <h2 class="panel-title">Submit Leave Application</h2>
          <form id="leave-form" class="stack-md">
            <div class="form-grid form-grid-2">
              <div class="field"><label class="field-label">From Date</label><input class="input mono" name="fromDate" type="date" required value="${todayIsoDate()}" /></div>
              <div class="field"><label class="field-label">To Date</label><input class="input mono" name="toDate" type="date" required value="${todayIsoDate()}" /></div>
            </div>
            <div class="field"><label class="field-label">Reason</label><textarea class="textarea" name="reason" required maxlength="500" placeholder="Describe the reason for leave..."></textarea></div>
            <div class="field"><label class="field-label">Supporting Document (Optional PDF/Image)</label><input class="input" name="file" type="file" accept="image/*,application/pdf" /></div>
            <button type="submit" class="btn btn-primary" id="submit-leave-btn">Submit Leave Request</button>
          </form>
        </section>

        <section class="panel stack-md">
          <h2 class="panel-title">My Leave Applications</h2>
          <div id="stu-leaves-list">${renderTableSkeleton(3, 3)}</div>
        </section>
      </div>
    </div>
  `;

  async function loadLeaves() {
    const list = await fetchCollection('leaveRequests', [where('studentUid', '==', profile.uid)]);
    const slot = container.querySelector('#stu-leaves-list');
    if (list.length === 0) {
      slot.innerHTML = renderEmptyState({ title: 'No leave requests submitted', description: 'Your submitted leave requests and approval status will appear here.' });
      return;
    }
    slot.innerHTML = `
      <div class="table-wrap"><table class="data-table"><thead><tr><th>Dates</th><th>Reason</th><th>Status</th></tr></thead><tbody>
        ${list
          .map(
            (l) => `<tr>
            <td class="mono">${escapeHtml(l.fromDate)}<br>${escapeHtml(l.toDate)}</td>
            <td>${escapeHtml(l.reason)}${l.attachmentUrl ? ` · <a href="${escapeHtml(l.attachmentUrl)}" target="_blank" rel="noopener">File</a>` : ''}</td>
            <td><span class="status-text ${l.status === 'approved' ? 'status-success' : l.status === 'rejected' ? 'status-danger' : 'status-warning'}" style="text-transform:capitalize;">${escapeHtml(l.status)}</span></td>
          </tr>`
          )
          .join('')}
      </tbody></table></div>
    `;
  }

  container.querySelector('#leave-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = container.querySelector('#submit-leave-btn');
    btn.disabled = true;
    try {
      const fd = new FormData(e.target);
      let attachmentUrl = '';
      const file = fd.get('file');
      if (file && file.size > 0) {
        const up = await uploadAttachment('leave-attachments', profile.uid, file);
        attachmentUrl = up.downloadUrl;
      }
      await createDoc('leaveRequests', {
        studentId: profile.uid,
        studentUid: profile.uid,
        classId: roleData?.classId || '',
        subjectId: '',
        fromDate: String(fd.get('fromDate')),
        toDate: String(fd.get('toDate')),
        reason: String(fd.get('reason')).trim(),
        attachmentUrl,
        status: 'pending',
        reviewedBy: '',
        reviewNote: '',
      });
      e.target.reset();
      showToast('Leave request submitted.', 'success');
      loadLeaves();
    } catch (err) {
      showToast(err.message || 'Failed to submit leave.', 'danger');
    } finally {
      btn.disabled = false;
    }
  });

  loadLeaves();
}

async function renderStudentCorrections(container) {
  const { profile } = getState();
  container.innerHTML = `
    <div class="stack-lg">
      <div class="page-header">
        <div>
          <h1 class="page-title">Attendance Correction Requests</h1>
          <p class="page-subtitle">Request a teacher review for an Absent or Late record.</p>
        </div>
      </div>

      <div class="grid-2">
        <section class="panel stack-md">
          <h2 class="panel-title">Submit Correction Request</h2>
          <div id="corr-form-slot">${renderTableSkeleton(2, 3)}</div>
        </section>

        <section class="panel stack-md">
          <h2 class="panel-title">My Correction Requests</h2>
          <div id="stu-corr-list">${renderTableSkeleton(3, 3)}</div>
        </section>
      </div>
    </div>
  `;

  const [records, subjects] = await Promise.all([
    fetchCollection('attendanceRecords', [where('studentUid', '==', profile.uid)]),
    fetchCollection('subjects'),
  ]);
  const subMap = new Map(subjects.map((s) => [s.id, s]));
  const eligible = records.filter((r) => r.status === 'absent' || r.status === 'late');

  const formSlot = container.querySelector('#corr-form-slot');
  if (eligible.length === 0) {
    formSlot.innerHTML = renderEmptyState({
      title: 'No Absent/Late records to contest',
      description: 'Correction requests can be submitted when an Absent or Late record exists.',
    });
  } else {
    formSlot.innerHTML = `
      <form id="corr-form" class="stack-md">
        <div class="field">
          <label class="field-label">Select Attendance Record</label>
          <select class="select" name="recordId" required>
            ${eligible
              .map((r) => {
                const sub = subMap.get(r.subjectId);
                return `<option value="${escapeHtml(r.id)}">${escapeHtml(r.date)} · ${escapeHtml(sub ? sub.code : r.subjectId)} (${escapeHtml(r.status)})</option>`;
              })
              .join('')}
          </select>
        </div>
        <div class="field">
          <label class="field-label">Requested Status</label>
          <select class="select" name="requestedStatus"><option value="present">Present</option><option value="excused">Excused</option></select>
        </div>
        <div class="field"><label class="field-label">Reason / Context</label><textarea class="textarea" name="reason" required maxlength="500" placeholder="Explain why this record should be corrected..."></textarea></div>
        <div class="field"><label class="field-label">Supporting Evidence (Optional)</label><input class="input" name="file" type="file" accept="image/*,application/pdf" /></div>
        <button type="submit" class="btn btn-primary" id="submit-corr-btn">Submit Correction Request</button>
      </form>
    `;

    formSlot.querySelector('#corr-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = formSlot.querySelector('#submit-corr-btn');
      btn.disabled = true;
      try {
        const fd = new FormData(e.target);
        const rec = eligible.find((r) => r.id === fd.get('recordId'));
        let evidenceUrl = '';
        const file = fd.get('file');
        if (file && file.size > 0) {
          const up = await uploadAttachment('correction-evidence', profile.uid, file);
          evidenceUrl = up.downloadUrl;
        }
        await createDoc('correctionRequests', {
          recordId: rec.id,
          sessionId: rec.sessionId,
          studentId: profile.uid,
          studentUid: profile.uid,
          subjectId: rec.subjectId,
          classId: rec.classId,
          teacherId: rec.teacherId || '',
          currentStatus: rec.status,
          requestedStatus: String(fd.get('requestedStatus')),
          reason: String(fd.get('reason')).trim(),
          evidenceUrl,
          status: 'pending',
          reviewedBy: '',
          reviewNote: '',
        });
        e.target.reset();
        showToast('Correction request submitted to teacher.', 'success');
        loadCorrections();
      } catch (err) {
        showToast(err.message || 'Failed to submit correction.', 'danger');
      } finally {
        btn.disabled = false;
      }
    });
  }

  async function loadCorrections() {
    const list = await fetchCollection('correctionRequests', [where('studentUid', '==', profile.uid)]);
    const slot = container.querySelector('#stu-corr-list');
    if (list.length === 0) {
      slot.innerHTML = renderEmptyState({ title: 'No correction requests', description: 'Your submitted correction requests will appear here.' });
      return;
    }
    slot.innerHTML = `
      <div class="table-wrap"><table class="data-table"><thead><tr><th>Subject</th><th>Requested</th><th>Reason</th><th>Status</th></tr></thead><tbody>
        ${list
          .map((c) => {
            const sub = subMap.get(c.subjectId);
            return `<tr>
              <td>${escapeHtml(sub ? sub.code : c.subjectId)}</td>
              <td style="text-transform:capitalize;">${escapeHtml(c.currentStatus)} &rarr; ${escapeHtml(c.requestedStatus)}</td>
              <td>${escapeHtml(c.reason)}</td>
              <td><span class="status-text ${c.status === 'approved' ? 'status-success' : c.status === 'rejected' ? 'status-danger' : 'status-warning'}" style="text-transform:capitalize;">${escapeHtml(c.status)}</span></td>
            </tr>`;
          })
          .join('')}
      </tbody></table></div>
    `;
  }

  loadCorrections();
}
