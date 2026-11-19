import { jsPDF } from 'jspdf';
import autoTable from 'jspdf-autotable';
import * as XLSX from 'xlsx';

export function exportAttendancePdf({ title, subtitle, columns, rows, fileName = 'smartattend-report.pdf' }) {
  const doc = new jsPDF({ orientation: columns.length > 6 ? 'landscape' : 'portrait', unit: 'pt', format: 'a4' });
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(16);
  doc.text('SmartAttend — Attendance Report', 40, 42);

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(11);
  doc.text(title || 'Attendance Summary', 40, 62);

  doc.setFontSize(9);
  doc.setTextColor(100);
  doc.text(`${subtitle || ''} · Generated ${new Date().toLocaleString()}`, 40, 78);
  doc.setTextColor(0);

  autoTable(doc, {
    startY: 94,
    head: [columns],
    body: rows,
    styles: { fontSize: 8.5, cellPadding: 5 },
    headStyles: { fillColor: [29, 78, 216], textColor: 255, fontStyle: 'bold' },
    alternateRowStyles: { fillColor: [248, 250, 252] },
  });

  doc.save(fileName);
}

export function exportAttendanceExcel({ sheetName = 'Attendance', columns, rows, fileName = 'smartattend-report.xlsx' }) {
  const worksheetData = [columns, ...rows];
  const ws = XLSX.utils.aoa_to_sheet(worksheetData);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, sheetName.slice(0, 31));
  XLSX.writeFile(wb, fileName);
}
