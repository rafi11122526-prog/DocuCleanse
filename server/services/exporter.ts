import { stringify as stringifyCsv } from 'csv-stringify/sync';
import PDFDocument from 'pdfkit';
import * as XLSX from 'xlsx';
import type { CleanJobRecord } from '../types.ts';

export function generateCsvBuffer(job: CleanJobRecord): Buffer {
  const rowsAsMatrix: string[][] = [job.cleanedHeaders];
  for (const row of job.cleanedRows) {
    rowsAsMatrix.push(job.cleanedHeaders.map((h) => String(row[h] ?? '')));
  }
  const csvString = stringifyCsv(rowsAsMatrix);
  return Buffer.from(csvString, 'utf8');
}

export function generateXlsxBuffer(job: CleanJobRecord): Buffer {
  const wb = XLSX.utils.book_new();

  // Sheet 1: Normalized Data
  const cleanMatrix: string[][] = [job.cleanedHeaders];
  for (const row of job.cleanedRows) {
    cleanMatrix.push(job.cleanedHeaders.map((h) => String(row[h] ?? '')));
  }
  const cleanSheet = XLSX.utils.aoa_to_sheet(cleanMatrix);
  cleanSheet['!cols'] = job.cleanedHeaders.map((h) => ({
    wch: Math.min(36, Math.max(14, h.length + 4)),
  }));
  XLSX.utils.book_append_sheet(wb, cleanSheet, 'Cleaned Data');

  // Sheet 2: Executive Anomaly Audit Log
  const anomalyRows = [
    ['Severity', 'Category', 'Location', 'Raw Value', 'Normalized / Suggested', 'Explanation'],
    ...job.anomalies.map((a) => [
      a.severity.toUpperCase(),
      a.category,
      a.location,
      a.rawValue,
      a.suggestedOrFixedValue,
      a.explanation,
    ]),
  ];
  const anomalySheet = XLSX.utils.aoa_to_sheet(anomalyRows);
  anomalySheet['!cols'] = [
    { wch: 12 },
    { wch: 18 },
    { wch: 24 },
    { wch: 24 },
    { wch: 24 },
    { wch: 48 },
  ];
  XLSX.utils.book_append_sheet(wb, anomalySheet, 'Anomaly Audit Log');

  // Sheet 3: Schema Mappings
  const mappingRows = [
    ['Raw Header', 'Normalized Header', 'Detected Type', 'Mapping Rationale'],
    ...job.schemaMappings.map((m) => [
      m.rawHeader,
      m.normalizedHeader,
      m.detectedType,
      m.reason,
    ]),
  ];
  const mappingSheet = XLSX.utils.aoa_to_sheet(mappingRows);
  mappingSheet['!cols'] = [{ wch: 24 }, { wch: 24 }, { wch: 16 }, { wch: 46 }];
  XLSX.utils.book_append_sheet(wb, mappingSheet, 'Schema Mapping');

  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}

export async function generateSummaryPdfBuffer(job: CleanJobRecord): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'LETTER',
      margin: 44,
      info: {
        Title: `DocuCleanse Audit Report — ${job.fileName}`,
        Author: 'DocuCleanse Normalization Engine',
      },
    });

    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    // Header
    doc
      .fillColor('#0F172A')
      .font('Helvetica-Bold')
      .fontSize(18)
      .text('DocuCleanse Executive Audit Report', { align: 'left' });

    doc
      .moveDown(0.3)
      .fillColor('#475569')
      .font('Helvetica')
      .fontSize(10)
      .text(
        `Source File: ${job.fileName}   |   Category: ${job.documentCategory.replace('_', ' ')}   |   Generated: ${new Date(job.createdAt).toLocaleString('en-US')}`
      );

    doc
      .moveDown(0.8)
      .strokeColor('#CBD5E1')
      .lineWidth(1)
      .moveTo(44, doc.y)
      .lineTo(568, doc.y)
      .stroke();

    // Summary Metrics Row
    doc.moveDown(0.8);
    const criticalCount = job.anomalies.filter((a) => a.severity === 'critical').length;
    const warningCount = job.anomalies.filter((a) => a.severity === 'warning').length;
    const fixedCount = job.anomalies.filter((a) => a.severity === 'fixed').length;

    doc
      .fillColor('#0F172A')
      .font('Helvetica-Bold')
      .fontSize(11)
      .text(
        `Rows Processed: ${job.rowCount}     Cells Normalized: ${job.cellDiffs.length}     Critical Issues: ${criticalCount}     Warnings: ${warningCount}     Auto-Fixed: ${fixedCount}`
      );

    // Executive Summary
    doc.moveDown(0.8);
    doc.fillColor('#0F172A').font('Helvetica-Bold').fontSize(12).text('Executive Summary');
    doc
      .moveDown(0.25)
      .fillColor('#334155')
      .font('Helvetica')
      .fontSize(10)
      .text(job.executiveSummary, { lineGap: 3 });

    // Anomaly Audit Log
    doc.moveDown(1);
    doc.fillColor('#0F172A').font('Helvetica-Bold').fontSize(12).text('Anomaly & Normalization Log');
    doc.moveDown(0.4);

    if (job.anomalies.length === 0) {
      doc
        .fillColor('#16A34A')
        .font('Helvetica')
        .fontSize(10)
        .text('No anomalies detected. Dataset matches canonical schema.');
    } else {
      for (const anom of job.anomalies.slice(0, 25)) {
        if (doc.y > 680) {
          doc.addPage();
        }
        const badgeColor =
          anom.severity === 'critical'
            ? '#DC2626'
            : anom.severity === 'warning'
            ? '#D97706'
            : '#16A34A';

        doc
          .fillColor(badgeColor)
          .font('Helvetica-Bold')
          .fontSize(9)
          .text(`[${anom.severity.toUpperCase()}] ${anom.category} — ${anom.location}`);

        doc
          .fillColor('#334155')
          .font('Helvetica')
          .fontSize(9)
          .text(`Raw: "${anom.rawValue}"  ->  Cleaned: "${anom.suggestedOrFixedValue}"`);

        doc
          .fillColor('#64748B')
          .font('Helvetica')
          .fontSize(8.5)
          .text(anom.explanation, { lineGap: 2 });

        doc.moveDown(0.45);
      }
    }

    // Preview of Normalized Records
    if (doc.y > 600) {
      doc.addPage();
    } else {
      doc.moveDown(0.8);
    }

    doc
      .fillColor('#0F172A')
      .font('Helvetica-Bold')
      .fontSize(12)
      .text(`Normalized Data Preview (First ${Math.min(20, job.cleanedRows.length)} of ${job.cleanedRows.length} rows)`);
    doc.moveDown(0.4);

    const previewHeaders = job.cleanedHeaders.slice(0, 6);
    doc
      .fillColor('#0F172A')
      .font('Helvetica-Bold')
      .fontSize(8)
      .text(previewHeaders.join('  |  '));

    doc
      .moveDown(0.2)
      .strokeColor('#E2E8F0')
      .lineWidth(0.5)
      .moveTo(44, doc.y)
      .lineTo(568, doc.y)
      .stroke();
    doc.moveDown(0.3);

    for (const row of job.cleanedRows.slice(0, 20)) {
      if (doc.y > 720) {
        doc.addPage();
      }
      const line = previewHeaders
        .map((h) => String(row[h] ?? '').slice(0, 24))
        .join('  |  ');
      doc.fillColor('#334155').font('Courier').fontSize(8).text(line);
      doc.moveDown(0.18);
    }

    doc.end();
  });
}
