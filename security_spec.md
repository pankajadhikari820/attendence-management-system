# SmartAttend Multi-Tenant Security Specification

## 1. Core Security Invariants
1. **Strict Multi-Organization Tenant Isolation**: All operational data (members, branches, departments, designations, shifts, holidays, QR tokens, sessions, records, leave requests, correction requests, notifications, anomalies, audit logs) is strictly nested under `organizations/{orgId}/...`. Every Firestore read/write checks `isVerifiedMemberOfOrg(orgId)` against the caller's trusted `users/{uid}/memberships/{orgId}` document.
2. **Capability-Based Access Control (Never Label-Based)**: Designations are user-customizable labels (`Manager`, `Team Lead`, `Faculty`, etc.). Both `firestore.rules` (`hasOrgPerm(orgId, permKey)`) and `resolveMembershipPermissions()` verify explicit boolean permission flags (`canTakeAttendance`, `canManageMembers`, `canApproveLeaves`, etc.), never designation names.
3. **No Client-Side Privilege Escalation**:
   - Users self-joining an organization can only create `users/{uid}/memberships/{orgId}` and `organizations/{orgId}/members/{uid}` locked to `isOwner: false`, `portalTier: 'member'`, and `canManageOrg: false, canManageMembers: false, canTakeAttendance: false`.
   - Members updating their own `members/{memberUid}` document are restricted to `['name', 'phone', 'qrTokenId', 'updatedAt']` and cannot alter `status`, `designationId`, `portalTier`, or `isOwner`.
4. **Email Verification Gate**: All operational organization reads and writes require `request.auth.token.email_verified == true`.
5. **Opaque Revocable Member QR Tokens**: Member QR codes contain only `{ v: 2, app: 'SmartAttend', type: 'member_id', orgId, token }` — zero PII (no email, phone, or password). Cross-organization QR scans and revoked tokens are rejected and logged in `anomalies`.
6. **Deterministic Attendance Records**: Daily/session records use deterministic IDs (`{date}__{scope}__{memberUid}`) inside Firestore transactions to guarantee atomic duplicate rejection.
7. **Immutable Audit Logs**: `organizations/{orgId}/auditLogs/{logId}` requires `actorUid == request.auth.uid`, is readable only by Owners/Admins with `canViewAuditLogs`, and denies all updates and deletes.
8. **No Passwords in Firestore**: Passwords remain strictly in Firebase Authentication.

## 2. Adversarial Payloads Blocked by Rules (`PERMISSION_DENIED`)
1. Unauthenticated read on `/organizations/{orgId}` or `/users/{uid}`.
2. Unverified email user writing `/organizations/{orgId}/attendanceRecords/{id}`.
3. User from Org A reading or scanning members/records in Org B.
4. Member self-joining with `isOwner: true` or `canTakeAttendance: true`.
5. Member updating their own `designationId` or `portalTier` in `/members/{uid}`.
6. Standard Member reading `/organizations/{orgId}/auditLogs/{logId}`.
7. Any user updating or deleting `/organizations/{orgId}/auditLogs/{logId}`.
8. Member approving their own `/leaveRequests/{id}` or `/correctionRequests/{id}`.
9. Global listing of `/organizations` or `/users` or `/invitationIndex` to prevent tenant scraping.
