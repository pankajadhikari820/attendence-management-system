export function escapeHtml(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function deterministicRecordId(sessionId, studentId) {
  const s = String(sessionId || '').trim();
  const st = String(studentId || '').trim();
  if (!s || !st) throw new Error('sessionId and studentId are required.');
  return `${s}_${st}`;
}

/**
 * Computes attendance statistics from an array of attendanceRecords.
 * Policy: 'present', 'late', and 'excused' count toward attended sessions.
 */
export function calculateAttendanceSummary(records = []) {
  let present = 0;
  let late = 0;
  let excused = 0;
  let absent = 0;

  for (const r of records) {
    const st = (r.status || '').toLowerCase();
    if (st === 'present') present += 1;
    else if (st === 'late') late += 1;
    else if (st === 'excused') excused += 1;
    else if (st === 'absent') absent += 1;
  }

  const total = present + late + excused + absent;
  const effectiveAttended = present + late + excused;
  const percentage = total > 0 ? Number(((effectiveAttended / total) * 100).toFixed(1)) : 100;

  return {
    present,
    late,
    excused,
    absent,
    effectiveAttended,
    total,
    percentage,
  };
}

/**
 * Attendance Shortage Calculator:
 * Determines how many consecutive upcoming classes must be attended to reach targetPct,
 * or how many classes can be safely missed while staying >= targetPct.
 */
export function calculateShortage(attended, total, targetPct = 75) {
  const target = Math.min(99, Math.max(1, Number(targetPct) || 75)) / 100;
  const att = Math.max(0, Number(attended) || 0);
  const tot = Math.max(0, Number(total) || 0);

  if (tot === 0) {
    return {
      currentPct: 100,
      targetPct: target * 100,
      isBelowThreshold: false,
      classesNeededToReach: 0,
      safeAbsencesRemaining: 0,
      statusLabel: 'No classes recorded yet',
    };
  }

  const currentPct = Number(((att / tot) * 100).toFixed(1));
  const isBelowThreshold = att / tot < target;

  let classesNeededToReach = 0;
  let safeAbsencesRemaining = 0;

  if (isBelowThreshold) {
    // Solve: (att + x) / (tot + x) >= target => x >= (target * tot - att) / (1 - target)
    classesNeededToReach = Math.max(0, Math.ceil((target * tot - att) / (1 - target)));
  } else {
    // Solve: att / (tot + y) >= target => y <= (att / target) - tot
    safeAbsencesRemaining = Math.max(0, Math.floor(att / target - tot));
  }

  return {
    currentPct,
    targetPct: Math.round(target * 100),
    isBelowThreshold,
    classesNeededToReach,
    safeAbsencesRemaining,
    statusLabel: isBelowThreshold
      ? `Attend ${classesNeededToReach} consecutive class${classesNeededToReach === 1 ? '' : 'es'} to reach ${Math.round(target * 100)}%`
      : `Safe margin: ${safeAbsencesRemaining} absence${safeAbsencesRemaining === 1 ? '' : 's'} remaining`,
  };
}

export function encodeQrPayload(sessionId, token, expiresAtMs) {
  return JSON.stringify({
    v: 1,
    app: 'SmartAttend',
    sessionId,
    token,
    exp: expiresAtMs,
  });
}

export function parseQrPayload(rawInput) {
  const trimmed = String(rawInput || '').trim();
  if (!trimmed) return null;

  // Support JSON QR payload
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && parsed.sessionId && parsed.token) {
        return {
          sessionId: String(parsed.sessionId),
          token: String(parsed.token),
          exp: Number(parsed.exp || 0),
        };
      }
    } catch {
      return null;
    }
  }

  // Support compact pipe or colon format: sessionId:token
  if (trimmed.includes(':')) {
    const [sessionId, token] = trimmed.split(':').map((s) => s.trim());
    if (sessionId && token) {
      return { sessionId, token, exp: 0 };
    }
  }

  return null;
}

export function validateQrTokenTiming(expiresAtMs, nowMs = Date.now()) {
  if (!expiresAtMs || Number.isNaN(Number(expiresAtMs))) {
    return { valid: false, reason: 'Invalid QR expiration timestamp.' };
  }
  if (nowMs > Number(expiresAtMs)) {
    return { valid: false, reason: 'QR code has expired. Please scan the newly rotated QR code.' };
  }
  return { valid: true };
}

export function paginateItems(items = [], page = 1, pageSize = 10) {
  const totalItems = items.length;
  const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));
  const safePage = Math.min(totalPages, Math.max(1, Number(page) || 1));
  const start = (safePage - 1) * pageSize;
  return {
    items: items.slice(start, start + pageSize),
    page: safePage,
    pageSize,
    totalItems,
    totalPages,
  };
}

export function todayIsoDate() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function formatDateTime(value) {
  if (!value) return '—';
  let dateObj;
  if (typeof value?.toDate === 'function') {
    dateObj = value.toDate();
  } else if (value instanceof Date) {
    dateObj = value;
  } else if (typeof value === 'number') {
    dateObj = new Date(value);
  } else {
    dateObj = new Date(value);
  }
  if (Number.isNaN(dateObj.getTime())) return String(value);
  return dateObj.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function getInitials(name) {
  const parts = String(name || 'U')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (parts.length === 0) return 'U';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}
