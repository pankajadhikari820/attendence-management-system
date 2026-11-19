import {
  collection,
  doc,
  addDoc,
  getDocs,
  query,
  where,
  runTransaction,
  writeBatch,
  increment,
  serverTimestamp,
  updateDoc,
} from 'firebase/firestore';
import { ref as rtdbRef, set as rtdbSet, update as rtdbUpdate, onValue } from 'firebase/database';
import { httpsCallable } from 'firebase/functions';
import { db, rtdb, functions } from '../firebase/config.js';
import { OperationType, handleFirestoreError } from '../firebase/errors.js';
import {
  deterministicRecordId,
  calculateAttendanceSummary,
  todayIsoDate,
  validateQrTokenTiming,
} from '../utils/attendanceMath.js';
import { createNotification, logAudit } from './firestoreService.js';
import { getState } from '../state/store.js';

export function generateQrToken() {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export async function startQrSession({
  classId,
  subjectId,
  teacherId,
  academicSession,
  qrRotationSeconds = 15,
  thresholdPct = 75,
  className = '',
  subjectName = '',
  totalStudents = 0,
}) {
  const token = generateQrToken();
  const rotSec = Math.max(10, Math.min(120, Number(qrRotationSeconds) || 15));
  const expiresAtMs = Date.now() + rotSec * 1000;
  const date = todayIsoDate();

  try {
    const sessionRef = await addDoc(collection(db, 'attendanceSessions'), {
      classId,
      subjectId,
      teacherId,
      academicSession: academicSession || '2026-2027 Fall',
      date,
      mode: 'qr',
      status: 'active',
      qrToken: token,
      qrExpiresAtMs: expiresAtMs,
      qrRotationSeconds: rotSec,
      thresholdPct: Number(thresholdPct) || 75,
      presentCount: 0,
      absentCount: 0,
      lateCount: 0,
      totalStudents: Number(totalStudents) || 0,
      startedAt: serverTimestamp(),
      closedAt: null,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });

    await rtdbSet(rtdbRef(rtdb, `liveSessions/${sessionRef.id}`), {
      active: true,
      currentToken: token,
      expiresAtMs,
      rotationSeconds: rotSec,
      teacherUid: teacherId,
      className,
      subjectName,
      updatedAt: Date.now(),
    }).catch(() => {});

    await logAudit('START_QR_SESSION', 'attendanceSessions', sessionRef.id, `${subjectName} · ${className}`);
    return { sessionId: sessionRef.id, token, expiresAtMs, rotationSeconds: rotSec };
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, 'attendanceSessions');
  }
}

export async function rotateQrSessionToken(sessionId, rotationSeconds = 15) {
  const { settings } = getState();
  const rotSec = Math.max(10, Math.min(120, Number(rotationSeconds) || 15));

  if (settings.useCloudFunctions) {
    try {
      const fn = httpsCallable(functions, 'rotateSessionQr');
      const res = await fn({ sessionId, rotationSeconds: rotSec });
      return res.data;
    } catch (fnErr) {
      console.warn('Cloud Function rotateSessionQr unavailable, falling back to direct update:', fnErr.message);
    }
  }

  const token = generateQrToken();
  const expiresAtMs = Date.now() + rotSec * 1000;
  try {
    await updateDoc(doc(db, 'attendanceSessions', sessionId), {
      qrToken: token,
      qrExpiresAtMs: expiresAtMs,
      updatedAt: serverTimestamp(),
    });
    await rtdbUpdate(rtdbRef(rtdb, `liveSessions/${sessionId}`), {
      currentToken: token,
      expiresAtMs,
      updatedAt: Date.now(),
    }).catch(() => {});
    return { token, expiresAtMs };
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, `attendanceSessions/${sessionId}`);
  }
}

export function subscribeLiveCheckins(sessionId, callback) {
  const r = rtdbRef(rtdb, `liveCheckins/${sessionId}`);
  return onValue(r, (snap) => {
    const val = snap.val() || {};
    const list = Object.entries(val).map(([uid, item]) => ({ uid, ...item }));
    list.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
    callback(list);
  });
}

export async function closeQrSession(sessionId, options = {}) {
  const {
    markUnmarkedAbsent = false,
    classStudents = [],
    classId = '',
    subjectId = '',
    teacherId = '',
    date = todayIsoDate(),
    thresholdPct = 75,
  } = options;

  try {
    let newlyMarkedAbsent = 0;
    if (markUnmarkedAbsent && classStudents.length > 0) {
      const existingSnap = await getDocs(
        query(collection(db, 'attendanceRecords'), where('sessionId', '==', sessionId))
      );
      const markedUids = new Set(existingSnap.docs.map((d) => d.data().studentUid));
      const unmarked = classStudents.filter((s) => !markedUids.has(s.uid));
      if (unmarked.length > 0) {
        const batch = writeBatch(db);
        for (const st of unmarked) {
          const recId = deterministicRecordId(sessionId, st.uid);
          batch.set(doc(db, 'attendanceRecords', recId), {
            id: recId,
            sessionId,
            studentId: st.uid,
            studentUid: st.uid,
            studentName: st.name || '',
            rollNumber: st.rollNumber || '',
            classId,
            subjectId,
            teacherId,
            date,
            status: 'absent',
            method: 'auto_close',
            markedBy: teacherId,
            markedAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          });
          newlyMarkedAbsent += 1;
        }
        await batch.commit();
        for (const st of unmarked) {
          await evaluateLowAttendanceAlert(st.uid, subjectId, thresholdPct);
        }
      }
    }

    await updateDoc(doc(db, 'attendanceSessions', sessionId), {
      status: 'closed',
      qrToken: '',
      absentCount: increment(newlyMarkedAbsent),
      closedAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });

    await rtdbUpdate(rtdbRef(rtdb, `liveSessions/${sessionId}`), {
      active: false,
      currentToken: '',
      updatedAt: Date.now(),
    }).catch(() => {});

    await logAudit('CLOSE_SESSION', 'attendanceSessions', sessionId, `Unmarked marked absent: ${newlyMarkedAbsent}`);
    return { newlyMarkedAbsent };
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, `attendanceSessions/${sessionId}`);
  }
}

export async function markQrAttendance({
  sessionId,
  token,
  studentUid,
  studentName = '',
  rollNumber = '',
  thresholdPct = 75,
}) {
  const { settings } = getState();
  if (!sessionId || !token) {
    throw new Error('Invalid QR payload: missing session or token.');
  }

  if (settings.useCloudFunctions) {
    try {
      const fn = httpsCallable(functions, 'markQrAttendance');
      const res = await fn({ sessionId, token });
      return res.data;
    } catch (fnErr) {
      if (fnErr?.code && !String(fnErr.code).includes('unavailable') && !String(fnErr.code).includes('not-found')) {
        throw new Error(fnErr.message || 'Server rejected attendance scan.');
      }
      console.warn('Cloud Function markQrAttendance unavailable, falling back to Firestore Transaction:', fnErr.message);
    }
  }

  const recordId = deterministicRecordId(sessionId, studentUid);
  let sessionData = null;

  try {
    await runTransaction(db, async (tx) => {
      const sessionRef = doc(db, 'attendanceSessions', sessionId);
      const sessionSnap = await tx.get(sessionRef);
      if (!sessionSnap.exists()) {
        throw new Error('Attendance session does not exist.');
      }
      sessionData = sessionSnap.data();

      if (sessionData.status !== 'active') {
        throw new Error('This attendance session has already been closed.');
      }
      if (sessionData.qrToken !== token) {
        throw new Error('QR token mismatch. Please scan the current QR code shown on screen.');
      }
      const timing = validateQrTokenTiming(sessionData.qrExpiresAtMs);
      if (!timing.valid) {
        throw new Error(timing.reason);
      }

      const studentRef = doc(db, 'students', studentUid);
      const studentSnap = await tx.get(studentRef);
      if (!studentSnap.exists()) {
        throw new Error('Student enrollment profile not found.');
      }
      const studentDoc = studentSnap.data();
      if (sessionData.classId && studentDoc.classId && studentDoc.classId !== sessionData.classId) {
        throw new Error('You are not enrolled in the class for this attendance session.');
      }

      const recRef = doc(db, 'attendanceRecords', recordId);
      const recSnap = await tx.get(recRef);
      if (recSnap.exists()) {
        throw new Error('Duplicate scan rejected: your attendance is already recorded for this session.');
      }

      tx.set(recRef, {
        id: recordId,
        sessionId,
        studentId: studentUid,
        studentUid,
        studentName: studentDoc.name || studentName,
        rollNumber: studentDoc.rollNumber || rollNumber,
        classId: sessionData.classId,
        subjectId: sessionData.subjectId,
        teacherId: sessionData.teacherId,
        date: sessionData.date || todayIsoDate(),
        status: 'present',
        method: 'qr',
        markedBy: studentUid,
        markedAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });

      tx.update(sessionRef, {
        presentCount: increment(1),
        updatedAt: serverTimestamp(),
      });
    });

    await rtdbSet(rtdbRef(rtdb, `liveCheckins/${sessionId}/${studentUid}`), {
      studentName,
      rollNumber,
      status: 'present',
      timestamp: Date.now(),
    }).catch(() => {});

    if (sessionData?.subjectId) {
      await evaluateLowAttendanceAlert(studentUid, sessionData.subjectId, sessionData.thresholdPct || thresholdPct);
    }

    return { ok: true, recordId, status: 'present' };
  } catch (error) {
    if (error?.message?.includes('Duplicate scan') || error?.message?.includes('expired') || error?.message?.includes('mismatch') || error?.message?.includes('closed') || error?.message?.includes('enrolled')) {
      throw error;
    }
    handleFirestoreError(error, OperationType.WRITE, `attendanceRecords/${recordId}`);
  }
}

export async function saveManualAttendanceBatch({
  classId,
  subjectId,
  teacherId,
  academicSession,
  date,
  entries = [], // [{ studentUid, studentName, rollNumber, status }]
  thresholdPct = 75,
}) {
  if (!classId || !subjectId || entries.length === 0) {
    throw new Error('Class, subject, and at least one student entry are required.');
  }

  try {
    let presentCount = 0;
    let absentCount = 0;
    let lateCount = 0;

    for (const e of entries) {
      if (e.status === 'present' || e.status === 'excused') presentCount += 1;
      else if (e.status === 'late') lateCount += 1;
      else absentCount += 1;
    }

    const sessionRef = await addDoc(collection(db, 'attendanceSessions'), {
      classId,
      subjectId,
      teacherId,
      academicSession: academicSession || '2026-2027 Fall',
      date: date || todayIsoDate(),
      mode: 'manual',
      status: 'closed',
      qrToken: '',
      qrExpiresAtMs: 0,
      qrRotationSeconds: 0,
      thresholdPct: Number(thresholdPct) || 75,
      presentCount,
      absentCount,
      lateCount,
      totalStudents: entries.length,
      startedAt: serverTimestamp(),
      closedAt: serverTimestamp(),
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });

    const batch = writeBatch(db);
    for (const e of entries) {
      const recId = deterministicRecordId(sessionRef.id, e.studentUid);
      batch.set(doc(db, 'attendanceRecords', recId), {
        id: recId,
        sessionId: sessionRef.id,
        studentId: e.studentUid,
        studentUid: e.studentUid,
        studentName: e.studentName || '',
        rollNumber: e.rollNumber || '',
        classId,
        subjectId,
        teacherId,
        date: date || todayIsoDate(),
        status: e.status,
        method: 'manual',
        markedBy: teacherId,
        markedAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    }
    await batch.commit();

    for (const e of entries) {
      if (e.status === 'absent') {
        await evaluateLowAttendanceAlert(e.studentUid, subjectId, thresholdPct);
      }
    }

    await logAudit('MANUAL_ATTENDANCE', 'attendanceSessions', sessionRef.id, `Saved ${entries.length} records for ${date}`);
    return { sessionId: sessionRef.id, count: entries.length };
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, 'attendanceRecords');
  }
}

export async function evaluateLowAttendanceAlert(studentUid, subjectId, thresholdPct = 75) {
  try {
    const snap = await getDocs(
      query(
        collection(db, 'attendanceRecords'),
        where('studentUid', '==', studentUid),
        where('subjectId', '==', subjectId)
      )
    );
    const records = snap.docs.map((d) => d.data());
    const summary = calculateAttendanceSummary(records);
    if (summary.total >= 1 && summary.percentage < Number(thresholdPct)) {
      await createNotification({
        userId: studentUid,
        title: 'Low Attendance Warning',
        message: `Your attendance in this subject dropped to ${summary.percentage}% (${summary.effectiveAttended}/${summary.total}), below the ${thresholdPct}% threshold.`,
        type: 'low_attendance',
        linkView: 'shortage',
      });
    }
  } catch {
    // Non-blocking alert check
  }
}

export async function reviewCorrectionRequest({ requestId, decision, reviewNote = '', reviewerUid }) {
  if (!['approved', 'rejected'].includes(decision)) {
    throw new Error('Decision must be approved or rejected.');
  }

  try {
    let reqData = null;
    await runTransaction(db, async (tx) => {
      const reqRef = doc(db, 'correctionRequests', requestId);
      const reqSnap = await tx.get(reqRef);
      if (!reqSnap.exists()) throw new Error('Correction request not found.');
      reqData = reqSnap.data();
      if (reqData.status !== 'pending') {
        throw new Error('This correction request has already been processed.');
      }

      tx.update(reqRef, {
        status: decision,
        reviewedBy: reviewerUid,
        reviewNote: reviewNote.slice(0, 300),
        updatedAt: serverTimestamp(),
      });

      if (decision === 'approved' && reqData.recordId) {
        const recRef = doc(db, 'attendanceRecords', reqData.recordId);
        tx.update(recRef, {
          status: reqData.requestedStatus || 'present',
          method: 'correction',
          markedBy: reviewerUid,
          updatedAt: serverTimestamp(),
        });
      }
    });

    if (reqData?.studentUid) {
      await createNotification({
        userId: reqData.studentUid,
        title: `Correction Request ${decision === 'approved' ? 'Approved' : 'Rejected'}`,
        message:
          decision === 'approved'
            ? `Your attendance record was updated to ${reqData.requestedStatus || 'present'}.`
            : `Your correction request was rejected${reviewNote ? ': ' + reviewNote : '.'}`,
        type: 'correction',
        linkView: 'corrections',
      });
    }

    await logAudit('REVIEW_CORRECTION', 'correctionRequests', requestId, `Decision: ${decision}`);
  } catch (error) {
    if (error?.message?.includes('processed') || error?.message?.includes('not found')) throw error;
    handleFirestoreError(error, OperationType.UPDATE, `correctionRequests/${requestId}`);
  }
}
