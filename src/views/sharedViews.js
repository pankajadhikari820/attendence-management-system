import { updateProfile } from 'firebase/auth';
import { auth } from '../firebase/config.js';
import {
  fetchCollection,
  updateDocById,
  where,
  orderBy,
  limit,
} from '../services/firestoreService.js';
import { uploadAttachment } from '../services/storageService.js';
import { registerPushToken } from '../services/messagingService.js';
import { escapeHtml, formatDateTime, getInitials, paginateItems } from '../utils/attendanceMath.js';
import { icon } from '../utils/icons.js';
import { showToast, renderEmptyState, renderTableSkeleton } from '../utils/ui.js';
import { getState, setState } from '../state/store.js';

export async function renderProfileView(container) {
  const { profile, roleData } = getState();
  container.innerHTML = `
    <div class="stack-lg">
      <div class="page-header">
        <div>
          <h1 class="page-title">Profile &amp; Preferences</h1>
          <p class="page-subtitle">Manage your personal details, avatar, and push notifications.</p>
        </div>
      </div>

      <div class="grid-2">
        <section class="panel stack-md">
          <div style="display:flex;align-items:center;gap:1rem;">
            <div class="avatar-circle" style="width:56px;height:56px;font-size:1.125rem;">
              ${
                profile.avatarUrl
                  ? `<img src="${escapeHtml(profile.avatarUrl)}" alt="${escapeHtml(profile.name)}" referrerpolicy="no-referrer" />`
                  : escapeHtml(getInitials(profile.name))
              }
            </div>
            <div>
              <h2 style="font-size:1.125rem;">${escapeHtml(profile.name)}</h2>
              <div class="meta-line">
                <span>${escapeHtml(profile.email)}</span>
                <span aria-hidden="true">·</span>
                <span style="text-transform:capitalize;">${escapeHtml(profile.role)}</span>
                ${roleData?.rollNumber ? `<span aria-hidden="true">·</span><span class="mono">${escapeHtml(roleData.rollNumber)}</span>` : ''}
                ${roleData?.employeeId ? `<span aria-hidden="true">·</span><span class="mono">${escapeHtml(roleData.employeeId)}</span>` : ''}
              </div>
            </div>
          </div>

          <form id="profile-update-form" class="stack-md">
            <div class="field">
              <label class="field-label" for="prof-name">Display Name</label>
              <input class="input" id="prof-name" name="name" required value="${escapeHtml(profile.name)}" maxlength="80" />
            </div>
            <div class="field">
              <label class="field-label" for="prof-avatar">Profile Photo (JPG/PNG/WebP, max 5 MB)</label>
              <input class="input" id="prof-avatar" name="avatar" type="file" accept="image/jpeg,image/png,image/webp" />
            </div>
            <button type="submit" class="btn btn-primary" id="prof-save-btn">Save Profile</button>
          </form>
        </section>

        <section class="panel stack-md">
          <div>
            <h2 class="panel-title">Firebase Cloud Messaging (Web Push)</h2>
            <p class="panel-meta">Receive background alerts for low attendance, session starts, and request approvals.</p>
          </div>
          <form id="fcm-form" class="stack-md">
            <div class="field">
              <label class="field-label" for="fcm-vapid">Firebase Web Push Certificate (VAPID Key)</label>
              <input class="input mono" id="fcm-vapid" name="vapidKey" placeholder="Paste VAPID public key from Firebase Console" />
              <span class="field-hint">Optional: Configure in Firebase Console &gt; Project Settings &gt; Cloud Messaging &gt; Web Push certificates.</span>
            </div>
            <button type="submit" class="btn btn-secondary">Enable Browser Push Notifications</button>
          </form>
        </section>
      </div>
    </div>
  `;

  container.querySelector('#profile-update-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = container.querySelector('#prof-save-btn');
    btn.disabled = true;
    btn.textContent = 'Saving...';
    try {
      const fd = new FormData(e.target);
      const name = String(fd.get('name')).trim();
      const file = fd.get('avatar');
      let avatarUrl = profile.avatarUrl || '';
      if (file && file.size > 0) {
        const uploaded = await uploadAttachment('avatars', profile.uid, file);
        avatarUrl = uploaded.downloadUrl;
      }
      if (auth.currentUser) {
        await updateProfile(auth.currentUser, { displayName: name, photoURL: avatarUrl || null });
      }
      await updateDocById('users', profile.uid, { name, avatarUrl });
      if (profile.role === 'student') {
        await updateDocById('students', profile.uid, { name }).catch(() => {});
      } else if (profile.role === 'teacher') {
        await updateDocById('teachers', profile.uid, { name }).catch(() => {});
      }
      setState({ profile: { ...profile, name, avatarUrl } });
      showToast('Profile updated successfully.', 'success');
      renderProfileView(container);
    } catch (err) {
      showToast(err.message || 'Failed to update profile.', 'danger');
    } finally {
      btn.disabled = false;
    }
  });

  container.querySelector('#fcm-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const vapidKey = new FormData(e.target).get('vapidKey');
    try {
      const token = await registerPushToken(vapidKey);
      await updateDocById('users', profile.uid, { fcmToken: token });
      showToast('Web Push notifications enabled for this device.', 'success');
    } catch (err) {
      showToast(err.message || 'Could not enable push notifications.', 'warning');
    }
  });
}

export async function renderNotificationsView(container) {
  const { profile } = getState();
  container.innerHTML = `
    <div class="stack-lg">
      <div class="page-header">
        <div>
          <h1 class="page-title">Notifications</h1>
          <p class="page-subtitle">Real-time attendance alerts, leave updates, and correction decisions.</p>
        </div>
        <div class="page-actions">
          <button type="button" class="btn btn-secondary" id="notif-mark-all">Mark All Read</button>
        </div>
      </div>
      <div id="notif-list-slot">${renderTableSkeleton(3, 4)}</div>
    </div>
  `;

  async function load() {
    const slot = container.querySelector('#notif-list-slot');
    try {
      const list = await fetchCollection('notifications', [
        where('userId', '==', profile.uid),
        orderBy('createdAt', 'desc'),
        limit(50),
      ]).catch(async () => {
        // Fallback if composite index not yet deployed
        const all = await fetchCollection('notifications', [where('userId', '==', profile.uid)]);
        return all.sort((a, b) => (b.createdAt?.toMillis?.() || 0) - (a.createdAt?.toMillis?.() || 0));
      });

      setState({
        notifications: list,
        unreadNotifications: list.filter((n) => !n.read).length,
      });

      if (list.length === 0) {
        slot.innerHTML = renderEmptyState({
          title: 'No notifications yet',
          description: 'Threshold warnings, leave approvals, and correction updates will appear here.',
        });
        return;
      }

      slot.innerHTML = `
        <div class="stack-sm">
          ${list
            .map(
              (n) => `
            <article class="panel" style="display:flex;justify-content:space-between;gap:1rem;align-items:flex-start;${n.read ? 'opacity:0.78;' : ''}">
              <div class="stack-sm" style="gap:0.25rem;">
                <div style="display:flex;align-items:center;gap:0.5rem;">
                  <strong style="font-size:0.9375rem;">${escapeHtml(n.title)}</strong>
                  ${!n.read ? '<span class="status-text status-warning" style="font-size:0.75rem;">Unread</span>' : ''}
                </div>
                <p style="font-size:0.875rem;color:var(--text-secondary);">${escapeHtml(n.message)}</p>
                <div class="meta-line">
                  <span style="text-transform:capitalize;">${escapeHtml((n.type || 'notice').replace('_', ' '))}</span>
                  <span aria-hidden="true">·</span>
                  <span class="mono">${escapeHtml(formatDateTime(n.createdAt))}</span>
                </div>
              </div>
              ${
                !n.read
                  ? `<button type="button" class="btn btn-secondary btn-sm" data-mark-read="${escapeHtml(n.id)}">Mark Read</button>`
                  : ''
              }
            </article>
          `
            )
            .join('')}
        </div>
      `;

      slot.querySelectorAll('[data-mark-read]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const id = btn.getAttribute('data-mark-read');
          await updateDocById('notifications', id, { read: true });
          load();
        });
      });

      container.querySelector('#notif-mark-all').onclick = async () => {
        const unread = list.filter((n) => !n.read);
        await Promise.all(unread.map((n) => updateDocById('notifications', n.id, { read: true })));
        showToast('All notifications marked as read.', 'success');
        load();
      };
    } catch (err) {
      slot.innerHTML = `<div class="notice notice-danger">${escapeHtml(err.message)}</div>`;
    }
  }

  load();
}

export async function renderAnnouncementsFeedView(container) {
  const { profile } = getState();
  container.innerHTML = `
    <div class="stack-lg">
      <div class="page-header">
        <div>
          <h1 class="page-title">Announcements</h1>
          <p class="page-subtitle">Official institutional notices and policy updates.</p>
        </div>
      </div>
      <div id="ann-feed-slot">${renderTableSkeleton(2, 3)}</div>
    </div>
  `;

  try {
    const all = await fetchCollection('announcements');
    const filtered = all
      .filter((a) => a.audience === 'all' || a.audience === `${profile.role}s` || profile.role === 'admin')
      .sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || (b.createdAt?.toMillis?.() || 0) - (a.createdAt?.toMillis?.() || 0));

    const slot = container.querySelector('#ann-feed-slot');
    if (filtered.length === 0) {
      slot.innerHTML = renderEmptyState({
        title: 'No announcements published',
        description: 'Institutional notices from administration will appear here.',
      });
      return;
    }

    slot.innerHTML = `
      <div class="stack-md">
        ${filtered
          .map(
            (a) => `
          <article class="panel stack-sm">
            <div style="display:flex;justify-content:space-between;gap:0.75rem;align-items:flex-start;">
              <h2 style="font-size:1.0625rem;">${escapeHtml(a.title)}</h2>
              ${a.pinned ? '<span class="status-text status-warning">Pinned</span>' : ''}
            </div>
            <p style="color:var(--text-secondary);white-space:pre-line;">${escapeHtml(a.body)}</p>
            <div class="meta-line">
              <span>${escapeHtml(a.authorName || 'Administration')}</span>
              <span aria-hidden="true">·</span>
              <span style="text-transform:capitalize;">Audience: ${escapeHtml(a.audience || 'all')}</span>
              <span aria-hidden="true">·</span>
              <span class="mono">${escapeHtml(formatDateTime(a.createdAt))}</span>
            </div>
          </article>
        `
          )
          .join('')}
      </div>
    `;
  } catch (err) {
    container.querySelector('#ann-feed-slot').innerHTML = `<div class="notice notice-danger">${escapeHtml(err.message)}</div>`;
  }
}

export async function renderScheduleAndHolidaysView(container, filterRole = 'all') {
  const { profile, roleData } = getState();
  let page = 1;
  let dayFilter = 'All';

  container.innerHTML = `
    <div class="stack-lg">
      <div class="page-header">
        <div>
          <h1 class="page-title">Timetable &amp; Academic Holidays</h1>
          <p class="page-subtitle">Weekly class schedule and scheduled institutional breaks.</p>
        </div>
      </div>

      <section class="panel stack-md">
        <div class="panel-header">
          <h2 class="panel-title">Weekly Class Timetable</h2>
          <div class="segmented-bar" id="tt-day-filter">
            ${['All', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
              .map((d) => `<button type="button" class="segmented-btn ${d === 'All' ? 'active' : ''}" data-day="${d}">${d}</button>`)
              .join('')}
          </div>
        </div>
        <div id="tt-table-slot">${renderTableSkeleton(5, 4)}</div>
      </section>

      <section class="panel stack-md">
        <div class="panel-header">
          <h2 class="panel-title">Academic Holidays</h2>
        </div>
        <div id="hol-table-slot">${renderTableSkeleton(4, 3)}</div>
      </section>
    </div>
  `;

  const [slots, subjects, classes, teachers, holidays] = await Promise.all([
    fetchCollection('timetable'),
    fetchCollection('subjects'),
    fetchCollection('classes'),
    fetchCollection('teachers'),
    fetchCollection('holidays'),
  ]);

  const subjectMap = new Map(subjects.map((s) => [s.id, s]));
  const classMap = new Map(classes.map((c) => [c.id, c]));
  const teacherMap = new Map(teachers.map((t) => [t.uid || t.id, t]));

  function renderTimetable() {
    let relevant = slots;
    if (filterRole === 'student' && roleData?.classId) {
      relevant = relevant.filter((s) => s.classId === roleData.classId);
    } else if (filterRole === 'teacher') {
      relevant = relevant.filter((s) => s.teacherId === profile.uid);
    }
    if (dayFilter !== 'All') {
      relevant = relevant.filter((s) => s.dayOfWeek === dayFilter);
    }
    const paged = paginateItems(relevant, page, 10);
    const slotEl = container.querySelector('#tt-table-slot');
    if (paged.totalItems === 0) {
      slotEl.innerHTML = renderEmptyState({
        title: 'No timetable entries found',
        description: 'Scheduled lectures for your filter will appear once configured by Administration.',
      });
      return;
    }

    slotEl.innerHTML = `
      <div class="table-wrap">
        <table class="data-table">
          <thead>
            <tr>
              <th>Day</th>
              <th>Time</th>
              <th>Subject</th>
              <th>Class</th>
              <th>Instructor</th>
              <th>Room</th>
            </tr>
          </thead>
          <tbody>
            ${paged.items
              .map((item) => {
                const sub = subjectMap.get(item.subjectId);
                const cls = classMap.get(item.classId);
                const tch = teacherMap.get(item.teacherId);
                return `
                  <tr>
                    <td><strong>${escapeHtml(item.dayOfWeek)}</strong></td>
                    <td class="mono">${escapeHtml(item.startTime)} – ${escapeHtml(item.endTime)}</td>
                    <td>${escapeHtml(sub ? `${sub.code} · ${sub.name}` : item.subjectId)}</td>
                    <td>${escapeHtml(cls ? cls.name : item.classId)}</td>
                    <td>${escapeHtml(tch ? tch.name : 'Assigned Faculty')}</td>
                    <td class="mono">${escapeHtml(item.room || '—')}</td>
                  </tr>
                `;
              })
              .join('')}
          </tbody>
        </table>
      </div>
    `;
  }

  function renderHolidays() {
    const slotEl = container.querySelector('#hol-table-slot');
    const sorted = [...holidays].sort((a, b) => String(a.date).localeCompare(String(b.date)));
    if (sorted.length === 0) {
      slotEl.innerHTML = renderEmptyState({
        title: 'No holidays listed',
        description: 'Public and academic holidays will display here.',
      });
      return;
    }
    slotEl.innerHTML = `
      <div class="table-wrap">
        <table class="data-table">
          <thead>
            <tr>
              <th>Date</th>
              <th>Holiday</th>
              <th>Type</th>
              <th>Description</th>
            </tr>
          </thead>
          <tbody>
            ${sorted
              .map(
                (h) => `
              <tr>
                <td class="mono">${escapeHtml(h.date)}</td>
                <td><strong>${escapeHtml(h.title)}</strong></td>
                <td style="text-transform:capitalize;">${escapeHtml(h.type || 'academic')}</td>
                <td style="color:var(--text-secondary);">${escapeHtml(h.description || '—')}</td>
              </tr>
            `
              )
              .join('')}
          </tbody>
        </table>
      </div>
    `;
  }

  container.querySelectorAll('#tt-day-filter [data-day]').forEach((btn) => {
    btn.addEventListener('click', () => {
      dayFilter = btn.getAttribute('data-day');
      page = 1;
      container.querySelectorAll('#tt-day-filter [data-day]').forEach((b) => b.classList.toggle('active', b === btn));
      renderTimetable();
    });
  });

  renderTimetable();
  renderHolidays();
}
