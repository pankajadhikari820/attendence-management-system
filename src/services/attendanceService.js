import {
  collection,
  doc,
  addDoc,
  getDoc,
  getDocs,
  query,
  where,
  runTransaction,
  writeBatch,
  increment,
  serverTimestamp,
  updateDoc,
} from 'firebase/firestore';
import { ref as rtdbRef, set as rtdbSet, update as rtdbUpdate } from 'firebase/database';
import { httpsCallable } from 'firebase/functions';
import { db, rtdb, functions } from '../firebase/config.js';
import { OperationType, handleFirestoreError } from '../firebase/errors.js';
import {
  deterministicRecordId,
  deterministicDailyRecordId,
  evaluateShiftTiming,
  todayIsoDate,
  calculateAttendanceSummary,
  isDateHolidayOrWeeklyOff,
} from '../utils/attendanceMath.js';
import {
  evaluateGeofence,
  parseUniversalQrPayload,
} from '../utils/orgIds.js';
import { assertOnlineForAttendance } from '../utils/pwa.js';
import { createOrgNotification, logOrgAudit, orgCol, orgDoc } from './firestoreService.js';
import { getState } from '../state/store.js';

export async function startOrgAttendanceSession({
  orgId,
  title,
  branchId = '',
  departmentId = '',
  shiftId = 'shift_standard',
  startedByUid,
  startedByName = '',
  mode = 'scanner',
  date = todayIsoDate(),
}) {
  assertOnlineForAttendance('start an attendance session');
  const cleanTitle = String(title || 'Daily Attendance Session').trim();

  try {
    const sessionRef = await addDoc(orgCol(orgId, 'attendanceSessions'), {
      orgId,
      title: cleanTitle,
      branchId,
      departmentId,
      shiftId,
      startedByUid,
      startedByName,
      date,
      mode,
      status: 'active',
      presentCount: 0,
      lateCount: 0,
      absentCount: 0,
      halfDayCount: 0,
      startedAt: serverTimestamp(),
      closedAt: null,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });

    await rtdbSet(rtdbRef(rtdb, `orgLive/${orgId}/sessions/${sessionRef.id}`), {
      active: true,
      title: cleanTitle,
      startedByUid,
      updatedAt: Date.now(),
    }).catch(() => {});

    await logOrgAudit({
      orgId,
      action: 'START_ATTENDANCE_SESSION',
      entityType: 'attendanceSessions',
      entityId: sessionRef.id,
      details: `Started ${mode} session "${cleanTitle}" (${date})`,
    });

    return { sessionId: sessionRef.id, title: cleanTitle, date };
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, `organizations/${orgId}/attendanceSessions`);
  }
}

export async function closeOrgAttendanceSession(orgId, sessionId) {
  assertOnlineForAttendance('close an attendance session');
  await updateDoc(orgDoc(orgId, 'attendanceSessions', sessionId), {
    status: 'closed',
    closedAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });
  await rtdbUpdate(rtdbRef(rtdb, `orgLive/${orgId}/sessions/${sessionId}`), {
    active: false,
    updatedAt: Date.now(),
  }).catch(() => {});
  await logOrgAudit({
    orgId,
    action: 'CLOSE_ATTENDANCE_SESSION',
    entityType: 'attendanceSessions',
    entityId: sessionId,
    details: 'Closed attendance session',
  });
}

async function recordAnomaly(orgId, payload) {
  try {
    await addDoc(orgCol(orgId, 'anomalies'), {
      orgId,
      ...payload,
      resolved: false,
      createdAt: serverTimestamp(),
    });
  } catch {
    // non-blocking
  }
}

/**
 * Head / Manager scans a Member's personal QR code (or enters SA-ORG... Member ID).
 * Supports Check-In and Check-Out with duplicate prevention, cross-org rejection,
 * holiday/weekly-off guard, shift timing evaluation, geofencing verification, and anomaly logging.
 */
export async function scanMemberQrForAttendance({
  orgId,
  rawScanInput,
  scannerUid,
  scannerName = '',
  sessionId = '',
  shiftId = 'shift_standard',
  actionType = 'check_in', // 'check_in' | 'check_out'
  date = todayIsoDate(),
  coords = null,
}) {
  assertOnlineForAttendance('scan member QR attendance');

  const parsed = parseUniversalQrPayload(rawScanInput);
  if (!parsed) {
    throw new Error('Unrecognized QR code or Member ID format.');
  }
  if (parsed.orgId && parsed.orgId !== orgId) {
    await recordAnomaly(orgId, {
      type: 'cross_org_qr',
      scannerUid,
      details: `Attempted scan of QR belonging to ${parsed.orgId}`,
    });
    throw new Error(`Cross-organization QR rejected: this QR belongs to ${parsed.orgId}, not ${orgId}.`);
  }

  const { activeOrg, settings } = getState();
  if (activeOrg?.policies?.useCloudFunctions) {
    try {
      const fn = httpsCallable(functions, 'scanMemberAttendance');
      const res = await fn({ orgId, parsed, sessionId, shiftId, actionType, date, coords });
      return res.data;
    } catch (fnErr) {
      if (fnErr?.code && !String(fnErr.code).includes('unavailable') && !String(fnErr.code).includes('not-found')) {
        throw new Error(fnErr.message || 'Server rejected QR attendance scan.');
      }
    }
  }

  // Resolve target member securely inside current orgId
  let targetMember = null;
  if (parsed.kind === 'member_qr') {
    const tokenSnap = await getDoc(orgDoc(orgId, 'qrTokens', parsed.token));
    if (!tokenSnap.exists() || tokenSnap.data().active !== true) {
      await recordAnomaly(orgId, {
        type: 'invalid_or_revoked_qr',
        scannerUid,
        details: `Scanned inactive/revoked QR token (${parsed.token.slice(0, 8)}...)`,
      });
      throw new Error('Invalid or revoked QR code. Ask the member to show their active QR ID.');
    }
    const memberSnap = await getDoc(orgDoc(orgId, 'members', tokenSnap.data().memberUid));
    if (!memberSnap.exists()) throw new Error('Member profile not found in this organization.');
    targetMember = { id: memberSnap.id, ...memberSnap.data() };
  } else if (parsed.kind === 'member_public_id') {
    const mSnap = await getDocs(
      query(orgCol(orgId, 'members'), where('memberPublicId', '==', parsed.memberPublicId))
    );
    if (mSnap.empty) {
      throw new Error(`Member ID "${parsed.memberPublicId}" not found in ${orgId}.`);
    }
    targetMember = { id: mSnap.docs[0].id, ...mSnap.docs[0].data() };
  } else {
    throw new Error('Expected a Member Personal QR ID or Member ID code.');
  }

  if (targetMember.status !== 'active') {
    throw new Error(`${targetMember.name} is currently ${targetMember.status} and cannot be marked.`);
  }

  // Load shift & holiday configuration
  const [shiftSnap, holidaySnap] = await Promise.all([
    getDoc(orgDoc(orgId, 'shifts', shiftId || targetMember.shiftId || 'shift_standard')),
    getDocs(query(orgCol(orgId, 'holidays'), where('date', '==', date))),
  ]);
  const shift = shiftSnap.exists()
    ? shiftSnap.data()
    : { startTime: '09:00', endTime: '17:00', lateGraceMinutes: 15, halfDayThresholdMinutes: 240 };

  const holidays = holidaySnap.docs.map((d) => d.data());
  const offCheck = isDateHolidayOrWeeklyOff(
    date,
    holidays,
    settings?.weeklyOffDays || [0],
    targetMember.departmentId
  );
  if (offCheck.isOff) {
    throw new Error(`Today (${date}) is marked as ${offCheck.label}. Attendance is disabled for non-working days.`);
  }

  // Geofencing verification (only if organization enabled geofencing)
  const geoCfg = activeOrg?.policies?.geofence;
  const geoRes = evaluateGeofence(geoCfg, coords);
  if (!geoRes.allowed) {
    await recordAnomaly(orgId, {
      type: 'geofence_violation',
      memberUid: targetMember.uid,
      memberName: targetMember.name,
      scannerUid,
      details: geoRes.reason,
    });
    throw new Error(geoRes.reason);
  }

  const scopeKey = sessionId || 'daily';
  const recordId = deterministicDailyRecordId(date, scopeKey, targetMember.uid);
  const nowMs = Date.now();

  let resultStatus = 'present';
  let resultSummary = null;

  await runTransaction(db, async (tx) => {
    const recRef = orgDoc(orgId, 'attendanceRecords', recordId);
    const recSnap = await tx.get(recRef);

    if (actionType === 'check_in') {
      if (recSnap.exists()) {
        throw new Error(`Duplicate scan rejected: ${targetMember.name} already checked in for ${date}.`);
      }

      const timing = evaluateShiftTiming({
        checkInMs: nowMs,
        shiftStart: shift.startTime,
        shiftEnd: shift.endTime,
        lateGraceMinutes: shift.lateGraceMinutes ?? settings?.lateGraceMinutes ?? 15,
        halfDayThresholdMinutes: shift.halfDayThresholdMinutes ?? settings?.halfDayThresholdMinutes ?? 240,
      });
      resultStatus = timing.status;

      tx.set(recRef, {
        id: recordId,
        orgId,
        sessionId: sessionId || '',
        date,
        memberUid: targetMember.uid,
        memberPublicId: targetMember.memberPublicId,
        memberName: targetMember.name,
        externalId: targetMember.externalId || '',
        departmentId: targetMember.departmentId || '',
        branchId: targetMember.branchId || '',
        designationName: targetMember.designationName || '',
        shiftId: shiftId || targetMember.shiftId || 'shift_standard',
        status: resultStatus,
        method: parsed.kind === 'member_qr' ? 'qr_scan' : 'member_id',
        checkInMs: nowMs,
        checkOutMs: null,
        lateMinutes: timing.lateMinutes,
        workingMinutes: 0,
        overtimeMinutes: 0,
        markedByUid: scannerUid,
        markedByName: scannerName,
        geofenceDistanceMeters: geoRes.checked ? geoRes.distanceMeters : null,
        markedAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });

      if (sessionId) {
        const sRef = orgDoc(orgId, 'attendanceSessions', sessionId);
        tx.update(sRef, {
          [resultStatus === 'late' ? 'lateCount' : 'presentCount']: increment(1),
          updatedAt: serverTimestamp(),
        });
      }
      resultSummary = { action: 'check_in', status: resultStatus, lateMinutes: timing.lateMinutes };
    } else {
      if (!recSnap.exists()) {
        throw new Error(`Cannot check out: ${targetMember.name} has not checked in yet on ${date}.`);
      }
      const existing = recSnap.data();
      if (existing.checkOutMs) {
        throw new Error(`Duplicate check-out rejected: ${targetMember.name} already checked out for ${date}.`);
      }
      const timing = evaluateShiftTiming({
        checkInMs: existing.checkInMs || nowMs - 60000,
        checkOutMs: nowMs,
        shiftStart: shift.startTime,
        shiftEnd: shift.endTime,
        lateGraceMinutes: shift.lateGraceMinutes ?? settings?.lateGraceMinutes ?? 15,
        halfDayThresholdMinutes: shift.halfDayThresholdMinutes ?? settings?.halfDayThresholdMinutes ?? 240,
      });
      resultStatus = timing.status === 'half_day' ? 'half_day' : existing.status;

      tx.update(recRef, {
        checkOutMs: nowMs,
        workingMinutes: timing.workingMinutes,
        overtimeMinutes: timing.overtimeMinutes,
        status: resultStatus,
        updatedAt: serverTimestamp(),
      });
      resultSummary = {
        action: 'check_out',
        status: resultStatus,
        workingMinutes: timing.workingMinutes,
        overtimeMinutes: timing.overtimeMinutes,
      };
    }
  }).catch(async (err) => {
    if (err.message?.includes('Duplicate')) {
      await recordAnomaly(orgId, {
        type: 'duplicate_scan',
        memberUid: targetMember.uid,
        memberName: targetMember.name,
        scannerUid,
        details: err.message,
      });
    }
    throw err;
  });

  await rtdbSet(rtdbRef(rtdb, `orgLive/${orgId}/recentScans/${targetMember.uid}`), {
    memberName: targetMember.name,
    memberPublicId: targetMember.memberPublicId,
    status: resultStatus,
    action: actionType,
    timestamp: nowMs,
  }).catch(() => {});

  await logOrgAudit({
    orgId,
    action: actionType === 'check_in' ? 'QR_CHECK_IN' : 'QR_CHECK_OUT',
    entityType: 'attendanceRecords',
    entityId: recordId,
    details: `${actionType} for ${targetMember.name} (${targetMember.memberPublicId}) -> ${resultStatus}`,
  });

  await evaluateLowAttendanceAlert(orgId, targetMember.uid, settings?.thresholdPct || 75, settings);

  return {
    ok: true,
    recordId,
    member: targetMember,
    ...resultSummary,
  };
}

export async function saveOrgManualAttendanceBatch({
  orgId,
  date = todayIsoDate(),
  sessionId = '',
  shiftId = 'shift_standard',
  markedByUid,
  markedByName = '',
  entries = [], // [{ member, status }]
}) {
  assertOnlineForAttendance('save manual attendance');
  if (!entries.length) throw new Error('Select at least one member to record attendance.');

  const batch = writeBatch(db);
  const scopeKey = sessionId || 'daily';

  for (const entry of entries) {
    const m = entry.member;
    const recId = deterministicDailyRecordId(date, scopeKey, m.uid);
    batch.set(
      orgDoc(orgId, 'attendanceRecords', recId),
      {
        id: recId,
        orgId,
        sessionId: sessionId || '',
        date,
        memberUid: m.uid,
        memberPublicId: m.memberPublicId,
        memberName: m.name,
        externalId: m.externalId || '',
        departmentId: m.departmentId || '',
        branchId: m.branchId || '',
        designationName: m.designationName || '',
        shiftId: shiftId || m.shiftId || 'shift_standard',
        status: entry.status,
        method: 'manual',
        workingMinutes: entry.status === 'present' || entry.status === 'late' ? 480 : entry.status === 'half_day' ? 240 : 0,
        overtimeMinutes: 0,
        markedByUid,
        markedByName,
        markedAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      },
      { merge: true }
    );
  }

  await batch.commit();
  await logOrgAudit({
    orgId,
    action: 'MANUAL_ATTENDANCE_BATCH',
    entityType: 'attendanceRecords',
    entityId: `${date}_${scopeKey}`,
    details: `Saved manual attendance for ${entries.length} member(s) on ${date}`,
  });

  const { settings } = getState();
  for (const entry of entries) {
    if (entry.status === 'absent' || entry.status === 'half_day') {
      await evaluateLowAttendanceAlert(orgId, entry.member.uid, settings?.thresholdPct || 75, settings);
    }
  }
  return { count: entries.length };
}

export async function evaluateLowAttendanceAlert(orgId, memberUid, thresholdPct = 75, policy = {}) {
  try {
    const snap = await getDocs(
      query(orgCol(orgId, 'attendanceRecords'), where('memberUid', '==', memberUid))
    );
    const records = snap.docs.map((d) => d.data());
    const summary = calculateAttendanceSummary(records, policy);
    if (summary.workingDaysRecorded >= 1 && summary.percentage < Number(thresholdPct)) {
      await createOrgNotification({
        orgId,
        userId: memberUid,
        title: 'Low Attendance Alert',
        message: `Your attendance is ${summary.percentage}% (${summary.effectiveAttended}/${summary.workingDaysRecorded}), below your organization's ${thresholdPct}% policy.`,
        type: 'low_attendance',
        linkView: 'shortage',
      });
    }
  } catch {
    // non-blocking
  }
}

export async function reviewOrgLeaveRequest({ orgId, leaveId, decision, reviewNote = '', reviewerUid, reviewerName = '' }) {
  assertOnlineForAttendance('review leave requests');
  if (!['approved', 'rejected'].includes(decision)) throw new Error('Invalid decision.');

  let leaveData = null;
  await runTransaction(db, async (tx) => {
    const leaveRef = orgDoc(orgId, 'leaveRequests', leaveId);
    const leaveSnap = await tx.get(leaveRef);
    if (!leaveSnap.exists()) throw new Error('Leave request not found.');
    leaveData = leaveSnap.data();
    if (leaveData.status !== 'pending') {
      throw new Error('This leave request has already been processed.');
    }

    tx.update(leaveRef, {
      status: decision,
      reviewedByUid: reviewerUid,
      reviewedByName: reviewerName,
      reviewNote: String(reviewNote || '').slice(0, 300),
      updatedAt: serverTimestamp(),
    });

    if (decision === 'approved') {
      const start = new Date(`${leaveData.startDate}T00:00:00`);
      const end = new Date(`${leaveData.endDate}T00:00:00`);
      let days = 0;
      const cur = new Date(start);
      while (cur <= end && days < 31) {
        const y = cur.getFullYear();
        const m = String(cur.getMonth() + 1).padStart(2, '0');
        const d = String(cur.getDate()).padStart(2, '0');
        const iso = `${y}-${m}-${d}`;
        const recId = deterministicDailyRecordId(iso, 'daily', leaveData.memberUid);
        tx.set(
          orgDoc(orgId, 'attendanceRecords', recId),
          {
            id: recId,
            orgId,
            sessionId: '',
            date: iso,
            memberUid: leaveData.memberUid,
            memberPublicId: leaveData.memberPublicId || '',
            memberName: leaveData.memberName || '',
            departmentId: leaveData.departmentId || '',
            branchId: leaveData.branchId || '',
            status: 'on_leave',
            method: 'leave_approval',
            workingMinutes: 0,
            overtimeMinutes: 0,
            markedByUid: reviewerUid,
            markedByName: reviewerName,
            markedAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          },
          { merge: true }
        );
        days += 1;
        cur.setDate(cur.getDate() + 1);
      }
    }
  });

  if (leaveData?.memberUid) {
    await createOrgNotification({
      orgId,
      userId: leaveData.memberUid,
      title: `Leave Request ${decision === 'approved' ? 'Approved' : 'Rejected'}`,
      message: `${leaveData.startDate} to ${leaveData.endDate} (${leaveData.leaveType || 'leave'}) was ${decision}.${reviewNote ? ' Note: ' + reviewNote : ''}`,
      type: 'leave',
      linkView: 'leaves',
    });
  }

  await logOrgAudit({
    orgId,
    action: 'REVIEW_LEAVE',
    entityType: 'leaveRequests',
    entityId: leaveId,
    details: `${decision} leave for ${leaveData?.memberName || leaveData?.memberUid}`,
    before: { status: 'pending' },
    after: { status: decision, reviewNote },
  });
}

export async function reviewOrgCorrectionRequest({
  orgId,
  requestId,
  decision,
  reviewNote = '',
  reviewerUid,
  reviewerName = '',
}) {
  assertOnlineForAttendance('review correction requests');
  if (!['approved', 'rejected'].includes(decision)) throw new Error('Invalid decision.');

  let reqData = null;
  let beforeRecord = null;
  await runTransaction(db, async (tx) => {
    const reqRef = orgDoc(orgId, 'correctionRequests', requestId);
    const reqSnap = await tx.get(reqRef);
    if (!reqSnap.exists()) throw new Error('Correction request not found.');
    reqData = reqSnap.data();
    if (reqData.status !== 'pending') {
      throw new Error('This correction request has already been processed.');
    }

    if (decision === 'approved' && reqData.recordId) {
      const recRef = orgDoc(orgId, 'attendanceRecords', reqData.recordId);
      const recSnap = await tx.get(recRef);
      if (recSnap.exists()) beforeRecord = { status: recSnap.data().status };
      tx.set(
        recRef,
        {
          id: reqData.recordId,
          orgId,
          date: reqData.date || todayIsoDate(),
          memberUid: reqData.memberUid,
          memberName: reqData.memberName || '',
          memberPublicId: reqData.memberPublicId || '',
          status: reqData.requestedStatus || 'present',
          method: 'correction',
          markedByUid: reviewerUid,
          markedByName: reviewerName,
          updatedAt: serverTimestamp(),
        },
        { merge: true }
      );
    }

    tx.update(reqRef, {
      status: decision,
      reviewedByUid: reviewerUid,
      reviewedByName: reviewerName,
      reviewNote: String(reviewNote || '').slice(0, 300),
      updatedAt: serverTimestamp(),
    });
  });

  if (reqData?.memberUid) {
    await createOrgNotification({
      orgId,
      userId: reqData.memberUid,
      title: `Correction Request ${decision === 'approved' ? 'Approved' : 'Rejected'}`,
      message:
        decision === 'approved'
          ? `Your attendance on ${reqData.date} was updated to ${reqData.requestedStatus}.`
          : `Correction request for ${reqData.date} was rejected${reviewNote ? ': ' + reviewNote : '.'}`,
      type: 'correction',
      linkView: 'corrections',
    });
  }

  await logOrgAudit({
    orgId,
    action: 'REVIEW_CORRECTION',
    entityType: 'correctionRequests',
    entityId: requestId,
    details: `${decision} attendance correction for ${reqData?.memberName} (${reqData?.date})`,
    before: beforeRecord || { status: 'absent' },
    after: { status: decision === 'approved' ? reqData?.requestedStatus : 'rejected' },
  });
}

export { deterministicRecordId };
