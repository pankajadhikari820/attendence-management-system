import {
  createUserWithEmailAndPassword,
  updateProfile,
  sendEmailVerification,
  signOut,
} from 'firebase/auth';
import { doc, getDoc, writeBatch, serverTimestamp, updateDoc } from 'firebase/firestore';
import { httpsCallable } from 'firebase/functions';
import { db, functions, getSecondaryAuth } from '../firebase/config.js';
import {
  fetchOrgCollection,
  createOrgDoc,
  updateOrgDoc,
  deleteOrgDoc,
  logOrgAudit,
} from './firestoreService.js';
import {
  generateMemberPublicId,
  generateOpaqueQrToken,
} from '../utils/orgIds.js';
import {
  DEFAULT_PERMISSIONS_MEMBER,
  resolveMembershipPermissions,
} from '../utils/authRouting.js';
import { SUBSCRIPTION_PLANS } from './orgService.js';

export async function createDesignation(orgId, payload) {
  const clean = {
    name: String(payload.name || '').trim(),
    level: Math.max(1, Math.min(20, Number(payload.level) || 3)),
    parentDesignationId: String(payload.parentDesignationId || ''),
    isSystemOwner: false,
    permissions: {
      ...DEFAULT_PERMISSIONS_MEMBER,
      ...(payload.permissions || {}),
    },
  };
  if (!clean.name) throw new Error('Designation name is required.');
  const id = await createOrgDoc(orgId, 'designations', clean);
  await logOrgAudit({
    orgId,
    action: 'CREATE_DESIGNATION',
    entityType: 'designations',
    entityId: id,
    details: `Created designation "${clean.name}" (Level ${clean.level})`,
    after: clean,
  });
  return id;
}

export async function updateDesignation(orgId, desId, patch, before = null) {
  await updateOrgDoc(orgId, 'designations', desId, patch);
  await logOrgAudit({
    orgId,
    action: 'UPDATE_DESIGNATION',
    entityType: 'designations',
    entityId: desId,
    details: `Updated designation "${patch.name || desId}"`,
    before,
    after: patch,
  });
}

export async function createBranch(orgId, orgDocData, payload) {
  const existing = await fetchOrgCollection(orgId, 'branches');
  const limit = Number(orgDocData?.branchLimit || SUBSCRIPTION_PLANS.free.maxBranches);
  if (existing.length >= limit) {
    throw new Error(`Plan limit reached (${limit} branch(es) on ${orgDocData?.plan || 'free'} plan). Upgrade plan in Organization Settings.`);
  }
  const clean = {
    name: String(payload.name || '').trim(),
    code: String(payload.code || '').trim().toUpperCase(),
    address: String(payload.address || '').trim(),
    managerUid: String(payload.managerUid || ''),
    geofence: payload.geofence || { enabled: false, lat: 0, lng: 0, radiusMeters: 150 },
    status: 'active',
  };
  if (!clean.name || !clean.code) throw new Error('Branch name and code are required.');
  const id = await createOrgDoc(orgId, 'branches', clean);
  await logOrgAudit({
    orgId,
    action: 'CREATE_BRANCH',
    entityType: 'branches',
    entityId: id,
    details: `Created branch ${clean.code} · ${clean.name}`,
    after: clean,
  });
  return id;
}

export async function createDepartment(orgId, payload) {
  const clean = {
    name: String(payload.name || '').trim(),
    code: String(payload.code || '').trim().toUpperCase(),
    branchId: String(payload.branchId || ''),
    headUid: String(payload.headUid || ''),
    description: String(payload.description || '').trim(),
  };
  if (!clean.name || !clean.code) throw new Error('Department name and code are required.');
  const id = await createOrgDoc(orgId, 'departments', clean);
  await logOrgAudit({
    orgId,
    action: 'CREATE_DEPARTMENT',
    entityType: 'departments',
    entityId: id,
    details: `Created department ${clean.code} · ${clean.name}`,
    after: clean,
  });
  return id;
}

export async function provisionOrgMember({
  orgId,
  orgDocData,
  existingMembers = [],
  designations = [],
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
}) {
  const cleanEmail = String(email || '').trim().toLowerCase();
  const cleanName = String(name || '').trim();
  const cleanExternal = String(externalId || '').trim();

  if (!cleanName || !cleanEmail || !password) {
    throw new Error('Member full name, email, and initial password are required.');
  }

  const maxMembers = Number(orgDocData?.memberLimit || SUBSCRIPTION_PLANS.free.maxMembers);
  const activeCount = existingMembers.filter((m) => m.status === 'active').length;
  if (activeCount >= maxMembers) {
    throw new Error(`Member limit reached (${maxMembers} active members on ${orgDocData?.plan || 'free'} plan).`);
  }

  if (existingMembers.some((m) => m.email?.toLowerCase() === cleanEmail)) {
    throw new Error(`A member with email "${cleanEmail}" already exists in this organization.`);
  }
  if (
    cleanExternal &&
    existingMembers.some((m) => (m.externalId || '').trim().toLowerCase() === cleanExternal.toLowerCase())
  ) {
    throw new Error(`Duplicate ID detected: "${cleanExternal}" is already assigned to another member.`);
  }

  const desObj = designations.find((d) => d.id === designationId);
  const designationName = desObj?.name || 'Member';
  const resolved = resolveMembershipPermissions(
    { status: 'active', isOwner: false, permissions: desObj?.permissions || DEFAULT_PERMISSIONS_MEMBER },
    desObj
  );

  let uid = '';
  if (orgDocData?.policies?.useCloudFunctions) {
    try {
      const fn = httpsCallable(functions, 'provisionOrgMemberServer');
      const res = await fn({
        orgId,
        name: cleanName,
        email: cleanEmail,
        password,
        externalId: cleanExternal,
        phone,
        designationId,
        branchId,
        departmentId,
        shiftId,
        parentMemberId,
        customFields,
      });
      return res.data;
    } catch (fnErr) {
      console.warn('Cloud Function provisionOrgMemberServer unavailable, using Spark secondary Auth:', fnErr.message);
    }
  }

  const secondaryAuth = getSecondaryAuth();
  try {
    const cred = await createUserWithEmailAndPassword(secondaryAuth, cleanEmail, password);
    uid = cred.user.uid;
    await updateProfile(cred.user, { displayName: cleanName });
    await sendEmailVerification(cred.user).catch(() => {});
  } finally {
    await signOut(secondaryAuth).catch(() => {});
  }

  const memberPublicId = generateMemberPublicId(orgId);
  const qrTokenId = generateOpaqueQrToken();

  const batch = writeBatch(db);
  batch.set(doc(db, 'users', uid), {
    uid,
    name: cleanName,
    email: cleanEmail,
    avatarUrl: '',
    emailVerified: false,
    lastActiveOrgId: orgId,
    status: 'active',
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });

  batch.set(doc(db, 'users', uid, 'memberships', orgId), {
    orgId,
    orgName: orgDocData?.name || orgId,
    orgType: orgDocData?.type || 'company',
    uid,
    memberPublicId,
    designationId,
    designationName,
    branchId,
    departmentId,
    isOwner: false,
    portalTier: resolved.tier,
    permissions: resolved.permissions,
    status: 'active',
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });

  batch.set(doc(db, 'organizations', orgId, 'members', uid), {
    uid,
    orgId,
    memberPublicId,
    externalId: cleanExternal || memberPublicId.slice(-6),
    name: cleanName,
    email: cleanEmail,
    phone: String(phone || '').trim(),
    designationId,
    designationName,
    branchId,
    departmentId,
    shiftId,
    parentMemberId: String(parentMemberId || ''),
    qrTokenId,
    isOwner: false,
    portalTier: resolved.tier,
    permissions: resolved.permissions,
    leaveBalance: { annual: 12, sick: 8, casual: 6 },
    customFields,
    status: 'active',
    joinedAt: serverTimestamp(),
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });

  batch.set(doc(db, 'organizations', orgId, 'qrTokens', qrTokenId), {
    tokenId: qrTokenId,
    orgId,
    memberUid: uid,
    memberPublicId,
    active: true,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });

  await batch.commit();
  await logOrgAudit({
    orgId,
    action: 'CREATE_MEMBER',
    entityType: 'members',
    entityId: uid,
    details: `Provisioned ${cleanName} (${memberPublicId}) as ${designationName}`,
    after: { uid, memberPublicId, email: cleanEmail, designationId, departmentId, branchId },
  });

  return { uid, memberPublicId, qrTokenId };
}

export async function updateOrgMemberHierarchy(orgId, memberUid, patch, before = null, designations = []) {
  const updates = { ...patch };
  if (patch.designationId && designations.length > 0) {
    const desObj = designations.find((d) => d.id === patch.designationId);
    if (desObj) {
      updates.designationName = desObj.name;
      const resolved = resolveMembershipPermissions(
        { status: 'active', isOwner: Boolean(before?.isOwner), permissions: desObj.permissions },
        desObj
      );
      updates.portalTier = resolved.tier;
      updates.permissions = resolved.permissions;
    }
  }
  await updateOrgDoc(orgId, 'members', memberUid, updates);

  const membershipPatch = {};
  if (updates.designationId !== undefined) membershipPatch.designationId = updates.designationId;
  if (updates.designationName !== undefined) membershipPatch.designationName = updates.designationName;
  if (updates.branchId !== undefined) membershipPatch.branchId = updates.branchId;
  if (updates.departmentId !== undefined) membershipPatch.departmentId = updates.departmentId;
  if (updates.portalTier !== undefined) membershipPatch.portalTier = updates.portalTier;
  if (updates.permissions !== undefined) membershipPatch.permissions = updates.permissions;
  if (updates.status !== undefined) membershipPatch.status = updates.status;

  if (Object.keys(membershipPatch).length > 0) {
    await updateDoc(doc(db, 'users', memberUid, 'memberships', orgId), {
      ...membershipPatch,
      updatedAt: serverTimestamp(),
    });
  }

  await logOrgAudit({
    orgId,
    action: 'UPDATE_MEMBER',
    entityType: 'members',
    entityId: memberUid,
    details: `Updated member hierarchy/status`,
    before,
    after: updates,
  });
}

export async function revokeAndRegenerateMemberQr(orgId, member) {
  const newTokenId = generateOpaqueQrToken();
  const oldTokenId = member.qrTokenId;
  const batch = writeBatch(db);

  if (oldTokenId) {
    const oldTokenRef = doc(db, 'organizations', orgId, 'qrTokens', oldTokenId);
    const oldTokenSnap = await getDoc(oldTokenRef).catch(() => null);
    if (oldTokenSnap?.exists()) {
      batch.update(oldTokenRef, {
        active: false,
        revokedAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    }
  }

  batch.set(doc(db, 'organizations', orgId, 'qrTokens', newTokenId), {
    tokenId: newTokenId,
    orgId,
    memberUid: member.uid,
    memberPublicId: member.memberPublicId,
    active: true,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });

  batch.update(doc(db, 'organizations', orgId, 'members', member.uid), {
    qrTokenId: newTokenId,
    updatedAt: serverTimestamp(),
  });

  await batch.commit();
  await logOrgAudit({
    orgId,
    action: 'ROTATE_MEMBER_QR',
    entityType: 'qrTokens',
    entityId: member.uid,
    details: `Revoked prior QR token and issued fresh token for ${member.memberPublicId}`,
  });
  return newTokenId;
}

/**
 * Builds an acyclic hierarchical tree of members based on parentMemberId.
 */
export function buildOrgHierarchyTree(members = []) {
  const byId = new Map(members.map((m) => [m.uid, { ...m, children: [] }]));
  const roots = [];

  for (const node of byId.values()) {
    const parentId = node.parentMemberId;
    if (parentId && parentId !== node.uid && byId.has(parentId)) {
      byId.get(parentId).children.push(node);
    } else {
      roots.push(node);
    }
  }

  const sortChildren = (list) => {
    list.sort((a, b) => (a.isOwner ? -1 : b.isOwner ? 1 : a.name.localeCompare(b.name)));
    list.forEach((n) => sortChildren(n.children));
  };
  sortChildren(roots);
  return roots;
}

/**
 * Collects all subordinate member UIDs under a manager UID (transitive).
 */
export function getSubordinateUids(members = [], managerUid) {
  const childrenByParent = new Map();
  for (const m of members) {
    if (!m.parentMemberId) continue;
    const arr = childrenByParent.get(m.parentMemberId) || [];
    arr.push(m.uid);
    childrenByParent.set(m.parentMemberId, arr);
  }
  const visited = new Set([managerUid]);
  const queue = [managerUid];
  while (queue.length > 0) {
    const curr = queue.shift();
    for (const childUid of childrenByParent.get(curr) || []) {
      if (!visited.has(childUid)) {
        visited.add(childUid);
        queue.push(childUid);
      }
    }
  }
  return visited;
}

/**
 * Filters org members strictly according to a manager's verified scope & assignments.
 */
export function filterMembersByManagerScope(allMembers = [], currentMember, permissions) {
  if (!permissions) return [];
  if (permissions.scope === 'org' || currentMember?.isOwner) {
    return allMembers;
  }
  if (permissions.scope === 'branch' && currentMember?.branchId) {
    return allMembers.filter((m) => m.branchId === currentMember.branchId);
  }
  if (permissions.scope === 'department' && currentMember?.departmentId) {
    return allMembers.filter((m) => m.departmentId === currentMember.departmentId);
  }
  const subUids = getSubordinateUids(allMembers, currentMember?.uid);
  return allMembers.filter((m) => subUids.has(m.uid));
}

/**
 * Parses and validates a CSV string for Bulk Member Import.
 * Expected columns: name,email,externalId,phone,designation,department,branch,tempPassword
 */
export function parseBulkMembersCsv(csvText, existingMembers = []) {
  const lines = String(csvText || '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

  if (lines.length < 2) {
    return { validRows: [], errors: [{ row: 0, message: 'CSV must include a header row and at least one member row.' }] };
  }

  const splitCsvLine = (line) => {
    const cols = [];
    let cur = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        inQuotes = !inQuotes;
      } else if (ch === ',' && !inQuotes) {
        cols.push(cur.trim());
        cur = '';
      } else {
        cur += ch;
      }
    }
    cols.push(cur.trim());
    return cols;
  };

  const headers = splitCsvLine(lines[0]).map((h) => h.toLowerCase().replace(/[^a-z0-9]/g, ''));
  const idx = (names) => headers.findIndex((h) => names.includes(h));

  const nameIdx = idx(['name', 'fullname', 'membername']);
  const emailIdx = idx(['email', 'emailaddress']);
  const extIdx = idx(['externalid', 'rollno', 'rollnumber', 'employeeid', 'id', 'code']);
  const phoneIdx = idx(['phone', 'mobile', 'phonenumber']);
  const desIdx = idx(['designation', 'role', 'title']);
  const deptIdx = idx(['department', 'dept']);
  const branchIdx = idx(['branch', 'campus', 'office']);
  const passIdx = idx(['password', 'temppassword', 'initialpassword']);

  if (nameIdx === -1 || emailIdx === -1) {
    return {
      validRows: [],
      errors: [{ row: 1, message: 'CSV header must contain at least "name" and "email" columns.' }],
    };
  }

  const existingEmails = new Set(existingMembers.map((m) => String(m.email || '').toLowerCase()));
  const existingExtIds = new Set(
    existingMembers.map((m) => String(m.externalId || '').trim().toLowerCase()).filter(Boolean)
  );
  const seenEmails = new Set();
  const seenExtIds = new Set();

  const validRows = [];
  const errors = [];

  for (let i = 1; i < lines.length; i++) {
    const rowNum = i + 1;
    const cols = splitCsvLine(lines[i]);
    const name = cols[nameIdx] || '';
    const email = (cols[emailIdx] || '').toLowerCase();
    const externalId = extIdx >= 0 ? cols[extIdx] || '' : '';
    const phone = phoneIdx >= 0 ? cols[phoneIdx] || '' : '';
    const designationName = desIdx >= 0 ? cols[desIdx] || '' : '';
    const departmentName = deptIdx >= 0 ? cols[deptIdx] || '' : '';
    const branchName = branchIdx >= 0 ? cols[branchIdx] || '' : '';
    const password = passIdx >= 0 && cols[passIdx] ? cols[passIdx] : `Smart@${Math.floor(100000 + Math.random() * 899999)}`;

    if (!name || name.length < 2) {
      errors.push({ row: rowNum, message: 'Missing or invalid member name.' });
      continue;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      errors.push({ row: rowNum, message: `Invalid email "${email}".` });
      continue;
    }
    if (password.length < 6) {
      errors.push({ row: rowNum, message: `Password for ${email} must be at least 6 characters.` });
      continue;
    }
    if (existingEmails.has(email) || seenEmails.has(email)) {
      errors.push({ row: rowNum, message: `Duplicate email "${email}".` });
      continue;
    }
    if (externalId) {
      const extKey = externalId.toLowerCase();
      if (existingExtIds.has(extKey) || seenExtIds.has(extKey)) {
        errors.push({ row: rowNum, message: `Duplicate Roll/Employee ID "${externalId}".` });
        continue;
      }
      seenExtIds.add(extKey);
    }
    seenEmails.add(email);
    validRows.push({
      rowNum,
      name,
      email,
      externalId,
      phone,
      designationName,
      departmentName,
      branchName,
      password,
    });
  }

  return { validRows, errors };
}

export { deleteOrgDoc };
