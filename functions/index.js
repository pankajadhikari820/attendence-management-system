const crypto = require('crypto');
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { onDocumentWritten } = require('firebase-functions/v2/firestore');
const admin = require('firebase-admin');

admin.initializeApp();
const db = admin.firestore();
const rtdb = admin.database();

function assertVerifiedAuth(request) {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'Authentication is required.');
  }
  if (!request.auth.token.email_verified) {
    throw new HttpsError('permission-denied', 'Email verification is required.');
  }
  return request.auth.uid;
}

async function getUserRole(uid) {
  const snap = await db.collection('users').doc(uid).get();
  if (!snap.exists) return null;
  return snap.data();
}

exports.rotateSessionQr = onCall({ region: 'us-central1' }, async (request) => {
  const uid = assertVerifiedAuth(request);
  const { sessionId, rotationSeconds = 15 } = request.data || {};
  if (!sessionId) throw new HttpsError('invalid-argument', 'sessionId is required.');

  const sessionRef = db.collection('attendanceSessions').doc(sessionId);
  const sessionSnap = await sessionRef.get();
  if (!sessionSnap.exists) throw new HttpsError('not-found', 'Session not found.');

  const session = sessionSnap.data();
  const user = await getUserRole(uid);
  if (session.teacherId !== uid && user?.role !== 'admin') {
    throw new HttpsError('permission-denied', 'Only the session teacher or admin may rotate QR tokens.');
  }
  if (session.status !== 'active') {
    throw new HttpsError('failed-precondition', 'Session is already closed.');
  }

  const rotSec = Math.max(10, Math.min(120, Number(rotationSeconds) || 15));
  const token = crypto.randomBytes(12).toString('hex');
  const expiresAtMs = Date.now() + rotSec * 1000;

  await sessionRef.update({
    qrToken: token,
    qrExpiresAtMs: expiresAtMs,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  await rtdb.ref(`liveSessions/${sessionId}`).update({
    currentToken: token,
    expiresAtMs,
    updatedAt: Date.now(),
  });

  return { token, expiresAtMs };
});

exports.markQrAttendance = onCall({ region: 'us-central1' }, async (request) => {
  const uid = assertVerifiedAuth(request);
  const { sessionId, token } = request.data || {};
  if (!sessionId || !token) {
    throw new HttpsError('invalid-argument', 'sessionId and token are required.');
  }

  const recordId = `${sessionId}_${uid}`;
  let studentDoc = null;
  let sessionDoc = null;

  await db.runTransaction(async (tx) => {
    const sessionRef = db.collection('attendanceSessions').doc(sessionId);
    const sessionSnap = await tx.get(sessionRef);
    if (!sessionSnap.exists) throw new HttpsError('not-found', 'Attendance session not found.');
    sessionDoc = sessionSnap.data();

    if (sessionDoc.status !== 'active') {
      throw new HttpsError('failed-precondition', 'This attendance session is closed.');
    }
    if (sessionDoc.qrToken !== token) {
      throw new HttpsError('permission-denied', 'QR token mismatch. Scan the current rotating QR.');
    }
    if (Date.now() > Number(sessionDoc.qrExpiresAtMs || 0)) {
      throw new HttpsError('deadline-exceeded', 'QR code has expired.');
    }

    const studentRef = db.collection('students').doc(uid);
    const studentSnap = await tx.get(studentRef);
    if (!studentSnap.exists) {
      throw new HttpsError('failed-precondition', 'Student profile not found.');
    }
    studentDoc = studentSnap.data();

    if (sessionDoc.classId && studentDoc.classId && studentDoc.classId !== sessionDoc.classId) {
      throw new HttpsError('permission-denied', 'Student is not enrolled in this session class.');
    }

    const recRef = db.collection('attendanceRecords').doc(recordId);
    const recSnap = await tx.get(recRef);
    if (recSnap.exists) {
      throw new HttpsError('already-exists', 'Duplicate scan rejected: Attendance already recorded for this session.');
    }

    tx.set(recRef, {
      id: recordId,
      sessionId,
      studentId: uid,
      studentUid: uid,
      studentName: studentDoc.name || '',
      rollNumber: studentDoc.rollNumber || '',
      classId: sessionDoc.classId,
      subjectId: sessionDoc.subjectId,
      teacherId: sessionDoc.teacherId,
      date: sessionDoc.date,
      status: 'present',
      method: 'qr',
      markedBy: uid,
      markedAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    tx.update(sessionRef, {
      presentCount: admin.firestore.FieldValue.increment(1),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  });

  await rtdb.ref(`liveCheckins/${sessionId}/${uid}`).set({
    studentName: studentDoc?.name || '',
    rollNumber: studentDoc?.rollNumber || '',
    status: 'present',
    timestamp: Date.now(),
  });

  return { ok: true, recordId, status: 'present' };
});

exports.createManagedUser = onCall({ region: 'us-central1' }, async (request) => {
  const actorUid = assertVerifiedAuth(request);
  const actor = await getUserRole(actorUid);
  if (actor?.role !== 'admin') {
    throw new HttpsError('permission-denied', 'Only administrators can provision user accounts.');
  }

  const { name, email, password, role, departmentId = '', courseId = '', classId = '', semester = 1, rollNumber = '', employeeId = '', designation = 'Faculty', guardianPhone = '' } = request.data || {};
  if (!name || !email || !password || !['admin', 'teacher', 'student'].includes(role)) {
    throw new HttpsError('invalid-argument', 'Valid name, email, password, and role are required.');
  }

  const userRecord = await admin.auth().createUser({
    email: email.trim().toLowerCase(),
    password,
    displayName: name.trim(),
    emailVerified: false,
  });

  await admin.auth().setCustomUserClaims(userRecord.uid, { role });

  const batch = db.batch();
  batch.set(db.collection('users').doc(userRecord.uid), {
    uid: userRecord.uid,
    name: name.trim(),
    email: email.trim().toLowerCase(),
    role,
    departmentId,
    status: 'active',
    avatarUrl: '',
    emailVerified: false,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  if (role === 'student') {
    batch.set(db.collection('students').doc(userRecord.uid), {
      uid: userRecord.uid,
      rollNumber: rollNumber || `STU-${userRecord.uid.slice(0, 6).toUpperCase()}`,
      name: name.trim(),
      email: email.trim().toLowerCase(),
      departmentId,
      courseId,
      classId,
      semester: Number(semester) || 1,
      guardianPhone,
      status: 'active',
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  } else if (role === 'teacher') {
    batch.set(db.collection('teachers').doc(userRecord.uid), {
      uid: userRecord.uid,
      employeeId: employeeId || `EMP-${userRecord.uid.slice(0, 6).toUpperCase()}`,
      name: name.trim(),
      email: email.trim().toLowerCase(),
      departmentId,
      designation,
      subjectIds: [],
      status: 'active',
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  }

  batch.set(db.collection('auditLogs').doc(), {
    actorUid,
    actorEmail: actor.email || '',
    actorRole: 'admin',
    action: 'CREATE_USER_SERVER',
    entityType: 'users',
    entityId: userRecord.uid,
    details: `Provisioned ${role} for ${email}`,
    timestamp: admin.firestore.FieldValue.serverTimestamp(),
  });

  await batch.commit();
  return { uid: userRecord.uid, role, email: userRecord.email };
});

exports.onAttendanceRecordWritten = onDocumentWritten('attendanceRecords/{recordId}', async (event) => {
  const after = event.data?.after?.data();
  if (!after || !after.studentUid || !after.subjectId) return;

  const settingsSnap = await db.collection('settings').doc('academic').get();
  const threshold = Number(settingsSnap.exists ? settingsSnap.data().defaultAttendanceThreshold : 75) || 75;

  const snap = await db
    .collection('attendanceRecords')
    .where('studentUid', '==', after.studentUid)
    .where('subjectId', '==', after.subjectId)
    .get();

  let attended = 0;
  let total = 0;
  snap.forEach((docSnap) => {
    const st = (docSnap.data().status || '').toLowerCase();
    total += 1;
    if (st === 'present' || st === 'late' || st === 'excused') attended += 1;
  });

  if (total === 0) return;
  const pct = Number(((attended / total) * 100).toFixed(1));
  if (pct < threshold) {
    await db.collection('notifications').add({
      userId: after.studentUid,
      title: 'Low Attendance Warning',
      message: `Your subject attendance is ${pct}% (${attended}/${total}), below the ${threshold}% requirement.`,
      type: 'low_attendance',
      read: false,
      linkView: 'shortage',
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  }
});
