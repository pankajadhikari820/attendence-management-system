import { updateProfile } from 'firebase/auth';
import { doc, updateDoc, serverTimestamp } from 'firebase/firestore';
import { auth, db } from '../firebase/config.js';
import {
  fetchOrgCollection,
  updateOrgDoc,
  where,
  orderBy,
  limit,
} from '../services/firestoreService.js';
import { uploadAttachment } from '../services/storageService.js';
import { registerPushToken } from '../services/messagingService.js';
import { escapeHtml, formatDateTime, getInitials } from '../utils/attendanceMath.js';
import { icon } from '../utils/icons.js';
import { canInstallPwa, isIosSafari, isRunningStandalone, triggerPwaInstall } from '../utils/pwa.js';
import { showToast, renderEmptyState, renderTableSkeleton } from '../utils/ui.js';
import { getState, setState } from '../state/store.js';

export async function renderProfileView(container) {
  const { userProfile, activeOrgId, activeMember, activeOrg } = getState();
  const displayName = activeMember?.name || userProfile?.name || 'Member';
  const email = activeMember?.email || userProfile?.email || '';
  const showInstall = !isRunningStandalone() && (canInstallPwa() || isIosSafari());

  container.innerHTML = `
    <div class="stack-lg">
      <div class="page-header">
        <div>
          <h1 class="page-title">Profile &amp; Preferences</h1>
          <p class="page-subtitle">Manage your identity, avatar, app installation, and push alerts in ${escapeHtml(activeOrg?.name || activeOrgId)}.</p>
        </div>
        ${
          showInstall
            ? `<div class="page-actions"><button type="button" class="btn btn-secondary" id="prof-install-pwa">${icon('smartphone', 16)} Install App</button></div>`
            : ''
        }
      </div>

      <div class="grid-2">
        <section class="panel stack-md">
          <div style="display:flex;align-items:center;gap:1rem;">
            <div class="avatar-circle" style="width:56px;height:56px;font-size:1.125rem;">
              ${
                userProfile?.avatarUrl
                  ? `<img src="${escapeHtml(userProfile.avatarUrl)}" alt="${escapeHtml(displayName)}" referrerpolicy="no-referrer" />`
                  : escapeHtml(getInitials(displayName))
              }
            </div>
            <div>
              <h2 style="font-size:1.125rem;">${escapeHtml(displayName)}</h2>
              <div class="meta-line">
                <span>${escapeHtml(email)}</span>
                <span aria-hidden="true">·</span>
                <span>${escapeHtml(activeMember?.designationName || 'Member')}</span>
                ${activeMember?.memberPublicId ? `<span aria-hidden="true">·</span><span class="mono">${escapeHtml(activeMember.memberPublicId)}</span>` : ''}
              </div>
            </div>
          </div>

          <form id="profile-update-form" class="stack-md">
            <div class="field">
              <label class="field-label" for="prof-name">Display Name</label>
              <input class="input" id="prof-name" name="name" required value="${escapeHtml(displayName)}" maxlength="80" />
            </div>
            <div class="field">
              <label class="field-label" for="prof-phone">Phone Number</label>
              <input class="input" id="prof-phone" name="phone" value="${escapeHtml(activeMember?.phone || '')}" maxlength="30" placeholder="+91 98765 43210" />
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
            <p class="panel-meta">Receive alerts for low attendance, leave approvals, and correction updates.</p>
          </div>
          <form id="fcm-form" class="stack-md">
            <div class="field">
              <label class="field-label" for="fcm-vapid">Firebase Web Push Certificate (VAPID Key)</label>
              <input class="input mono" id="fcm-vapid" name="vapidKey" placeholder="Paste VAPID public key from Firebase Console" />
              <span class="field-hint">Configure in Firebase Console &gt; Project Settings &gt; Cloud Messaging &gt; Web Push certificates.</span>
            </div>
            <button type="submit" class="btn btn-secondary">Enable Browser Push Notifications</button>
          </form>
        </section>
      </div>
    </div>
  `;

  container.querySelector('#prof-install-pwa')?.addEventListener('click', () => triggerPwaInstall());

  container.querySelector('#profile-update-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = container.querySelector('#prof-save-btn');
    btn.disabled = true;
    btn.textContent = 'Saving...';
    try {
      const fd = new FormData(e.target);
      const name = String(fd.get('name')).trim();
      const phone = String(fd.get('phone') || '').trim();
      const file = fd.get('avatar');
      let avatarUrl = userProfile?.avatarUrl || '';
      if (file && file.size > 0) {
        const uploaded = await uploadAttachment('avatars', auth.currentUser.uid, file);
        avatarUrl = uploaded.downloadUrl;
      }
      if (auth.currentUser) {
        await updateProfile(auth.currentUser, { displayName: name, photoURL: avatarUrl || null });
      }
      await updateDoc(doc(db, 'users', auth.currentUser.uid), {
        name,
        avatarUrl,
        updatedAt: serverTimestamp(),
      });
      if (activeOrgId && activeMember) {
        await updateOrgDoc(activeOrgId, 'members', auth.currentUser.uid, { name, phone });
      }
      setState({
        userProfile: { ...userProfile, name, avatarUrl },
        activeMember: activeMember ? { ...activeMember, name, phone } : null,
      });
      showToast('Profile updated.', 'success');
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
      await updateDoc(doc(db, 'users', auth.currentUser.uid), {
        fcmToken: token,
        updatedAt: serverTimestamp(),
      });
      showToast('Web Push notifications enabled.', 'success');
    } catch (err) {
      showToast(err.message || 'Could not enable push notifications.', 'warning');
    }
  });
}

export async function renderNotificationsView(container) {
  const { activeOrgId, firebaseUser } = getState();
  container.innerHTML = `
    <div class="stack-lg">
      <div class="page-header">
        <div>
          <h1 class="page-title">Notifications</h1>
          <p class="page-subtitle">Organization attendance alerts, leave updates, and correction decisions.</p>
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
      const list = await fetchOrgCollection(activeOrgId, 'notifications', [
        where('userId', '==', firebaseUser.uid),
        orderBy('createdAt', 'desc'),
        limit(50),
      ]).catch(async () => {
        const all = await fetchOrgCollection(activeOrgId, 'notifications', [
          where('userId', '==', firebaseUser.uid),
        ]);
        return all.sort((a, b) => (b.createdAt?.toMillis?.() || 0) - (a.createdAt?.toMillis?.() || 0));
      });

      setState({
        notifications: list,
        unreadNotifications: list.filter((n) => !n.read).length,
      });

      if (list.length === 0) {
        slot.innerHTML = renderEmptyState({
          title: 'No notifications yet',
          description: 'Threshold alerts, leave approvals, and attendance decisions appear here.',
        });
        return;
      }

      slot.innerHTML = `
        <div class="stack-sm">
          ${list
            .map(
              (n) => `
            <article class="panel" style="display:flex;justify-content:space-between;gap:1rem;align-items:flex-start;${n.read ? 'opacity:0.75;' : ''}">
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
          await updateOrgDoc(activeOrgId, 'notifications', btn.getAttribute('data-mark-read'), { read: true });
          load();
        });
      });

      container.querySelector('#notif-mark-all').onclick = async () => {
        const unread = list.filter((n) => !n.read);
        await Promise.all(unread.map((n) => updateOrgDoc(activeOrgId, 'notifications', n.id, { read: true })));
        showToast('All notifications marked read.', 'success');
        load();
      };
    } catch (err) {
      slot.innerHTML = `<div class="notice notice-danger">${escapeHtml(err.message)}</div>`;
    }
  }

  load();
}
