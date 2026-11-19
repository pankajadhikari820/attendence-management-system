import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  generateOrgId,
  generateMemberPublicId,
  generateOpaqueQrToken,
  encodeMemberQrPayload,
  parseUniversalQrPayload,
  haversineDistanceMeters,
  evaluateGeofence,
} from '../src/utils/orgIds.js';
import {
  escapeHtml,
  deterministicRecordId,
  deterministicDailyRecordId,
  calculateAttendanceSummary,
  evaluateShiftTiming,
  isDateHolidayOrWeeklyOff,
  calculateShortage,
  paginateItems,
} from '../src/utils/attendanceMath.js';
import {
  DEFAULT_PERMISSIONS_OWNER,
  DEFAULT_PERMISSIONS_MEMBER,
  resolveMembershipPermissions,
  validateUserProfile,
  resolveDashboardRoute,
  parseHashRoute,
} from '../src/utils/authRouting.js';
import {
  buildOrgHierarchyTree,
  getSubordinateUids,
  filterMembersByManagerScope,
  parseBulkMembersCsv,
} from '../src/services/hierarchyService.js';

function testOrgIdsAndZeroPiiQr() {
  const orgA = generateOrgId();
  const orgB = generateOrgId();
  assert.match(orgA, /^ORG-[A-Z0-9]{5}$/);
  assert.notEqual(orgA, orgB);

  const memberPubA = generateMemberPublicId(orgA);
  assert.match(memberPubA, /^SA-ORG[A-Z0-9]{5}-[A-Z0-9]{6}$/);

  const token = generateOpaqueQrToken();
  assert.equal(token.length, 32);

  const qrString = encodeMemberQrPayload(orgA, token);
  const rawObj = JSON.parse(qrString);
  assert.equal(rawObj.v, 2);
  assert.equal(rawObj.type, 'member_id');
  assert.equal(rawObj.orgId, orgA);
  assert.equal(rawObj.token, token);
  assert.equal('email' in rawObj, false);
  assert.equal('phone' in rawObj, false);
  assert.equal('password' in rawObj, false);

  const parsedQr = parseUniversalQrPayload(qrString);
  assert.deepEqual(parsedQr, { kind: 'member_qr', orgId: orgA, token });

  const parsedPublicId = parseUniversalQrPayload(memberPubA.toLowerCase());
  assert.deepEqual(parsedPublicId, { kind: 'member_public_id', memberPublicId: memberPubA });
}

function testCapabilityBasedHierarchyAndRouting() {
  // 1. Owner resolves to owner tier & #/owner/overview
  const ownerResolved = resolveMembershipPermissions({
    status: 'active',
    isOwner: true,
    portalTier: 'owner',
    permissions: DEFAULT_PERMISSIONS_OWNER,
  });
  assert.equal(ownerResolved.tier, 'owner');
  assert.equal(resolveDashboardRoute(ownerResolved.tier, 'u1').hash, '#/owner/overview');

  // 2. Designation named "Manager" WITHOUT elevated capability flags MUST remain base 'member'
  const fakeManagerDesignation = {
    name: 'Manager',
    permissions: { ...DEFAULT_PERMISSIONS_MEMBER },
  };
  const fakeManagerResolved = resolveMembershipPermissions(
    { status: 'active', isOwner: false, portalTier: 'member', permissions: {} },
    fakeManagerDesignation
  );
  assert.equal(fakeManagerResolved.tier, 'member');
  assert.equal(resolveDashboardRoute(fakeManagerResolved.tier, 'u2').hash, '#/member/overview');

  // 3. Custom designation "Floor Supervisor" WITH canTakeAttendance resolves to scoped 'manager'
  const supervisorDes = {
    name: 'Floor Supervisor',
    permissions: { ...DEFAULT_PERMISSIONS_MEMBER, canTakeAttendance: true, scope: 'department' },
  };
  const supervisorResolved = resolveMembershipPermissions(
    { status: 'active', isOwner: false, permissions: {} },
    supervisorDes
  );
  assert.equal(supervisorResolved.tier, 'manager');
  assert.equal(supervisorResolved.permissions.scope, 'department');
  assert.equal(resolveDashboardRoute(supervisorResolved.tier, 'u3').hash, '#/manager/overview');

  // 4. Pending / missing / suspended profile rejections
  assert.throws(
    () => resolveMembershipPermissions({ status: 'pending', isOwner: false }),
    /inactive or pending/i
  );
  assert.throws(() => validateUserProfile(null, 'uid_missing'), /User profile not found/);
  assert.throws(() => validateUserProfile({ status: 'suspended' }, 'uid_susp'), /suspended or inactive/i);
}

function testHierarchyTreeAndManagerScope() {
  const members = [
    { uid: 'u_owner', name: 'CEO', isOwner: true, branchId: 'b_hq', departmentId: 'd_exec', parentMemberId: '' },
    { uid: 'u_mgr_eng', name: 'VP Eng', isOwner: false, branchId: 'b_hq', departmentId: 'd_eng', parentMemberId: 'u_owner' },
    { uid: 'u_lead_fe', name: 'FE Lead', isOwner: false, branchId: 'b_hq', departmentId: 'd_eng', parentMemberId: 'u_mgr_eng' },
    { uid: 'u_dev_1', name: 'Dev One', isOwner: false, branchId: 'b_hq', departmentId: 'd_eng', parentMemberId: 'u_lead_fe' },
    { uid: 'u_sales_1', name: 'Sales Rep', isOwner: false, branchId: 'b_west', departmentId: 'd_sales', parentMemberId: 'u_owner' },
  ];

  const tree = buildOrgHierarchyTree(members);
  assert.equal(tree.length, 1);
  assert.equal(tree[0].uid, 'u_owner');
  assert.equal(tree[0].children.length, 2);

  const subSet = getSubordinateUids(members, 'u_mgr_eng');
  assert.equal(subSet.has('u_mgr_eng'), true);
  assert.equal(subSet.has('u_lead_fe'), true);
  assert.equal(subSet.has('u_dev_1'), true);
  assert.equal(subSet.has('u_sales_1'), false);

  const teamScoped = filterMembersByManagerScope(members, members[1], { scope: 'team' });
  assert.deepEqual(
    teamScoped.map((m) => m.uid).sort(),
    ['u_dev_1', 'u_lead_fe', 'u_mgr_eng']
  );

  const branchScoped = filterMembersByManagerScope(members, members[4], { scope: 'branch' });
  assert.deepEqual(branchScoped.map((m) => m.uid), ['u_sales_1']);
}

function testShiftTimingHolidayAndAttendanceMath() {
  // Check-in 5 mins after 09:00 with 15 min grace -> present
  const day = '2026-10-05'; // Monday
  const checkInOnTime = new Date(`${day}T09:05:00`).getTime();
  const timing1 = evaluateShiftTiming({
    checkInMs: checkInOnTime,
    shiftStart: '09:00',
    shiftEnd: '17:00',
    lateGraceMinutes: 15,
    halfDayThresholdMinutes: 240,
  });
  assert.equal(timing1.status, 'present');
  assert.equal(timing1.lateMinutes, 5);

  // Check-in 25 mins late -> late
  const checkInLate = new Date(`${day}T09:25:00`).getTime();
  const timing2 = evaluateShiftTiming({
    checkInMs: checkInLate,
    shiftStart: '09:00',
    shiftEnd: '17:00',
    lateGraceMinutes: 15,
  });
  assert.equal(timing2.status, 'late');
  assert.equal(timing2.lateMinutes, 25);

  // Check-out after 3 hours (180 mins < 240 threshold) -> half_day
  const checkOutShort = checkInOnTime + 180 * 60000;
  const timing3 = evaluateShiftTiming({
    checkInMs: checkInOnTime,
    checkOutMs: checkOutShort,
    shiftStart: '09:00',
    shiftEnd: '17:00',
    halfDayThresholdMinutes: 240,
  });
  assert.equal(timing3.status, 'half_day');
  assert.equal(timing3.workingMinutes, 180);

  // Check-out after 9.5 hours (570 mins vs 480 planned) -> 90 mins overtime
  const checkOutOt = checkInOnTime + 570 * 60000;
  const timing4 = evaluateShiftTiming({
    checkInMs: checkInOnTime,
    checkOutMs: checkOutOt,
    shiftStart: '09:00',
    shiftEnd: '17:00',
    halfDayThresholdMinutes: 240,
  });
  assert.equal(timing4.workingMinutes, 570);
  assert.equal(timing4.overtimeMinutes, 90);

  // Holidays & Weekly Offs must NEVER count as absent
  const offSun = isDateHolidayOrWeeklyOff('2026-10-04', [], [0], 'd_eng'); // Sunday
  assert.equal(offSun.isOff, true);
  assert.equal(offSun.reason, 'weekly_off');

  const offHoliday = isDateHolidayOrWeeklyOff(
    '2026-10-02',
    [{ date: '2026-10-02', title: 'National Holiday', departmentId: 'all' }],
    [0],
    'd_eng'
  );
  assert.equal(offHoliday.isOff, true);
  assert.equal(offHoliday.reason, 'holiday');

  const summary = calculateAttendanceSummary([
    { status: 'present', workingMinutes: 480, overtimeMinutes: 0 },
    { status: 'late', workingMinutes: 460, overtimeMinutes: 0 },
    { status: 'half_day', workingMinutes: 240, overtimeMinutes: 0 },
    { status: 'absent', workingMinutes: 0, overtimeMinutes: 0 },
    { status: 'on_leave', workingMinutes: 0, overtimeMinutes: 0 },
    { status: 'holiday', workingMinutes: 0, overtimeMinutes: 0 },
    { status: 'weekly_off', workingMinutes: 0, overtimeMinutes: 0 },
  ]);
  // workingDaysRecorded = present(1) + late(1) + half_day(1) + absent(1) = 4 (leave/holiday/weekly_off excluded)
  assert.equal(summary.workingDaysRecorded, 4);
  // effectiveAttended = 1 + 1 + 0.5 = 2.5 => 62.5%
  assert.equal(summary.effectiveAttended, 2.5);
  assert.equal(summary.percentage, 62.5);

  const shortage = calculateShortage(1, 4, 75);
  assert.equal(shortage.isBelowThreshold, true);
  assert.equal(shortage.classesNeededToReach, 8);
}

function testBulkCsvImportAndGeofence() {
  const existing = [{ email: 'existing@acme.com', externalId: 'EMP-001' }];
  const csv = [
    'name,email,externalId,phone,designation,department,branch,tempPassword',
    'Aarav Sharma,aarav@acme.com,EMP-002,+9199990001,Engineer,Engineering,HQ,Pass@123',
    'Dup Email,existing@acme.com,EMP-003,,Engineer,Engineering,HQ,Pass@123',
    'Dup Ext,new@acme.com,EMP-001,,Engineer,Engineering,HQ,Pass@123',
    'Short Pass,short@acme.com,EMP-004,,Engineer,Engineering,HQ,123',
    'Valid Two,diya@acme.com,EMP-005,,Manager,Operations,HQ,',
  ].join('\n');

  const res = parseBulkMembersCsv(csv, existing);
  assert.equal(res.validRows.length, 2);
  assert.equal(res.errors.length, 3);
  assert.match(res.errors[0].message, /Duplicate email/i);
  assert.match(res.errors[1].message, /Duplicate Roll\/Employee ID/i);
  assert.match(res.errors[2].message, /at least 6 characters/i);

  // Geofence check
  const cfg = { enabled: true, lat: 28.6139, lng: 77.209, radiusMeters: 150 };
  const inside = evaluateGeofence(cfg, { lat: 28.614, lng: 77.2091 });
  assert.equal(inside.allowed, true);
  assert.ok(haversineDistanceMeters(28.6139, 77.209, 28.614, 77.2091) < 50);

  const outside = evaluateGeofence(cfg, { lat: 28.62, lng: 77.22 });
  assert.equal(outside.allowed, false);
  assert.match(outside.reason, /Outside allowed organization geofence/i);

  const noCoords = evaluateGeofence(cfg, null);
  assert.equal(noCoords.allowed, false);
}

function testRoutesRecordsAndSecurityArtifacts() {
  assert.deepEqual(parseHashRoute(''), { type: 'public', page: 'home', role: null, view: null });
  assert.deepEqual(parseHashRoute('#/pricing'), { type: 'public', page: 'pricing', role: null, view: null });
  assert.deepEqual(parseHashRoute('#/privacy'), { type: 'public', page: 'privacy', role: null, view: null });
  assert.deepEqual(parseHashRoute('#/org-register'), { type: 'auth', page: 'org-register', role: null, view: null });
  assert.deepEqual(parseHashRoute('#/join/ABC12345'), {
    type: 'auth',
    page: 'join',
    inviteCode: 'abc12345',
    role: null,
    view: null,
  });
  assert.deepEqual(parseHashRoute('#/owner/hierarchy'), { type: 'dashboard', role: 'owner', view: 'hierarchy' });

  assert.equal(deterministicDailyRecordId('2026-10-05', 'daily', 'uid1'), '2026-10-05__daily__uid1');
  assert.equal(deterministicRecordId('sess_1', 'uid1'), 'sess_1_uid1');

  const paged = paginateItems(Array.from({ length: 25 }, (_, i) => i + 1), 2, 10);
  assert.equal(paged.totalPages, 3);
  assert.equal(paged.items[0], 11);

  assert.equal(escapeHtml('<script>alert("xss")</script>'), '&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;');

  // Verify security rules & PWA artifacts exist with critical tenant guards
  const rules = fs.readFileSync('firestore.rules', 'utf8');
  assert.match(rules, /match \/organizations\/\{orgId\}/);
  assert.match(rules, /isVerifiedMemberOfOrg\(orgId\)/);
  assert.match(rules, /allow list: if false/);
  assert.match(rules, /allow update, delete: if false/);

  const manifest = JSON.parse(fs.readFileSync('public/manifest.webmanifest', 'utf8'));
  assert.equal(manifest.name, 'SmartAttend — Universal Attendance SaaS');
  assert.ok(Array.isArray(manifest.icons) && manifest.icons.length >= 3);
  assert.equal(fs.existsSync('public/sw.js'), true);
  assert.equal(fs.existsSync('public/pwa-192x192.png'), true);
  assert.equal(fs.existsSync('public/pwa-512x512.png'), true);

  const firebaseCfg = fs.readFileSync('src/firebase/config.js', 'utf8');
  assert.doesNotMatch(firebaseCfg, /firebase\/app-check/);
  assert.doesNotMatch(firebaseCfg, /initializeAppCheck/);
  assert.doesNotMatch(firebaseCfg, /ReCaptchaEnterpriseProvider|ReCaptchaV3Provider/);
  assert.doesNotMatch(firebaseCfg, /VITE_FIREBASE_APPCHECK|VITE_RECAPTCHA/);
  assert.match(firebaseCfg, /getApps\(\)\.find\(\(a\) => a\.name === '\[DEFAULT\]'\)/);
  assert.match(firebaseCfg, /export const auth = getAuth\(app\);/);

  // Verify org creation sequencing & firestore.rules bootstrap permissions
  assert.match(rules, /function isOrgCreator\(orgId\)/);
  assert.match(rules, /\(isOrgCreator\(orgId\) && incoming\(\)\.orgId == orgId\)/);
  assert.match(rules, /isOrgCreator\(orgId\) \|\| isVerifiedMemberOfOrg\(orgId\)/);

  const orgServiceSrc = fs.readFileSync('src/services/orgService.js', 'utf8');
  const step1Idx = orgServiceSrc.indexOf('await ensureGlobalUserProfile(');
  const step2Idx = orgServiceSrc.indexOf("await setDoc(doc(db, 'organizations', orgId)");
  const step3Idx = orgServiceSrc.indexOf('const batch = writeBatch(db);', step2Idx);
  assert.ok(step1Idx > 0 && step2Idx > step1Idx && step3Idx > step2Idx, 'Org creation must order user profile -> org root -> subcollections batch');
}

testOrgIdsAndZeroPiiQr();
testCapabilityBasedHierarchyAndRouting();
testHierarchyTreeAndManagerScope();
testShiftTimingHolidayAndAttendanceMath();
testBulkCsvImportAndGeofence();
testRoutesRecordsAndSecurityArtifacts();

console.log('All SmartAttend multi-tenant SaaS workflow, hierarchy, QR security, policy, and PWA checks passed.');
