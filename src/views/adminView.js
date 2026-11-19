import { Chart, registerables } from 'chart.js';
import {
  fetchCollection,
  createDoc,
  updateDocById,
  deleteDocById,
  saveAcademicSettings,
  logAudit,
  createNotification,
} from '../services/firestoreService.js';
import { adminCreateUserAccount } from '../services/authService.js';
import { reviewCorrectionRequest } from '../services/attendanceService.js';
import { exportAttendancePdf, exportAttendanceExcel } from '../services/reportService.js';
import { seedDemoDataset, clearDemoDataset } from '../services/seedService.js';
import {
  calculateAttendanceSummary,
  escapeHtml,
  formatDateTime,
  paginateItems,
  todayIsoDate,
} from '../utils/attendanceMath.js';
import { icon } from '../utils/icons.js';
import {
  showToast,
  showConfirm,
  openModal,
  closeModal,
  renderEmptyState,
  renderTableSkeleton,
} from '../utils/ui.js';
import { getState } from '../state/store.js';
import { renderProfileView, renderNotificationsView } from './sharedViews.js';

Chart.register(...registerables);

let activeCharts = [];
function destroyCharts() {
  activeCharts.forEach((c) => c.destroy());
  activeCharts = [];
}

export async function renderAdminView(container, viewKey) {
  destroyCharts();
  switch (viewKey) {
    case 'overview':
      return renderAdminOverview(container);
    case 'academic':
      return renderAdminAcademicSettings(container);
    case 'departments':
      return renderAdminDepartmentsAndCourses(container);
    case 'subjects':
      return renderAdminSubjectsAndClasses(container);
    case 'teachers':
      return renderAdminTeachers(container);
    case 'students':
      return renderAdminStudents(container);
    case 'timetable':
      return renderAdminTimetableAndHolidays(container);
    case 'requests':
      return renderAdminRequests(container);
    case 'announcements':
      return renderAdminAnnouncements(container);
    case 'reports':
      return renderAdminReports(container);
    case 'auditLogs':
      return renderAdminAuditLogs(container);
    case 'notifications':
      return renderNotificationsView(container);
    case 'profile':
      return renderProfileView(container);
    default:
      return renderAdminOverview(container);
  }
}

async function renderAdminOverview(container) {
  const { settings, profile } = getState();
  container.innerHTML = `
    <div class="stack-lg">
      <div class="page-header">
        <div>
          <h1 class="page-title">Institution Overview</h1>
          <p class="page-subtitle">Session: ${escapeHtml(settings.currentAcademicSession)} · Threshold: ${settings.defaultAttendanceThreshold}%</p>
        </div>
        <div class="page-actions">
          <button type="button" class="btn btn-secondary" id="admin-seed-quick">Seed Demo Dataset</button>
          <button type="button" class="btn btn-primary" id="admin-goto-reports">${icon('download', 16)} Export Reports</button>
        </div>
      </div>
      <div id="admin-overview-body">${renderTableSkeleton(4, 4)}</div>
    </div>
  `;

  container.querySelector('#admin-goto-reports').addEventListener('click', () => {
    window.dispatchEvent(new CustomEvent('smartattend:navigate', { detail: 'reports' }));
  });

  container.querySelector('#admin-seed-quick').addEventListener('click', async () => {
    const ok = await showConfirm({
      title: 'Seed Demo Academic Dataset?',
      message: 'This adds clearly labeled demo departments, courses, subjects, classes, timetable, holidays, and sample attendance records for testing.',
      confirmLabel: 'Seed Demo Data',
    });
    if (!ok) return;
    try {
      await seedDemoDataset(profile.uid);
      showToast('Demo dataset seeded.', 'success');
      renderAdminOverview(container);
    } catch (err) {
      showToast(err.message || 'Seeding failed.', 'danger');
    }
  });

  const bodyEl = container.querySelector('#admin-overview-body');
  try {
    const [students, teachers, classes, subjects, records, leaves, corrections, audits] = await Promise.all([
      fetchCollection('students'),
      fetchCollection('teachers'),
      fetchCollection('classes'),
      fetchCollection('subjects'),
      fetchCollection('attendanceRecords'),
      fetchCollection('leaveRequests'),
      fetchCollection('correctionRequests'),
      fetchCollection('auditLogs'),
    ]);

    const summary = calculateAttendanceSummary(records);
    const threshold = Number(settings.defaultAttendanceThreshold || 75);

    // Compute per-student attendance
    const byStudent = new Map();
    for (const r of records) {
      const list = byStudent.get(r.studentUid) || [];
      list.push(r);
      byStudent.set(r.studentUid, list);
    }
    const lowStudents = [];
    for (const st of students) {
      const stRecords = byStudent.get(st.uid) || [];
      if (stRecords.length === 0) continue;
      const s = calculateAttendanceSummary(stRecords);
      if (s.percentage < threshold) {
        lowStudents.push({ student: st, summary: s });
      }
    }

    const pendingLeaves = leaves.filter((l) => l.status === 'pending').length;
    const pendingCorr = corrections.filter((c) => c.status === 'pending').length;

    bodyEl.innerHTML = `
      <div class="stack-lg">
        <div class="grid-kpi">
          <div class="kpi-card">
            <span class="kpi-label">Active Students</span>
            <span class="kpi-value">${students.length}</span>
            <span class="kpi-foot">${classes.length} classes configured</span>
          </div>
          <div class="kpi-card">
            <span class="kpi-label">Faculty Members</span>
            <span class="kpi-value">${teachers.length}</span>
            <span class="kpi-foot">${subjects.length} subjects assigned</span>
          </div>
          <div class="kpi-card">
            <span class="kpi-label">Institutional Attendance</span>
            <span class="kpi-value">${records.length ? summary.percentage + '%' : '—'}</span>
            <span class="kpi-foot">${summary.effectiveAttended} / ${summary.total} records attended</span>
          </div>
          <div class="kpi-card">
            <span class="kpi-label">Below ${threshold}% / Pending</span>
            <span class="kpi-value ${lowStudents.length > 0 ? 'status-danger' : ''}">${lowStudents.length}</span>
            <span class="kpi-foot">${pendingLeaves} leaves · ${pendingCorr} corrections pending</span>
          </div>
        </div>

        <div class="grid-2">
          <section class="panel stack-md">
            <div class="panel-header">
              <h2 class="panel-title">Attendance Trend by Date</h2>
              <span class="panel-meta">Percentage across recent sessions</span>
            </div>
            <div class="chart-box"><canvas id="chart-admin-trend"></canvas></div>
          </section>

          <section class="panel stack-md">
            <div class="panel-header">
              <h2 class="panel-title">Attendance by Subject</h2>
              <span class="panel-meta">Subject-wise percentage</span>
            </div>
            <div class="chart-box"><canvas id="chart-admin-subjects"></canvas></div>
          </section>
        </div>

        <div class="grid-2">
          <section class="panel stack-md">
            <div class="panel-header">
              <h2 class="panel-title">Low-Attendance Watchlist (&lt; ${threshold}%)</h2>
              <span class="panel-meta">${lowStudents.length} flagged</span>
            </div>
            ${
              lowStudents.length === 0
                ? renderEmptyState({
                    title: 'No students below threshold',
                    description: 'Students falling below the configured attendance threshold will appear here automatically.',
                  })
                : `<div class="table-wrap">
                    <table class="data-table">
                      <thead><tr><th>Student</th><th>Roll No.</th><th class="num">Attended</th><th class="num">Pct</th></tr></thead>
                      <tbody>
                        ${lowStudents
                          .slice(0, 8)
                          .map(
                            (row) => `
                          <tr>
                            <td><strong>${escapeHtml(row.student.name)}</strong></td>
                            <td class="mono">${escapeHtml(row.student.rollNumber)}</td>
                            <td class="num">${row.summary.effectiveAttended}/${row.summary.total}</td>
                            <td class="num status-danger"><strong>${row.summary.percentage}%</strong></td>
                          </tr>
                        `
                          )
                          .join('')}
                      </tbody>
                    </table>
                  </div>`
            }
          </section>

          <section class="panel stack-md">
            <div class="panel-header">
              <h2 class="panel-title">Recent Audit Activity</h2>
              <span class="panel-meta">Immutable event trail</span>
            </div>
            ${
              audits.length === 0
                ? renderEmptyState({
                    title: 'No audit events recorded yet',
                    description: 'Administrative and attendance actions are logged here automatically.',
                  })
                : `<div class="table-wrap">
                    <table class="data-table">
                      <thead><tr><th>Action</th><th>Actor</th><th>Time</th></tr></thead>
                      <tbody>
                        ${[...audits]
                          .sort((a, b) => (b.timestamp?.toMillis?.() || 0) - (a.timestamp?.toMillis?.() || 0))
                          .slice(0, 6)
                          .map(
                            (a) => `
                          <tr>
                            <td><strong>${escapeHtml(a.action)}</strong><br><span style="font-size:0.75rem;color:var(--text-muted);">${escapeHtml(a.details || a.entityType)}</span></td>
                            <td>${escapeHtml(a.actorEmail || a.actorRole)}</td>
                            <td class="mono" style="font-size:0.75rem;">${escapeHtml(formatDateTime(a.timestamp))}</td>
                          </tr>
                        `
                          )
                          .join('')}
                      </tbody>
                    </table>
                  </div>`
            }
          </section>
        </div>
      </div>
    `;

    // Build Trend Chart
    const byDate = new Map();
    for (const r of records) {
      const list = byDate.get(r.date) || [];
      list.push(r);
      byDate.set(r.date, list);
    }
    const sortedDates = [...byDate.keys()].sort().slice(-10);
    const trendValues = sortedDates.map((d) => calculateAttendanceSummary(byDate.get(d)).percentage);

    const trendCtx = bodyEl.querySelector('#chart-admin-trend');
    if (trendCtx) {
      activeCharts.push(
        new Chart(trendCtx, {
          type: 'line',
          data: {
            labels: sortedDates.length ? sortedDates : ['No Data'],
            datasets: [
              {
                label: 'Attendance %',
                data: trendValues.length ? trendValues : [0],
                borderColor: '#1d4ed8',
                backgroundColor: 'rgba(29, 78, 216, 0.12)',
                fill: true,
                tension: 0.25,
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

    // Build Subject Chart
    const subjectLabels = [];
    const subjectValues = [];
    for (const sub of subjects.slice(0, 8)) {
      const subRecs = records.filter((r) => r.subjectId === sub.id);
      if (subRecs.length > 0) {
        subjectLabels.push(sub.code || sub.name);
        subjectValues.push(calculateAttendanceSummary(subRecs).percentage);
      }
    }
    const subCtx = bodyEl.querySelector('#chart-admin-subjects');
    if (subCtx) {
      activeCharts.push(
        new Chart(subCtx, {
          type: 'bar',
          data: {
            labels: subjectLabels.length ? subjectLabels : ['No Sessions Yet'],
            datasets: [
              {
                label: 'Attendance %',
                data: subjectValues.length ? subjectValues : [0],
                backgroundColor: subjectValues.map((v) => (v < threshold ? '#dc2626' : '#16a34a')),
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
    bodyEl.innerHTML = `<div class="notice notice-danger">${escapeHtml(err.message)}</div>`;
  }
}

async function renderAdminAcademicSettings(container) {
  const { settings } = getState();
  const sessions = Array.isArray(settings.academicSessions) ? settings.academicSessions : ['2026-2027 Fall'];

  container.innerHTML = `
    <div class="stack-lg">
      <div class="page-header">
        <div>
          <h1 class="page-title">Academic Sessions &amp; Policies</h1>
          <p class="page-subtitle">Configure active academic term, attendance thresholds, QR rotation, and server integration mode.</p>
        </div>
      </div>

      <div class="grid-2">
        <section class="panel stack-md">
          <h2 class="panel-title">Attendance &amp; QR Policies</h2>
          <form id="settings-form" class="stack-md">
            <div class="field">
              <label class="field-label" for="set-active-session">Active Academic Session</label>
              <select class="select" id="set-active-session" name="currentAcademicSession">
                ${sessions
                  .map(
                    (s) =>
                      `<option value="${escapeHtml(s)}" ${s === settings.currentAcademicSession ? 'selected' : ''}>${escapeHtml(s)}</option>`
                  )
                  .join('')}
              </select>
            </div>
            <div class="form-grid form-grid-2">
              <div class="field">
                <label class="field-label" for="set-threshold">Default Threshold (%)</label>
                <input class="input mono" id="set-threshold" name="defaultAttendanceThreshold" type="number" min="1" max="100" value="${Number(settings.defaultAttendanceThreshold || 75)}" required />
              </div>
              <div class="field">
                <label class="field-label" for="set-qr-rot">QR Rotation (seconds)</label>
                <input class="input mono" id="set-qr-rot" name="qrRotationSeconds" type="number" min="10" max="120" value="${Number(settings.qrRotationSeconds || 15)}" required />
              </div>
            </div>
            <div class="field">
              <label class="field-label" for="set-grace">Late Grace Period (minutes)</label>
              <input class="input mono" id="set-grace" name="lateGraceMinutes" type="number" min="0" max="60" value="${Number(settings.lateGraceMinutes || 10)}" />
            </div>
            <div class="field">
              <label style="display:flex;align-items:center;gap:0.5rem;cursor:pointer;">
                <input type="checkbox" id="set-use-fn" name="useCloudFunctions" ${settings.useCloudFunctions ? 'checked' : ''} />
                <span style="font-size:0.875rem;font-weight:500;">Use Deployed Firebase Cloud Functions (Blaze Plan)</span>
              </label>
              <span class="field-hint">When unchecked (Spark Free Plan safe alternative), SmartAttend validates rotating QR tokens and prevents duplicates using atomic Firestore Transactions and Firestore Security Rules.</span>
            </div>
            <button type="submit" class="btn btn-primary">Save Policy Settings</button>
          </form>
        </section>

        <section class="panel stack-md">
          <h2 class="panel-title">Manage Academic Sessions</h2>
          <form id="add-session-form" class="toolbar">
            <input class="input" id="new-session-name" placeholder="e.g. 2027-2028 Fall" required maxlength="50" />
            <button type="submit" class="btn btn-secondary">Add Session</button>
          </form>
          <div class="table-wrap">
            <table class="data-table">
              <thead><tr><th>Session Name</th><th>Status</th><th class="num">Action</th></tr></thead>
              <tbody>
                ${sessions
                  .map(
                    (s) => `
                  <tr>
                    <td><strong>${escapeHtml(s)}</strong></td>
                    <td>${s === settings.currentAcademicSession ? '<span class="status-text status-success">Active</span>' : '<span class="status-muted">Inactive</span>'}</td>
                    <td class="num">
                      ${
                        s !== settings.currentAcademicSession
                          ? `<button type="button" class="btn btn-ghost btn-sm" data-del-session="${escapeHtml(s)}">Remove</button>`
                          : '—'
                      }
                    </td>
                  </tr>
                `
                  )
                  .join('')}
              </tbody>
            </table>
          </div>

          <div class="notice stack-sm" style="margin-top:0.5rem;">
            <strong style="font-size:0.875rem;">Testing &amp; Demo Data Utility</strong>
            <span style="font-size:0.8125rem;color:var(--text-secondary);">Seed or remove clearly labeled demo records (<code>isDemo: true</code>) without affecting production data.</span>
            <div class="toolbar-group">
              <button type="button" class="btn btn-secondary btn-sm" id="seed-demo-btn">Seed Demo Data</button>
              <button type="button" class="btn btn-danger btn-sm" id="clear-demo-btn">Clear Demo Data</button>
            </div>
          </div>
        </section>
      </div>
    </div>
  `;

  container.querySelector('#settings-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      await saveAcademicSettings({
        currentAcademicSession: String(fd.get('currentAcademicSession')),
        defaultAttendanceThreshold: Number(fd.get('defaultAttendanceThreshold')),
        qrRotationSeconds: Number(fd.get('qrRotationSeconds')),
        lateGraceMinutes: Number(fd.get('lateGraceMinutes')),
        useCloudFunctions: Boolean(fd.get('useCloudFunctions')),
      });
      showToast('Academic policy settings saved.', 'success');
      renderAdminAcademicSettings(container);
    } catch (err) {
      showToast(err.message || 'Failed to save settings.', 'danger');
    }
  });

  container.querySelector('#add-session-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const val = container.querySelector('#new-session-name').value.trim();
    if (!val || sessions.includes(val)) {
      showToast('Enter a unique academic session name.', 'warning');
      return;
    }
    try {
      await saveAcademicSettings({ academicSessions: [...sessions, val] });
      showToast('Academic session added.', 'success');
      renderAdminAcademicSettings(container);
    } catch (err) {
      showToast(err.message, 'danger');
    }
  });

  container.querySelectorAll('[data-del-session]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const target = btn.getAttribute('data-del-session');
      await saveAcademicSettings({ academicSessions: sessions.filter((s) => s !== target) });
      showToast('Session removed.', 'success');
      renderAdminAcademicSettings(container);
    });
  });

  container.querySelector('#seed-demo-btn').addEventListener('click', async () => {
    await seedDemoDataset(getState().profile.uid);
    showToast('Demo dataset seeded.', 'success');
  });

  container.querySelector('#clear-demo-btn').addEventListener('click', async () => {
    const ok = await showConfirm({
      title: 'Clear All Demo Data?',
      message: 'This deletes all records tagged with isDemo: true across academic collections.',
      confirmLabel: 'Clear Demo Data',
      danger: true,
    });
    if (!ok) return;
    const count = await clearDemoDataset();
    showToast(`Cleared ${count} demo documents.`, 'success');
  });
}

async function renderAdminDepartmentsAndCourses(container) {
  let deptSearch = '';
  let deptPage = 1;

  container.innerHTML = `
    <div class="stack-lg">
      <div class="page-header">
        <div>
          <h1 class="page-title">Departments &amp; Courses</h1>
          <p class="page-subtitle">Define academic departments and degree programs.</p>
        </div>
        <div class="page-actions">
          <button type="button" class="btn btn-secondary" id="add-course-btn">${icon('plus', 16)} Add Course</button>
          <button type="button" class="btn btn-primary" id="add-dept-btn">${icon('plus', 16)} Add Department</button>
        </div>
      </div>

      <section class="panel stack-md">
        <div class="toolbar">
          <h2 class="panel-title">Departments</h2>
          <input class="input" style="max-width:260px;" id="dept-search" placeholder="Search departments..." />
        </div>
        <div id="dept-table-slot">${renderTableSkeleton(4, 3)}</div>
      </section>

      <section class="panel stack-md">
        <div class="panel-header">
          <h2 class="panel-title">Courses / Programs</h2>
        </div>
        <div id="course-table-slot">${renderTableSkeleton(4, 3)}</div>
      </section>
    </div>
  `;

  let depts = [];
  let courses = [];

  async function loadAll() {
    [depts, courses] = await Promise.all([fetchCollection('departments'), fetchCollection('courses')]);
    renderDepts();
    renderCourses();
  }

  function renderDepts() {
    const filtered = depts.filter(
      (d) =>
        !deptSearch ||
        d.name?.toLowerCase().includes(deptSearch.toLowerCase()) ||
        d.code?.toLowerCase().includes(deptSearch.toLowerCase())
    );
    const paged = paginateItems(filtered, deptPage, 8);
    const slot = container.querySelector('#dept-table-slot');
    if (paged.totalItems === 0) {
      slot.innerHTML = renderEmptyState({
        title: 'No departments found',
        description: 'Add your first academic department to organize courses, faculty, and students.',
      });
      return;
    }
    slot.innerHTML = `
      <div class="table-wrap">
        <table class="data-table">
          <thead><tr><th>Code</th><th>Department Name</th><th class="num">Actions</th></tr></thead>
          <tbody>
            ${paged.items
              .map(
                (d) => `
              <tr>
                <td class="mono"><strong>${escapeHtml(d.code)}</strong></td>
                <td>${escapeHtml(d.name)}</td>
                <td class="num">
                  <button type="button" class="btn btn-ghost btn-sm" data-edit-dept="${escapeHtml(d.id)}">Edit</button>
                  <button type="button" class="btn btn-ghost btn-sm status-danger" data-del-dept="${escapeHtml(d.id)}">Delete</button>
                </td>
              </tr>
            `
              )
              .join('')}
          </tbody>
        </table>
      </div>
      <div class="pagination">
        <span>Showing ${paged.items.length} of ${paged.totalItems}</span>
        <div class="pagination-controls">
          <button type="button" class="btn btn-secondary btn-sm" id="dept-prev" ${paged.page <= 1 ? 'disabled' : ''}>Prev</button>
          <span>Page ${paged.page}/${paged.totalPages}</span>
          <button type="button" class="btn btn-secondary btn-sm" id="dept-next" ${paged.page >= paged.totalPages ? 'disabled' : ''}>Next</button>
        </div>
      </div>
    `;

    slot.querySelector('#dept-prev')?.addEventListener('click', () => {
      deptPage -= 1;
      renderDepts();
    });
    slot.querySelector('#dept-next')?.addEventListener('click', () => {
      deptPage += 1;
      renderDepts();
    });
    slot.querySelectorAll('[data-edit-dept]').forEach((btn) => {
      btn.addEventListener('click', () => openDeptModal(depts.find((x) => x.id === btn.getAttribute('data-edit-dept'))));
    });
    slot.querySelectorAll('[data-del-dept]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.getAttribute('data-del-dept');
        const ok = await showConfirm({
          title: 'Delete Department?',
          message: 'Ensure dependent courses and subjects are reassigned first.',
          confirmLabel: 'Delete',
          danger: true,
        });
        if (!ok) return;
        await deleteDocById('departments', id);
        await logAudit('DELETE_DEPARTMENT', 'departments', id);
        showToast('Department deleted.', 'success');
        loadAll();
      });
    });
  }

  function renderCourses() {
    const deptMap = new Map(depts.map((d) => [d.id, d.name]));
    const slot = container.querySelector('#course-table-slot');
    if (courses.length === 0) {
      slot.innerHTML = renderEmptyState({
        title: 'No courses created yet',
        description: 'Create degree programs linked to your departments.',
      });
      return;
    }
    slot.innerHTML = `
      <div class="table-wrap">
        <table class="data-table">
          <thead><tr><th>Code</th><th>Course Name</th><th>Department</th><th class="num">Semesters</th><th class="num">Actions</th></tr></thead>
          <tbody>
            ${courses
              .map(
                (c) => `
              <tr>
                <td class="mono"><strong>${escapeHtml(c.code)}</strong></td>
                <td>${escapeHtml(c.name)}</td>
                <td>${escapeHtml(deptMap.get(c.departmentId) || '—')}</td>
                <td class="num">${Number(c.durationSemesters || 8)}</td>
                <td class="num">
                  <button type="button" class="btn btn-ghost btn-sm" data-edit-course="${escapeHtml(c.id)}">Edit</button>
                  <button type="button" class="btn btn-ghost btn-sm status-danger" data-del-course="${escapeHtml(c.id)}">Delete</button>
                </td>
              </tr>
            `
              )
              .join('')}
          </tbody>
        </table>
      </div>
    `;

    slot.querySelectorAll('[data-edit-course]').forEach((btn) => {
      btn.addEventListener('click', () => openCourseModal(courses.find((x) => x.id === btn.getAttribute('data-edit-course'))));
    });
    slot.querySelectorAll('[data-del-course]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.getAttribute('data-del-course');
        const ok = await showConfirm({ title: 'Delete Course?', message: 'Remove this course permanently?', confirmLabel: 'Delete', danger: true });
        if (!ok) return;
        await deleteDocById('courses', id);
        await logAudit('DELETE_COURSE', 'courses', id);
        showToast('Course deleted.', 'success');
        loadAll();
      });
    });
  }

  function openDeptModal(existing = null) {
    openModal({
      title: existing ? 'Edit Department' : 'Create Department',
      bodyHtml: `
        <form id="dept-modal-form" class="stack-md">
          <div class="field">
            <label class="field-label">Department Code</label>
            <input class="input mono" name="code" required maxlength="16" value="${escapeHtml(existing?.code || '')}" placeholder="CSE" />
          </div>
          <div class="field">
            <label class="field-label">Department Name</label>
            <input class="input" name="name" required maxlength="100" value="${escapeHtml(existing?.name || '')}" placeholder="Computer Science & Engineering" />
          </div>
          <button type="submit" class="btn btn-primary">${existing ? 'Update Department' : 'Create Department'}</button>
        </form>
      `,
      onMount(dialog) {
        dialog.querySelector('#dept-modal-form').addEventListener('submit', async (e) => {
          e.preventDefault();
          const fd = new FormData(e.target);
          const payload = { code: String(fd.get('code')).trim().toUpperCase(), name: String(fd.get('name')).trim(), headTeacherId: '' };
          if (existing) {
            await updateDocById('departments', existing.id, payload);
            await logAudit('UPDATE_DEPARTMENT', 'departments', existing.id, payload.name);
          } else {
            const id = await createDoc('departments', payload);
            await logAudit('CREATE_DEPARTMENT', 'departments', id, payload.name);
          }
          closeModal();
          showToast('Department saved.', 'success');
          loadAll();
        });
      },
    });
  }

  function openCourseModal(existing = null) {
    openModal({
      title: existing ? 'Edit Course' : 'Create Course',
      bodyHtml: `
        <form id="course-modal-form" class="stack-md">
          <div class="field">
            <label class="field-label">Course Code</label>
            <input class="input mono" name="code" required maxlength="20" value="${escapeHtml(existing?.code || '')}" placeholder="BTECH-CS" />
          </div>
          <div class="field">
            <label class="field-label">Course Name</label>
            <input class="input" name="name" required maxlength="100" value="${escapeHtml(existing?.name || '')}" placeholder="B.Tech Computer Science" />
          </div>
          <div class="field">
            <label class="field-label">Department</label>
            <select class="select" name="departmentId" required>
              <option value="">Select department</option>
              ${depts.map((d) => `<option value="${escapeHtml(d.id)}" ${existing?.departmentId === d.id ? 'selected' : ''}>${escapeHtml(d.name)}</option>`).join('')}
            </select>
          </div>
          <div class="field">
            <label class="field-label">Duration (Semesters)</label>
            <input class="input mono" name="durationSemesters" type="number" min="1" max="12" value="${Number(existing?.durationSemesters || 8)}" required />
          </div>
          <button type="submit" class="btn btn-primary">${existing ? 'Update Course' : 'Create Course'}</button>
        </form>
      `,
      onMount(dialog) {
        dialog.querySelector('#course-modal-form').addEventListener('submit', async (e) => {
          e.preventDefault();
          const fd = new FormData(e.target);
          const payload = {
            code: String(fd.get('code')).trim().toUpperCase(),
            name: String(fd.get('name')).trim(),
            departmentId: String(fd.get('departmentId')),
            durationSemesters: Number(fd.get('durationSemesters')),
          };
          if (existing) {
            await updateDocById('courses', existing.id, payload);
            await logAudit('UPDATE_COURSE', 'courses', existing.id, payload.name);
          } else {
            const id = await createDoc('courses', payload);
            await logAudit('CREATE_COURSE', 'courses', id, payload.name);
          }
          closeModal();
          showToast('Course saved.', 'success');
          loadAll();
        });
      },
    });
  }

  container.querySelector('#add-dept-btn').addEventListener('click', () => openDeptModal());
  container.querySelector('#add-course-btn').addEventListener('click', () => openCourseModal());
  container.querySelector('#dept-search').addEventListener('input', (e) => {
    deptSearch = e.target.value;
    deptPage = 1;
    renderDepts();
  });

  loadAll();
}

async function renderAdminSubjectsAndClasses(container) {
  let subSearch = '';

  container.innerHTML = `
    <div class="stack-lg">
      <div class="page-header">
        <div>
          <h1 class="page-title">Subjects &amp; Classes</h1>
          <p class="page-subtitle">Manage curriculum subjects, assign faculty, and configure student class sections.</p>
        </div>
        <div class="page-actions">
          <button type="button" class="btn btn-secondary" id="add-class-btn">${icon('plus', 16)} Add Class</button>
          <button type="button" class="btn btn-primary" id="add-subject-btn">${icon('plus', 16)} Add Subject</button>
        </div>
      </div>

      <section class="panel stack-md">
        <div class="toolbar">
          <h2 class="panel-title">Subjects</h2>
          <input class="input" style="max-width:260px;" id="sub-search" placeholder="Search subjects..." />
        </div>
        <div id="sub-table-slot">${renderTableSkeleton(5, 4)}</div>
      </section>

      <section class="panel stack-md">
        <div class="panel-header">
          <h2 class="panel-title">Classes / Sections</h2>
        </div>
        <div id="cls-table-slot">${renderTableSkeleton(5, 3)}</div>
      </section>
    </div>
  `;

  let depts = [],
    courses = [],
    teachers = [],
    subjects = [],
    classes = [];

  async function loadAll() {
    [depts, courses, teachers, subjects, classes] = await Promise.all([
      fetchCollection('departments'),
      fetchCollection('courses'),
      fetchCollection('teachers'),
      fetchCollection('subjects'),
      fetchCollection('classes'),
    ]);
    renderSubjects();
    renderClasses();
  }

  function renderSubjects() {
    const teacherMap = new Map(teachers.map((t) => [t.uid || t.id, t.name]));
    const deptMap = new Map(depts.map((d) => [d.id, d.code]));
    const filtered = subjects.filter(
      (s) =>
        !subSearch ||
        s.name?.toLowerCase().includes(subSearch.toLowerCase()) ||
        s.code?.toLowerCase().includes(subSearch.toLowerCase())
    );
    const slot = container.querySelector('#sub-table-slot');
    if (filtered.length === 0) {
      slot.innerHTML = renderEmptyState({ title: 'No subjects found', description: 'Create subjects and assign faculty instructors.' });
      return;
    }
    slot.innerHTML = `
      <div class="table-wrap">
        <table class="data-table">
          <thead><tr><th>Code</th><th>Subject</th><th>Dept</th><th>Assigned Teacher</th><th class="num">Min %</th><th class="num">Actions</th></tr></thead>
          <tbody>
            ${filtered
              .map(
                (s) => `
              <tr>
                <td class="mono"><strong>${escapeHtml(s.code)}</strong></td>
                <td>${escapeHtml(s.name)}</td>
                <td class="mono">${escapeHtml(deptMap.get(s.departmentId) || '—')}</td>
                <td>${escapeHtml(teacherMap.get(s.teacherId) || 'Unassigned')}</td>
                <td class="num">${Number(s.minAttendancePct || 75)}%</td>
                <td class="num">
                  <button type="button" class="btn btn-ghost btn-sm" data-edit-sub="${escapeHtml(s.id)}">Edit</button>
                  <button type="button" class="btn btn-ghost btn-sm status-danger" data-del-sub="${escapeHtml(s.id)}">Delete</button>
                </td>
              </tr>
            `
              )
              .join('')}
          </tbody>
        </table>
      </div>
    `;
    slot.querySelectorAll('[data-edit-sub]').forEach((b) =>
      b.addEventListener('click', () => openSubjectModal(subjects.find((x) => x.id === b.getAttribute('data-edit-sub'))))
    );
    slot.querySelectorAll('[data-del-sub]').forEach((b) =>
      b.addEventListener('click', async () => {
        const id = b.getAttribute('data-del-sub');
        const ok = await showConfirm({ title: 'Delete Subject?', message: 'Delete this subject?', confirmLabel: 'Delete', danger: true });
        if (!ok) return;
        await deleteDocById('subjects', id);
        await logAudit('DELETE_SUBJECT', 'subjects', id);
        showToast('Subject deleted.', 'success');
        loadAll();
      })
    );
  }

  function renderClasses() {
    const deptMap = new Map(depts.map((d) => [d.id, d.code]));
    const slot = container.querySelector('#cls-table-slot');
    if (classes.length === 0) {
      slot.innerHTML = renderEmptyState({ title: 'No classes configured', description: 'Create class sections to enroll students and start sessions.' });
      return;
    }
    slot.innerHTML = `
      <div class="table-wrap">
        <table class="data-table">
          <thead><tr><th>Code</th><th>Class Name</th><th>Dept</th><th class="num">Semester</th><th>Session</th><th class="num">Actions</th></tr></thead>
          <tbody>
            ${classes
              .map(
                (c) => `
              <tr>
                <td class="mono"><strong>${escapeHtml(c.code)}</strong></td>
                <td>${escapeHtml(c.name)}</td>
                <td class="mono">${escapeHtml(deptMap.get(c.departmentId) || '—')}</td>
                <td class="num">${Number(c.semester || 1)}</td>
                <td>${escapeHtml(c.academicSession || '—')}</td>
                <td class="num">
                  <button type="button" class="btn btn-ghost btn-sm" data-edit-cls="${escapeHtml(c.id)}">Edit</button>
                  <button type="button" class="btn btn-ghost btn-sm status-danger" data-del-cls="${escapeHtml(c.id)}">Delete</button>
                </td>
              </tr>
            `
              )
              .join('')}
          </tbody>
        </table>
      </div>
    `;
    slot.querySelectorAll('[data-edit-cls]').forEach((b) =>
      b.addEventListener('click', () => openClassModal(classes.find((x) => x.id === b.getAttribute('data-edit-cls'))))
    );
    slot.querySelectorAll('[data-del-cls]').forEach((b) =>
      b.addEventListener('click', async () => {
        const id = b.getAttribute('data-del-cls');
        const ok = await showConfirm({ title: 'Delete Class?', message: 'Delete this class section?', confirmLabel: 'Delete', danger: true });
        if (!ok) return;
        await deleteDocById('classes', id);
        await logAudit('DELETE_CLASS', 'classes', id);
        showToast('Class deleted.', 'success');
        loadAll();
      })
    );
  }

  function openSubjectModal(existing = null) {
    const { settings } = getState();
    openModal({
      title: existing ? 'Edit Subject' : 'Create Subject',
      bodyHtml: `
        <form id="sub-modal-form" class="stack-md">
          <div class="form-grid form-grid-2">
            <div class="field"><label class="field-label">Subject Code</label><input class="input mono" name="code" required value="${escapeHtml(existing?.code || '')}" placeholder="CS301" /></div>
            <div class="field"><label class="field-label">Credits</label><input class="input mono" name="credits" type="number" min="1" max="10" value="${Number(existing?.credits || 4)}" /></div>
          </div>
          <div class="field"><label class="field-label">Subject Name</label><input class="input" name="name" required value="${escapeHtml(existing?.name || '')}" placeholder="Data Structures" /></div>
          <div class="form-grid form-grid-2">
            <div class="field">
              <label class="field-label">Department</label>
              <select class="select" name="departmentId">
                <option value="">Select department</option>
                ${depts.map((d) => `<option value="${escapeHtml(d.id)}" ${existing?.departmentId === d.id ? 'selected' : ''}>${escapeHtml(d.name)}</option>`).join('')}
              </select>
            </div>
            <div class="field">
              <label class="field-label">Course</label>
              <select class="select" name="courseId">
                <option value="">Select course</option>
                ${courses.map((c) => `<option value="${escapeHtml(c.id)}" ${existing?.courseId === c.id ? 'selected' : ''}>${escapeHtml(c.name)}</option>`).join('')}
              </select>
            </div>
          </div>
          <div class="form-grid form-grid-2">
            <div class="field">
              <label class="field-label">Assigned Teacher</label>
              <select class="select" name="teacherId">
                <option value="">Unassigned</option>
                ${teachers.map((t) => `<option value="${escapeHtml(t.uid || t.id)}" ${existing?.teacherId === (t.uid || t.id) ? 'selected' : ''}>${escapeHtml(t.name)}</option>`).join('')}
              </select>
            </div>
            <div class="field">
              <label class="field-label">Min Threshold (%)</label>
              <input class="input mono" name="minAttendancePct" type="number" min="1" max="100" value="${Number(existing?.minAttendancePct || settings.defaultAttendanceThreshold || 75)}" />
            </div>
          </div>
          <button type="submit" class="btn btn-primary">${existing ? 'Update Subject' : 'Create Subject'}</button>
        </form>
      `,
      onMount(dialog) {
        dialog.querySelector('#sub-modal-form').addEventListener('submit', async (e) => {
          e.preventDefault();
          const fd = new FormData(e.target);
          const payload = {
            code: String(fd.get('code')).trim().toUpperCase(),
            name: String(fd.get('name')).trim(),
            credits: Number(fd.get('credits')) || 4,
            departmentId: String(fd.get('departmentId') || ''),
            courseId: String(fd.get('courseId') || ''),
            teacherId: String(fd.get('teacherId') || ''),
            minAttendancePct: Number(fd.get('minAttendancePct')) || 75,
            semester: 1,
          };
          if (existing) {
            await updateDocById('subjects', existing.id, payload);
            await logAudit('UPDATE_SUBJECT', 'subjects', existing.id, payload.code);
          } else {
            const id = await createDoc('subjects', payload);
            await logAudit('CREATE_SUBJECT', 'subjects', id, payload.code);
          }
          closeModal();
          showToast('Subject saved.', 'success');
          loadAll();
        });
      },
    });
  }

  function openClassModal(existing = null) {
    const { settings } = getState();
    openModal({
      title: existing ? 'Edit Class' : 'Create Class',
      bodyHtml: `
        <form id="cls-modal-form" class="stack-md">
          <div class="form-grid form-grid-2">
            <div class="field"><label class="field-label">Class Code</label><input class="input mono" name="code" required value="${escapeHtml(existing?.code || '')}" placeholder="CSE-3A" /></div>
            <div class="field"><label class="field-label">Section</label><input class="input" name="section" value="${escapeHtml(existing?.section || 'A')}" placeholder="A" /></div>
          </div>
          <div class="field"><label class="field-label">Class Name</label><input class="input" name="name" required value="${escapeHtml(existing?.name || '')}" placeholder="CSE Semester 3 - Section A" /></div>
          <div class="form-grid form-grid-2">
            <div class="field">
              <label class="field-label">Department</label>
              <select class="select" name="departmentId">
                <option value="">Select department</option>
                ${depts.map((d) => `<option value="${escapeHtml(d.id)}" ${existing?.departmentId === d.id ? 'selected' : ''}>${escapeHtml(d.name)}</option>`).join('')}
              </select>
            </div>
            <div class="field">
              <label class="field-label">Course</label>
              <select class="select" name="courseId">
                <option value="">Select course</option>
                ${courses.map((c) => `<option value="${escapeHtml(c.id)}" ${existing?.courseId === c.id ? 'selected' : ''}>${escapeHtml(c.name)}</option>`).join('')}
              </select>
            </div>
          </div>
          <div class="form-grid form-grid-2">
            <div class="field"><label class="field-label">Semester</label><input class="input mono" name="semester" type="number" min="1" max="12" value="${Number(existing?.semester || 1)}" /></div>
            <div class="field"><label class="field-label">Academic Session</label><input class="input" name="academicSession" value="${escapeHtml(existing?.academicSession || settings.currentAcademicSession)}" /></div>
          </div>
          <button type="submit" class="btn btn-primary">${existing ? 'Update Class' : 'Create Class'}</button>
        </form>
      `,
      onMount(dialog) {
        dialog.querySelector('#cls-modal-form').addEventListener('submit', async (e) => {
          e.preventDefault();
          const fd = new FormData(e.target);
          const payload = {
            code: String(fd.get('code')).trim().toUpperCase(),
            section: String(fd.get('section')).trim(),
            name: String(fd.get('name')).trim(),
            departmentId: String(fd.get('departmentId') || ''),
            courseId: String(fd.get('courseId') || ''),
            semester: Number(fd.get('semester')) || 1,
            academicSession: String(fd.get('academicSession')).trim(),
          };
          if (existing) {
            await updateDocById('classes', existing.id, payload);
            await logAudit('UPDATE_CLASS', 'classes', existing.id, payload.code);
          } else {
            const id = await createDoc('classes', payload);
            await logAudit('CREATE_CLASS', 'classes', id, payload.code);
          }
          closeModal();
          showToast('Class saved.', 'success');
          loadAll();
        });
      },
    });
  }

  container.querySelector('#add-subject-btn').addEventListener('click', () => openSubjectModal());
  container.querySelector('#add-class-btn').addEventListener('click', () => openClassModal());
  container.querySelector('#sub-search').addEventListener('input', (e) => {
    subSearch = e.target.value;
    renderSubjects();
  });

  loadAll();
}

async function renderAdminTeachers(container) {
  let search = '';
  let deptFilter = 'all';
  let page = 1;

  container.innerHTML = `
    <div class="stack-lg">
      <div class="page-header">
        <div>
          <h1 class="page-title">Faculty / Teachers</h1>
          <p class="page-subtitle">Provision verified teacher accounts and manage department assignments.</p>
        </div>
        <div class="page-actions">
          <button type="button" class="btn btn-primary" id="add-teacher-btn">${icon('plus', 16)} Add Teacher</button>
        </div>
      </div>

      <section class="panel stack-md">
        <div class="toolbar">
          <input class="input" style="max-width:260px;" id="teacher-search" placeholder="Search name, email, employee ID..." />
          <select class="select" style="max-width:220px;" id="teacher-dept-filter">
            <option value="all">All Departments</option>
          </select>
        </div>
        <div id="teacher-table-slot">${renderTableSkeleton(5, 4)}</div>
      </section>
    </div>
  `;

  let teachers = [],
    depts = [];

  async function load() {
    [teachers, depts] = await Promise.all([fetchCollection('teachers'), fetchCollection('departments')]);
    const deptSelect = container.querySelector('#teacher-dept-filter');
    deptSelect.innerHTML =
      '<option value="all">All Departments</option>' +
      depts.map((d) => `<option value="${escapeHtml(d.id)}" ${deptFilter === d.id ? 'selected' : ''}>${escapeHtml(d.name)}</option>`).join('');
    renderTable();
  }

  function renderTable() {
    const deptMap = new Map(depts.map((d) => [d.id, d.name]));
    const filtered = teachers.filter((t) => {
      const matchDept = deptFilter === 'all' || t.departmentId === deptFilter;
      const q = search.toLowerCase();
      const matchSearch =
        !q ||
        t.name?.toLowerCase().includes(q) ||
        t.email?.toLowerCase().includes(q) ||
        t.employeeId?.toLowerCase().includes(q);
      return matchDept && matchSearch;
    });

    const paged = paginateItems(filtered, page, 10);
    const slot = container.querySelector('#teacher-table-slot');
    if (paged.totalItems === 0) {
      slot.innerHTML = renderEmptyState({ title: 'No teachers found', description: 'Use "Add Teacher" to create a new faculty account.' });
      return;
    }

    slot.innerHTML = `
      <div class="table-wrap">
        <table class="data-table">
          <thead><tr><th>Employee ID</th><th>Name</th><th>Email</th><th>Department</th><th>Designation</th><th>Status</th><th class="num">Actions</th></tr></thead>
          <tbody>
            ${paged.items
              .map(
                (t) => `
              <tr>
                <td class="mono">${escapeHtml(t.employeeId)}</td>
                <td><strong>${escapeHtml(t.name)}</strong></td>
                <td>${escapeHtml(t.email)}</td>
                <td>${escapeHtml(deptMap.get(t.departmentId) || '—')}</td>
                <td>${escapeHtml(t.designation || 'Faculty')}</td>
                <td><span class="status-text ${t.status === 'inactive' ? 'status-danger' : 'status-success'}">${escapeHtml(t.status || 'active')}</span></td>
                <td class="num">
                  <button type="button" class="btn btn-ghost btn-sm" data-edit-teacher="${escapeHtml(t.id)}">Edit</button>
                  <button type="button" class="btn btn-ghost btn-sm" data-toggle-teacher="${escapeHtml(t.id)}">${t.status === 'inactive' ? 'Activate' : 'Deactivate'}</button>
                </td>
              </tr>
            `
              )
              .join('')}
          </tbody>
        </table>
      </div>
      <div class="pagination">
        <span>Showing ${paged.items.length} of ${paged.totalItems}</span>
        <div class="pagination-controls">
          <button type="button" class="btn btn-secondary btn-sm" id="t-prev" ${paged.page <= 1 ? 'disabled' : ''}>Prev</button>
          <span>Page ${paged.page}/${paged.totalPages}</span>
          <button type="button" class="btn btn-secondary btn-sm" id="t-next" ${paged.page >= paged.totalPages ? 'disabled' : ''}>Next</button>
        </div>
      </div>
    `;

    slot.querySelector('#t-prev')?.addEventListener('click', () => {
      page -= 1;
      renderTable();
    });
    slot.querySelector('#t-next')?.addEventListener('click', () => {
      page += 1;
      renderTable();
    });
    slot.querySelectorAll('[data-edit-teacher]').forEach((b) =>
      b.addEventListener('click', () => openTeacherModal(teachers.find((x) => x.id === b.getAttribute('data-edit-teacher'))))
    );
    slot.querySelectorAll('[data-toggle-teacher]').forEach((b) =>
      b.addEventListener('click', async () => {
        const t = teachers.find((x) => x.id === b.getAttribute('data-toggle-teacher'));
        const nextStatus = t.status === 'inactive' ? 'active' : 'inactive';
        await updateDocById('teachers', t.id, { status: nextStatus });
        await updateDocById('users', t.uid || t.id, { status: nextStatus }).catch(() => {});
        await logAudit('TOGGLE_TEACHER_STATUS', 'teachers', t.id, nextStatus);
        showToast(`Teacher ${nextStatus}.`, 'success');
        load();
      })
    );
  }

  function openTeacherModal(existing = null) {
    openModal({
      title: existing ? 'Edit Teacher' : 'Create Teacher Account',
      bodyHtml: `
        <form id="teacher-modal-form" class="stack-md">
          <div class="form-grid form-grid-2">
            <div class="field"><label class="field-label">Full Name</label><input class="input" name="name" required value="${escapeHtml(existing?.name || '')}" /></div>
            <div class="field"><label class="field-label">Employee ID</label><input class="input mono" name="employeeId" required value="${escapeHtml(existing?.employeeId || '')}" placeholder="EMP-101" /></div>
          </div>
          ${
            existing
              ? ''
              : `
          <div class="form-grid form-grid-2">
            <div class="field"><label class="field-label">Email</label><input class="input" name="email" type="email" required /></div>
            <div class="field"><label class="field-label">Temporary Password</label><input class="input" name="password" type="password" minlength="6" required /></div>
          </div>
          `
          }
          <div class="form-grid form-grid-2">
            <div class="field">
              <label class="field-label">Department</label>
              <select class="select" name="departmentId">
                <option value="">Select department</option>
                ${depts.map((d) => `<option value="${escapeHtml(d.id)}" ${existing?.departmentId === d.id ? 'selected' : ''}>${escapeHtml(d.name)}</option>`).join('')}
              </select>
            </div>
            <div class="field"><label class="field-label">Designation</label><input class="input" name="designation" value="${escapeHtml(existing?.designation || 'Assistant Professor')}" /></div>
          </div>
          <p class="field-hint">Creating a teacher provisions a Firebase Auth account and sends a verification email without signing you out. Passwords are never stored in Firestore.</p>
          <button type="submit" class="btn btn-primary" id="save-teacher-btn">${existing ? 'Update Teacher' : 'Create Teacher'}</button>
        </form>
      `,
      onMount(dialog) {
        dialog.querySelector('#teacher-modal-form').addEventListener('submit', async (e) => {
          e.preventDefault();
          const btn = dialog.querySelector('#save-teacher-btn');
          btn.disabled = true;
          try {
            const fd = new FormData(e.target);
            if (existing) {
              const patch = {
                name: String(fd.get('name')).trim(),
                employeeId: String(fd.get('employeeId')).trim(),
                departmentId: String(fd.get('departmentId') || ''),
                designation: String(fd.get('designation')).trim(),
              };
              await updateDocById('teachers', existing.id, patch);
              await updateDocById('users', existing.uid || existing.id, { name: patch.name, departmentId: patch.departmentId }).catch(() => {});
              await logAudit('UPDATE_TEACHER', 'teachers', existing.id, patch.name);
              showToast('Teacher updated.', 'success');
            } else {
              await adminCreateUserAccount({
                name: String(fd.get('name')),
                email: String(fd.get('email')),
                password: String(fd.get('password')),
                role: 'teacher',
                employeeId: String(fd.get('employeeId')),
                departmentId: String(fd.get('departmentId') || ''),
                designation: String(fd.get('designation')),
              });
              showToast('Teacher account created & verification email sent.', 'success');
            }
            closeModal();
            load();
          } catch (err) {
            showToast(err.message || 'Failed to save teacher.', 'danger');
          } finally {
            btn.disabled = false;
          }
        });
      },
    });
  }

  container.querySelector('#add-teacher-btn').addEventListener('click', () => openTeacherModal());
  container.querySelector('#teacher-search').addEventListener('input', (e) => {
    search = e.target.value;
    page = 1;
    renderTable();
  });
  container.querySelector('#teacher-dept-filter').addEventListener('change', (e) => {
    deptFilter = e.target.value;
    page = 1;
    renderTable();
  });

  load();
}

async function renderAdminStudents(container) {
  let search = '';
  let classFilter = 'all';
  let page = 1;

  container.innerHTML = `
    <div class="stack-lg">
      <div class="page-header">
        <div>
          <h1 class="page-title">Students Directory</h1>
          <p class="page-subtitle">Provision student accounts, assign classes, and monitor attendance standing.</p>
        </div>
        <div class="page-actions">
          <button type="button" class="btn btn-primary" id="add-student-btn">${icon('plus', 16)} Add Student</button>
        </div>
      </div>

      <section class="panel stack-md">
        <div class="toolbar">
          <input class="input" style="max-width:260px;" id="student-search" placeholder="Search name, roll no, email..." />
          <select class="select" style="max-width:240px;" id="student-class-filter">
            <option value="all">All Classes</option>
          </select>
        </div>
        <div id="student-table-slot">${renderTableSkeleton(6, 5)}</div>
      </section>
    </div>
  `;

  let students = [],
    classes = [],
    depts = [],
    courses = [],
    records = [];

  async function load() {
    [students, classes, depts, courses, records] = await Promise.all([
      fetchCollection('students'),
      fetchCollection('classes'),
      fetchCollection('departments'),
      fetchCollection('courses'),
      fetchCollection('attendanceRecords'),
    ]);
    const clsSelect = container.querySelector('#student-class-filter');
    clsSelect.innerHTML =
      '<option value="all">All Classes</option>' +
      classes.map((c) => `<option value="${escapeHtml(c.id)}" ${classFilter === c.id ? 'selected' : ''}>${escapeHtml(c.name)}</option>`).join('');
    renderTable();
  }

  function renderTable() {
    const classMap = new Map(classes.map((c) => [c.id, c.name]));
    const threshold = Number(getState().settings.defaultAttendanceThreshold || 75);
    const filtered = students.filter((s) => {
      const matchCls = classFilter === 'all' || s.classId === classFilter;
      const q = search.toLowerCase();
      const matchSearch =
        !q || s.name?.toLowerCase().includes(q) || s.rollNumber?.toLowerCase().includes(q) || s.email?.toLowerCase().includes(q);
      return matchCls && matchSearch;
    });

    const paged = paginateItems(filtered, page, 10);
    const slot = container.querySelector('#student-table-slot');
    if (paged.totalItems === 0) {
      slot.innerHTML = renderEmptyState({ title: 'No students found', description: 'Add students or adjust your class filter.' });
      return;
    }

    slot.innerHTML = `
      <div class="table-wrap">
        <table class="data-table">
          <thead><tr><th>Roll No.</th><th>Name</th><th>Email</th><th>Class</th><th class="num">Attendance</th><th>Status</th><th class="num">Actions</th></tr></thead>
          <tbody>
            ${paged.items
              .map((s) => {
                const stRecs = records.filter((r) => r.studentUid === (s.uid || s.id));
                const sum = calculateAttendanceSummary(stRecs);
                const pctHtml =
                  stRecs.length === 0
                    ? '<span class="status-muted">—</span>'
                    : `<span class="${sum.percentage < threshold ? 'status-danger' : 'status-success'}"><strong>${sum.percentage}%</strong></span>`;
                return `
                  <tr>
                    <td class="mono">${escapeHtml(s.rollNumber)}</td>
                    <td><strong>${escapeHtml(s.name)}</strong></td>
                    <td>${escapeHtml(s.email)}</td>
                    <td>${escapeHtml(classMap.get(s.classId) || 'Unassigned')}</td>
                    <td class="num">${pctHtml}</td>
                    <td><span class="status-text ${s.status === 'inactive' ? 'status-danger' : 'status-success'}">${escapeHtml(s.status || 'active')}</span></td>
                    <td class="num">
                      <button type="button" class="btn btn-ghost btn-sm" data-edit-student="${escapeHtml(s.id)}">Edit</button>
                      <button type="button" class="btn btn-ghost btn-sm" data-toggle-student="${escapeHtml(s.id)}">${s.status === 'inactive' ? 'Activate' : 'Deactivate'}</button>
                    </td>
                  </tr>
                `;
              })
              .join('')}
          </tbody>
        </table>
      </div>
      <div class="pagination">
        <span>Showing ${paged.items.length} of ${paged.totalItems}</span>
        <div class="pagination-controls">
          <button type="button" class="btn btn-secondary btn-sm" id="st-prev" ${paged.page <= 1 ? 'disabled' : ''}>Prev</button>
          <span>Page ${paged.page}/${paged.totalPages}</span>
          <button type="button" class="btn btn-secondary btn-sm" id="st-next" ${paged.page >= paged.totalPages ? 'disabled' : ''}>Next</button>
        </div>
      </div>
    `;

    slot.querySelector('#st-prev')?.addEventListener('click', () => {
      page -= 1;
      renderTable();
    });
    slot.querySelector('#st-next')?.addEventListener('click', () => {
      page += 1;
      renderTable();
    });
    slot.querySelectorAll('[data-edit-student]').forEach((b) =>
      b.addEventListener('click', () => openStudentModal(students.find((x) => x.id === b.getAttribute('data-edit-student'))))
    );
    slot.querySelectorAll('[data-toggle-student]').forEach((b) =>
      b.addEventListener('click', async () => {
        const s = students.find((x) => x.id === b.getAttribute('data-toggle-student'));
        const nextStatus = s.status === 'inactive' ? 'active' : 'inactive';
        await updateDocById('students', s.id, { status: nextStatus });
        await updateDocById('users', s.uid || s.id, { status: nextStatus }).catch(() => {});
        await logAudit('TOGGLE_STUDENT_STATUS', 'students', s.id, nextStatus);
        showToast(`Student ${nextStatus}.`, 'success');
        load();
      })
    );
  }

  function openStudentModal(existing = null) {
    openModal({
      title: existing ? 'Edit Student' : 'Create Student Account',
      bodyHtml: `
        <form id="student-modal-form" class="stack-md">
          <div class="form-grid form-grid-2">
            <div class="field"><label class="field-label">Full Name</label><input class="input" name="name" required value="${escapeHtml(existing?.name || '')}" /></div>
            <div class="field"><label class="field-label">Roll Number</label><input class="input mono" name="rollNumber" required value="${escapeHtml(existing?.rollNumber || '')}" placeholder="CSE26-001" /></div>
          </div>
          ${
            existing
              ? ''
              : `
          <div class="form-grid form-grid-2">
            <div class="field"><label class="field-label">Email</label><input class="input" name="email" type="email" required /></div>
            <div class="field"><label class="field-label">Temporary Password</label><input class="input" name="password" type="password" minlength="6" required /></div>
          </div>
          `
          }
          <div class="form-grid form-grid-2">
            <div class="field">
              <label class="field-label">Department</label>
              <select class="select" name="departmentId">
                <option value="">Select department</option>
                ${depts.map((d) => `<option value="${escapeHtml(d.id)}" ${existing?.departmentId === d.id ? 'selected' : ''}>${escapeHtml(d.name)}</option>`).join('')}
              </select>
            </div>
            <div class="field">
              <label class="field-label">Class / Section</label>
              <select class="select" name="classId">
                <option value="">Select class</option>
                ${classes.map((c) => `<option value="${escapeHtml(c.id)}" ${existing?.classId === c.id ? 'selected' : ''}>${escapeHtml(c.name)}</option>`).join('')}
              </select>
            </div>
          </div>
          <div class="form-grid form-grid-2">
            <div class="field">
              <label class="field-label">Course</label>
              <select class="select" name="courseId">
                <option value="">Select course</option>
                ${courses.map((c) => `<option value="${escapeHtml(c.id)}" ${existing?.courseId === c.id ? 'selected' : ''}>${escapeHtml(c.name)}</option>`).join('')}
              </select>
            </div>
            <div class="field"><label class="field-label">Semester</label><input class="input mono" name="semester" type="number" min="1" max="12" value="${Number(existing?.semester || 1)}" /></div>
          </div>
          <div class="field"><label class="field-label">Guardian Contact</label><input class="input" name="guardianPhone" value="${escapeHtml(existing?.guardianPhone || '')}" placeholder="+1 555 0100" /></div>
          <button type="submit" class="btn btn-primary" id="save-student-btn">${existing ? 'Update Student' : 'Create Student'}</button>
        </form>
      `,
      onMount(dialog) {
        dialog.querySelector('#student-modal-form').addEventListener('submit', async (e) => {
          e.preventDefault();
          const btn = dialog.querySelector('#save-student-btn');
          btn.disabled = true;
          try {
            const fd = new FormData(e.target);
            if (existing) {
              const patch = {
                name: String(fd.get('name')).trim(),
                rollNumber: String(fd.get('rollNumber')).trim(),
                departmentId: String(fd.get('departmentId') || ''),
                classId: String(fd.get('classId') || ''),
                courseId: String(fd.get('courseId') || ''),
                semester: Number(fd.get('semester')) || 1,
                guardianPhone: String(fd.get('guardianPhone') || '').trim(),
              };
              await updateDocById('students', existing.id, patch);
              await updateDocById('users', existing.uid || existing.id, { name: patch.name, departmentId: patch.departmentId }).catch(() => {});
              await logAudit('UPDATE_STUDENT', 'students', existing.id, patch.rollNumber);
              showToast('Student updated.', 'success');
            } else {
              await adminCreateUserAccount({
                name: String(fd.get('name')),
                email: String(fd.get('email')),
                password: String(fd.get('password')),
                role: 'student',
                rollNumber: String(fd.get('rollNumber')),
                departmentId: String(fd.get('departmentId') || ''),
                classId: String(fd.get('classId') || ''),
                courseId: String(fd.get('courseId') || ''),
                semester: Number(fd.get('semester')) || 1,
                guardianPhone: String(fd.get('guardianPhone') || ''),
              });
              showToast('Student account created & verification email sent.', 'success');
            }
            closeModal();
            load();
          } catch (err) {
            showToast(err.message || 'Failed to save student.', 'danger');
          } finally {
            btn.disabled = false;
          }
        });
      },
    });
  }

  container.querySelector('#add-student-btn').addEventListener('click', () => openStudentModal());
  container.querySelector('#student-search').addEventListener('input', (e) => {
    search = e.target.value;
    page = 1;
    renderTable();
  });
  container.querySelector('#student-class-filter').addEventListener('change', (e) => {
    classFilter = e.target.value;
    page = 1;
    renderTable();
  });

  load();
}

async function renderAdminTimetableAndHolidays(container) {
  container.innerHTML = `
    <div class="stack-lg">
      <div class="page-header">
        <div>
          <h1 class="page-title">Timetable &amp; Holidays</h1>
          <p class="page-subtitle">Schedule weekly class periods and publish academic holidays.</p>
        </div>
        <div class="page-actions">
          <button type="button" class="btn btn-secondary" id="add-holiday-btn">${icon('plus', 16)} Add Holiday</button>
          <button type="button" class="btn btn-primary" id="add-slot-btn">${icon('plus', 16)} Add Timetable Slot</button>
        </div>
      </div>

      <section class="panel stack-md">
        <h2 class="panel-title">Weekly Timetable</h2>
        <div id="admin-tt-slot">${renderTableSkeleton(6, 4)}</div>
      </section>

      <section class="panel stack-md">
        <h2 class="panel-title">Academic Holidays</h2>
        <div id="admin-hol-slot">${renderTableSkeleton(4, 3)}</div>
      </section>
    </div>
  `;

  let slots = [],
    holidays = [],
    classes = [],
    subjects = [],
    teachers = [];

  async function load() {
    [slots, holidays, classes, subjects, teachers] = await Promise.all([
      fetchCollection('timetable'),
      fetchCollection('holidays'),
      fetchCollection('classes'),
      fetchCollection('subjects'),
      fetchCollection('teachers'),
    ]);
    renderTables();
  }

  function renderTables() {
    const clsMap = new Map(classes.map((c) => [c.id, c.name]));
    const subMap = new Map(subjects.map((s) => [s.id, `${s.code} · ${s.name}`]));
    const tchMap = new Map(teachers.map((t) => [t.uid || t.id, t.name]));

    const ttSlot = container.querySelector('#admin-tt-slot');
    ttSlot.innerHTML =
      slots.length === 0
        ? renderEmptyState({ title: 'No timetable slots configured', description: 'Add weekly class slots to populate student and teacher schedules.' })
        : `<div class="table-wrap"><table class="data-table"><thead><tr><th>Day</th><th>Time</th><th>Class</th><th>Subject</th><th>Teacher</th><th>Room</th><th class="num">Action</th></tr></thead><tbody>
            ${slots
              .map(
                (s) => `
              <tr>
                <td><strong>${escapeHtml(s.dayOfWeek)}</strong></td>
                <td class="mono">${escapeHtml(s.startTime)}–${escapeHtml(s.endTime)}</td>
                <td>${escapeHtml(clsMap.get(s.classId) || s.classId)}</td>
                <td>${escapeHtml(subMap.get(s.subjectId) || s.subjectId)}</td>
                <td>${escapeHtml(tchMap.get(s.teacherId) || '—')}</td>
                <td class="mono">${escapeHtml(s.room || '—')}</td>
                <td class="num"><button type="button" class="btn btn-ghost btn-sm status-danger" data-del-tt="${escapeHtml(s.id)}">Delete</button></td>
              </tr>
            `
              )
              .join('')}
          </tbody></table></div>`;

    ttSlot.querySelectorAll('[data-del-tt]').forEach((b) =>
      b.addEventListener('click', async () => {
        await deleteDocById('timetable', b.getAttribute('data-del-tt'));
        showToast('Timetable slot deleted.', 'success');
        load();
      })
    );

    const holSlot = container.querySelector('#admin-hol-slot');
    holSlot.innerHTML =
      holidays.length === 0
        ? renderEmptyState({ title: 'No holidays added', description: 'Add public or academic holidays for the term.' })
        : `<div class="table-wrap"><table class="data-table"><thead><tr><th>Date</th><th>Title</th><th>Type</th><th>Description</th><th class="num">Action</th></tr></thead><tbody>
            ${holidays
              .map(
                (h) => `
              <tr>
                <td class="mono">${escapeHtml(h.date)}</td>
                <td><strong>${escapeHtml(h.title)}</strong></td>
                <td style="text-transform:capitalize;">${escapeHtml(h.type)}</td>
                <td>${escapeHtml(h.description || '—')}</td>
                <td class="num"><button type="button" class="btn btn-ghost btn-sm status-danger" data-del-hol="${escapeHtml(h.id)}">Delete</button></td>
              </tr>
            `
              )
              .join('')}
          </tbody></table></div>`;

    holSlot.querySelectorAll('[data-del-hol]').forEach((b) =>
      b.addEventListener('click', async () => {
        await deleteDocById('holidays', b.getAttribute('data-del-hol'));
        showToast('Holiday deleted.', 'success');
        load();
      })
    );
  }

  container.querySelector('#add-slot-btn').addEventListener('click', () => {
    openModal({
      title: 'Add Timetable Slot',
      bodyHtml: `
        <form id="tt-form" class="stack-md">
          <div class="form-grid form-grid-2">
            <div class="field">
              <label class="field-label">Day of Week</label>
              <select class="select" name="dayOfWeek">
                ${['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'].map((d) => `<option>${d}</option>`).join('')}
              </select>
            </div>
            <div class="field"><label class="field-label">Room</label><input class="input" name="room" placeholder="LH-204" /></div>
          </div>
          <div class="form-grid form-grid-2">
            <div class="field"><label class="field-label">Start Time</label><input class="input mono" name="startTime" type="time" value="09:00" required /></div>
            <div class="field"><label class="field-label">End Time</label><input class="input mono" name="endTime" type="time" value="10:00" required /></div>
          </div>
          <div class="field">
            <label class="field-label">Class</label>
            <select class="select" name="classId" required>
              ${classes.map((c) => `<option value="${escapeHtml(c.id)}">${escapeHtml(c.name)}</option>`).join('')}
            </select>
          </div>
          <div class="field">
            <label class="field-label">Subject</label>
            <select class="select" name="subjectId" required>
              ${subjects.map((s) => `<option value="${escapeHtml(s.id)}">${escapeHtml(s.code + ' · ' + s.name)}</option>`).join('')}
            </select>
          </div>
          <div class="field">
            <label class="field-label">Teacher</label>
            <select class="select" name="teacherId">
              <option value="">Assigned to subject teacher</option>
              ${teachers.map((t) => `<option value="${escapeHtml(t.uid || t.id)}">${escapeHtml(t.name)}</option>`).join('')}
            </select>
          </div>
          <button type="submit" class="btn btn-primary">Save Timetable Slot</button>
        </form>
      `,
      onMount(dialog) {
        dialog.querySelector('#tt-form').addEventListener('submit', async (e) => {
          e.preventDefault();
          const fd = new FormData(e.target);
          await createDoc('timetable', {
            dayOfWeek: String(fd.get('dayOfWeek')),
            startTime: String(fd.get('startTime')),
            endTime: String(fd.get('endTime')),
            room: String(fd.get('room') || '').trim(),
            classId: String(fd.get('classId')),
            subjectId: String(fd.get('subjectId')),
            teacherId: String(fd.get('teacherId') || ''),
            academicSession: getState().settings.currentAcademicSession,
          });
          closeModal();
          showToast('Timetable slot added.', 'success');
          load();
        });
      },
    });
  });

  container.querySelector('#add-holiday-btn').addEventListener('click', () => {
    openModal({
      title: 'Add Holiday',
      bodyHtml: `
        <form id="hol-form" class="stack-md">
          <div class="field"><label class="field-label">Holiday Title</label><input class="input" name="title" required placeholder="Republic Day" /></div>
          <div class="form-grid form-grid-2">
            <div class="field"><label class="field-label">Date</label><input class="input mono" name="date" type="date" required value="${todayIsoDate()}" /></div>
            <div class="field">
              <label class="field-label">Type</label>
              <select class="select" name="type"><option value="public">Public</option><option value="academic">Academic</option><option value="exam">Exam Break</option></select>
            </div>
          </div>
          <div class="field"><label class="field-label">Description</label><textarea class="textarea" name="description"></textarea></div>
          <button type="submit" class="btn btn-primary">Add Holiday</button>
        </form>
      `,
      onMount(dialog) {
        dialog.querySelector('#hol-form').addEventListener('submit', async (e) => {
          e.preventDefault();
          const fd = new FormData(e.target);
          await createDoc('holidays', {
            title: String(fd.get('title')).trim(),
            date: String(fd.get('date')),
            type: String(fd.get('type')),
            description: String(fd.get('description') || '').trim(),
          });
          closeModal();
          showToast('Holiday added.', 'success');
          load();
        });
      },
    });
  });

  load();
}

async function renderAdminRequests(container) {
  let tab = 'corrections';
  container.innerHTML = `
    <div class="stack-lg">
      <div class="page-header">
        <div>
          <h1 class="page-title">Leave &amp; Correction Requests</h1>
          <p class="page-subtitle">Oversee and resolve institutional attendance corrections and leave applications.</p>
        </div>
        <div class="segmented-bar">
          <button type="button" class="segmented-btn active" data-req-tab="corrections">Corrections</button>
          <button type="button" class="segmented-btn" data-req-tab="leaves">Leaves</button>
        </div>
      </div>
      <div id="admin-req-slot">${renderTableSkeleton(5, 4)}</div>
    </div>
  `;

  async function load() {
    const slot = container.querySelector('#admin-req-slot');
    const [corrections, leaves, students, subjects] = await Promise.all([
      fetchCollection('correctionRequests'),
      fetchCollection('leaveRequests'),
      fetchCollection('students'),
      fetchCollection('subjects'),
    ]);
    const stMap = new Map(students.map((s) => [s.uid || s.id, s]));
    const subMap = new Map(subjects.map((s) => [s.id, s.name]));

    if (tab === 'corrections') {
      if (corrections.length === 0) {
        slot.innerHTML = renderEmptyState({ title: 'No correction requests', description: 'Student attendance correction requests will appear here.' });
        return;
      }
      slot.innerHTML = `
        <div class="table-wrap"><table class="data-table"><thead><tr><th>Student</th><th>Subject</th><th>Requested</th><th>Reason</th><th>Status</th><th class="num">Action</th></tr></thead><tbody>
          ${corrections
            .map((c) => {
              const st = stMap.get(c.studentUid);
              return `<tr>
                <td><strong>${escapeHtml(st?.name || c.studentUid)}</strong><br><span class="mono" style="font-size:0.75rem;color:var(--text-muted);">${escapeHtml(st?.rollNumber || '')}</span></td>
                <td>${escapeHtml(subMap.get(c.subjectId) || c.subjectId)}</td>
                <td style="text-transform:capitalize;">${escapeHtml(c.currentStatus)} &rarr; <strong>${escapeHtml(c.requestedStatus)}</strong></td>
                <td>${escapeHtml(c.reason)}${c.evidenceUrl ? ` · <a href="${escapeHtml(c.evidenceUrl)}" target="_blank" rel="noopener">Attachment</a>` : ''}</td>
                <td><span class="status-text ${c.status === 'approved' ? 'status-success' : c.status === 'rejected' ? 'status-danger' : 'status-warning'}">${escapeHtml(c.status)}</span></td>
                <td class="num">
                  ${
                    c.status === 'pending'
                      ? `<button type="button" class="btn btn-primary btn-sm" data-corr-approve="${escapeHtml(c.id)}">Approve</button>
                         <button type="button" class="btn btn-secondary btn-sm" data-corr-reject="${escapeHtml(c.id)}">Reject</button>`
                      : '—'
                  }
                </td>
              </tr>`;
            })
            .join('')}
        </tbody></table></div>
      `;
      slot.querySelectorAll('[data-corr-approve]').forEach((b) =>
        b.addEventListener('click', async () => {
          await reviewCorrectionRequest({ requestId: b.getAttribute('data-corr-approve'), decision: 'approved', reviewerUid: getState().profile.uid });
          showToast('Correction approved and attendance record updated.', 'success');
          load();
        })
      );
      slot.querySelectorAll('[data-corr-reject]').forEach((b) =>
        b.addEventListener('click', async () => {
          await reviewCorrectionRequest({ requestId: b.getAttribute('data-corr-reject'), decision: 'rejected', reviewerUid: getState().profile.uid });
          showToast('Correction rejected.', 'info');
          load();
        })
      );
    } else {
      if (leaves.length === 0) {
        slot.innerHTML = renderEmptyState({ title: 'No leave requests', description: 'Student leave applications will appear here.' });
        return;
      }
      slot.innerHTML = `
        <div class="table-wrap"><table class="data-table"><thead><tr><th>Student</th><th>Dates</th><th>Reason</th><th>Status</th><th class="num">Action</th></tr></thead><tbody>
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
                      ? `<button type="button" class="btn btn-primary btn-sm" data-lv-approve="${escapeHtml(l.id)}" data-uid="${escapeHtml(l.studentUid)}">Approve</button>
                         <button type="button" class="btn btn-secondary btn-sm" data-lv-reject="${escapeHtml(l.id)}" data-uid="${escapeHtml(l.studentUid)}">Reject</button>`
                      : '—'
                  }
                </td>
              </tr>`;
            })
            .join('')}
        </tbody></table></div>
      `;
      slot.querySelectorAll('[data-lv-approve]').forEach((b) =>
        b.addEventListener('click', async () => {
          const id = b.getAttribute('data-lv-approve');
          await updateDocById('leaveRequests', id, { status: 'approved', reviewedBy: getState().profile.uid });
          await createNotification({ userId: b.getAttribute('data-uid'), title: 'Leave Request Approved', message: 'Your leave application has been approved.', type: 'leave', linkView: 'leaves' });
          showToast('Leave approved.', 'success');
          load();
        })
      );
      slot.querySelectorAll('[data-lv-reject]').forEach((b) =>
        b.addEventListener('click', async () => {
          const id = b.getAttribute('data-lv-reject');
          await updateDocById('leaveRequests', id, { status: 'rejected', reviewedBy: getState().profile.uid });
          await createNotification({ userId: b.getAttribute('data-uid'), title: 'Leave Request Rejected', message: 'Your leave application was declined.', type: 'leave', linkView: 'leaves' });
          showToast('Leave rejected.', 'info');
          load();
        })
      );
    }
  }

  container.querySelectorAll('[data-req-tab]').forEach((btn) => {
    btn.addEventListener('click', () => {
      tab = btn.getAttribute('data-req-tab');
      container.querySelectorAll('[data-req-tab]').forEach((b) => b.classList.toggle('active', b === btn));
      load();
    });
  });

  load();
}

async function renderAdminAnnouncements(container) {
  container.innerHTML = `
    <div class="stack-lg">
      <div class="page-header">
        <div>
          <h1 class="page-title">Announcements</h1>
          <p class="page-subtitle">Broadcast institutional notices to students, teachers, or everyone.</p>
        </div>
        <button type="button" class="btn btn-primary" id="new-ann-btn">${icon('plus', 16)} Publish Announcement</button>
      </div>
      <div id="admin-ann-list">${renderTableSkeleton(3, 3)}</div>
    </div>
  `;

  async function load() {
    const list = await fetchCollection('announcements');
    const sorted = [...list].sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0));
    const slot = container.querySelector('#admin-ann-list');
    if (sorted.length === 0) {
      slot.innerHTML = renderEmptyState({ title: 'No announcements yet', description: 'Publish an announcement to notify teachers and students.' });
      return;
    }
    slot.innerHTML = `
      <div class="stack-md">
        ${sorted
          .map(
            (a) => `
          <article class="panel stack-sm">
            <div style="display:flex;justify-content:space-between;gap:1rem;align-items:flex-start;">
              <div>
                <h2 style="font-size:1.0625rem;">${escapeHtml(a.title)}</h2>
                <div class="meta-line">
                  <span style="text-transform:capitalize;">Audience: ${escapeHtml(a.audience || 'all')}</span>
                  <span aria-hidden="true">·</span>
                  <span class="mono">${escapeHtml(formatDateTime(a.createdAt))}</span>
                  ${a.pinned ? '<span aria-hidden="true">·</span><span class="status-text status-warning">Pinned</span>' : ''}
                </div>
              </div>
              <div class="toolbar-group">
                <button type="button" class="btn btn-secondary btn-sm" data-pin-ann="${escapeHtml(a.id)}" data-pinned="${a.pinned ? '1' : '0'}">${a.pinned ? 'Unpin' : 'Pin'}</button>
                <button type="button" class="btn btn-ghost btn-sm status-danger" data-del-ann="${escapeHtml(a.id)}">Delete</button>
              </div>
            </div>
            <p style="color:var(--text-secondary);">${escapeHtml(a.body)}</p>
          </article>
        `
          )
          .join('')}
      </div>
    `;
    slot.querySelectorAll('[data-pin-ann]').forEach((b) =>
      b.addEventListener('click', async () => {
        await updateDocById('announcements', b.getAttribute('data-pin-ann'), { pinned: b.getAttribute('data-pinned') !== '1' });
        load();
      })
    );
    slot.querySelectorAll('[data-del-ann]').forEach((b) =>
      b.addEventListener('click', async () => {
        await deleteDocById('announcements', b.getAttribute('data-del-ann'));
        showToast('Announcement deleted.', 'success');
        load();
      })
    );
  }

  container.querySelector('#new-ann-btn').addEventListener('click', () => {
    openModal({
      title: 'Publish Announcement',
      bodyHtml: `
        <form id="ann-form" class="stack-md">
          <div class="field"><label class="field-label">Title</label><input class="input" name="title" required maxlength="140" /></div>
          <div class="field">
            <label class="field-label">Target Audience</label>
            <select class="select" name="audience"><option value="all">All Users</option><option value="students">Students Only</option><option value="teachers">Teachers Only</option></select>
          </div>
          <div class="field"><label class="field-label">Message</label><textarea class="textarea" name="body" required maxlength="2000"></textarea></div>
          <label style="display:flex;align-items:center;gap:0.5rem;"><input type="checkbox" name="pinned" /> Pin to top</label>
          <button type="submit" class="btn btn-primary">Publish</button>
        </form>
      `,
      onMount(dialog) {
        dialog.querySelector('#ann-form').addEventListener('submit', async (e) => {
          e.preventDefault();
          const fd = new FormData(e.target);
          const { profile } = getState();
          await createDoc('announcements', {
            title: String(fd.get('title')).trim(),
            audience: String(fd.get('audience')),
            body: String(fd.get('body')).trim(),
            pinned: Boolean(fd.get('pinned')),
            departmentId: '',
            authorUid: profile.uid,
            authorName: profile.name,
          });
          await logAudit('CREATE_ANNOUNCEMENT', 'announcements', 'new', String(fd.get('title')));
          closeModal();
          showToast('Announcement published.', 'success');
          load();
        });
      },
    });
  });

  load();
}

async function renderAdminReports(container) {
  container.innerHTML = `
    <div class="stack-lg">
      <div class="page-header">
        <div>
          <h1 class="page-title">Attendance Reports (PDF &amp; Excel)</h1>
          <p class="page-subtitle">Filter attendance logs by class, subject, and date range, then export audit-ready files.</p>
        </div>
        <div class="page-actions">
          <button type="button" class="btn btn-secondary" id="exp-xlsx-btn">${icon('download', 16)} Export Excel (.xlsx)</button>
          <button type="button" class="btn btn-primary" id="exp-pdf-btn">${icon('file', 16)} Export PDF</button>
        </div>
      </div>

      <section class="panel stack-md">
        <div class="form-grid form-grid-3">
          <div class="field">
            <label class="field-label">Filter Class</label>
            <select class="select" id="rep-class"><option value="all">All Classes</option></select>
          </div>
          <div class="field">
            <label class="field-label">Filter Subject</label>
            <select class="select" id="rep-subject"><option value="all">All Subjects</option></select>
          </div>
          <div class="field">
            <label class="field-label">From Date</label>
            <input class="input mono" id="rep-from" type="date" />
          </div>
        </div>
        <div id="rep-table-slot">${renderTableSkeleton(6, 5)}</div>
      </section>
    </div>
  `;

  const [records, students, subjects, classes] = await Promise.all([
    fetchCollection('attendanceRecords'),
    fetchCollection('students'),
    fetchCollection('subjects'),
    fetchCollection('classes'),
  ]);

  const stMap = new Map(students.map((s) => [s.uid || s.id, s]));
  const subMap = new Map(subjects.map((s) => [s.id, s]));
  const clsMap = new Map(classes.map((c) => [c.id, c]));

  const clsSel = container.querySelector('#rep-class');
  const subSel = container.querySelector('#rep-subject');
  const fromEl = container.querySelector('#rep-from');

  clsSel.innerHTML = '<option value="all">All Classes</option>' + classes.map((c) => `<option value="${escapeHtml(c.id)}">${escapeHtml(c.name)}</option>`).join('');
  subSel.innerHTML = '<option value="all">All Subjects</option>' + subjects.map((s) => `<option value="${escapeHtml(s.id)}">${escapeHtml(s.code + ' · ' + s.name)}</option>`).join('');

  let currentRows = [];

  function buildRows() {
    const clsVal = clsSel.value;
    const subVal = subSel.value;
    const fromVal = fromEl.value;
    const filtered = records.filter((r) => {
      if (clsVal !== 'all' && r.classId !== clsVal) return false;
      if (subVal !== 'all' && r.subjectId !== subVal) return false;
      if (fromVal && r.date < fromVal) return false;
      return true;
    });

    // Aggregate per student + subject
    const grouped = new Map();
    for (const r of filtered) {
      const key = `${r.studentUid}__${r.subjectId}`;
      const list = grouped.get(key) || [];
      list.push(r);
      grouped.set(key, list);
    }

    const threshold = Number(getState().settings.defaultAttendanceThreshold || 75);
    currentRows = [...grouped.entries()].map(([key, recs]) => {
      const [studentUid, subjectId] = key.split('__');
      const st = stMap.get(studentUid);
      const sub = subMap.get(subjectId);
      const cls = clsMap.get(recs[0]?.classId);
      const sum = calculateAttendanceSummary(recs);
      return {
        rollNumber: st?.rollNumber || recs[0]?.rollNumber || '—',
        studentName: st?.name || recs[0]?.studentName || studentUid,
        className: cls?.name || recs[0]?.classId || '—',
        subjectName: sub ? `${sub.code} · ${sub.name}` : subjectId,
        attended: sum.effectiveAttended,
        total: sum.total,
        percentage: sum.percentage,
        standing: sum.percentage < threshold ? `Below ${threshold}%` : 'Good Standing',
      };
    });

    const slot = container.querySelector('#rep-table-slot');
    if (currentRows.length === 0) {
      slot.innerHTML = renderEmptyState({ title: 'No attendance records match filters', description: 'Record attendance sessions or adjust filters to generate reports.' });
      return;
    }

    slot.innerHTML = `
      <div class="table-wrap">
        <table class="data-table">
          <thead><tr><th>Roll No.</th><th>Student</th><th>Class</th><th>Subject</th><th class="num">Attended</th><th class="num">Total</th><th class="num">%</th><th>Standing</th></tr></thead>
          <tbody>
            ${currentRows
              .map(
                (r) => `
              <tr>
                <td class="mono">${escapeHtml(r.rollNumber)}</td>
                <td><strong>${escapeHtml(r.studentName)}</strong></td>
                <td>${escapeHtml(r.className)}</td>
                <td>${escapeHtml(r.subjectName)}</td>
                <td class="num">${r.attended}</td>
                <td class="num">${r.total}</td>
                <td class="num"><strong>${r.percentage}%</strong></td>
                <td><span class="status-text ${r.standing.startsWith('Below') ? 'status-danger' : 'status-success'}">${escapeHtml(r.standing)}</span></td>
              </tr>
            `
              )
              .join('')}
          </tbody>
        </table>
      </div>
    `;
  }

  clsSel.addEventListener('change', buildRows);
  subSel.addEventListener('change', buildRows);
  fromEl.addEventListener('change', buildRows);

  container.querySelector('#exp-pdf-btn').addEventListener('click', () => {
    if (currentRows.length === 0) return showToast('No rows to export.', 'warning');
    exportAttendancePdf({
      title: 'Institutional Attendance Summary',
      subtitle: `Session: ${getState().settings.currentAcademicSession}`,
      columns: ['Roll No.', 'Student', 'Class', 'Subject', 'Attended', 'Total', 'Pct %', 'Standing'],
      rows: currentRows.map((r) => [r.rollNumber, r.studentName, r.className, r.subjectName, r.attended, r.total, `${r.percentage}%`, r.standing]),
      fileName: `smartattend-report-${todayIsoDate()}.pdf`,
    });
    showToast('PDF report downloaded.', 'success');
  });

  container.querySelector('#exp-xlsx-btn').addEventListener('click', () => {
    if (currentRows.length === 0) return showToast('No rows to export.', 'warning');
    exportAttendanceExcel({
      sheetName: 'Attendance Summary',
      columns: ['Roll No.', 'Student', 'Class', 'Subject', 'Attended', 'Total', 'Pct %', 'Standing'],
      rows: currentRows.map((r) => [r.rollNumber, r.studentName, r.className, r.subjectName, r.attended, r.total, r.percentage, r.standing]),
      fileName: `smartattend-report-${todayIsoDate()}.xlsx`,
    });
    showToast('Excel report downloaded.', 'success');
  });

  buildRows();
}

async function renderAdminAuditLogs(container) {
  let search = '';
  let page = 1;
  container.innerHTML = `
    <div class="stack-lg">
      <div class="page-header">
        <div>
          <h1 class="page-title">Audit Logs</h1>
          <p class="page-subtitle">Immutable operational log of administrative and attendance actions.</p>
        </div>
      </div>
      <section class="panel stack-md">
        <div class="toolbar">
          <input class="input" style="max-width:300px;" id="audit-search" placeholder="Search action, actor email, details..." />
        </div>
        <div id="audit-slot">${renderTableSkeleton(5, 6)}</div>
      </section>
    </div>
  `;

  const logs = await fetchCollection('auditLogs');
  logs.sort((a, b) => (b.timestamp?.toMillis?.() || 0) - (a.timestamp?.toMillis?.() || 0));

  function render() {
    const q = search.toLowerCase();
    const filtered = logs.filter(
      (l) => !q || l.action?.toLowerCase().includes(q) || l.actorEmail?.toLowerCase().includes(q) || l.details?.toLowerCase().includes(q)
    );
    const paged = paginateItems(filtered, page, 15);
    const slot = container.querySelector('#audit-slot');
    if (paged.totalItems === 0) {
      slot.innerHTML = renderEmptyState({ title: 'No audit logs found', description: 'System events will appear here.' });
      return;
    }
    slot.innerHTML = `
      <div class="table-wrap"><table class="data-table"><thead><tr><th>Timestamp</th><th>Actor</th><th>Role</th><th>Action</th><th>Entity</th><th>Details</th></tr></thead><tbody>
        ${paged.items
          .map(
            (l) => `
          <tr>
            <td class="mono" style="font-size:0.75rem;">${escapeHtml(formatDateTime(l.timestamp))}</td>
            <td>${escapeHtml(l.actorEmail || l.actorUid)}</td>
            <td style="text-transform:capitalize;">${escapeHtml(l.actorRole || '—')}</td>
            <td class="mono"><strong>${escapeHtml(l.action)}</strong></td>
            <td class="mono">${escapeHtml(l.entityType)}</td>
            <td style="color:var(--text-secondary);">${escapeHtml(l.details || '—')}</td>
          </tr>
        `
          )
          .join('')}
      </tbody></table></div>
      <div class="pagination">
        <span>Showing ${paged.items.length} of ${paged.totalItems}</span>
        <div class="pagination-controls">
          <button type="button" class="btn btn-secondary btn-sm" id="aud-prev" ${paged.page <= 1 ? 'disabled' : ''}>Prev</button>
          <span>Page ${paged.page}/${paged.totalPages}</span>
          <button type="button" class="btn btn-secondary btn-sm" id="aud-next" ${paged.page >= paged.totalPages ? 'disabled' : ''}>Next</button>
        </div>
      </div>
    `;
    slot.querySelector('#aud-prev')?.addEventListener('click', () => {
      page -= 1;
      render();
    });
    slot.querySelector('#aud-next')?.addEventListener('click', () => {
      page += 1;
      render();
    });
  }

  container.querySelector('#audit-search').addEventListener('input', (e) => {
    search = e.target.value;
    page = 1;
    render();
  });

  render();
}
