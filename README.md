# SmartAttend — Smart Attendance Management System

SmartAttend is a responsive, production-style academic attendance management system built strictly with **HTML5, CSS3, and Vanilla JavaScript (ES modules)** paired with **Firebase** (`Authentication`, `Cloud Firestore`, `Realtime Database`, `Firebase Storage`, `Firebase Cloud Messaging`, and optional `Cloud Functions`).

---

## Key Features

- **Role-Based Portals**: Dedicated Admin, Teacher, and Student workspaces with email verification enforcement (`request.auth.token.email_verified == true`) and database-backed RBAC (`users/{uid}`).
- **Dynamic Expiring QR Attendance**:
  - Teachers launch live sessions with configurable QR rotation intervals (`10s–120s`), live countdowns, and a real-time check-in feed powered by **Firebase Realtime Database**.
  - Students scan QR codes via live camera (`jsQR`) or direct session code fallback.
  - Duplicate scans are prevented at both transaction and rule levels using deterministic document IDs (`${sessionId}_${studentUid}`).
- **Manual Attendance & Correction Workflows**: Batch manual marking (`present`, `absent`, `late`, `excused`), student leave applications and attendance correction requests with **Firebase Storage** file attachments, and atomic teacher approvals.
- **Shortage Calculator & Low-Attendance Alerts**: Configurable threshold (default `75%`), automatic student low-attendance notifications, and an interactive shortage/recovery calculator.
- **Analytics & Audit-Ready Exports**: Interactive **Chart.js** visualizations, immutable `auditLogs`, and **PDF** (`jsPDF` + `autoTable`) and **Excel** (`.xlsx` via SheetJS) report exports.
- **Responsive Mobile-First UI & Dark/Light Mode**: Built with pure CSS3 custom properties, accessible focus states, loading skeletons, empty states, confirmation dialogs, and toast notifications.

---

## Firebase Project Configuration

The app is pre-wired in `src/firebase/config.js` and `public/firebase-messaging-sw.js` to your supplied Firebase project:
- **Project ID**: `attendence-system-867c1`
- **Auth Domain**: `attendence-system-867c1.firebaseapp.com`
- **Realtime Database URL**: `https://attendence-system-867c1-default-rtdb.firebaseio.com`
- **Storage Bucket**: `attendence-system-867c1.firebasestorage.app`

---

## Firebase Console Setup Checklist

1. **Authentication Providers**:
   - Open **Firebase Console > Authentication > Sign-in method**.
   - Enable **Email/Password** and **Google**.
   - Under **Settings > Authorized domains**, ensure `localhost` and your hosting/preview domain are allowlisted.
2. **Cloud Firestore**:
   - Open **Firebase Console > Firestore Database > Create database**.
   - Choose your region and start in **Production mode** (then deploy `firestore.rules`).
3. **Firebase Realtime Database**:
   - Open **Firebase Console > Realtime Database > Create Database** matching `https://attendence-system-867c1-default-rtdb.firebaseio.com`.
   - Deploy `database.rules.json` so ephemeral live session updates are strictly scoped.
4. **Firebase Storage**:
   - Open **Firebase Console > Storage > Get started** and deploy `storage.rules`.
5. **Firebase Cloud Messaging (Optional Web Push)**:
   - Open **Project Settings > Cloud Messaging > Web Push certificates** and generate a key pair.
   - Paste the public VAPID key inside **Profile & Preferences > Enable Browser Push Notifications** in SmartAttend.

---

## Deploying Security Rules, Indexes & Optional Cloud Functions

Install the Firebase CLI (`npm i -g firebase-tools`) and authenticate (`firebase login`):

```bash
firebase use attendence-system-867c1

# Deploy Firestore rules, indexes, Realtime Database rules, and Storage rules
firebase deploy --only firestore,database,storage
```

### Cloud Functions vs. Spark Free Plan Safe Alternative

SmartAttend includes full Node.js 20 Cloud Functions in `functions/index.js`:
- `rotateSessionQr` — Server-side cryptographic QR token generation & expiry timestamp
- `markQrAttendance` — Server-side token/session/enrollment validation and atomic duplicate rejection
- `createManagedUser` — Admin SDK user creation with custom claims (without signing out the Admin)
- `onAttendanceRecordWritten` — Firestore trigger generating low-attendance notifications

**Deploying Functions (requires Firebase Blaze Plan):**
```bash
cd functions && npm install && cd ..
firebase deploy --only functions
```
Then toggle **"Use Deployed Firebase Cloud Functions"** ON inside **Admin > Sessions & Policy**.

**Safe Alternative on Spark Free Plan (Default):**
If Cloud Functions are not deployed:
- **QR Validation & Duplicate Prevention**: Executed via atomic Firestore `runTransaction` against deterministic record ID `${sessionId}_${studentUid}` and enforced by `firestore.rules` (`status == 'active'`, `recordId == sessionId + '_' + studentUid`, student ownership). *Security note*: Without Cloud Functions, a compromised client holding a currently active token string cannot mark another student's attendance or scan twice, though true server-enforced token expiration clock checks require Cloud Functions.
- **Admin Creating Teacher/Student Accounts**: Handled via an isolated secondary Firebase app instance (`adminProvisioner`) so the Admin remains signed in while Firebase Auth creates the new user and sends email verification. Passwords are **never** stored in Firestore.

---

## Running & Testing Locally

```bash
# Install dependencies
npm install

# Run ES module syntax check
npm run lint

# Run automated workflow tests (QR lifecycle, duplicate rejection, shortage math, threshold alerts)
npm test

# Start local development server on port 3000
npm run dev

# Build production bundle
npm run build
```

### Bootstrapping the First Admin Account
1. Start the app (`npm run dev`) and sign up or sign in with Google using the bootstrapped admin email configured in `firestore.rules` (`pankajadhikari820@gmail.com`).
2. Verify your email address when prompted.
3. Once signed into the **Admin Portal**, open **Overview** or **Sessions & Policy** and click **Seed Demo Dataset** (optional) to populate sample departments, courses, subjects, classes, timetable, and holidays for immediate testing.
