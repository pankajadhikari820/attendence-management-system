const crypto = require('crypto');
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { onDocumentWritten } = require('firebase-functions/v2/firestore');
const admin = require('firebase-admin');

admin.initializeApp();
const db = admin.firestore();
const rtdb = admin.database();

const ALPHANUM = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';

function randomChars(len) {
  const bytes = crypto.randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i += 1) {
    out += ALPHANUM[bytes[i] % ALPHANUM.length];
  }
  return out;
}

function generateMemberPublicId(orgId) {
  const cleanOrg = String(orgId || 'ORG00000')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
  return `SA-${cleanOrg}-${randomChars(6)}`;
}

function assertVerifiedAuth(request) {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'Authentication is required.');
  }
  if (!request.auth.token.email_verified) {
    throw new HttpsError('permission-denied', 'Email verification is required.');
  }
  return request.auth.uid;
}

async function getActiveMembership(uid, orgId) {
  const snap = await db.collection('users').doc(uid).collection('memberships').doc(orgId).get();
  if (!snap.exists) return null;
  const data = snap.data();
  if (data.status !== 'active') return null;
  return data;
}

function hasOrgPerm(membership, permKey) {
  if (!membership) return false;
  if (membership.isOwner === true || membership.portalTier === 'owner') return true;
  return Boolean(membership.permissions && membership.permissions[permKey] === true);
}

function haversineDistanceMeters(lat1, lng1, lat2, lng2) {
  const toRad = (deg) => (Number(deg) * Math.PI) / 180;
  const R = 6371000;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return Math.round(R * c);
}

function evaluateShiftTiming({
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

  return { status, lateMinutes, workingMinutes, overtimeMinutes };
}

async function logAnomalyServer(orgId, payload) {
  await db.collection('organizations').doc(orgId).collection('anomalies').add({
    orgId,
    ...payload,
    resolved: false,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });
}

/**
 * Multi-tenant trusted QR / Member ID check-in & check-out handler.
 */
exports.scanMemberAttendance = onCall({ region: 'us-central1' }, async (request) => {
  const scannerUid = assertVerifiedAuth(request);
  const {
    orgId,
    parsed,
    sessionId = '',
    shiftId = 'shift_standard',
    actionType = 'check_in',
    date,
    coords = null,
  } = request.data || {};

  if (!orgId || !parsed || !date) {
    throw new HttpsError('invalid-argument', 'orgId, parsed QR payload, and date are required.');
  }

  const membership = await getActiveMembership(scannerUid, orgId);
  if (!hasOrgPerm(membership, 'canTakeAttendance')) {
    throw new HttpsError('permission-denied', 'You do not have permission to scan attendance in this organization.');
  }

  if (parsed.orgId && parsed.orgId !== orgId) {
    await logAnomalyServer(orgId, {
      type: 'cross_org_qr',
      scannerUid,
      details: `Server rejected cross-org QR belonging to ${parsed.orgId}`,
    });
    throw new HttpsError('permission-denied', `Cross-organization QR rejected (${parsed.orgId} != ${orgId}).`);
  }

  const orgSnap = await db.collection('organizations').doc(orgId).get();
  if (!orgSnap.exists) {
    throw new HttpsError('not-found', 'Organization not found.');
  }
  const orgData = orgSnap.data();
  const policies = orgData.policies || {};

  let targetMember = null;
  if (parsed.kind === 'member_qr') {
    const tokenSnap = await db.collection('organizations').doc(orgId).collection('qrTokens').doc(parsed.token).get();
    if (!tokenSnap.exists || tokenSnap.data().active !== true) {
      await logAnomalyServer(orgId, {
        type: 'invalid_or_revoked_qr',
        scannerUid,
        details: `Scanned inactive/revoked QR token (${String(parsed.token).slice(0, 8)}...)`,
      });
      throw new HttpsError('permission-denied', 'Invalid or revoked QR code.');
    }
    const memberSnap = await db.collection('organizations').doc(orgId).collection('members').doc(tokenSnap.data().memberUid).get();
    if (!memberSnap.exists) throw new HttpsError('not-found', 'Member profile not found.');
    targetMember = memberSnap.data();
  } else if (parsed.kind === 'member_public_id') {
    const mSnap = await db
      .collection('organizations')
      .doc(orgId)
      .collection('members')
      .where('memberPublicId', '==', parsed.memberPublicId)
      .limit(1)
      .get();
    if (mSnap.empty) throw new HttpsError('not-found', 'Member public ID not found in organization.');
    targetMember = mSnap.docs[0].data();
  } else {
    throw new HttpsError('invalid-argument', 'Unsupported QR payload format.');
  }

  if (targetMember.status !== 'active') {
    throw new HttpsError('failed-precondition', `${targetMember.name} is not active.`);
  }

  // Holiday & weekly off check
  const dt = new Date(`${date}T00:00:00`);
  const weeklyOffDays = Array.isArray(policies.weeklyOffDays) ? policies.weeklyOffDays : [0];
  if (!Number.isNaN(dt.getTime()) && weeklyOffDays.includes(dt.getDay())) {
    throw new HttpsError('failed-precondition', `${date} is a configured Weekly Off.`);
  }
  const holidaySnap = await db.collection('organizations').doc(orgId).collection('holidays').where('date', '==', date).get();
  const matchingHoliday = holidaySnap.docs.find((d) => {
    const h = d.data();
    return !h.departmentId || h.departmentId === 'all' || h.departmentId === targetMember.departmentId;
  });
  if (matchingHoliday) {
    throw new HttpsError('failed-precondition', `${date} is marked as Holiday (${matchingHoliday.data().title}).`);
  }

  // Geofence enforcement
  let geofenceDistanceMeters = null;
  if (policies.geofence?.enabled) {
    if (!coords || Number.isNaN(Number(coords.lat)) || Number.isNaN(Number(coords.lng))) {
      await logAnomalyServer(orgId, {
        type: 'geofence_violation',
        memberUid: targetMember.uid,
        memberName: targetMember.name,
        scannerUid,
        details: 'Missing coordinates while geofence enforcement active.',
      });
      throw new HttpsError('failed-precondition', 'Location coordinates required by geofencing policy.');
    }
    geofenceDistanceMeters = haversineDistanceMeters(
      Number(policies.geofence.lat),
      Number(policies.geofence.lng),
      Number(coords.lat),
      Number(coords.lng)
    );
    const maxRad = Math.max(25, Number(policies.geofence.radiusMeters) || 150);
    if (geofenceDistanceMeters > maxRad) {
      await logAnomalyServer(orgId, {
        type: 'geofence_violation',
        memberUid: targetMember.uid,
        memberName: targetMember.name,
        scannerUid,
        details: `Outside geofence (${geofenceDistanceMeters}m > ${maxRad}m).`,
      });
      throw new HttpsError('permission-denied', `Outside organization geofence (${geofenceDistanceMeters}m > ${maxRad}m).`);
    }
  }

  const shiftSnap = await db
    .collection('organizations')
    .doc(orgId)
    .collection('shifts')
    .doc(shiftId || targetMember.shiftId || 'shift_standard')
    .get();
  const shift = shiftSnap.exists
    ? shiftSnap.data()
    : { startTime: '09:00', endTime: '17:00', lateGraceMinutes: 15, halfDayThresholdMinutes: 240 };

  const scopeKey = sessionId || 'daily';
  const recordId = `${date}__${scopeKey}__${targetMember.uid}`;
  const nowMs = Date.now();
  let resultSummary = null;
  let resultStatus = 'present';

  await db.runTransaction(async (tx) => {
    const recRef = db.collection('organizations').doc(orgId).collection('attendanceRecords').doc(recordId);
    const recSnap = await tx.get(recRef);

    if (actionType === 'check_in') {
      if (recSnap.exists) {
        throw new HttpsError('already-exists', `Duplicate scan rejected: ${targetMember.name} already checked in for ${date}.`);
      }
      const timing = evaluateShiftTiming({
        checkInMs: nowMs,
        shiftStart: shift.startTime,
        shiftEnd: shift.endTime,
        lateGraceMinutes: shift.lateGraceMinutes ?? policies.lateGraceMinutes ?? 15,
        halfDayThresholdMinutes: shift.halfDayThresholdMinutes ?? policies.halfDayThresholdMinutes ?? 240,
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
        markedByName: membership.designationName || '',
        geofenceDistanceMeters,
        markedAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      if (sessionId) {
        const sessRef = db.collection('organizations').doc(orgId).collection('attendanceSessions').doc(sessionId);
        tx.update(sessRef, {
          [resultStatus === 'late' ? 'lateCount' : 'presentCount']: admin.firestore.FieldValue.increment(1),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      }

      resultSummary = { action: 'check_in', status: resultStatus, lateMinutes: timing.lateMinutes };
    } else {
      if (!recSnap.exists) {
        throw new HttpsError('failed-precondition', `${targetMember.name} has not checked in yet on ${date}.`);
      }
      const existing = recSnap.data();
      if (existing.checkOutMs) {
        throw new HttpsError('already-exists', `Duplicate check-out rejected for ${targetMember.name}.`);
      }
      const timing = evaluateShiftTiming({
        checkInMs: existing.checkInMs || nowMs - 60000,
        checkOutMs: nowMs,
        shiftStart: shift.startTime,
        shiftEnd: shift.endTime,
        lateGraceMinutes: shift.lateGraceMinutes ?? policies.lateGraceMinutes ?? 15,
        halfDayThresholdMinutes: shift.halfDayThresholdMinutes ?? policies.halfDayThresholdMinutes ?? 240,
      });
      resultStatus = timing.status === 'half_day' ? 'half_day' : existing.status;

      tx.update(recRef, {
        checkOutMs: nowMs,
        workingMinutes: timing.workingMinutes,
        overtimeMinutes: timing.overtimeMinutes,
        status: resultStatus,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      resultSummary = {
        action: 'check_out',
        status: resultStatus,
        workingMinutes: timing.workingMinutes,
        overtimeMinutes: timing.overtimeMinutes,
      };
    }
  });

  await rtdb.ref(`orgLive/${orgId}/recentScans/${targetMember.uid}`).set({
    memberName: targetMember.name,
    memberPublicId: targetMember.memberPublicId,
    status: resultStatus,
    action: actionType,
    timestamp: nowMs,
  });

  await db.collection('organizations').doc(orgId).collection('auditLogs').add({
    orgId,
    actorUid: scannerUid,
    action: actionType === 'check_in' ? 'QR_CHECK_IN_SERVER' : 'QR_CHECK_OUT_SERVER',
    entityType: 'attendanceRecords',
    entityId: recordId,
    details: `${actionType} for ${targetMember.name} (${targetMember.memberPublicId}) -> ${resultStatus}`,
    timestamp: admin.firestore.FieldValue.serverTimestamp(),
  });

  return { ok: true, recordId, member: targetMember, ...resultSummary };
});

/**
 * Multi-tenant trusted Member Provisioning via Firebase Admin SDK.
 */
exports.provisionOrgMemberServer = onCall({ region: 'us-central1' }, async (request) => {
  const actorUid = assertVerifiedAuth(request);
  const {
    orgId,
    name,
    email,
    password,
    externalId = '',
    phone = '',
    designationId = 'des_member',
    branchId = 'branch_hq',
    departmentId = 'dept_general',
    shiftId = 'shift_standard',
    parentMemberId = '',
    customFields = {},
  } = request.data || {};

  if (!orgId || !name || !email || !password) {
    throw new HttpsError('invalid-argument', 'orgId, name, email, and password are required.');
  }

  const actorMembership = await getActiveMembership(actorUid, orgId);
  if (!hasOrgPerm(actorMembership, 'canManageMembers')) {
    throw new HttpsError('permission-denied', 'Missing canManageMembers permission.');
  }

  const orgSnap = await db.collection('organizations').doc(orgId).get();
  if (!orgSnap.exists) throw new HttpsError('not-found', 'Organization not found.');
  const orgData = orgSnap.data();

  const desSnap = await db.collection('organizations').doc(orgId).collection('designations').doc(designationId).get();
  const desData = desSnap.exists ? desSnap.data() : { name: 'Member', permissions: { scope: 'self' } };
  const perms = desData.permissions || { scope: 'self' };
  const hasElevated = Object.entries(perms).some(([k, v]) => k !== 'scope' && v === true);
  const portalTier = perms.canManageOrg ? 'owner' : hasElevated ? 'manager' : 'member';

  const cleanEmail = String(email).trim().toLowerCase();
  const cleanName = String(name).trim();

  const userRecord = await admin.auth().createUser({
    email: cleanEmail,
    password,
    displayName: cleanName,
    emailVerified: false,
  });

  const memberPublicId = generateMemberPublicId(orgId);
  const qrTokenId = crypto.randomBytes(16).toString('hex');

  const batch = db.batch();
  batch.set(
    db.collection('users').doc(userRecord.uid),
    {
      uid: userRecord.uid,
      name: cleanName,
      email: cleanEmail,
      emailVerified: false,
      lastActiveOrgId: orgId,
      status: 'active',
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true }
  );

  batch.set(db.collection('users').doc(userRecord.uid).collection('memberships').doc(orgId), {
    orgId,
    orgName: orgData.name,
    orgType: orgData.type,
    uid: userRecord.uid,
    memberPublicId,
    designationId,
    designationName: desData.name || 'Member',
    branchId,
    departmentId,
    isOwner: false,
    portalTier,
    permissions: perms,
    status: 'active',
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  batch.set(db.collection('organizations').doc(orgId).collection('members').doc(userRecord.uid), {
    uid: userRecord.uid,
    orgId,
    memberPublicId,
    externalId: String(externalId || memberPublicId.slice(-6)).trim(),
    name: cleanName,
    email: cleanEmail,
    phone: String(phone || '').trim(),
    designationId,
    designationName: desData.name || 'Member',
    branchId,
    departmentId,
    shiftId,
    parentMemberId: String(parentMemberId || ''),
    qrTokenId,
    isOwner: false,
    portalTier,
    permissions: perms,
    leaveBalance: { annual: 12, sick: 8, casual: 6 },
    customFields,
    status: 'active',
    joinedAt: admin.firestore.FieldValue.serverTimestamp(),
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  batch.set(db.collection('organizations').doc(orgId).collection('qrTokens').doc(qrTokenId), {
    tokenId: qrTokenId,
    orgId,
    memberUid: userRecord.uid,
    memberPublicId,
    active: true,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  batch.set(db.collection('organizations').doc(orgId).collection('auditLogs').doc(), {
    orgId,
    actorUid,
    action: 'CREATE_MEMBER_SERVER',
    entityType: 'members',
    entityId: userRecord.uid,
    details: `Provisioned ${cleanName} (${memberPublicId}) via Admin SDK`,
    timestamp: admin.firestore.FieldValue.serverTimestamp(),
  });

  await batch.commit();
  return { uid: userRecord.uid, memberPublicId, qrTokenId };
});

/**
 * Multi-tenant low-attendance threshold trigger scoped strictly inside organizations/{orgId}.
 */
exports.onOrgAttendanceWritten = onDocumentWritten('organizations/{orgId}/attendanceRecords/{recordId}', async (event) => {
  const { orgId } = event.params;
  const after = event.data?.after?.data();
  if (!after || !after.memberUid) return;

  const orgSnap = await db.collection('organizations').doc(orgId).get();
  if (!orgSnap.exists) return;
  const policies = orgSnap.data().policies || {};
  const threshold = Number(policies.thresholdPct || 75);
  const lateCountsAsPresent = policies.lateCountsAsPresent !== false;
  const halfDayWeight = Number(policies.halfDayWeight ?? 0.5);

  const recSnap = await db
    .collection('organizations')
    .doc(orgId)
    .collection('attendanceRecords')
    .where('memberUid', '==', after.memberUid)
    .get();

  let working = 0;
  let attended = 0;
  recSnap.forEach((d) => {
    const st = String(d.data().status || '').toLowerCase();
    if (st === 'holiday' || st === 'weekly_off' || st === 'on_leave') return;
    working += 1;
    if (st === 'present') attended += 1;
    else if (st === 'late' && lateCountsAsPresent) attended += 1;
    else if (st === 'half_day') attended += halfDayWeight;
  });

  if (working === 0) return;
  const pct = Number(((attended / working) * 100).toFixed(1));
  if (pct < threshold) {
    await db.collection('organizations').doc(orgId).collection('notifications').add({
      orgId,
      userId: after.memberUid,
      title: 'Low Attendance Alert',
      message: `Your attendance is ${pct}% (${attended}/${working}), below ${threshold}%.`,
      type: 'low_attendance',
      read: false,
      linkView: 'shortage',
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  }
});
