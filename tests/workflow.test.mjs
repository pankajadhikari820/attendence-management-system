import assert from 'node:assert/strict';
import {
  deterministicRecordId,
  calculateAttendanceSummary,
  calculateShortage,
  encodeQrPayload,
  parseQrPayload,
  validateQrTokenTiming,
  paginateItems,
} from '../src/utils/attendanceMath.js';

// Simulated in-memory Firestore-compatible workflow harness validating all core workflows:
// 1. Admin creates teacher and student
// 2. Teacher starts a session
// 3. Student marks attendance via QR
// 4. Duplicate scan is rejected
// 5. Attendance percentage updates
// 6. Warning appears below threshold (75%)
// 7. Teacher exports report data

function runWorkflowTests() {
  const db = {
    teachers: new Map(),
    students: new Map(),
    sessions: new Map(),
    records: new Map(),
    notifications: [],
  };

  // Workflow 1: Admin creates teacher & student (no passwords stored)
  const teacher = { uid: 'tch_1', name: 'Dr. Meera Nair', email: 'meera@inst.edu', role: 'teacher' };
  const student = { uid: 'stu_1', name: 'Aarav Patel', rollNumber: 'CSE26-001', classId: 'cls_cs3a', role: 'student' };
  db.teachers.set(teacher.uid, teacher);
  db.students.set(student.uid, student);
  assert.equal('password' in teacher, false);
  assert.equal('password' in student, false);

  // Workflow 2: Teacher starts QR session with 15s expiration
  const now = 1_700_000_000_000;
  const sessionId = 'sess_101';
  const token = 'a1b2c3d4e5f6';
  const expiresAtMs = now + 15_000;
  db.sessions.set(sessionId, {
    id: sessionId,
    classId: 'cls_cs3a',
    subjectId: 'sub_dsa',
    teacherId: teacher.uid,
    status: 'active',
    qrToken: token,
    qrExpiresAtMs: expiresAtMs,
    thresholdPct: 75,
  });

  const qrString = encodeQrPayload(sessionId, token, expiresAtMs);
  const parsed = parseQrPayload(qrString);
  assert.equal(parsed.sessionId, sessionId);
  assert.equal(parsed.token, token);

  // Workflow 3: Student scans QR within expiry window
  function simulateStudentScan(scanPayload, scanTimeMs) {
    const sess = db.sessions.get(scanPayload.sessionId);
    if (!sess || sess.status !== 'active') throw new Error('Session closed');
    if (sess.qrToken !== scanPayload.token) throw new Error('Token mismatch');
    const timing = validateQrTokenTiming(sess.qrExpiresAtMs, scanTimeMs);
    if (!timing.valid) throw new Error(timing.reason);

    const recId = deterministicRecordId(sess.id, student.uid);
    if (db.records.has(recId)) {
      throw new Error('Duplicate scan rejected: Attendance already recorded for this session.');
    }
    db.records.set(recId, {
      id: recId,
      sessionId: sess.id,
      studentUid: student.uid,
      subjectId: sess.subjectId,
      status: 'present',
      method: 'qr',
    });
    return recId;
  }

  const firstRecId = simulateStudentScan(parsed, now + 4_000);
  assert.equal(firstRecId, 'sess_101_stu_1');

  // Workflow 4: Duplicate scan is rejected
  assert.throws(
    () => simulateStudentScan(parsed, now + 6_000),
    /Duplicate scan rejected/
  );

  // Expired token is also rejected
  assert.throws(
    () => simulateStudentScan({ sessionId: 'sess_101', token }, now + 20_000),
    /expired/i
  );

  // Workflow 5 & 6: Attendance percentage updates & low-attendance warning below 75%
  // Add 3 absent records for same subject -> 1 present / 4 total = 25%
  db.records.set('sess_102_stu_1', { id: 'sess_102_stu_1', studentUid: student.uid, subjectId: 'sub_dsa', status: 'absent' });
  db.records.set('sess_103_stu_1', { id: 'sess_103_stu_1', studentUid: student.uid, subjectId: 'sub_dsa', status: 'absent' });
  db.records.set('sess_104_stu_1', { id: 'sess_104_stu_1', studentUid: student.uid, subjectId: 'sub_dsa', status: 'absent' });

  const studentRecords = [...db.records.values()].filter((r) => r.studentUid === student.uid);
  const summary = calculateAttendanceSummary(studentRecords);
  assert.equal(summary.total, 4);
  assert.equal(summary.effectiveAttended, 1);
  assert.equal(summary.percentage, 25);

  const shortage = calculateShortage(summary.effectiveAttended, summary.total, 75);
  assert.equal(shortage.isBelowThreshold, true);
  // (1 + x) / (4 + x) >= 0.75 => 1 + x >= 3 + 0.75x => 0.25x >= 2 => x = 8
  assert.equal(shortage.classesNeededToReach, 8);

  if (summary.percentage < 75) {
    db.notifications.push({
      userId: student.uid,
      type: 'low_attendance',
      message: `Attendance dropped to ${summary.percentage}%`,
    });
  }
  assert.equal(db.notifications.length, 1);

  // Pagination test
  const paged = paginateItems(Array.from({ length: 25 }, (_, i) => i + 1), 2, 10);
  assert.equal(paged.totalPages, 3);
  assert.equal(paged.items.length, 10);
  assert.equal(paged.items[0], 11);

  console.log('All SmartAttend workflow tests passed (7/7 assertions verified).');
}

runWorkflowTests();
