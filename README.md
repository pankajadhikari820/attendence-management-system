# SmartAttend — Universal Multi-Organization Attendance SaaS

**SmartAttend** is a responsive, multi-tenant Attendance Management SaaS platform built exclusively with **HTML5, CSS3, and Vanilla JavaScript (ES modules)** and powered by **Firebase** (`Authentication`, `Cloud Firestore`, `Realtime Database`, `Firebase Storage`, `Firebase Cloud Messaging`, `Firebase App Check`, and optional `Cloud Functions`).

Designed for **Schools, Colleges, Universities, Coaching Institutes, Training Centers, Private Companies, Corporate Offices, Startups, and Factories**.

---

## Core Capabilities

- **Public SaaS Platform & Legal Pages**: Complete responsive marketing website (`Home`, `Features`, `Solutions`, `How It Works`, `Pricing`, `Contact`, `Privacy Policy`, `Terms of Service`) plus interactive onboarding flows.
- **Multi-Organization Tenant Isolation**: Every organization receives a unique `ORG-XXXXX` identifier with isolated Firestore subcollections (`organizations/{orgId}/...`), verified membership claims (`users/{uid}/memberships/{orgId}`), and a Multi-Organization Workspace Switcher.
- **Unlimited Custom Hierarchy & Capability RBAC**: Define any number of designations (`level`, `parentDesignationId`), physical branches, departments, shifts, and granular capability flags (`canManageOrg`, `canManageMembers`, `canTakeAttendance`, `canApproveLeaves`, `canViewReports`, `scope`: `org | branch | department | team | self`) plus an interactive Reporting Tree (`parentMemberId`).
- **Member QR ID Badges & Dual-Mode Scanner**:
  - Every member receives an immutable `SA-ORGXXXXX-YYYYYY` ID and an opaque revocable QR token (`{ v: 2, type: 'member_id', orgId, token }`) containing zero PII, downloadable as a labeled PNG badge.
  - Authorized Heads/Managers scan members via live camera (`jsQR`) or Member ID entry with Check-In / Check-Out tracking, shift grace & overtime math, duplicate scan prevention, cross-org rejection, optional WGS84 geofencing, and anomaly logging.
- **Attendance Policy, Leave & Correction Engines**: Supports `present`, `absent`, `late`, `half_day`, `on_leave`, `holiday`, and `weekly_off` (holidays & weekly offs never penalize members), attachment-backed leave & correction approvals synced atomically to attendance records, attendance shortage calculator, and CSV Bulk Member Import with duplicate detection.
- **Analytics, Reporting & PWA**: Interactive **Chart.js** visualizations, PDF (`jsPDF` + `autoTable`), Excel (`.xlsx`), CSV exports, full organization JSON backups, dark/light theme, offline status guard, and installable PWA manifest & service worker.

---

## Firebase Configuration (`attendence-system-867c1`)

Pre-configured in `src/firebase/config.js` and `public/firebase-messaging-sw.js`:
- **Project ID**: `attendence-system-867c1`
- **Auth Domain**: `attendence-system-867c1.firebaseapp.com`
- **Database URL**: `https://attendence-system-867c1-default-rtdb.firebaseio.com`
- **Storage Bucket**: `attendence-system-867c1.firebasestorage.app`

---

## Firebase Console Setup

1. **Authentication Providers**:
   - Open **Firebase Console > Authentication > Sign-in method** and enable **Email/Password** and **Google**.
   - Add `localhost` and your Cloud Run / Firebase Hosting domain under **Authentication > Settings > Authorized domains**.
2. **Cloud Firestore & Composite Indexes**:
   - Create Firestore in **Production mode**, then deploy `firestore.rules` and `firestore.indexes.json`.
3. **Realtime Database & Storage**:
   - Ensure Realtime Database (`attendence-system-867c1-default-rtdb.firebaseio.com`) and Storage (`attendence-system-867c1.firebasestorage.app`) are initialized, then deploy `database.rules.json` and `storage.rules`.
4. **Firebase App Check (reCAPTCHA Enterprise)**:
   - Register your web app under **Firebase Console > App Check** with your Google Cloud **reCAPTCHA Enterprise** website key.
   - Ensure your deployed domain (e.g., `attendence-management-system-rouge.vercel.app`) is allowlisted in both Google Cloud **reCAPTCHA Enterprise Key > Domains** and **Firebase Console > Authentication > Settings > Authorized domains**.
   - Set `VITE_RECAPTCHA_ENTERPRISE_SITE_KEY` in Vercel Project Settings > Environment Variables (and redeploy), or save the public site key in **Owner > Organization Settings > App Check**. Never expose secret keys in frontend code.
5. **Firebase Cloud Messaging (Optional Web Push)**:
   - Generate a Web Push VAPID key pair under **Project Settings > Cloud Messaging** and enter it under **Profile & Preferences**.

---

## Deploying Rules, Indexes & Cloud Functions

```bash
npm i -g firebase-tools
firebase login
firebase use attendence-system-867c1

# Deploy security rules & indexes
firebase deploy --only firestore,database,storage
```

### Cloud Functions vs. Spark Plan Safe Fallback
- `functions/index.js` implements server-side Node.js v2 Cloud Functions (`scanMemberAttendance`, `provisionOrgMemberServer`, `onOrgAttendanceWritten`).
- **Deploying Functions (Blaze Plan)**:
  ```bash
  cd functions && npm install && cd ..
  firebase deploy --only functions
  ```
  Then enable **Use Deployed Cloud Functions** in **Owner > Organization Settings**.
- **Spark Free Plan Default**:
  - Attendance recording uses atomic Firestore `runTransaction` with deterministic `{date}__{scope}__{memberUid}` record IDs enforced by `firestore.rules`.
  - Admin member provisioning uses an isolated secondary Firebase Auth app instance (`adminProvisioner`) so the owner/manager stays signed in and passwords are never stored in Firestore.

---

## Running & Testing Locally

```bash
npm install
npm run lint    # Node ES module syntax verification across src/, scripts/, tests/
npm test        # Multi-tenant workflow, QR security, hierarchy & policy tests
npm run dev     # Start Vite development server on http://localhost:3000
npm run build   # Production bundle output to dist/
```

See `docs/DATABASE_STRUCTURE.md` and `docs/TESTING_CHECKLIST.md` for full schema and QA details.
