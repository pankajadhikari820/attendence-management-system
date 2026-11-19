export function escapeHtml(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function deterministicRecordId(sessionId, memberUid) {
  const s = String(sessionId || '').trim();
  const m = String(memberUid || '').trim();
  if (!s || !m) throw new Error('sessionId and memberUid are required.');
  return `${s}_${m}`;
}

export function deterministicDailyRecordId(dateIso, scopeKey = 'daily', memberUid) {
  const d = String(dateIso || '').trim();
  const sc = String(scopeKey || 'daily').trim();
  const m = String(memberUid || '').trim();
  if (!d || !m) throw new Error('date and memberUid are required.');
  return `${d}__${sc}__${m}`;
}

export const DEFAULT_ATTENDANCE_POLICY = Object.freeze({
  thresholdPct: 75,
  lateCountsAsPresent: true,
  halfDayWeight: 0.5, // 0.5 attended credit per half_day
  approvedLeavePolicy: 'neutral', // 'neutral' (excluded from working denominator) | 'present' | 'absent'
  lateGraceMinutes: 15,
  halfDayThresholdMinutes: 240,
  standardShiftMinutes: 480,
  weeklyOffDays: [0], // 0 = Sunday
});

/**
 * Computes comprehensive attendance metrics using organization policy.
 * Holidays and Weekly Offs are NEVER counted as absences or working denominator days.
 */
export function calculateAttendanceSummary(records = [], policy = {}) {
  const cfg = { ...DEFAULT_ATTENDANCE_POLICY, ...(policy || {}) };
  let present = 0;
  let late = 0;
  let halfDay = 0;
  let onLeave = 0;
  let absent = 0;
  let holiday = 0;
  let weeklyOff = 0;
  let totalWorkingMinutes = 0;
  let totalOvertimeMinutes = 0;

  for (const r of records) {
    const st = String(r.status || '').toLowerCase();
    if (st === 'present') {
      present += 1;
    } else if (st === 'late') {
      late += 1;
    } else if (st === 'half_day') {
      halfDay += 1;
    } else if (st === 'on_leave' || st === 'excused') {
      onLeave += 1;
    } else if (st === 'holiday') {
      holiday += 1;
    } else if (st === 'weekly_off') {
      weeklyOff += 1;
    } else if (st === 'absent') {
      absent += 1;
    }

    totalWorkingMinutes += Math.max(0, Number(r.workingMinutes || 0));
    totalOvertimeMinutes += Math.max(0, Number(r.overtimeMinutes || 0));
  }

  const lateCredit = cfg.lateCountsAsPresent ? late : 0;
  const halfDayCredit = halfDay * Number(cfg.halfDayWeight ?? 0.5);

  let leaveDenominator = 0;
  let leaveCredit = 0;
  if (cfg.approvedLeavePolicy === 'present') {
    leaveDenominator = onLeave;
    leaveCredit = onLeave;
  } else if (cfg.approvedLeavePolicy === 'absent') {
    leaveDenominator = onLeave;
    leaveCredit = 0;
  }

  const workingDaysRecorded = present + late + halfDay + absent + leaveDenominator;
  const effectiveAttended = Number((present + lateCredit + halfDayCredit + leaveCredit).toFixed(2));
  const percentage =
    workingDaysRecorded > 0
      ? Number(((effectiveAttended / workingDaysRecorded) * 100).toFixed(1))
      : 100;

  return {
    present,
    late,
    halfDay,
    onLeave,
    excused: onLeave,
    absent,
    holiday,
    weeklyOff,
    workingDaysRecorded,
    effectiveAttended,
    total: workingDaysRecorded,
    percentage,
    totalWorkingMinutes,
    totalOvertimeMinutes,
    totalWorkingHours: Number((totalWorkingMinutes / 60).toFixed(1)),
    totalOvertimeHours: Number((totalOvertimeMinutes / 60).toFixed(1)),
  };
}

/**
 * Computes working minutes, overtime minutes, and late/half-day status for Check-In / Check-Out.
 */
export function evaluateShiftTiming({
  checkInMs,
  checkOutMs = null,
  shiftStart = '09:00',
  shiftEnd = '17:00',
  lateGraceMinutes = 15,
  halfDayThresholdMinutes = 240,
}) {
  const [sh, sm] = String(shiftStart || '09:00').split(':').map((n) => Number(n) || 0);
  const [eh, em] = String(shiftEnd || '17:00').split(':').map((n) => Number(n) || 0);

  const inDate = new Date(checkInMs);
  const shiftStartDate = new Date(inDate);
  shiftStartDate.setHours(sh, sm, 0, 0);

  const shiftEndDate = new Date(inDate);
  shiftEndDate.setHours(eh, em, 0, 0);
  if (shiftEndDate <= shiftStartDate) {
    shiftEndDate.setDate(shiftEndDate.getDate() + 1);
  }

  const plannedMinutes = Math.max(60, Math.round((shiftEndDate - shiftStartDate) / 60000));
  const lateMinutes = Math.max(0, Math.round((inDate - shiftStartDate) / 60000));
  let status = lateMinutes > Number(lateGraceMinutes ?? 15) ? 'late' : 'present';

  let workingMinutes = 0;
  let overtimeMinutes = 0;
  if (checkOutMs && checkOutMs > checkInMs) {
    workingMinutes = Math.round((checkOutMs - checkInMs) / 60000);
    if (workingMinutes < Number(halfDayThresholdMinutes ?? 240)) {
      status = 'half_day';
    }
    if (workingMinutes > plannedMinutes) {
      overtimeMinutes = workingMinutes - plannedMinutes;
    }
  }

  return {
    status,
    lateMinutes,
    workingMinutes,
    overtimeMinutes,
    plannedMinutes,
  };
}

export function isDateHolidayOrWeeklyOff(dateIso, holidays = [], weeklyOffDays = [0], departmentId = '') {
  const dt = new Date(`${dateIso}T00:00:00`);
  const dayIndex = Number.isNaN(dt.getTime()) ? -1 : dt.getDay();
  if (Array.isArray(weeklyOffDays) && weeklyOffDays.includes(dayIndex)) {
    return { isOff: true, reason: 'weekly_off', label: 'Weekly Off' };
  }
  const match = (holidays || []).find((h) => {
    if (h.date !== dateIso) return false;
    if (!h.departmentId || h.departmentId === 'all') return true;
    return departmentId && h.departmentId === departmentId;
  });
  if (match) {
    return { isOff: true, reason: 'holiday', label: match.title || 'Holiday' };
  }
  return { isOff: false, reason: null, label: '' };
}

/**
 * Attendance Shortage Calculator:
 * Determines how many consecutive upcoming working days/sessions must be attended to reach targetPct,
 * or how many absences can be absorbed safely.
 */
export function calculateShortage(attended, total, targetPct = 75) {
  const target = Math.min(99, Math.max(1, Number(targetPct) || 75)) / 100;
  const att = Math.max(0, Number(attended) || 0);
  const tot = Math.max(0, Number(total) || 0);

  if (tot === 0) {
    return {
      currentPct: 100,
      targetPct: Math.round(target * 100),
      isBelowThreshold: false,
      classesNeededToReach: 0,
      safeAbsencesRemaining: 0,
      statusLabel: 'No working sessions recorded yet',
    };
  }

  const currentPct = Number(((att / tot) * 100).toFixed(1));
  const isBelowThreshold = att / tot < target;

  let classesNeededToReach = 0;
  let safeAbsencesRemaining = 0;

  if (isBelowThreshold) {
    classesNeededToReach = Math.max(0, Math.ceil((target * tot - att) / (1 - target)));
  } else {
    safeAbsencesRemaining = Math.max(0, Math.floor(att / target - tot));
  }

  return {
    currentPct,
    targetPct: Math.round(target * 100),
    isBelowThreshold,
    classesNeededToReach,
    safeAbsencesRemaining,
    statusLabel: isBelowThreshold
      ? `Attend ${classesNeededToReach} consecutive session${classesNeededToReach === 1 ? '' : 's'} to reach ${Math.round(target * 100)}%`
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
    return { valid: false, reason: 'QR code has expired. Please scan the current QR code.' };
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
