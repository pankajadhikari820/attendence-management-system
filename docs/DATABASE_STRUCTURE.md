# SmartAttend — Multi-Tenant Database Structure

SmartAttend uses **Cloud Firestore** as the primary multi-tenant system of record and **Firebase Realtime Database** exclusively for ephemeral live scan streams (`orgLive/{orgId}/...`).

---

## 1. Global Root Collections (Firestore)

| Path | Purpose | Access Pattern |
|---|---|---|
| `/users/{uid}` | Global user profile (`name`, `email`, `avatarUrl`, `emailVerified`, `lastActiveOrgId`, `fcmToken`, `status`) | Read/update own doc only (`list` denied) |
| `/users/{uid}/memberships/{orgId}` | Trusted org membership mirror (`orgId`, `orgName`, `portalTier`, `isOwner`, `permissions`, `status`, `designationId`, `branchId`, `departmentId`) | Read own memberships or org admins with `canManageMembers`; self-create locked to `member` tier |
| `/invitationIndex/{inviteCode}` | Invite code -> `{ orgId, email, designationName, status, expiresAtMs }` | `get` by exact code only (`list` denied) |
| `/contactInquiries/{inquiryId}` | Public SaaS landing page contact inquiry submissions | Write-only for valid public form submissions; reads denied client-side |

---

## 2. Tenant-Isolated Organization Collections (`/organizations/{orgId}/...`)

Every organization has a unique `orgId` (`ORG-XXXXX`), enforcing strict tenant isolation:

| Subcollection Path | Description | Key Fields |
|---|---|---|
| `/organizations/{orgId}` | Organization root profile, plan limits & policies | `orgId`, `name`, `type`, `ownerUid`, `plan` (`free`/`pro`/`enterprise`), `memberLimit`, `branchLimit`, `policies` (`thresholdPct`, `lateCountsAsPresent`, `halfDayWeight`, `approvedLeavePolicy`, `weeklyOffDays`, `geofence`, `useCloudFunctions`) |
| `/organizations/{orgId}/branches/{branchId}` | Physical campuses, offices, or factory locations | `name`, `code`, `address`, `managerUid`, `geofence`, `status` |
| `/organizations/{orgId}/departments/{deptId}` | Departments, classes, teams, or divisions | `name`, `code`, `branchId`, `headUid`, `description` |
| `/organizations/{orgId}/designations/{desId}` | Unlimited custom hierarchy roles & capability flags | `name`, `level`, `parentDesignationId`, `isSystemOwner`, `permissions` (`canManageOrg`, `canManageHierarchy`, `canManageMembers`, `canTakeAttendance`, `canEditAttendance`, `canApproveLeaves`, `canApproveCorrections`, `canViewReports`, `canExportData`, `canViewAuditLogs`, `scope`: `org` / `branch` / `department` / `team` / `self`) |
| `/organizations/{orgId}/shifts/{shiftId}` | Work / class shift definitions | `name`, `startTime`, `endTime`, `lateGraceMinutes`, `halfDayThresholdMinutes`, `isDefault` |
| `/organizations/{orgId}/holidays/{holidayId}` | Organization & department-specific holidays | `title`, `date`, `type` (`public`/`org`/`optional`), `departmentId` |
| `/organizations/{orgId}/members/{memberUid}` | Organization member roster & reporting hierarchy | `uid`, `orgId`, `memberPublicId` (`SA-ORGXXXXX-YYYYYY`), `externalId`, `name`, `email`, `phone`, `designationId`, `branchId`, `departmentId`, `shiftId`, `parentMemberId`, `qrTokenId`, `portalTier`, `permissions`, `leaveBalance`, `status` |
| `/organizations/{orgId}/qrTokens/{tokenId}` | Opaque revocable QR token registry (zero PII inside QR) | `tokenId`, `orgId`, `memberUid`, `memberPublicId`, `active`, `revokedAt` |
| `/organizations/{orgId}/invitations/{inviteCode}` | Org onboarding invitations | `inviteCode`, `email`, `designationId`, `departmentId`, `branchId`, `status`, `expiresAtMs` |
| `/organizations/{orgId}/attendanceSessions/{sessionId}` | Named QR / batch attendance sessions | `title`, `branchId`, `departmentId`, `shiftId`, `startedByUid`, `date`, `mode`, `status`, `presentCount`, `lateCount` |
| `/organizations/{orgId}/attendanceRecords/{recordId}` | Deterministic attendance records (`{date}__{scope}__{memberUid}`) | `orgId`, `sessionId`, `date`, `memberUid`, `memberPublicId`, `status` (`present`, `absent`, `late`, `half_day`, `on_leave`, `holiday`, `weekly_off`), `method`, `checkInMs`, `checkOutMs`, `lateMinutes`, `workingMinutes`, `overtimeMinutes`, `markedByUid`, `geofenceDistanceMeters` |
| `/organizations/{orgId}/leaveRequests/{leaveId}` | Leave applications with optional Firebase Storage attachment | `orgId`, `memberUid`, `leaveType`, `startDate`, `endDate`, `reason`, `attachmentUrl`, `status`, `reviewedByUid`, `reviewNote` |
| `/organizations/{orgId}/correctionRequests/{corrId}` | Attendance correction requests with evidence URL | `orgId`, `recordId`, `date`, `memberUid`, `currentStatus`, `requestedStatus`, `reason`, `evidenceUrl`, `status`, `reviewedByUid` |
| `/organizations/{orgId}/notifications/{notifId}` | Per-member notifications inside org | `orgId`, `userId`, `title`, `message`, `type`, `read`, `linkView` |
| `/organizations/{orgId}/anomalies/{anomalyId}` | Scan security anomalies (`cross_org_qr`, `invalid_or_revoked_qr`, `duplicate_scan`, `geofence_violation`) | `orgId`, `type`, `scannerUid`, `memberUid`, `details`, `resolved` |
| `/organizations/{orgId}/auditLogs/{logId}` | Append-only operational audit trail | `orgId`, `actorUid`, `actorEmail`, `actorName`, `action`, `entityType`, `entityId`, `details`, `before`, `after`, `timestamp` |

---

## 3. Firebase Realtime Database (`orgLive`)

- `/orgLive/{orgId}/sessions/{sessionId}` — Ephemeral active/closed session metadata.
- `/orgLive/{orgId}/recentScans/{memberUid}` — Live scanner check-in/out feed updates.

## 4. Firebase Storage Buckets

- `/avatars/{uid}/{fileName}` — User profile photos (<= 5MB images).
- `/orgs/{orgId}/logos/{logoOwner}/{fileName}` — Organization logos (<= 5MB images).
- `/orgs/{orgId}/leave-attachments/{uid}/{fileName}` — Supporting leave documents (<= 5MB image/PDF).
- `/orgs/{orgId}/correction-evidence/{uid}/{fileName}` — Attendance correction proof (<= 5MB image/PDF).
