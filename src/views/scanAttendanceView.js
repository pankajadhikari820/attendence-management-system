import jsQR from 'jsqr';
import { fetchOrgCollection } from '../services/firestoreService.js';
import {
  startOrgAttendanceSession,
  closeOrgAttendanceSession,
  scanMemberQrForAttendance,
  saveOrgManualAttendanceBatch,
} from '../services/attendanceService.js';
import { filterMembersByManagerScope } from '../services/hierarchyService.js';
import { escapeHtml, todayIsoDate, paginateItems } from '../utils/attendanceMath.js';
import { icon } from '../utils/icons.js';
import { isNetworkOnline } from '../utils/pwa.js';
import { showToast, renderEmptyState, renderTableSkeleton } from '../utils/ui.js';
import { getState } from '../state/store.js';

let scannerStream = null;
let scannerRafId = null;

export function cleanupScannerStreams() {
  if (scannerRafId) {
    cancelAnimationFrame(scannerRafId);
    scannerRafId = null;
  }
  if (scannerStream) {
    scannerStream.getTracks().forEach((t) => t.stop());
    scannerStream = null;
  }
}

async function getCurrentCoordinatesIfRequired(org) {
  if (!org?.policies?.geofence?.enabled) return null;
  if (!navigator.geolocation) {
    throw new Error('Geolocation is not supported by this browser, but your organization requires geofencing.');
  }
  return new Promise((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
      (err) => reject(new Error(`Location access denied (${err.message}). Geofencing is enabled in this organization.`)),
      { enableHighAccuracy: true, timeout: 8000 }
    );
  });
}

export async function renderScannerWorkspace(container) {
  cleanupScannerStreams();
  const { activeOrgId, activeOrg, activeMember, firebaseUser } = getState();

  container.innerHTML = `
    <div class="stack-lg">
      <div class="page-header">
        <div>
          <h1 class="page-title">QR Attendance Scanner</h1>
          <p class="page-subtitle">Scan any member's personal SmartAttend QR card or enter their Member ID (${escapeHtml(activeOrgId)}).</p>
        </div>
      </div>
      <div id="scanner-ws-body">${renderTableSkeleton(3, 4)}</div>
    </div>
  `;

  const body = container.querySelector('#scanner-ws-body');
  try {
    const [shifts, sessions, branches, depts] = await Promise.all([
      fetchOrgCollection(activeOrgId, 'shifts'),
      fetchOrgCollection(activeOrgId, 'attendanceSessions'),
      fetchOrgCollection(activeOrgId, 'branches'),
      fetchOrgCollection(activeOrgId, 'departments'),
    ]);

    const activeSessions = sessions.filter((s) => s.status === 'active');
    const recentResults = [];
    let scanCooldown = false;

    body.innerHTML = `
      <div class="grid-2">
        <section class="panel stack-md">
          <div class="panel-header">
            <h2 class="panel-title">1. Session &amp; Scan Mode</h2>
            <button type="button" class="btn btn-secondary btn-sm" id="scan-new-sess-btn">${icon('plus', 14)} New Session</button>
          </div>

          <div class="form-grid form-grid-2">
            <div class="field">
              <label class="field-label" for="scan-date">Date</label>
              <input class="input mono" id="scan-date" type="date" value="${todayIsoDate()}" />
            </div>
            <div class="field">
              <label class="field-label" for="scan-shift">Shift</label>
              <select class="select" id="scan-shift">
                ${shifts.map((s) => `<option value="${escapeHtml(s.id)}">${escapeHtml(s.name)} (${escapeHtml(s.startTime)}–${escapeHtml(s.endTime)})</option>`).join('')}
              </select>
            </div>
          </div>

          <div class="form-grid form-grid-2">
            <div class="field">
              <label class="field-label" for="scan-action">Scan Type</label>
              <select class="select" id="scan-action">
                <option value="check_in">Check-In (Start / Present)</option>
                <option value="check_out">Check-Out (End / Overtime)</option>
              </select>
            </div>
            <div class="field">
              <label class="field-label" for="scan-session">Active Session (Optional)</label>
              <select class="select" id="scan-session">
                <option value="">General Daily Attendance</option>
                ${activeSessions.map((s) => `<option value="${escapeHtml(s.id)}">${escapeHtml(s.title)} (${escapeHtml(s.date)})</option>`).join('')}
              </select>
            </div>
          </div>

          ${
            activeOrg?.policies?.geofence?.enabled
              ? `<div class="notice notice-warning"><span style="font-size:0.8125rem;">${icon('mapPin', 14)} Geofencing active: scans verify location within ${activeOrg.policies.geofence.radiusMeters}m.</span></div>`
              : ''
          }

          <div class="qr-stage">
            <div class="scanner-box" id="cam-box">
              <video id="scan-video" playsinline muted style="display:none;"></video>
              <canvas id="scan-canvas" style="display:none;"></canvas>
              <div class="scanner-reticle" aria-hidden="true"></div>
              <div id="cam-placeholder" style="color:#cbd5e1;padding:1rem;font-size:0.875rem;">
                Camera idle. Click "Start Camera Scanner" or enter a Member ID below.
              </div>
            </div>
            <div style="display:flex;gap:0.5rem;flex-wrap:wrap;justify-content:center;">
              <button type="button" class="btn btn-primary" id="cam-start-btn">${icon('camera', 16)} Start Camera Scanner</button>
              <button type="button" class="btn btn-secondary" id="cam-stop-btn" style="display:none;">Stop Camera</button>
            </div>
          </div>

          <form id="manual-id-scan-form" class="stack-sm">
            <label class="field-label" for="manual-qr-input">Manual Member ID (SA-ORG...) or QR Payload</label>
            <div style="display:flex;gap:0.5rem;">
              <input class="input mono" id="manual-qr-input" placeholder="e.g. SA-ORG7K9P2-4M8Q9X" required />
              <button type="submit" class="btn btn-primary" id="manual-scan-submit">Mark</button>
            </div>
          </form>
        </section>

        <section class="panel stack-md">
          <div class="panel-header">
            <h2 class="panel-title">2. Scan Feedback &amp; Live Log</h2>
            <span class="panel-meta" id="scan-count-meta">0 processed this session</span>
          </div>
          <div id="scan-feedback-box" class="notice">
            <span style="font-size:0.875rem;color:var(--text-secondary);">Ready to scan. Present a member's QR code to the camera or enter their Member ID.</span>
          </div>
          <div id="scan-recent-table">
            ${renderEmptyState({
              title: 'No scans recorded yet',
              description: 'Processed check-ins and check-outs appear here immediately.',
            })}
          </div>
        </section>
      </div>
    `;

    const feedbackBox = body.querySelector('#scan-feedback-box');
    const recentTableEl = body.querySelector('#scan-recent-table');
    const countMeta = body.querySelector('#scan-count-meta');

    function renderRecentTable() {
      countMeta.textContent = `${recentResults.length} processed`;
      if (recentResults.length === 0) return;
      recentTableEl.innerHTML = `
        <div class="table-wrap">
          <table class="data-table">
            <thead><tr><th>Member</th><th>ID</th><th>Action</th><th>Status</th></tr></thead>
            <tbody>
              ${recentResults
                .slice(0, 12)
                .map(
                  (r) => `
                <tr>
                  <td><strong>${escapeHtml(r.member.name)}</strong></td>
                  <td class="mono">${escapeHtml(r.member.memberPublicId)}</td>
                  <td style="text-transform:capitalize;">${escapeHtml(r.action.replace('_', ' '))}</td>
                  <td><span class="status-text ${r.status === 'present' ? 'status-success' : 'status-warning'}" style="text-transform:capitalize;">${escapeHtml(r.status.replace('_', ' '))}</span></td>
                </tr>
              `
                )
                .join('')}
            </tbody>
          </table>
        </div>
      `;
    }

    async function processScan(rawValue) {
      if (!isNetworkOnline()) {
        const msg = 'Offline: live QR attendance scanning is blocked until internet connectivity is restored.';
        feedbackBox.className = 'notice notice-danger';
        feedbackBox.innerHTML = `<strong style="color:var(--danger);">Offline Guard</strong><span style="font-size:0.8125rem;">${msg}</span>`;
        showToast(msg, 'danger');
        return;
      }

      try {
        const coords = await getCurrentCoordinatesIfRequired(activeOrg);
        const res = await scanMemberQrForAttendance({
          orgId: activeOrgId,
          rawScanInput: rawValue,
          scannerUid: firebaseUser.uid,
          scannerName: activeMember?.name || firebaseUser.displayName || '',
          sessionId: body.querySelector('#scan-session').value,
          shiftId: body.querySelector('#scan-shift').value,
          actionType: body.querySelector('#scan-action').value,
          date: body.querySelector('#scan-date').value || todayIsoDate(),
          coords,
        });
        recentResults.unshift(res);
        renderRecentTable();
        feedbackBox.className = 'notice notice-success';
        feedbackBox.innerHTML = `
          <strong style="color:var(--success);">${escapeHtml(res.member.name)} · ${escapeHtml(res.status.toUpperCase())}</strong>
          <span style="font-size:0.8125rem;color:var(--text-secondary);">
            ID: <span class="mono">${escapeHtml(res.member.memberPublicId)}</span> · Action: ${escapeHtml(res.action.replace('_', ' '))}
            ${res.workingMinutes ? ` · ${Math.floor(res.workingMinutes / 60)}h ${res.workingMinutes % 60}m worked` : ''}
          </span>
        `;
        showToast(`${res.member.name} marked ${res.status}.`, 'success');
      } catch (err) {
        feedbackBox.className = 'notice notice-danger';
        feedbackBox.innerHTML = `<strong style="color:var(--danger);">Scan Rejected</strong><span style="font-size:0.8125rem;">${escapeHtml(err.message)}</span>`;
        showToast(err.message, 'danger');
      }
    }

    body.querySelector('#manual-id-scan-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const input = body.querySelector('#manual-qr-input');
      const btn = body.querySelector('#manual-scan-submit');
      btn.disabled = true;
      await processScan(input.value);
      input.value = '';
      btn.disabled = false;
    });

    body.querySelector('#scan-new-sess-btn').addEventListener('click', async () => {
      const date = body.querySelector('#scan-date').value || todayIsoDate();
      const shiftId = body.querySelector('#scan-shift').value;
      const shiftName = shifts.find((s) => s.id === shiftId)?.name || 'Session';
      try {
        const created = await startOrgAttendanceSession({
          orgId: activeOrgId,
          title: `${shiftName} (${date})`,
          branchId: branches[0]?.id || '',
          departmentId: depts[0]?.id || '',
          shiftId,
          startedByUid: firebaseUser.uid,
          startedByName: activeMember?.name || '',
          mode: 'scanner',
          date,
        });
        const sel = body.querySelector('#scan-session');
        const opt = document.createElement('option');
        opt.value = created.sessionId;
        opt.textContent = `${created.title}`;
        opt.selected = true;
        sel.appendChild(opt);
        showToast('New attendance session started.', 'success');
      } catch (err) {
        showToast(err.message || 'Unable to start session.', 'danger');
      }
    });

    const videoEl = body.querySelector('#scan-video');
    const canvasEl = body.querySelector('#scan-canvas');
    const placeholderEl = body.querySelector('#cam-placeholder');
    const startCamBtn = body.querySelector('#cam-start-btn');
    const stopCamBtn = body.querySelector('#cam-stop-btn');

    function stopCam() {
      cleanupScannerStreams();
      videoEl.style.display = 'none';
      placeholderEl.style.display = 'block';
      startCamBtn.style.display = 'inline-flex';
      stopCamBtn.style.display = 'none';
    }

    stopCamBtn.addEventListener('click', stopCam);

    startCamBtn.addEventListener('click', async () => {
      try {
        scannerStream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'environment' },
          audio: false,
        });
        videoEl.srcObject = scannerStream;
        await videoEl.play();
        videoEl.style.display = 'block';
        placeholderEl.style.display = 'none';
        startCamBtn.style.display = 'none';
        stopCamBtn.style.display = 'inline-flex';

        const ctx = canvasEl.getContext('2d', { willReadFrequently: true });
        const tick = async () => {
          if (!scannerStream) return;
          if (videoEl.readyState === videoEl.HAVE_ENOUGH_DATA && !scanCooldown) {
            canvasEl.width = videoEl.videoWidth;
            canvasEl.height = videoEl.videoHeight;
            ctx.drawImage(videoEl, 0, 0, canvasEl.width, canvasEl.height);
            const imgData = ctx.getImageData(0, 0, canvasEl.width, canvasEl.height);
            const code = jsQR(imgData.data, imgData.width, imgData.height, { inversionAttempts: 'dontInvert' });
            if (code?.data) {
              scanCooldown = true;
              await processScan(code.data);
              setTimeout(() => {
                scanCooldown = false;
              }, 2200);
            }
          }
          scannerRafId = requestAnimationFrame(tick);
        };
        scannerRafId = requestAnimationFrame(tick);
      } catch (err) {
        showToast(`Camera unavailable: ${err.message}. Use Manual Member ID input below.`, 'warning', 5500);
      }
    });
  } catch (err) {
    body.innerHTML = `<div class="notice notice-danger">${escapeHtml(err.message)}</div>`;
  }
}

export async function renderManualBatchWorkspace(container) {
  cleanupScannerStreams();
  const { activeOrgId, activeMember, resolvedPermissions, firebaseUser } = getState();

  container.innerHTML = `
    <div class="stack-lg">
      <div class="page-header">
        <div>
          <h1 class="page-title">Manual Batch Attendance</h1>
          <p class="page-subtitle">Mark Present, Absent, Late, Half Day, or On Leave for members in your authorized scope.</p>
        </div>
      </div>
      <div id="manual-batch-body">${renderTableSkeleton(4, 5)}</div>
    </div>
  `;

  const body = container.querySelector('#manual-batch-body');
  try {
    const [allMembers, shifts, depts] = await Promise.all([
      fetchOrgCollection(activeOrgId, 'members'),
      fetchOrgCollection(activeOrgId, 'shifts'),
      fetchOrgCollection(activeOrgId, 'departments'),
    ]);

    const scopedMembers = filterMembersByManagerScope(allMembers, activeMember, resolvedPermissions).filter(
      (m) => m.status === 'active'
    );
    const deptMap = new Map(depts.map((d) => [d.id, d.name]));
    let selectedDept = 'all';
    let search = '';
    let page = 1;
    const statusMap = new Map(scopedMembers.map((m) => [m.uid, 'present']));

    body.innerHTML = `
      <section class="panel stack-md">
        <div class="form-grid form-grid-3">
          <div class="field">
            <label class="field-label" for="mb-date">Date</label>
            <input class="input mono" id="mb-date" type="date" value="${todayIsoDate()}" />
          </div>
          <div class="field">
            <label class="field-label" for="mb-shift">Shift</label>
            <select class="select" id="mb-shift">
              ${shifts.map((s) => `<option value="${escapeHtml(s.id)}">${escapeHtml(s.name)}</option>`).join('')}
            </select>
          </div>
          <div class="field">
            <label class="field-label" for="mb-dept">Department Filter</label>
            <select class="select" id="mb-dept">
              <option value="all">All Authorized Departments</option>
              ${depts.map((d) => `<option value="${escapeHtml(d.id)}">${escapeHtml(d.name)}</option>`).join('')}
            </select>
          </div>
        </div>

        <div class="toolbar">
          <div class="toolbar-group">
            <input class="input" id="mb-search" placeholder="Search member name or ID..." style="min-width:220px;" />
          </div>
          <div class="toolbar-group">
            <button type="button" class="btn btn-secondary btn-sm" id="mb-all-present">Mark Visible Present</button>
            <button type="button" class="btn btn-primary" id="mb-save-btn">Save Attendance Batch</button>
          </div>
        </div>

        <div id="mb-table-slot"></div>
      </section>
    `;

    function filteredList() {
      return scopedMembers.filter((m) => {
        if (selectedDept !== 'all' && m.departmentId !== selectedDept) return false;
        if (search) {
          const hay = `${m.name} ${m.memberPublicId} ${m.externalId}`.toLowerCase();
          if (!hay.includes(search.toLowerCase())) return false;
        }
        return true;
      });
    }

    function renderRows() {
      const list = filteredList();
      const paged = paginateItems(list, page, 15);
      const slot = body.querySelector('#mb-table-slot');
      if (paged.totalItems === 0) {
        slot.innerHTML = renderEmptyState({
          title: 'No matching members in scope',
          description: 'Adjust your search or department filter.',
        });
        return;
      }

      slot.innerHTML = `
        <div class="table-wrap">
          <table class="data-table">
            <thead>
              <tr>
                <th>Member</th>
                <th>Member ID</th>
                <th>Department</th>
                <th>Designation</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              ${paged.items
                .map((m) => {
                  const st = statusMap.get(m.uid) || 'present';
                  return `
                    <tr>
                      <td><strong>${escapeHtml(m.name)}</strong></td>
                      <td class="mono">${escapeHtml(m.memberPublicId)}</td>
                      <td>${escapeHtml(deptMap.get(m.departmentId) || '—')}</td>
                      <td>${escapeHtml(m.designationName || 'Member')}</td>
                      <td>
                        <select class="select" data-mb-status="${escapeHtml(m.uid)}" style="min-height:36px;min-width:130px;">
                          ${['present', 'absent', 'late', 'half_day', 'on_leave']
                            .map((opt) => `<option value="${opt}" ${st === opt ? 'selected' : ''}>${opt.replace('_', ' ')}</option>`)
                            .join('')}
                        </select>
                      </td>
                    </tr>
                  `;
                })
                .join('')}
            </tbody>
          </table>
        </div>
        <div class="pagination">
          <span>Showing ${paged.items.length} of ${paged.totalItems} members</span>
          <div class="pagination-controls">
            <button type="button" class="btn btn-secondary btn-sm" id="mb-prev" ${paged.page <= 1 ? 'disabled' : ''}>Prev</button>
            <span class="mono">${paged.page}/${paged.totalPages}</span>
            <button type="button" class="btn btn-secondary btn-sm" id="mb-next" ${paged.page >= paged.totalPages ? 'disabled' : ''}>Next</button>
          </div>
        </div>
      `;

      slot.querySelectorAll('[data-mb-status]').forEach((sel) => {
        sel.addEventListener('change', () => {
          statusMap.set(sel.getAttribute('data-mb-status'), sel.value);
        });
      });
      slot.querySelector('#mb-prev')?.addEventListener('click', () => {
        page = Math.max(1, page - 1);
        renderRows();
      });
      slot.querySelector('#mb-next')?.addEventListener('click', () => {
        page = Math.min(paged.totalPages, page + 1);
        renderRows();
      });
    }

    body.querySelector('#mb-dept').addEventListener('change', (e) => {
      selectedDept = e.target.value;
      page = 1;
      renderRows();
    });
    body.querySelector('#mb-search').addEventListener('input', (e) => {
      search = e.target.value;
      page = 1;
      renderRows();
    });
    body.querySelector('#mb-all-present').addEventListener('click', () => {
      filteredList().forEach((m) => statusMap.set(m.uid, 'present'));
      renderRows();
    });
    body.querySelector('#mb-save-btn').addEventListener('click', async () => {
      const btn = body.querySelector('#mb-save-btn');
      btn.disabled = true;
      btn.textContent = 'Saving...';
      try {
        const list = filteredList();
        const entries = list.map((m) => ({ member: m, status: statusMap.get(m.uid) || 'present' }));
        await saveOrgManualAttendanceBatch({
          orgId: activeOrgId,
          date: body.querySelector('#mb-date').value || todayIsoDate(),
          shiftId: body.querySelector('#mb-shift').value,
          markedByUid: firebaseUser.uid,
          markedByName: activeMember?.name || '',
          entries,
        });
        showToast(`Saved attendance for ${entries.length} member(s).`, 'success');
      } catch (err) {
        showToast(err.message || 'Save failed.', 'danger');
      } finally {
        btn.disabled = false;
        btn.textContent = 'Save Attendance Batch';
      }
    });

    renderRows();
  } catch (err) {
    body.innerHTML = `<div class="notice notice-danger">${escapeHtml(err.message)}</div>`;
  }
}

export { closeOrgAttendanceSession };
