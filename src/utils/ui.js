import { escapeHtml } from './attendanceMath.js';
import { icon } from './icons.js';

export function showToast(message, variant = 'info', durationMs = 4200) {
  const root = document.getElementById('toast-root');
  if (!root) return;
  const el = document.createElement('div');
  el.className = `toast toast-${variant}`;
  el.innerHTML = `
    <div>
      <strong style="display:block;font-size:0.8125rem;margin-bottom:2px;">
        ${variant === 'success' ? 'Success' : variant === 'danger' ? 'Action Failed' : variant === 'warning' ? 'Attention' : 'Notice'}
      </strong>
      <span>${escapeHtml(message)}</span>
    </div>
    <button type="button" class="btn btn-ghost btn-sm" aria-label="Dismiss notification" style="min-height:28px;padding:4px;">
      ${icon('close', 14)}
    </button>
  `;
  const closeBtn = el.querySelector('button');
  const remove = () => {
    if (el.parentNode) el.parentNode.removeChild(el);
  };
  closeBtn.addEventListener('click', remove);
  root.appendChild(el);
  if (durationMs > 0) {
    setTimeout(remove, durationMs);
  }
}

export function openModal({ title, bodyHtml, footerHtml = '', onMount }) {
  const root = document.getElementById('modal-root');
  if (!root) return;
  root.innerHTML = `
    <div class="modal-overlay" role="dialog" aria-modal="true" aria-labelledby="modal-title-text">
      <div class="modal-dialog">
        <div class="modal-header">
          <h3 id="modal-title-text" class="panel-title">${escapeHtml(title)}</h3>
          <button type="button" class="icon-btn" id="modal-close-x" aria-label="Close modal">
            ${icon('close', 16)}
          </button>
        </div>
        <div class="modal-body">${bodyHtml}</div>
        ${footerHtml ? `<div class="modal-footer">${footerHtml}</div>` : ''}
      </div>
    </div>
  `;
  const overlay = root.querySelector('.modal-overlay');
  const closeX = root.querySelector('#modal-close-x');
  const close = () => closeModal();
  closeX?.addEventListener('click', close);
  overlay?.addEventListener('click', (e) => {
    if (e.target === overlay) close();
  });
  if (typeof onMount === 'function') {
    onMount(root.querySelector('.modal-dialog'));
  }
}

export function closeModal() {
  const root = document.getElementById('modal-root');
  if (root) root.innerHTML = '';
}

export function showConfirm({ title, message, confirmLabel = 'Confirm', danger = false }) {
  return new Promise((resolve) => {
    openModal({
      title,
      bodyHtml: `<p style="color:var(--text-secondary);font-size:0.9375rem;">${escapeHtml(message)}</p>`,
      footerHtml: `
        <button type="button" class="btn btn-secondary" id="confirm-cancel">Cancel</button>
        <button type="button" class="btn ${danger ? 'btn-danger' : 'btn-primary'}" id="confirm-ok">${escapeHtml(confirmLabel)}</button>
      `,
      onMount(dialog) {
        dialog.querySelector('#confirm-cancel')?.addEventListener('click', () => {
          closeModal();
          resolve(false);
        });
        dialog.querySelector('#confirm-ok')?.addEventListener('click', () => {
          closeModal();
          resolve(true);
        });
      },
    });
  });
}

export function getCurrentTheme() {
  return document.documentElement.classList.contains('dark') ? 'dark' : 'light';
}

export function setTheme(theme) {
  if (theme === 'dark') {
    document.documentElement.classList.add('dark');
  } else {
    document.documentElement.classList.remove('dark');
  }
  try {
    localStorage.setItem('smartattend_theme', theme);
  } catch {
    // ignore storage restriction
  }
}

export function toggleTheme() {
  const next = getCurrentTheme() === 'dark' ? 'light' : 'dark';
  setTheme(next);
  return next;
}

export function renderEmptyState({ title, description, actionHtml = '' }) {
  return `
    <div class="empty-state">
      <div>${icon('file', 28)}</div>
      <h3>${escapeHtml(title)}</h3>
      <p>${escapeHtml(description)}</p>
      ${actionHtml}
    </div>
  `;
}

export function renderTableSkeleton(cols = 5, rows = 5) {
  const trs = Array.from({ length: rows })
    .map(
      () => `<tr>${Array.from({ length: cols })
        .map(() => '<td><div class="skeleton-line"></div></td>')
        .join('')}</tr>`
    )
    .join('');
  return `<div class="table-wrap"><table class="data-table"><tbody>${trs}</tbody></table></div>`;
}
