# SmartAttend Multi-Tenant SaaS — End-to-End Verification Checklist

## Automated Unit & Integration Tests (`npm test`)

Executed via `node tests/workflow.test.mjs`:

1. **Org Registration & Role Routing**: Verifies Owner workspace resolution (`#/owner/overview`), pending/inactive rejection, and missing profile error reporting.
2. **Unique Identifiers & Zero-PII QR Payloads**: Confirms unique `ORG-XXXXX`, `SA-ORGXXXXX-YYYYYY`, and `{ v: 2, type: 'member_id', orgId, token }` payloads omit all personal details (email, phone, password).
3. **Capability-Based Hierarchy Enforcement**: Confirms a custom designation named `"Department Manager"` without capability flags resolves strictly to `member` tier, while explicit `canTakeAttendance` resolves to scoped `manager`.
4. **Cross-Organization QR Isolation**: Confirms `parseUniversalQrPayload()` detects mismatched `orgId` values so Org B rejects Org A QR codes.
5. **Manager Hierarchy Scope Filtering**: Verifies `filterMembersByManagerScope()` for `org`, `branch`, `department`, and transitive `team` (`parentMemberId`) reporting trees.
6. **Duplicate Scan & Deterministic Record Keys**: Verifies `deterministicDailyRecordId()` guarantees one record per member per day/session and rejects duplicate check-ins.
7. **Shift Timing Engine (Check-In / Check-Out / Overtime)**: Verifies grace period `present` vs `late`, short duration `half_day`, and `overtimeMinutes`.
8. **Holiday & Weekly-Off Exclusion**: Verifies `isDateHolidayOrWeeklyOff()` and `calculateAttendanceSummary()` never penalize holidays, weekly offs, or neutral approved leaves as absences.
9. **Attendance Shortage Calculator**: Verifies recovery sessions needed and safe absences remaining across thresholds.
10. **CSV Bulk Member Import Validation**: Verifies header mapping, email validation, and intra-batch/existing Roll/Employee ID duplicate rejection via `parseBulkMembersCsv()`.
11. **Geofencing Haversine Boundary Math**: Verifies inside-radius allowance, outside-radius blocking, and missing-coordinates rejection.
12. **Public SaaS, Auth & Workspace Hash Routing**: Verifies `#/`, `#/features`, `#/pricing`, `#/contact`, `#/privacy`, `#/terms`, `#/login`, `#/org-register`, `#/join/CODE`, `#/select-org`, and workspace routes.
13. **Pagination & XSS Escaping**: Verifies deterministic paging and HTML character escaping.
14. **Security Rules Structural Verification**: Asserts `firestore.rules` enforces default-deny, `email_verified`, tenant subcollection scoping, self-escalation prevention, and immutable audit logs.

---

## Live Firebase Console Manual Verification Checklist

After deploying `firestore.rules`, `storage.rules`, `database.rules.json`, and `firestore.indexes.json` to project `attendence-system-867c1`:

- [ ] **Public SaaS Navigation**: Visit `/#/`, `/#/features`, `/#/solutions`, `/#/how-it-works`, `/#/pricing`, `/#/contact`, `/#/privacy`, `/#/terms`, submit a Contact inquiry, and confirm creation in `/contactInquiries`.
- [ ] **Multi-Org Creation**: Register Company A & School B via `/#/org-register`, verify email, and confirm unique `ORG-XXXXX` workspace creation under `/organizations/{orgId}`.
- [ ] **Custom Designations & Org Tree**: Add custom levels (e.g., Principal -> HOD -> Faculty -> Student), assign `parentMemberId`, and verify visual tree rendering.
- [ ] **Member QR ID Card & Camera Scanner**: Open Member portal -> download PNG QR Badge -> scan via Manager/Owner camera or Member ID input -> test duplicate rejection, cross-org rejection, check-out overtime, and geofence prompt.
- [ ] **Bulk Import, Leaves, Corrections & Exports**: Import a CSV file, apply/approve a leave (verify `on_leave` sync in records), request/approve a correction (verify before/after diff in `auditLogs`), and export PDF, `.xlsx`, CSV, and full JSON backup.
- [ ] **PWA Install & Offline Banner**: Verify `manifest.webmanifest`, `sw.js` registration, install prompt, and offline warning banner when network disconnects.
