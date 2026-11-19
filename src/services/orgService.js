import {
  collection,
  doc,
  getDoc,
  getDocs,
  setDoc,
  updateDoc,
  addDoc,
  query,
  where,
  serverTimestamp,
  writeBatch,
} from 'firebase/firestore';
import { db } from '../firebase/config.js';
import {
  DEFAULT_ATTENDANCE_POLICY,
} from '../utils/attendanceMath.js';
import {
  generateOrgId,
  generateMemberPublicId,
  generateOpaqueQrToken,
} from '../utils/orgIds.js';
import {
  DEFAULT_PERMISSIONS_OWNER,
  DEFAULT_PERMISSIONS_MEMBER,
  resolveMembershipPermissions,
} from '../utils/authRouting.js';
import { fetchOrgCollection, logOrgAudit, updateOrgDoc, createOrgNotification } from './firestoreService.js';

export const ORG_TYPES = Object.freeze([
  { id: 'school', label: 'School', memberLabel: 'Student', idFieldLabel: 'Roll / Admission No.' },
  { id: 'college', label: 'College', memberLabel: 'Student', idFieldLabel: 'Roll / Reg No.' },
  { id: 'university', label: 'University', memberLabel: 'Student', idFieldLabel: 'University ID / Roll No.' },
  { id: 'coaching', label: 'Coaching Institute', memberLabel: 'Student', idFieldLabel: 'Batch Roll No.' },
  { id: 'training', label: 'Training Center', memberLabel: 'Trainee', idFieldLabel: 'Trainee ID' },
  { id: 'company', label: 'Private Company', memberLabel: 'Employee', idFieldLabel: 'Employee ID' },
  { id: 'office', label: 'Corporate Office', memberLabel: 'Employee', idFieldLabel: 'Employee ID' },
  { id: 'startup', label: 'Startup / Tech Team', memberLabel: 'Team Member', idFieldLabel: 'Member Code' },
  { id: 'factory', label: 'Factory / Operations', memberLabel: 'Worker', idFieldLabel: 'Badge / Shift ID' },
  { id: 'other', label: 'Other Organization', memberLabel: 'Member', idFieldLabel: 'Reference ID' },
]);

export const SUBSCRIPTION_PLANS = Object.freeze({
  free: {
    id: 'free',
    name: 'Starter Free',
    priceMonthly: '$0',
    maxMembers: 50,
    maxBranches: 1,
    features: ['Up to 50 active members', '1 Branch workspace', 'Custom hierarchy & QR attendance', 'CSV/Excel/PDF exports'],
  },
  pro: {
    id: 'pro',
    name: 'Growth Pro',
    priceMonthly: '$29',
    maxMembers: 1000,
    maxBranches: 10,
    features: ['Up to 1,000 members', '10 Branches & geofencing', 'Multi-shift & overtime policies', 'Full audit trails & CSV import'],
  },
  enterprise: {
    id: 'enterprise',
    name: 'Enterprise',
    priceMonthly: 'Custom',
    maxMembers: 100000,
    maxBranches: 500,
    features: ['Unlimited members & branches', 'Dedicated Cloud Functions enforcement', 'App Check & custom SLA', 'Full JSON/CSV compliance backups'],
  },
});

export function getOrgTypeMeta(typeId) {
  return ORG_TYPES.find((t) => t.id === typeId) || ORG_TYPES[ORG_TYPES.length - 1];
}

export async function provisionOrganizationDocuments({
  ownerUid,
  ownerName,
  ownerEmail,
  orgName,
  orgType = 'company',
  country = 'India',
  timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
  phone = '',
  address = '',
  description = '',
  emailVerified = false,
}) {
  const orgId = generateOrgId();
  const memberPublicId = generateMemberPublicId(orgId);
  const qrTokenId = generateOpaqueQrToken();
  const typeMeta = getOrgTypeMeta(orgType);

  const ownerDesId = 'des_owner';
  const managerDesId = 'des_manager';
  const memberDesId = 'des_member';
  const defaultDeptId = 'dept_general';
  const defaultBranchId = 'branch_hq';
  const defaultShiftId = 'shift_standard';

  const managerLabel = ['school', 'college', 'university', 'coaching', 'training'].includes(orgType)
    ? 'Coordinator / Instructor'
    : 'Department Manager';
  const memberLabel = typeMeta.memberLabel;

  const batch = writeBatch(db);

  // 1. Organization Root Document
  batch.set(doc(db, 'organizations', orgId), {
    orgId,
    name: orgName.trim(),
    type: orgType,
    email: ownerEmail.trim().toLowerCase(),
    phone: phone.trim(),
    address: address.trim(),
    country: country.trim() || 'India',
    timezone: timezone.trim() || 'UTC',
    logoUrl: '',
    description: description.trim(),
    ownerUid,
    plan: 'free',
    subscriptionStatus: 'active',
    memberLimit: SUBSCRIPTION_PLANS.free.maxMembers,
    branchLimit: SUBSCRIPTION_PLANS.free.maxBranches,
    policies: {
      ...DEFAULT_ATTENDANCE_POLICY,
      allowSelfCheckIn: false,
      allowMemberJoinRequests: true,
      requireJoinApproval: true,
      geofence: {
        enabled: false,
        lat: 0,
        lng: 0,
        radiusMeters: 150,
      },
      useCloudFunctions: false,
    },
    status: 'active',
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });

  // 2. Default Branch
  batch.set(doc(db, 'organizations', orgId, 'branches', defaultBranchId), {
    id: defaultBranchId,
    orgId,
    name: 'Headquarters / Main Campus',
    code: 'HQ-01',
    address: address.trim(),
    managerUid: ownerUid,
    geofence: { enabled: false, lat: 0, lng: 0, radiusMeters: 150 },
    status: 'active',
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });

  // 3. Default Department
  batch.set(doc(db, 'organizations', orgId, 'departments', defaultDeptId), {
    id: defaultDeptId,
    orgId,
    name: 'General Administration',
    code: 'GEN',
    branchId: defaultBranchId,
    headUid: ownerUid,
    description: 'Primary administrative department',
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });

  // 4. Default Shift
  batch.set(doc(db, 'organizations', orgId, 'shifts', defaultShiftId), {
    id: defaultShiftId,
    orgId,
    name: 'Standard Day Shift',
    startTime: '09:00',
    endTime: '17:00',
    lateGraceMinutes: 15,
    halfDayThresholdMinutes: 240,
    isDefault: true,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });

  // 5. Default Designations (Owner, Manager, Member) — fully editable & expandable
  batch.set(doc(db, 'organizations', orgId, 'designations', ownerDesId), {
    id: ownerDesId,
    orgId,
    name: 'Organization Owner / Head',
    level: 1,
    parentDesignationId: '',
    isSystemOwner: true,
    permissions: { ...DEFAULT_PERMISSIONS_OWNER },
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });

  batch.set(doc(db, 'organizations', orgId, 'designations', managerDesId), {
    id: managerDesId,
    orgId,
    name: managerLabel,
    level: 2,
    parentDesignationId: ownerDesId,
    isSystemOwner: false,
    permissions: {
      ...DEFAULT_PERMISSIONS_MEMBER,
      canTakeAttendance: true,
      canEditAttendance: true,
      canApproveLeaves: true,
      canApproveCorrections: true,
      canViewReports: true,
      canManageMembers: false,
      scope: 'department',
    },
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });

  batch.set(doc(db, 'organizations', orgId, 'designations', memberDesId), {
    id: memberDesId,
    orgId,
    name: memberLabel,
    level: 3,
    parentDesignationId: managerDesId,
    isSystemOwner: false,
    permissions: { ...DEFAULT_PERMISSIONS_MEMBER },
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });

  // 6. Owner Member Document inside Org
  batch.set(doc(db, 'organizations', orgId, 'members', ownerUid), {
    uid: ownerUid,
    orgId,
    memberPublicId,
    externalId: 'OWNER-001',
    name: ownerName.trim(),
    email: ownerEmail.trim().toLowerCase(),
    phone: phone.trim(),
    designationId: ownerDesId,
    designationName: 'Organization Owner / Head',
    branchId: defaultBranchId,
    departmentId: defaultDeptId,
    shiftId: defaultShiftId,
    parentMemberId: '',
    qrTokenId,
    isOwner: true,
    portalTier: 'owner',
    permissions: { ...DEFAULT_PERMISSIONS_OWNER },
    leaveBalance: { annual: 20, sick: 10, casual: 10 },
    customFields: {},
    status: 'active',
    joinedAt: serverTimestamp(),
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });

  // 7. Opaque Revocable QR Token Document (Zero PII stored in QR string)
  batch.set(doc(db, 'organizations', orgId, 'qrTokens', qrTokenId), {
    tokenId: qrTokenId,
    orgId,
    memberUid: ownerUid,
    memberPublicId,
    active: true,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });

  // 8. Global User Profile & Trusted Membership Lookup (users/{uid}/memberships/{orgId})
  batch.set(
    doc(db, 'users', ownerUid),
    {
      uid: ownerUid,
      name: ownerName.trim(),
      email: ownerEmail.trim().toLowerCase(),
      avatarUrl: '',
      emailVerified,
      lastActiveOrgId: orgId,
      status: 'active',
      updatedAt: serverTimestamp(),
    },
    { merge: true }
  );

  batch.set(doc(db, 'users', ownerUid, 'memberships', orgId), {
    orgId,
    orgName: orgName.trim(),
    orgType,
    uid: ownerUid,
    memberPublicId,
    designationId: ownerDesId,
    designationName: 'Organization Owner / Head',
    branchId: defaultBranchId,
    departmentId: defaultDeptId,
    isOwner: true,
    portalTier: 'owner',
    permissions: { ...DEFAULT_PERMISSIONS_OWNER },
    status: 'active',
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });

  // 9. Initial Immutable Audit Log
  batch.set(doc(collection(db, 'organizations', orgId, 'auditLogs')), {
    orgId,
    actorUid: ownerUid,
    actorEmail: ownerEmail.trim().toLowerCase(),
    actorName: ownerName.trim(),
    actorDesignation: 'Organization Owner / Head',
    action: 'CREATE_ORGANIZATION',
    entityType: 'organizations',
    entityId: orgId,
    details: `Created ${typeMeta.label} workspace "${orgName.trim()}" (${orgId})`,
    before: '',
    after: JSON.stringify({ orgId, orgName: orgName.trim(), orgType, plan: 'free' }),
    timestamp: serverTimestamp(),
  });

  await batch.commit();
  return { orgId, memberPublicId, qrTokenId };
}

export async function fetchUserProfileAndMemberships(uid) {
  if (!uid) return { userProfile: null, memberships: [] };
  const userSnap = await getDoc(doc(db, 'users', uid));
  const userProfile = userSnap.exists() ? { id: userSnap.id, ...userSnap.data() } : null;

  const memSnap = await getDocs(collection(db, 'users', uid, 'memberships'));
  const memberships = memSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
  return { userProfile, memberships };
}

export async function loadOrganizationContext(uid, orgId) {
  const [orgSnap, membershipSnap, memberSnap] = await Promise.all([
    getDoc(doc(db, 'organizations', orgId)),
    getDoc(doc(db, 'users', uid, 'memberships', orgId)),
    getDoc(doc(db, 'organizations', orgId, 'members', uid)),
  ]);

  if (!orgSnap.exists()) {
    throw new Error(`Organization (${orgId}) no longer exists.`);
  }
  if (!membershipSnap.exists()) {
    throw new Error(`You are not authorized to access organization ${orgId}.`);
  }

  const activeOrg = { id: orgSnap.id, ...orgSnap.data() };
  const activeMembership = { id: membershipSnap.id, ...membershipSnap.data() };
  const activeMember = memberSnap.exists() ? { id: memberSnap.id, ...memberSnap.data() } : null;

  if (activeMembership.status === 'pending') {
    throw new Error(`Your join request for "${activeOrg.name}" is awaiting administrator approval.`);
  }
  if (activeMembership.status !== 'active' || (activeMember && activeMember.status !== 'active')) {
    throw new Error(`Your membership in "${activeOrg.name}" is inactive or suspended.`);
  }

  let activeDesignation = null;
  const desId = activeMember?.designationId || activeMembership.designationId;
  if (desId) {
    const desSnap = await getDoc(doc(db, 'organizations', orgId, 'designations', desId));
    if (desSnap.exists()) {
      activeDesignation = { id: desSnap.id, ...desSnap.data() };
    }
  }

  const resolved = resolveMembershipPermissions(activeMembership, activeDesignation, activeMember);

  // Remember user's last active org
  await updateDoc(doc(db, 'users', uid), { lastActiveOrgId: orgId }).catch(() => {});

  return {
    activeOrg,
    activeMembership,
    activeMember,
    activeDesignation,
    resolvedTier: resolved.tier,
    resolvedPermissions: resolved.permissions,
    settings: {
      ...DEFAULT_ATTENDANCE_POLICY,
      ...(activeOrg.policies || {}),
    },
  };
}

export async function updateOrganizationPolicies(orgId, patch, beforeSnapshot) {
  await updateDoc(doc(db, 'organizations', orgId), {
    ...patch,
    updatedAt: serverTimestamp(),
  });
  await logOrgAudit({
    orgId,
    action: 'UPDATE_ORG_SETTINGS',
    entityType: 'organizations',
    entityId: orgId,
    details: 'Updated organization profile or attendance policies',
    before: beforeSnapshot,
    after: patch,
  });
}

export async function createOrgInvitation(orgId, { email, designationId, designationName, departmentId = '', branchId = '', createdByUid }) {
  const inviteCode = generateOpaqueQrToken().slice(0, 10).toUpperCase();
  const payload = {
    orgId,
    inviteCode,
    email: String(email || '').trim().toLowerCase(),
    designationId,
    designationName,
    departmentId,
    branchId,
    status: 'pending',
    createdByUid,
    expiresAtMs: Date.now() + 14 * 24 * 60 * 60 * 1000,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  };
  await setDoc(doc(db, 'organizations', orgId, 'invitations', inviteCode), payload);
  await setDoc(doc(db, 'invitationIndex', inviteCode), {
    inviteCode,
    orgId,
    email: payload.email,
    designationName,
    status: 'pending',
    expiresAtMs: payload.expiresAtMs,
    createdAt: serverTimestamp(),
  });
  await logOrgAudit({
    orgId,
    action: 'CREATE_INVITATION',
    entityType: 'invitations',
    entityId: inviteCode,
    details: `Invited ${email || 'open link'} as ${designationName}`,
  });
  return { inviteCode, ...payload };
}

export async function lookupInvitationByCode(inviteCode) {
  const clean = String(inviteCode || '').trim().toUpperCase();
  if (!clean) throw new Error('Invitation code is required.');
  const idxSnap = await getDoc(doc(db, 'invitationIndex', clean));
  if (!idxSnap.exists()) {
    throw new Error('Invalid or expired invitation code.');
  }
  const idx = idxSnap.data();
  if (idx.status !== 'pending') {
    throw new Error('This invitation has already been used or revoked.');
  }
  if (idx.expiresAtMs && Date.now() > Number(idx.expiresAtMs)) {
    throw new Error('This invitation code has expired.');
  }
  const orgSnap = await getDoc(doc(db, 'organizations', idx.orgId));
  if (!orgSnap.exists()) throw new Error('Target organization not found.');
  return {
    ...idx,
    orgName: orgSnap.data().name,
    orgType: orgSnap.data().type,
  };
}

export async function joinOrganizationWithCodeOrId({
  uid,
  name,
  email,
  phone = '',
  externalId = '',
  inviteCode = '',
  orgIdInput = '',
  emailVerified = false,
}) {
  let targetOrgId = '';
  let status = 'pending';
  let designationId = 'des_member';
  let designationName = 'Member';
  let departmentId = 'dept_general';
  let branchId = 'branch_hq';
  let inviteDoc = null;

  if (inviteCode.trim()) {
    inviteDoc = await lookupInvitationByCode(inviteCode);
    targetOrgId = inviteDoc.orgId;
    const fullInv = await getDoc(doc(db, 'organizations', targetOrgId, 'invitations', inviteDoc.inviteCode));
    if (fullInv.exists()) {
      const d = fullInv.data();
      if (d.email && d.email.toLowerCase() !== email.trim().toLowerCase()) {
        throw new Error(`This invitation was issued specifically for ${d.email}.`);
      }
      designationId = d.designationId || designationId;
      designationName = d.designationName || designationName;
      departmentId = d.departmentId || departmentId;
      branchId = d.branchId || branchId;
    }
    status = 'active';
  } else {
    targetOrgId = orgIdInput.trim().toUpperCase();
    if (!targetOrgId) throw new Error('Provide either an Invitation Code or Organization ID.');
    const orgSnap = await getDoc(doc(db, 'organizations', targetOrgId));
    if (!orgSnap.exists()) throw new Error(`Organization "${targetOrgId}" was not found.`);
    const orgData = orgSnap.data();
    if (orgData.policies?.allowMemberJoinRequests === false) {
      throw new Error('This organization only accepts members via direct invitation.');
    }
    status = orgData.policies?.requireJoinApproval === false ? 'active' : 'pending';
  }

  const orgSnap = await getDoc(doc(db, 'organizations', targetOrgId));
  const orgData = orgSnap.data();
  const memberPublicId = generateMemberPublicId(targetOrgId);
  const qrTokenId = generateOpaqueQrToken();

  const batch = writeBatch(db);
  batch.set(
    doc(db, 'users', uid),
    {
      uid,
      name: name.trim(),
      email: email.trim().toLowerCase(),
      emailVerified,
      lastActiveOrgId: targetOrgId,
      status: 'active',
      updatedAt: serverTimestamp(),
    },
    { merge: true }
  );

  batch.set(doc(db, 'users', uid, 'memberships', targetOrgId), {
    orgId: targetOrgId,
    orgName: orgData.name,
    orgType: orgData.type,
    uid,
    memberPublicId,
    designationId,
    designationName,
    branchId,
    departmentId,
    isOwner: false,
    portalTier: 'member',
    permissions: { ...DEFAULT_PERMISSIONS_MEMBER },
    status,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });

  batch.set(doc(db, 'organizations', targetOrgId, 'members', uid), {
    uid,
    orgId: targetOrgId,
    memberPublicId,
    externalId: externalId.trim() || memberPublicId.slice(-6),
    name: name.trim(),
    email: email.trim().toLowerCase(),
    phone: phone.trim(),
    designationId,
    designationName,
    branchId,
    departmentId,
    shiftId: 'shift_standard',
    parentMemberId: '',
    qrTokenId,
    isOwner: false,
    portalTier: 'member',
    permissions: { ...DEFAULT_PERMISSIONS_MEMBER },
    leaveBalance: { annual: 12, sick: 8, casual: 6 },
    customFields: {},
    status,
    joinedAt: serverTimestamp(),
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });

  batch.set(doc(db, 'organizations', targetOrgId, 'qrTokens', qrTokenId), {
    tokenId: qrTokenId,
    orgId: targetOrgId,
    memberUid: uid,
    memberPublicId,
    active: status === 'active',
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });

  if (inviteDoc) {
    batch.update(doc(db, 'organizations', targetOrgId, 'invitations', inviteDoc.inviteCode), {
      status: 'accepted',
      acceptedByUid: uid,
      updatedAt: serverTimestamp(),
    });
    batch.update(doc(db, 'invitationIndex', inviteDoc.inviteCode), {
      status: 'accepted',
      updatedAt: serverTimestamp(),
    });
  }

  await batch.commit();
  return { orgId: targetOrgId, orgName: orgData.name, status, memberPublicId };
}

export async function reviewPendingMember(orgId, memberUid, decision) {
  const nextStatus = decision === 'approve' ? 'active' : 'rejected';
  const memberSnap = await getDoc(doc(db, 'organizations', orgId, 'members', memberUid));
  if (!memberSnap.exists()) throw new Error('Member record not found.');
  const member = memberSnap.data();

  await updateOrgDoc(orgId, 'members', memberUid, { status: nextStatus });
  await updateDoc(doc(db, 'users', memberUid, 'memberships', orgId), {
    status: nextStatus,
    updatedAt: serverTimestamp(),
  });
  if (member.qrTokenId) {
    await updateOrgDoc(orgId, 'qrTokens', member.qrTokenId, { active: nextStatus === 'active' }).catch(() => {});
  }
  await createOrgNotification({
    orgId,
    userId: memberUid,
    title: decision === 'approve' ? 'Membership Approved' : 'Membership Declined',
    message:
      decision === 'approve'
        ? 'Your organization join request was approved. You can now view your workspace and QR ID.'
        : 'Your organization join request was declined by an administrator.',
    type: 'membership',
  });
  await logOrgAudit({
    orgId,
    action: decision === 'approve' ? 'APPROVE_MEMBER' : 'REJECT_MEMBER',
    entityType: 'members',
    entityId: memberUid,
    details: `${decision === 'approve' ? 'Approved' : 'Rejected'} ${member.name} (${member.email})`,
  });
}

export async function exportFullOrganizationData(orgId) {
  const orgSnap = await getDoc(doc(db, 'organizations', orgId));
  const [
    branches,
    departments,
    designations,
    shifts,
    holidays,
    members,
    attendanceSessions,
    attendanceRecords,
    leaveRequests,
    correctionRequests,
    anomalies,
    auditLogs,
  ] = await Promise.all([
    fetchOrgCollection(orgId, 'branches'),
    fetchOrgCollection(orgId, 'departments'),
    fetchOrgCollection(orgId, 'designations'),
    fetchOrgCollection(orgId, 'shifts'),
    fetchOrgCollection(orgId, 'holidays'),
    fetchOrgCollection(orgId, 'members'),
    fetchOrgCollection(orgId, 'attendanceSessions'),
    fetchOrgCollection(orgId, 'attendanceRecords'),
    fetchOrgCollection(orgId, 'leaveRequests'),
    fetchOrgCollection(orgId, 'correctionRequests'),
    fetchOrgCollection(orgId, 'anomalies'),
    fetchOrgCollection(orgId, 'auditLogs'),
  ]);

  return {
    exportedAt: new Date().toISOString(),
    organization: orgSnap.exists() ? orgSnap.data() : { orgId },
    branches,
    departments,
    designations,
    shifts,
    holidays,
    members,
    attendanceSessions,
    attendanceRecords,
    leaveRequests,
    correctionRequests,
    anomalies,
    auditLogs,
  };
}
