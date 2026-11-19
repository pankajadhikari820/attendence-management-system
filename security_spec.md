# SmartAttend Security Specification

## 1. Core Data Invariants
1. **No Client-Side Role Escalation**: A user creating their own `users/{uid}` document can only assign `role: "student"` (except the designated bootstrapped admin email with verified token). Self-updates cannot alter `role` or `status`.
2. **Email Verification Gate**: All operational reads and writes require `request.auth.token.email_verified == true`.
3. **No Passwords in Firestore**: Passwords are handled exclusively by Firebase Authentication and never written to Firestore.
4. **Deterministic Duplicate Prevention**: Every `attendanceRecords` document ID MUST equal `${sessionId}_${studentUid}`. Duplicate QR scans for the same session fail atomically inside Firestore transactions and rules.
5. **Immutable Audit Trail**: `auditLogs` can only be created with `actorUid == request.auth.uid`, read only by Admins, and never updated or deleted.
6. **PII Isolation**: `users` and `students` documents cannot be listed by students or anonymous callers.

## 2. Adversarial "Dirty Dozen" Payloads (Expected: PERMISSION_DENIED)
1. Unauthenticated read on `/users/{uid}`
2. Unverified email user writing `/attendanceRecords/{id}`
3. Student self-creating `/users/{uid}` with `role: "admin"`
4. Student updating own `/users/{uid}` with `{ role: "teacher" }`
5. Student creating `/attendanceRecords/random_id` (non-deterministic ID)
6. Student creating `/attendanceRecords/{sessionId}_{otherUid}` (identity spoofing)
7. Student creating QR attendance for a closed session (`status == "closed"`)
8. Student updating `/attendanceRecords/{id}` from `absent` to `present`
9. Teacher updating another teacher's `/attendanceSessions/{sessionId}`
10. Student reading `/auditLogs/{logId}`
11. Any user updating or deleting `/auditLogs/{logId}`
12. Student approving their own `/correctionRequests/{id}` (`status: "approved"`)
