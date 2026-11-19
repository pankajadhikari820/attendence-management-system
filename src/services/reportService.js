import { jsPDF } from 'jspdf';
import autoTable from 'jspdf-autotable';
import * as XLSX from 'xlsx';

export function exportAttendancePdf({
  orgName = 'SmartAttend',
  title,
  subtitle,
  columns,
  rows,
  fileName = 'smartattend-report.pdf',
}) {
  const doc = new jsPDF({
    orientation: columns.length > 6 ? 'landscape' : 'portrait',
    unit: 'pt',
    format: 'a4',
  });
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(15);
  doc.text(`${orgName} — SmartAttend Report`, 40, 40);

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(11);
  doc.text(title || 'Attendance Summary', 40, 58);

  doc.setFontSize(8.5);
  doc.setTextColor(100);
  doc.text(`${subtitle || ''} · Generated ${new Date().toLocaleString()}`, 40, 74);
  doc.setTextColor(0);

  autoTable(doc, {
    startY: 90,
    head: [columns],
    body: rows,
    styles: { fontSize: 8, cellPadding: 5 },
    headStyles: { fillColor: [29, 78, 216], textColor: 255, fontStyle: 'bold' },
    alternateRowStyles: { fillColor: [248, 250, 252] },
  });

  doc.save(fileName);
}

export function exportAttendanceExcel({
  sheetName = 'Attendance',
  columns,
  rows,
  fileName = 'smartattend-report.xlsx',
}) {
  const worksheetData = [columns, ...rows];
  const ws = XLSX.utils.aoa_to_sheet(worksheetData);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, sheetName.slice(0, 31));
  XLSX.writeFile(wb, fileName);
}

export function exportAttendanceCsv({ columns, rows, fileName = 'smartattend-report.csv' }) {
  const escapeCell = (val) => {
    const s = String(val ?? '');
    if (/[",\n]/.test(s)) return `"${s.replaceAll('"', '""')}"`;
    return s;
  };
  const csv = [columns.map(escapeCell).join(','), ...rows.map((r) => r.map(escapeCell).join(','))].join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export function downloadJsonBackup(data, fileName = 'smartattend-org-backup.json') {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
