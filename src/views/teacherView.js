import QRCode from 'qrcode';
import { Chart, registerables } from 'chart.js';
import {
  fetchCollection,
  updateDocById,
  createNotification,
  where,
} from '../services/firestoreService.js';
import {
  startQrSession,
  rotateQrSessionToken,
  subscribeLiveCheckins,
  closeQrSession,
  saveManualAttendanceBatch,
  reviewCorrectionRequest,
} from '../services/attendanceService.js';
import { exportAttendancePdf, exportAttendanceExcel } from '../services/reportService.js';
import {
  calculateAttendanceSummary,
  encodeQrPayload,
  escapeHtml,
  formatDateTime,
  paginateItems,
  todayIsoDate,
} from '../utils/attendanceMath.js';
import { icon } from '../utils/icons.js';
import {
  showToast,
  showConfirm,
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

let activeTimers = [];
let activeUnsubs = [];
let activeCharts = [];

export function cleanupTeacherListeners() {
  activeTimers.forEach((t) => clearInterval(t));
  activeTimers = [];
  activeUnsubs.forEach((fn) => {
    try {
      fn();
    } catch {}
  });
  activeUnsubs = [];
  activeCharts.forEach((c) => c.destroy());
  activeCharts = [];
}

export async function renderTeacherView(container, viewKey) {
  cleanupTeacherListeners();
  switch (viewKey) {
    case 'overview':
      return renderTeacherOverview(container);
    case 'qr-session':
      return renderTeacherQrSession(container);
    case 'manual-attendance':
      return renderTeacherManualAttendance(container);
    case 'corrections':
      return renderTeacherCorrections(container);
    case 'leaves':
      return renderTeacherLeaves(container);
    case 'students-analytics':
      return renderTeacherStudentAnalytics(container);
    case 'reports':
      return renderTeacherReports(container);
    case 'timetable':
      return renderScheduleAndHolidaysView(container, 'teacher');
    case 'announcements':
      return renderAnnouncementsFeedView(container);
    case 'notifications':
      return renderNotificationsView(container);
    case 'profile':
      return renderProfileView(container);
    default:
      return renderTeacherOverview(container);
  }
}

async function renderTeacherOverview(container) {
  const { profile, settings } = getState();
  container.innerHTML = `
    <div class="stack-lg">
      <div class="page-header">
        <div>
          <h1 class="page-title">Faculty Dashboard</h1>
          <p class="page-subtitle">Welcome, ${escapeHtml(profile.name)} · Session ${escapeHtml(settings.currentAcademicSession)}</p>
        </div>
        <div class="page-actions">
          <button type="button" class="btn btn-secondary" id="tch-go-manual">Manual Attendance</button>
          <button type="button" class="btn btn-primary" id="tch-go-qr">${icon('qr', 16)} Start QR Session</button>
        </div>
      </div>
      <div id="tch-overview-body">${renderTableSkeleton(4, 4)}</div>
    </div>
  `;

  container.querySelector('#tch-go-qr').addEventListener('click', () => {
    window.dispatchEvent(new CustomEvent('smartattend:navigate', { detail: 'qr-session' }));
  });
  container.querySelector('#tch-go-manual').addEventListener('click', () => {
    window.dispatchEvent(new CustomEvent('smartattend:navigate', { detail: 'manual-attendance' }));
  });

  const body = container.querySelector('#tch-overview-body');
  try {
    const [subjects, sessions, records, corrections, leaves] = await Promise.all([
      fetchCollection('subjects'),
      fetchCollection('attendanceSessions', [where('teacherId', '==', profile.uid)]),
      fetchCollection('attendanceRecords', [where('teacherId', '==', profile.uid)]),
      fetchCollection('correctionRequests'),
      fetchCollection('leaveRequests'),
    ]);

    const mySubjects = subjects.filter((s) => s.teacherId === profile.uid);
    const activeSessions = sessions.filter((s) => s.status === 'active');
    const pendingCorr = corrections.filter((c) => c.status === 'pending' && (!c.teacherId || c.teacherId === profile.uid));
    const pendingLeaves = leaves.filter((l) => l.status === 'pending');
    const overall = calculateAttendanceSummary(records);

    body.innerHTML = `
      <div class="stack-lg">
        <div class="grid-kpi">
          <div class="kpi-card">
            <span class="kpi-label">Assigned Subjects</span>
            <span class="kpi-value">${mySubjects.length || subjects.length}</span>
            <span class="kpi-foot">${sessions.length} total sessions held</span>
          </div>
          <div class="kpi-card">
            <span class="kpi-label">Active QR Sessions</span>
            <span class="kpi-value">${activeSessions.length}</span>
            <span class="kpi-foot">${activeSessions.length ? 'Live check-in open' : 'None currently active'}</span>
          </div>
          <div class="kpi-card">
            <span class="kpi-label">Average Attendance</span>
            <span class="kpi-value">${records.length ? overall.percentage + '%' : '—'}</span>
            <span class="kpi-foot">${overall.effectiveAttended} / ${overall.total} marked present</span>
          </div>
          <div class="kpi-card">
            <span class="kpi-label">Pending Reviews</span>
            <span class="kpi-value">${pendingCorr.length + pendingLeaves.length}</span>
            <span class="kpi-foot">${pendingCorr.length} corrections · ${pendingLeaves.length} leaves</span>
          </div>
        </div>

        <section class="panel stack-md">
          <div class="panel-header">
            <h2 class="panel-title">Subject Attendance Performance</h2>
            <span class="panel-meta">Threshold target: ${settings.defaultAttendanceThreshold}%</span>
          </div>
          <div class="chart-box"><canvas id="chart-tch-subjects"></canvas></div>
        </section>
      </div>
    `;

    const displaySubjects = mySubjects.length > 0 ? mySubjects : subjects;
    const labels = [];
    const values = [];
    for (const sub of displaySubjects.slice(0, 8)) {
      const subRecs = records.filter((r) => r.subjectId === sub.id);
      if (subRecs.length > 0) {
        labels.push(sub.code || sub.name);
        values.push(calculateAttendanceSummary(subRecs).percentage);
      }
    }

    const ctx = body.querySelector('#chart-tch-subjects');
    if (ctx) {
      activeCharts.push(
        new Chart(ctx, {
          type: 'bar',
          data: {
            labels: labels.length ? labels : ['No Recorded Sessions'],
            datasets: [
              {
                label: 'Attendance %',
                data: values.length ? values : [0],
                backgroundColor: '#1d4ed8',
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

async function renderTeacherQrSession(container) {
  const { profile, settings } = getState();
  container.innerHTML = `
    <div class="stack-lg">
      <div class="page-header">
        <div>
          <h1 class="page-title">Dynamic Expiring QR Session</h1>
          <p class="page-subtitle">Launch an auto-rotating QR session with live Realtime Database check-in stream and duplicate rejection.</p>
        </div>
      </div>
      <div id="qr-session-workspace">${renderTableSkeleton(3, 4)}</div>
    </div>
  `;

  const workspace = container.querySelector('#qr-session-workspace');
  const [classes, subjects, students, existingSessions] = await Promise.all([
    fetchCollection('classes'),
    fetchCollection('subjects'),
    fetchCollection('students'),
    fetchCollection('attendanceSessions', [where('teacherId', '==', profile.uid)]),
  ]);

  let activeSession = existingSessions.find((s) => s.status === 'active') || null;
  if (activeSession) {
    activeSession = {
      sessionId: activeSession.id,
      classId: activeSession.classId,
      subjectId: activeSession.subjectId,
      token: activeSession.qrToken,
      expiresAtMs: activeSession.qrExpiresAtMs,
      rotationSeconds: activeSession.qrRotationSeconds || settings.qrRotationSeconds || 15,
    };
  }

  function renderSetupOrLive() {
    if (!activeSession) {
      workspace.innerHTML = `
        <div class="grid-2">
          <section class="panel stack-md">
            <h2 class="panel-title">Configure &amp; Start Session</h2>
            ${
              classes.length === 0 || subjects.length === 0
                ? `<div class="notice notice-warning">No classes or subjects configured yet. Ask your Admin to create classes and subjects (or seed demo data).</div>`
                : `
              <form id="start-qr-form" class="stack-md">
                <div class="field">
                  <label class="field-label" for="qr-class">Class / Section</label>
                  <select class="select" id="qr-class" name="classId" required>
                    ${classes.map((c) => `<option value="${escapeHtml(c.id)}">${escapeHtml(c.name)}</option>`).join('')}
                  </select>
                </div>
                <div class="field">
                  <label class="field-label" for="qr-subject">Subject</label>
                  <select class="select" id="qr-subject" name="subjectId" required>
                    ${subjects.map((s) => `<option value="${escapeHtml(s.id)}">${escapeHtml(s.code + ' · ' + s.name)}</option>`).join('')}
                  </select>
                </div>
                <div class="form-grid form-grid-2">
                  <div class="field">
                    <label class="field-label" for="qr-rot">QR Rotation Interval (sec)</label>
                    <input class="input mono" id="qr-rot" name="rotationSeconds" type="number" min="10" max="120" value="${Number(settings.qrRotationSeconds || 15)}" required />
                  </div>
                  <div class="field">
                    <label class="field-label" for="qr-thresh">Threshold (%)</label>
                    <input class="input mono" id="qr-thresh" name="thresholdPct" type="number" min="1" max="100" value="${Number(settings.defaultAttendanceThreshold || 75)}" required />
                  </div>
                </div>
                <button type="submit" class="btn btn-primary" id="launch-qr-btn">${icon('qr', 16)} Start Live QR Session</button>
              </form>
            `
            }
          </section>

          <section class="panel stack-md">
            <h2 class="panel-title">Recent Teacher Sessions</h2>
            ${
              existingSessions.length === 0
                ? renderEmptyState({ title: 'No sessions started yet', description: 'Your QR and manual attendance sessions will appear here.' })
                : `<div class="table-wrap"><table class="data-table"><thead><tr><th>Date</th><th>Mode</th><th class="num">Present</th><th>Status</th></tr></thead><tbody>
                    ${existingSessions
                      .slice(0, 6)
                      .map(
                        (s) => `<tr>
                        <td class="mono">${escapeHtml(s.date)}</td>
                        <td style="text-transform:uppercase;">${escapeHtml(s.mode)}</td>
                        <td class="num">${Number(s.presentCount || 0)}</td>
                        <td><span class="status-text ${s.status === 'active' ? 'status-success' : 'status-muted'}">${escapeHtml(s.status)}</span></td>
                      </tr>`
                      )
                      .join('')}
                  </tbody></table></div>`
            }
          </section>
        </div>
      `;

      workspace.querySelector('#start-qr-form')?.addEventListener('submit', async (e) => {
        e.preventDefault();
        const btn = workspace.querySelector('#launch-qr-btn');
        btn.disabled = true;
        try {
          const fd = new FormData(e.target);
          const classId = String(fd.get('classId'));
          const subjectId = String(fd.get('subjectId'));
          const rotationSeconds = Number(fd.get('rotationSeconds'));
          const thresholdPct = Number(fd.get('thresholdPct'));
          const cls = classes.find((c) => c.id === classId);
          const sub = subjects.find((s) => s.id === subjectId);
          const classStudents = students.filter((st) => st.classId === classId);

          const res = await startQrSession({
            classId,
            subjectId,
            teacherId: profile.uid,
            academicSession: settings.currentAcademicSession,
            qrRotationSeconds: rotationSeconds,
            thresholdPct,
            className: cls?.name || classId,
            subjectName: sub?.name || subjectId,
            totalStudents: classStudents.length,
          });
          activeSession = {
            ...res,
            classId,
            subjectId,
            thresholdPct,
          };
          showToast('Live QR session started!', 'success');
          renderSetupOrLive();
        } catch (err) {
          showToast(err.message || 'Failed to start session.', 'danger');
          btn.disabled = false;
        }
      });
      return;
    }

    const cls = classes.find((c) => c.id === activeSession.classId);
    const sub = subjects.find((s) => s.id === activeSession.subjectId);
    const classStudents = students.filter((st) => st.classId === activeSession.classId);

    workspace.innerHTML = `
      <div class="grid-2">
        <section class="panel stack-md">
          <div class="panel-header">
            <div>
              <h2 class="panel-title">${escapeHtml(sub ? `${sub.code} · ${sub.name}` : 'Active QR Session')}</h2>
              <span class="panel-meta">${escapeHtml(cls?.name || '')} · Rotates every ${activeSession.rotationSeconds}s</span>
            </div>
            <span class="status-text status-success">Session Active</span>
          </div>

          <div class="qr-stage">
            <div class="qr-frame">
              <canvas id="live-qr-canvas" width="240" height="240" aria-label="Dynamic Attendance QR Code"></canvas>
            </div>
            <div style="width:100%;max-width:300px;" class="stack-sm">
              <div style="display:flex;justify-content:space-between;font-size:0.8125rem;">
                <span>Token expires in</span>
                <strong class="mono" id="qr-countdown">--s</strong>
              </div>
              <div class="progress-track"><div class="progress-fill" id="qr-progress-bar" style="width:100%;"></div></div>
            </div>
            <div style="width:100%;" class="stack-sm">
              <span style="font-size:0.75rem;color:var(--text-muted);">Direct Check-in Code (accessibility / desktop fallback):</span>
              <div style="display:flex;gap:0.5rem;align-items:center;justify-content:center;flex-wrap:wrap;">
                <code class="mono" id="qr-compact-code" style="font-size:0.75rem;padding:0.35rem 0.6rem;background:var(--bg-surface);border:1px solid var(--border-hairline);border-radius:4px;word-break:break-all;"></code>
                <button type="button" class="btn btn-secondary btn-sm" id="copy-qr-code-btn">Copy Code</button>
              </div>
            </div>
          </div>

          <div style="display:flex;flex-wrap:wrap;gap:0.5rem;justify-content:space-between;align-items:center;">
            <button type="button" class="btn btn-secondary" id="rotate-now-btn">Rotate QR Now</button>
            <div style="display:flex;align-items:center;gap:0.75rem;">
              <label style="font-size:0.8125rem;display:flex;align-items:center;gap:0.35rem;">
                <input type="checkbox" id="mark-unmarked-absent" checked /> Mark unmarked absent
              </label>
              <button type="button" class="btn btn-danger" id="close-session-btn">Close Session</button>
            </div>
          </div>
        </section>

        <section class="panel stack-md">
          <div class="panel-header">
            <h2 class="panel-title">Live Check-Ins (Realtime DB)</h2>
            <span class="panel-meta mono" id="live-checkin-count">0 checked in</span>
          </div>
          <div id="live-checkins-list">
            ${renderEmptyState({
              title: 'Waiting for student scans',
              description: 'Students who scan the QR code will appear here in real time.',
            })}
          </div>
        </section>
      </div>
    `;

    const canvas = workspace.querySelector('#live-qr-canvas');
    const compactEl = workspace.querySelector('#qr-compact-code');
    const countdownEl = workspace.querySelector('#qr-countdown');
    const progressEl = workspace.querySelector('#qr-progress-bar');

    async function drawCurrentQr() {
      const payloadStr = encodeQrPayload(activeSession.sessionId, activeSession.token, activeSession.expiresAtMs);
      compactEl.textContent = `${activeSession.sessionId}:${activeSession.token}`;
      await QRCode.toCanvas(canvas, payloadStr, { width: 240, margin: 1 });
    }

    drawCurrentQr();

    let rotating = false;
    const timer = setInterval(async () => {
      if (!activeSession) return;
      const msLeft = Math.max(0, activeSession.expiresAtMs - Date.now());
      const secLeft = Math.ceil(msLeft / 1000);
      const pct = Math.min(100, Math.round((msLeft / (activeSession.rotationSeconds * 1000)) * 100));
      countdownEl.textContent = `${secLeft}s`;
      progressEl.style.width = `${pct}%`;

      if (msLeft <= 0 && !rotating) {
        rotating = true;
        try {
          const next = await rotateQrSessionToken(activeSession.sessionId, activeSession.rotationSeconds);
          activeSession.token = next.token;
          activeSession.expiresAtMs = next.expiresAtMs;
          await drawCurrentQr();
        } catch (err) {
          console.warn('Auto QR rotation error:', err.message);
        } finally {
          rotating = false;
        }
      }
    }, 500);
    activeTimers.push(timer);

    const unsub = subscribeLiveCheckins(activeSession.sessionId, (checkins) => {
      workspace.querySelector('#live-checkin-count').textContent = `${checkins.length} checked in`;
      const listEl = workspace.querySelector('#live-checkins-list');
      if (checkins.length === 0) return;
      listEl.innerHTML = `
        <div class="table-wrap">
          <table class="data-table">
            <thead><tr><th>Roll No.</th><th>Student</th><th>Status</th><th>Time</th></tr></thead>
            <tbody>
              ${checkins
                .map(
                  (c) => `
                <tr>
                  <td class="mono">${escapeHtml(c.rollNumber || '—')}</td>
                  <td><strong>${escapeHtml(c.studentName || c.uid)}</strong></td>
                  <td><span class="status-text status-success">Present</span></td>
                  <td class="mono" style="font-size:0.75rem;">${escapeHtml(formatDateTime(c.timestamp))}</td>
                </tr>
              `
                )
                .join('')}
            </tbody>
          </table>
        </div>
      `;
    });
    activeUnsubs.push(unsub);

    workspace.querySelector('#copy-qr-code-btn').addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(compactEl.textContent);
        showToast('Session check-in code copied.', 'success');
      } catch {
        showToast('Select and copy the code manually.', 'info');
      }
    });

    workspace.querySelector('#rotate-now-btn').addEventListener('click', async () => {
      const next = await rotateQrSessionToken(activeSession.sessionId, activeSession.rotationSeconds);
      activeSession.token = next.token;
      activeSession.expiresAtMs = next.expiresAtMs;
      await drawCurrentQr();
      showToast('QR token rotated.', 'info');
    });

    workspace.querySelector('#close-session-btn').addEventListener('click', async () => {
      const markAbsent = workspace.querySelector('#mark-unmarked-absent').checked;
      const ok = await showConfirm({
        title: 'Close Attendance Session?',
        message: markAbsent
          ? 'This will close QR scanning and record Absent for enrolled class students who did not scan.'
          : 'This will close QR scanning immediately.',
        confirmLabel: 'Close Session',
      });
      if (!ok) return;
      await closeQrSession(activeSession.sessionId, {
        markUnmarkedAbsent: markAbsent,
        classStudents,
        classId: activeSession.classId,
        subjectId: activeSession.subjectId,
        teacherId: profile.uid,
        thresholdPct: activeSession.thresholdPct || settings.defaultAttendanceThreshold,
      });
      cleanupTeacherListeners();
      activeSession = null;
      showToast('Attendance session closed.', 'success');
      renderTeacherQrSession(container);
    });
  }

  renderSetupOrLive();
}

async function renderTeacherManualAttendance(container) {
  const { profile, settings } = getState();
  container.innerHTML = `
    <div class="stack-lg">
      <div class="page-header">
        <div>
          <h1 class="page-title">Manual Attendance</h1>
          <p class="page-subtitle">Mark Present, Absent, Late, or Excused for any class roster and date.</p>
        </div>
      </div>
      <section class="panel stack-md" id="manual-panel">${renderTableSkeleton(4, 4)}</section>
    </div>
  `;

  const panel = container.querySelector('#manual-panel');
  const [classes, subjects, students] = await Promise.all([
    fetchCollection('classes'),
    fetchCollection('subjects'),
    fetchCollection('students'),
  ]);

  if (classes.length === 0 || subjects.length === 0) {
    panel.innerHTML = `<div class="notice notice-warning">Classes and subjects must be configured before taking manual attendance.</div>`;
    return;
  }

  panel.innerHTML = `
    <div class="form-grid form-grid-3">
      <div class="field">
        <label class="field-label" for="man-class">Class</label>
        <select class="select" id="man-class">
          ${classes.map((c) => `<option value="${escapeHtml(c.id)}">${escapeHtml(c.name)}</option>`).join('')}
        </select>
      </div>
      <div class="field">
        <label class="field-label" for="man-subject">Subject</label>
        <select class="select" id="man-subject">
          ${subjects.map((s) => `<option value="${escapeHtml(s.id)}">${escapeHtml(s.code + ' · ' + s.name)}</option>`).join('')}
        </select>
      </div>
      <div class="field">
        <label class="field-label" for="man-date">Session Date</label>
        <input class="input mono" id="man-date" type="date" value="${todayIsoDate()}" />
      </div>
    </div>
    <div class="toolbar">
      <span class="panel-meta" id="man-roster-meta"></span>
      <div class="toolbar-group">
        <button type="button" class="btn btn-secondary btn-sm" id="man-all-present">Mark All Present</button>
        <button type="button" class="btn btn-primary" id="man-save-btn">Save Attendance</button>
      </div>
    </div>
    <div id="man-roster-slot"></div>
  `;

  const classSel = panel.querySelector('#man-class');
  const subSel = panel.querySelector('#man-subject');
  const dateEl = panel.querySelector('#man-date');
  const rosterSlot = panel.querySelector('#man-roster-slot');
  const metaEl = panel.querySelector('#man-roster-meta');

  let statusMap = new Map();

  function getRoster() {
    const clsId = classSel.value;
    const matched = students.filter((s) => s.classId === clsId && s.status !== 'inactive');
    return matched;
  }

  function renderRoster() {
    const roster = getRoster();
    metaEl.textContent = `${roster.length} student${roster.length === 1 ? '' : 's'} enrolled in selected class`;
    if (roster.length === 0) {
      rosterSlot.innerHTML = renderEmptyState({
        title: 'No students assigned to this class',
        description: 'Assign students to this class in Admin > Students Directory to take manual attendance.',
      });
      return;
    }

    roster.forEach((st) => {
      if (!statusMap.has(st.uid || st.id)) statusMap.set(st.uid || st.id, 'present');
    });

    rosterSlot.innerHTML = `
      <div class="table-wrap">
        <table class="data-table">
          <thead><tr><th>Roll No.</th><th>Student</th><th>Attendance Status</th></tr></thead>
          <tbody>
            ${roster
              .map((st) => {
                const uid = st.uid || st.id;
                const curr = statusMap.get(uid) || 'present';
                return `
                  <tr>
                    <td class="mono">${escapeHtml(st.rollNumber)}</td>
                    <td><strong>${escapeHtml(st.name)}</strong></td>
                    <td>
                      <div class="segmented-bar">
                        ${['present', 'absent', 'late', 'excused']
                          .map(
                            (opt) =>
                              `<button type="button" class="segmented-btn ${curr === opt ? 'active' : ''}" data-st-uid="${escapeHtml(uid)}" data-st-val="${opt}" style="text-transform:capitalize;">${opt}</button>`
                          )
                          .join('')}
                      </div>
                    </td>
                  </tr>
                `;
              })
              .join('')}
          </tbody>
        </table>
      </div>
    `;

    rosterSlot.querySelectorAll('[data-st-uid]').forEach((btn) => {
      btn.addEventListener('click', () => {
        statusMap.set(btn.getAttribute('data-st-uid'), btn.getAttribute('data-st-val'));
        renderRoster();
      });
    });
  }

  classSel.addEventListener('change', renderRoster);
  panel.querySelector('#man-all-present').addEventListener('click', () => {
    getRoster().forEach((st) => statusMap.set(st.uid || st.id, 'present'));
    renderRoster();
  });

  panel.querySelector('#man-save-btn').addEventListener('click', async () => {
    const roster = getRoster();
    if (roster.length === 0) return showToast('No students in roster.', 'warning');
    const btn = panel.querySelector('#man-save-btn');
    btn.disabled = true;
    btn.textContent = 'Saving...';
    try {
      const entries = roster.map((st) => {
        const uid = st.uid || st.id;
        return {
          studentUid: uid,
          studentName: st.name,
          rollNumber: st.rollNumber,
          status: statusMap.get(uid) || 'present',
        };
      });
      await saveManualAttendanceBatch({
        classId: classSel.value,
        subjectId: subSel.value,
        teacherId: profile.uid,
        academicSession: settings.currentAcademicSession,
        date: dateEl.value,
        entries,
        thresholdPct: settings.defaultAttendanceThreshold,
      });
      showToast(`Saved attendance for ${entries.length} students.`, 'success');
    } catch (err) {
      showToast(err.message || 'Failed to save attendance.', 'danger');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Save Attendance';
    }
  });

  renderRoster();
}

async function renderTeacherCorrections(container) {
  const { profile } = getState();
  container.innerHTML = `
    <div class="stack-lg">
      <div class="page-header">
        <div>
          <h1 class="page-title">Correction Requests</h1>
          <p class="page-subtitle">Approve or reject student attendance correction requests. Approved requests update records atomically.</p>
        </div>
      </div>
      <div id="tch-corr-slot">${renderTableSkeleton(5, 4)}</div>
    </div>
  `;

  async function load() {
    const [requests, students, subjects] = await Promise.all([
      fetchCollection('correctionRequests'),
      fetchCollection('students'),
      fetchCollection('subjects'),
    ]);
    const stMap = new Map(students.map((s) => [s.uid || s.id, s]));
    const subMap = new Map(subjects.map((s) => [s.id, s.name]));
    const mine = requests.filter((r) => !r.teacherId || r.teacherId === profile.uid);

    const slot = container.querySelector('#tch-corr-slot');
    if (mine.length === 0) {
      slot.innerHTML = renderEmptyState({ title: 'No correction requests', description: 'Student correction requests for your sessions will appear here.' });
      return;
    }

    slot.innerHTML = `
      <div class="table-wrap"><table class="data-table"><thead><tr><th>Student</th><th>Subject</th><th>Change</th><th>Reason</th><th>Status</th><th class="num">Actions</th></tr></thead><tbody>
        ${mine
          .map((c) => {
            const st = stMap.get(c.studentUid);
            return `<tr>
              <td><strong>${escapeHtml(st?.name || c.studentUid)}</strong><br><span class="mono" style="font-size:0.75rem;color:var(--text-muted);">${escapeHtml(st?.rollNumber || '')}</span></td>
              <td>${escapeHtml(subMap.get(c.subjectId) || c.subjectId)}</td>
              <td style="text-transform:capitalize;">${escapeHtml(c.currentStatus)} &rarr; <strong>${escapeHtml(c.requestedStatus)}</strong></td>
              <td>${escapeHtml(c.reason)}${c.evidenceUrl ? ` · <a href="${escapeHtml(c.evidenceUrl)}" target="_blank" rel="noopener">Evidence</a>` : ''}</td>
              <td><span class="status-text ${c.status === 'approved' ? 'status-success' : c.status === 'rejected' ? 'status-danger' : 'status-warning'}">${escapeHtml(c.status)}</span></td>
              <td class="num">
                ${
                  c.status === 'pending'
                    ? `<button type="button" class="btn btn-primary btn-sm" data-app-corr="${escapeHtml(c.id)}">Approve</button>
                       <button type="button" class="btn btn-secondary btn-sm" data-rej-corr="${escapeHtml(c.id)}">Reject</button>`
                    : '—'
                }
              </td>
            </tr>`;
          })
          .join('')}
      </tbody></table></div>
    `;

    slot.querySelectorAll('[data-app-corr]').forEach((b) =>
      b.addEventListener('click', async () => {
        await reviewCorrectionRequest({ requestId: b.getAttribute('data-app-corr'), decision: 'approved', reviewerUid: profile.uid });
        showToast('Correction approved.', 'success');
        load();
      })
    );
    slot.querySelectorAll('[data-rej-corr]').forEach((b) =>
      b.addEventListener('click', async () => {
        await reviewCorrectionRequest({ requestId: b.getAttribute('data-rej-corr'), decision: 'rejected', reviewerUid: profile.uid });
        showToast('Correction rejected.', 'info');
        load();
      })
    );
  }

  load();
}

async function renderTeacherLeaves(container) {
  const { profile } = getState();
  container.innerHTML = `
    <div class="stack-lg">
      <div class="page-header">
        <div>
          <h1 class="page-title">Student Leave Requests</h1>
          <p class="page-subtitle">Review medical and academic leave requests.</p>
        </div>
      </div>
      <div id="tch-lv-slot">${renderTableSkeleton(5, 4)}</div>
    </div>
  `;

  async function load() {
    const [leaves, students] = await Promise.all([fetchCollection('leaveRequests'), fetchCollection('students')]);
    const stMap = new Map(students.map((s) => [s.uid || s.id, s]));
    const slot = container.querySelector('#tch-lv-slot');
    if (leaves.length === 0) {
      slot.innerHTML = renderEmptyState({ title: 'No leave requests', description: 'Submitted student leave requests will appear here.' });
      return;
    }
    slot.innerHTML = `
      <div class="table-wrap"><table class="data-table"><thead><tr><th>Student</th><th>Date Range</th><th>Reason</th><th>Status</th><th class="num">Actions</th></tr></thead><tbody>
        ${leaves
          .map((l) => {
            const st = stMap.get(l.studentUid);
            return `<tr>
              <td><strong>${escapeHtml(st?.name || l.studentUid)}</strong></td>
              <td class="mono">${escapeHtml(l.fromDate)} to ${escapeHtml(l.toDate)}</td>
              <td>${escapeHtml(l.reason)}${l.attachmentUrl ? ` · <a href="${escapeHtml(l.attachmentUrl)}" target="_blank" rel="noopener">Attachment</a>` : ''}</td>
              <td><span class="status-text ${l.status === 'approved' ? 'status-success' : l.status === 'rejected' ? 'status-danger' : 'status-warning'}">${escapeHtml(l.status)}</span></td>
              <td class="num">
                ${
                  l.status === 'pending'
                    ? `<button type="button" class="btn btn-primary btn-sm" data-app-lv="${escapeHtml(l.id)}" data-uid="${escapeHtml(l.studentUid)}">Approve</button>
                       <button type="button" class="btn btn-secondary btn-sm" data-rej-lv="${escapeHtml(l.id)}" data-uid="${escapeHtml(l.studentUid)}">Reject</button>`
                    : '—'
                }
              </td>
            </tr>`;
          })
          .join('')}
      </tbody></table></div>
    `;
    slot.querySelectorAll('[data-app-lv]').forEach((b) =>
      b.addEventListener('click', async () => {
        await updateDocById('leaveRequests', b.getAttribute('data-app-lv'), { status: 'approved', reviewedBy: profile.uid });
        await createNotification({ userId: b.getAttribute('data-uid'), title: 'Leave Approved', message: 'Your leave request was approved by faculty.', type: 'leave', linkView: 'leaves' });
        showToast('Leave approved.', 'success');
        load();
      })
    );
    slot.querySelectorAll('[data-rej-lv]').forEach((b) =>
      b.addEventListener('click', async () => {
        await updateDocById('leaveRequests', b.getAttribute('data-rej-lv'), { status: 'rejected', reviewedBy: profile.uid });
        await createNotification({ userId: b.getAttribute('data-uid'), title: 'Leave Rejected', message: 'Your leave request was rejected.', type: 'leave', linkView: 'leaves' });
        showToast('Leave rejected.', 'info');
        load();
      })
    );
  }

  load();
}

async function renderTeacherStudentAnalytics(container) {
  const { settings } = getState();
  const threshold = Number(settings.defaultAttendanceThreshold || 75);
  let search = '';
  let onlyBelow = false;
  let page = 1;

  container.innerHTML = `
    <div class="stack-lg">
      <div class="page-header">
        <div>
          <h1 class="page-title">Student Attendance &amp; Low-Attendance Alerts</h1>
          <p class="page-subtitle">Monitor student percentages against the ${threshold}% institutional threshold.</p>
        </div>
      </div>
      <section class="panel stack-md">
        <div class="toolbar">
          <input class="input" style="max-width:260px;" id="sa-search" placeholder="Search student or roll no..." />
          <label style="display:flex;align-items:center;gap:0.45rem;font-size:0.875rem;">
            <input type="checkbox" id="sa-only-low" /> Show only below ${threshold}%
          </label>
        </div>
        <div id="sa-table-slot">${renderTableSkeleton(5, 5)}</div>
      </section>
    </div>
  `;

  const [students, records] = await Promise.all([fetchCollection('students'), fetchCollection('attendanceRecords')]);

  function render() {
    const rows = students
      .map((st) => {
        const recs = records.filter((r) => r.studentUid === (st.uid || st.id));
        const sum = calculateAttendanceSummary(recs);
        return { st, sum };
      })
      .filter(({ st, sum }) => {
        const q = search.toLowerCase();
        const matchQ = !q || st.name?.toLowerCase().includes(q) || st.rollNumber?.toLowerCase().includes(q);
        const matchLow = !onlyBelow || (sum.total > 0 && sum.percentage < threshold);
        return matchQ && matchLow;
      });

    const paged = paginateItems(rows, page, 12);
    const slot = container.querySelector('#sa-table-slot');
    if (paged.totalItems === 0) {
      slot.innerHTML = renderEmptyState({ title: 'No matching students', description: 'Adjust your search or threshold filter.' });
      return;
    }

    slot.innerHTML = `
      <div class="table-wrap"><table class="data-table"><thead><tr><th>Roll No.</th><th>Student</th><th class="num">Attended</th><th class="num">Total</th><th class="num">%</th><th>Status</th></tr></thead><tbody>
        ${paged.items
          .map(({ st, sum }) => {
            const low = sum.total > 0 && sum.percentage < threshold;
            return `<tr>
              <td class="mono">${escapeHtml(st.rollNumber)}</td>
              <td><strong>${escapeHtml(st.name)}</strong></td>
              <td class="num">${sum.effectiveAttended}</td>
              <td class="num">${sum.total}</td>
              <td class="num"><strong>${sum.total ? sum.percentage + '%' : '—'}</strong></td>
              <td>${
                sum.total === 0
                  ? '<span class="status-muted">No classes yet</span>'
                  : low
                  ? `<span class="status-text status-danger">Warning (&lt; ${threshold}%)</span>`
                  : '<span class="status-text status-success">On Track</span>'
              }</td>
            </tr>`;
          })
          .join('')}
      </tbody></table></div>
      <div class="pagination">
        <span>Showing ${paged.items.length} of ${paged.totalItems}</span>
        <div class="pagination-controls">
          <button type="button" class="btn btn-secondary btn-sm" id="sa-prev" ${paged.page <= 1 ? 'disabled' : ''}>Prev</button>
          <span>Page ${paged.page}/${paged.totalPages}</span>
          <button type="button" class="btn btn-secondary btn-sm" id="sa-next" ${paged.page >= paged.totalPages ? 'disabled' : ''}>Next</button>
        </div>
      </div>
    `;
    slot.querySelector('#sa-prev')?.addEventListener('click', () => {
      page -= 1;
      render();
    });
    slot.querySelector('#sa-next')?.addEventListener('click', () => {
      page += 1;
      render();
    });
  }

  container.querySelector('#sa-search').addEventListener('input', (e) => {
    search = e.target.value;
    page = 1;
    render();
  });
  container.querySelector('#sa-only-low').addEventListener('change', (e) => {
    onlyBelow = e.target.checked;
    page = 1;
    render();
  });

  render();
}

async function renderTeacherReports(container) {
  const { profile, settings } = getState();
  const threshold = Number(settings.defaultAttendanceThreshold || 75);

  container.innerHTML = `
    <div class="stack-lg">
      <div class="page-header">
        <div>
          <h1 class="page-title">Faculty Attendance Reports</h1>
          <p class="page-subtitle">Export subject-wise and class-wise attendance reports in PDF or Excel format.</p>
        </div>
        <div class="page-actions">
          <button type="button" class="btn btn-secondary" id="t-exp-xlsx">${icon('download', 16)} Export Excel</button>
          <button type="button" class="btn btn-primary" id="t-exp-pdf">${icon('file', 16)} Export PDF</button>
        </div>
      </div>
      <section class="panel stack-md">
        <div class="form-grid form-grid-2">
          <div class="field"><label class="field-label">Subject</label><select class="select" id="t-rep-sub"><option value="all">All Subjects</option></select></div>
          <div class="field"><label class="field-label">Class</label><select class="select" id="t-rep-cls"><option value="all">All Classes</option></select></div>
        </div>
        <div id="t-rep-slot">${renderTableSkeleton(5, 4)}</div>
      </section>
    </div>
  `;

  const [records, students, subjects, classes] = await Promise.all([
    fetchCollection('attendanceRecords', [where('teacherId', '==', profile.uid)]),
    fetchCollection('students'),
    fetchCollection('subjects'),
    fetchCollection('classes'),
  ]);

  const stMap = new Map(students.map((s) => [s.uid || s.id, s]));
  const subMap = new Map(subjects.map((s) => [s.id, s]));
  const clsMap = new Map(classes.map((c) => [c.id, c]));

  const subSel = container.querySelector('#t-rep-sub');
  const clsSel = container.querySelector('#t-rep-cls');
  subSel.innerHTML = '<option value="all">All Subjects</option>' + subjects.map((s) => `<option value="${escapeHtml(s.id)}">${escapeHtml(s.code + ' · ' + s.name)}</option>`).join('');
  clsSel.innerHTML = '<option value="all">All Classes</option>' + classes.map((c) => `<option value="${escapeHtml(c.id)}">${escapeHtml(c.name)}</option>`).join('');

  let exportRows = [];

  function build() {
    const filtered = records.filter((r) => {
      if (subSel.value !== 'all' && r.subjectId !== subSel.value) return false;
      if (clsSel.value !== 'all' && r.classId !== clsSel.value) return false;
      return true;
    });
    const grouped = new Map();
    for (const r of filtered) {
      const k = `${r.studentUid}__${r.subjectId}`;
      const list = grouped.get(k) || [];
      list.push(r);
      grouped.set(k, list);
    }
    exportRows = [...grouped.entries()].map(([k, recs]) => {
      const [studentUid, subjectId] = k.split('__');
      const st = stMap.get(studentUid);
      const sub = subMap.get(subjectId);
      const cls = clsMap.get(recs[0]?.classId);
      const sum = calculateAttendanceSummary(recs);
      return [
        st?.rollNumber || recs[0]?.rollNumber || '—',
        st?.name || recs[0]?.studentName || studentUid,
        cls?.name || '—',
        sub ? `${sub.code} · ${sub.name}` : subjectId,
        sum.effectiveAttended,
        sum.total,
        sum.percentage,
        sum.percentage < threshold ? `Below ${threshold}%` : 'Good Standing',
      ];
    });

    const slot = container.querySelector('#t-rep-slot');
    if (exportRows.length === 0) {
      slot.innerHTML = renderEmptyState({ title: 'No attendance records found', description: 'Take attendance via QR or Manual mode to generate reports.' });
      return;
    }
    slot.innerHTML = `
      <div class="table-wrap"><table class="data-table"><thead><tr><th>Roll No.</th><th>Student</th><th>Class</th><th>Subject</th><th class="num">Attended</th><th class="num">Total</th><th class="num">%</th><th>Standing</th></tr></thead><tbody>
        ${exportRows
          .map(
            (r) => `<tr>
            <td class="mono">${escapeHtml(r[0])}</td>
            <td><strong>${escapeHtml(r[1])}</strong></td>
            <td>${escapeHtml(r[2])}</td>
            <td>${escapeHtml(r[3])}</td>
            <td class="num">${r[4]}</td>
            <td class="num">${r[5]}</td>
            <td class="num"><strong>${r[6]}%</strong></td>
            <td><span class="status-text ${String(r[7]).startsWith('Below') ? 'status-danger' : 'status-success'}">${escapeHtml(r[7])}</span></td>
          </tr>`
          )
          .join('')}
      </tbody></table></div>
    `;
  }

  subSel.addEventListener('change', build);
  clsSel.addEventListener('change', build);

  container.querySelector('#t-exp-pdf').addEventListener('click', () => {
    if (exportRows.length === 0) return showToast('No data to export.', 'warning');
    exportAttendancePdf({
      title: `Faculty Report — ${profile.name}`,
      subtitle: `Session: ${settings.currentAcademicSession}`,
      columns: ['Roll No.', 'Student', 'Class', 'Subject', 'Attended', 'Total', 'Pct %', 'Standing'],
      rows: exportRows.map((r) => [r[0], r[1], r[2], r[3], r[4], r[5], `${r[6]}%`, r[7]]),
      fileName: `faculty-attendance-${todayIsoDate()}.pdf`,
    });
    showToast('PDF downloaded.', 'success');
  });

  container.querySelector('#t-exp-xlsx').addEventListener('click', () => {
    if (exportRows.length === 0) return showToast('No data to export.', 'warning');
    exportAttendanceExcel({
      sheetName: 'Faculty Attendance',
      columns: ['Roll No.', 'Student', 'Class', 'Subject', 'Attended', 'Total', 'Pct %', 'Standing'],
      rows: exportRows,
      fileName: `faculty-attendance-${todayIsoDate()}.xlsx`,
    });
    showToast('Excel downloaded.', 'success');
  });

  build();
}
