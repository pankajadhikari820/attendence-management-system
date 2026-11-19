import { doc, writeBatch, getDocs, collection, query, where, serverTimestamp } from 'firebase/firestore';
import { db } from '../firebase/config.js';
import { deterministicRecordId, todayIsoDate } from '../utils/attendanceMath.js';
import { logAudit } from './firestoreService.js';

/**
 * Clearly labeled Demo Seed utility for Admin testing.
 * Prefixes IDs with `demo_` so they can be cleanly audited or removed without touching real records.
 */
export async function seedDemoDataset(actorUid) {
  const batch = writeBatch(db);
  const today = todayIsoDate();

  // Academic settings
  batch.set(
    doc(db, 'settings', 'academic'),
    {
      currentAcademicSession: '2026-2027 Fall',
      academicSessions: ['2026-2027 Fall', '2026-2027 Spring'],
      defaultAttendanceThreshold: 75,
      qrRotationSeconds: 15,
      lateGraceMinutes: 10,
      updatedAt: serverTimestamp(),
    },
    { merge: true }
  );

  // Departments
  const depts = [
    { id: 'demo_dept_cs', code: 'CSE', name: 'Computer Science & Engineering' },
    { id: 'demo_dept_ec', code: 'ECE', name: 'Electronics & Communication' },
  ];
  for (const d of depts) {
    batch.set(doc(db, 'departments', d.id), {
      ...d,
      headTeacherId: '',
      isDemo: true,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
  }

  // Courses
  const courses = [
    { id: 'demo_crs_btech_cs', code: 'BTECH-CS', name: 'B.Tech Computer Science', departmentId: 'demo_dept_cs', durationSemesters: 8 },
    { id: 'demo_crs_btech_ec', code: 'BTECH-EC', name: 'B.Tech Electronics', departmentId: 'demo_dept_ec', durationSemesters: 8 },
  ];
  for (const c of courses) {
    batch.set(doc(db, 'courses', c.id), {
      ...c,
      isDemo: true,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
  }

  // Classes
  const classes = [
    {
      id: 'demo_cls_cs3a',
      name: 'CSE Semester 3 - Section A',
      code: 'CSE-3A',
      departmentId: 'demo_dept_cs',
      courseId: 'demo_crs_btech_cs',
      semester: 3,
      academicSession: '2026-2027 Fall',
      section: 'A',
      studentCount: 2,
    },
  ];
  for (const cl of classes) {
    batch.set(doc(db, 'classes', cl.id), {
      ...cl,
      isDemo: true,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
  }

  // Subjects
  const subjects = [
    {
      id: 'demo_sub_dsa',
      code: 'CS301',
      name: 'Data Structures & Algorithms',
      departmentId: 'demo_dept_cs',
      courseId: 'demo_crs_btech_cs',
      semester: 3,
      teacherId: actorUid,
      credits: 4,
      minAttendancePct: 75,
    },
    {
      id: 'demo_sub_dbms',
      code: 'CS302',
      name: 'Database Management Systems',
      departmentId: 'demo_dept_cs',
      courseId: 'demo_crs_btech_cs',
      semester: 3,
      teacherId: actorUid,
      credits: 4,
      minAttendancePct: 75,
    },
  ];
  for (const s of subjects) {
    batch.set(doc(db, 'subjects', s.id), {
      ...s,
      isDemo: true,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
  }

  // Timetable
  const slots = [
    {
      id: 'demo_tt_mon_1',
      classId: 'demo_cls_cs3a',
      subjectId: 'demo_sub_dsa',
      teacherId: actorUid,
      dayOfWeek: 'Monday',
      startTime: '09:00',
      endTime: '10:00',
      room: 'LH-204',
      academicSession: '2026-2027 Fall',
    },
    {
      id: 'demo_tt_wed_1',
      classId: 'demo_cls_cs3a',
      subjectId: 'demo_sub_dbms',
      teacherId: actorUid,
      dayOfWeek: 'Wednesday',
      startTime: '11:00',
      endTime: '12:00',
      room: 'LH-102',
      academicSession: '2026-2027 Fall',
    },
  ];
  for (const t of slots) {
    batch.set(doc(db, 'timetable', t.id), {
      ...t,
      isDemo: true,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
  }

  // Holidays
  batch.set(doc(db, 'holidays', 'demo_hol_1'), {
    id: 'demo_hol_1',
    title: 'Annual Convocation Break',
    date: today,
    type: 'academic',
    description: 'Demo institutional holiday entry for calendar verification.',
    isDemo: true,
    createdAt: serverTimestamp(),
  });

  // Announcements
  batch.set(doc(db, 'announcements', 'demo_ann_1'), {
    id: 'demo_ann_1',
    title: 'Minimum 75% Attendance Policy Active (Demo Notice)',
    body: 'All students must maintain at least 75% attendance across registered subjects to remain eligible for end-semester assessments.',
    audience: 'all',
    departmentId: '',
    authorUid: actorUid,
    authorName: 'Administration',
    pinned: true,
    isDemo: true,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });

  // Sample closed session & record
  batch.set(doc(db, 'attendanceSessions', 'demo_sess_1'), {
    classId: 'demo_cls_cs3a',
    subjectId: 'demo_sub_dsa',
    teacherId: actorUid,
    academicSession: '2026-2027 Fall',
    date: today,
    mode: 'manual',
    status: 'closed',
    qrToken: '',
    qrExpiresAtMs: 0,
    qrRotationSeconds: 15,
    thresholdPct: 75,
    presentCount: 1,
    absentCount: 0,
    lateCount: 0,
    totalStudents: 1,
    isDemo: true,
    startedAt: serverTimestamp(),
    closedAt: serverTimestamp(),
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });

  const demoRecId = deterministicRecordId('demo_sess_1', 'demo_student_1');
  batch.set(doc(db, 'attendanceRecords', demoRecId), {
    id: demoRecId,
    sessionId: 'demo_sess_1',
    studentId: 'demo_student_1',
    studentUid: 'demo_student_1',
    studentName: 'Demo Student',
    rollNumber: 'CSE26-001',
    classId: 'demo_cls_cs3a',
    subjectId: 'demo_sub_dsa',
    teacherId: actorUid,
    date: today,
    status: 'present',
    method: 'manual',
    markedBy: actorUid,
    isDemo: true,
    markedAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });

  await batch.commit();
  await logAudit('SEED_DEMO_DATA', 'system', 'demo', 'Seeded clearly labeled demo academic structure');
}

export async function clearDemoDataset() {
  const collections = [
    'departments',
    'courses',
    'classes',
    'subjects',
    'timetable',
    'holidays',
    'announcements',
    'attendanceSessions',
    'attendanceRecords',
  ];
  let deleted = 0;
  for (const colName of collections) {
    const snap = await getDocs(query(collection(db, colName), where('isDemo', '==', true)));
    if (snap.empty) continue;
    const batch = writeBatch(db);
    snap.docs.forEach((d) => {
      batch.delete(d.ref);
      deleted += 1;
    });
    await batch.commit();
  }
  await logAudit('CLEAR_DEMO_DATA', 'system', 'demo', `Removed ${deleted} demo documents`);
  return deleted;
}
