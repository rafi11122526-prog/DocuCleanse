import crypto from 'node:crypto';
import { stringify as stringifyCsv } from 'csv-stringify/sync';
import ExcelJS from 'exceljs';
import PDFDocument from 'pdfkit';
import type { AuditMetadata, CleanJobRecord } from '../types.ts';

function sanitizeMojibake(val: string): string {
  return val
    .replace(/â‚¬/g, '€')
    .replace(/Â£/g, '£')
    .replace(/Â¥/g, '¥')
    .replace(/Â·/g, '·')
    .replace(/â€”/g, '—')
    .replace(/â€“/g, '–')
    .replace(/Â\s/g, ' ');
}

function parseNumericStrict(raw: unknown): number | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  const s = sanitizeMojibake(String(raw)).trim();
  if (!s || s.startsWith('=') || s.startsWith('[ERROR') || s === '[MISSING]' || s.endsWith('%')) {
    return null;
  }
  const neg = /^\(.*\)$/.test(s);
  let cleaned = s
    .replace(/([-(\s\u00A0]|^)(?:CA|AU|US|NZ|HK|SG|C|A|S)\$/gi, '$1')
    .replace(/\b(USD|EUR|GBP|CAD|AUD|JPY|CHF|NZD|SGD|HKD|PKR|INR|AED|SAR|RS\.?)\b/gi, '')
    .replace(/[$€£¥₹₩₽\s\u00A0()]/g, '');

  if (/^-?\d{1,3}(\.\d{3})*,\d{1,2}$/.test(cleaned) || /^-?\d+,\d{1,2}$/.test(cleaned)) {
    cleaned = cleaned.replace(/\./g, '').replace(',', '.');
  } else {
    cleaned = cleaned.replace(/,/g, '');
  }

  if (!/^-?\d+(\.\d+)?$/.test(cleaned)) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? (neg ? -Math.abs(n) : n) : null;
}

function detectCurrencyCode(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  const s = sanitizeMojibake(String(raw)).trim();
  if (!s) return null;
  if (/\bCAD\b|CA\$|(?:^|[\s(-])C\$/i.test(s)) return 'CAD';
  if (/\bAUD\b|AU\$|(?:^|[\s(-])A\$/i.test(s)) return 'AUD';
  if (/\bNZD\b|NZ\$/i.test(s)) return 'NZD';
  if (/\bSGD\b|SG\$|(?:^|[\s(-])S\$/i.test(s)) return 'SGD';
  if (/\bHKD\b|HK\$/i.test(s)) return 'HKD';
  if (/£|\bGBP\b/i.test(s)) return 'GBP';
  if (/€|\bEUR\b/i.test(s)) return 'EUR';
  if (/¥|\bJPY\b/i.test(s)) return 'JPY';
  if (/₹|\bINR\b/i.test(s)) return 'INR';
  if (/\bCHF\b/i.test(s)) return 'CHF';
  if (/\bPKR\b|\bRs\.?\b/i.test(s)) return 'PKR';
  if (/\bAED\b/i.test(s)) return 'AED';
  if (/\bSAR\b/i.test(s)) return 'SAR';
  if (/US\$|\$|\bUSD\b/i.test(s)) return 'USD';
  return null;
}

function parseTaxRateFraction(raw: unknown): number | null {
  if (raw === null || raw === undefined) return null;
  const s = sanitizeMojibake(String(raw)).trim();
  if (!s || s.startsWith('=') || s.startsWith('[ERROR') || s === '[MISSING]') return null;
  if (s.endsWith('%')) {
    const num = Number(s.slice(0, -1).replace(/,/g, '').trim());
    return Number.isFinite(num) ? num / 100 : null;
  }
  const num = Number(s.replace(/,/g, '').trim());
  if (!Number.isFinite(num)) return null;
  // Values like 20 or 5 in a tax_rate column mean 20% (0.20) or 5% (0.05); 0.2 means 20%
  return Math.abs(num) > 1 ? num / 100 : num;
}

function colIndexToExcelLetter(zeroBasedIdx: number): string {
  let n = zeroBasedIdx + 1;
  let result = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    result = String.fromCharCode(65 + rem) + result;
    n = Math.floor((n - 1) / 26);
  }
  return result;
}

function excelNumberFormatForCurrency(code: string | null): string {
  switch ((code || '').toUpperCase()) {
    case 'USD':
      return '"$"#,##0.00;-"$"#,##0.00;"$"0.00';
    case 'EUR':
      return '"€"#,##0.00;-"€"#,##0.00;"€"0.00';
    case 'GBP':
      return '"£"#,##0.00;-"£"#,##0.00;"£"0.00';
    case 'JPY':
      return '"¥"#,##0;-"¥"#,##0;"¥"0';
    case 'CAD':
      return '"CA$"#,##0.00;-"CA$"#,##0.00;"CA$"0.00';
    case 'AUD':
      return '"A$"#,##0.00;-"A$"#,##0.00;"A$"0.00';
    case 'INR':
      return '"INR "#,##0.00;-"INR "#,##0.00;"INR "0.00';
    case 'CHF':
      return '"CHF "#,##0.00;-"CHF "#,##0.00;"CHF "0.00';
    default:
      return '#,##0.00';
  }
}

function pdfSafeCurrencySymbol(code: string): string {
  switch (code.toUpperCase()) {
    case 'EUR':
      return '€';
    case 'GBP':
      return '£';
    case 'USD':
      return '$';
    case 'JPY':
      return '¥';
    case 'CAD':
      return 'CA$';
    case 'AUD':
      return 'A$';
    default:
      return `${code.toUpperCase()} `;
  }
}

function formatMoney(val: number, detectedCurrencies: string[] = []): string {
  const sign = val < 0 ? '-' : '';
  const absFormatted = Math.abs(val).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  if (detectedCurrencies.length === 1) {
    const sym = pdfSafeCurrencySymbol(detectedCurrencies[0]);
    return `${sign}${sym}${absFormatted}`;
  }
  return `${sign}${absFormatted}`;
}

function formatIsoCurrencyTotal(val: number, code: string): string {
  const sign = val < 0 ? '-' : '';
  const absFormatted = Math.abs(val).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  const upper = code.toUpperCase();
  const sym = pdfSafeCurrencySymbol(upper);
  if (sym.endsWith(' ')) {
    return `${upper} ${sign}${absFormatted}`;
  }
  return `${upper} ${sign}${sym}${absFormatted}`;
}

function formatUtcTimestamp(iso: string): string {
  if (iso.endsWith(' UTC')) return iso;
  const dt = new Date(iso);
  if (Number.isNaN(dt.getTime())) return `${iso} UTC`;
  return `${dt.toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '')} UTC`;
}

interface SynchronizedExportMetrics {
  meta: AuditMetadata;
  grossInflow: number;
  negativeExposure: number;
  netInflow: number;
  confidenceScore: number;
  detectedCurrencies: string[];
  currencySummary: Array<{ code: string; total: number }>;
  isMultiCurrency: boolean;
}

/**
 * Computes exact synchronized metrics matching the Executive Dashboard:
 * - Gross Inflow: sum of all positive normalized transaction amounts (e.g., 29,019.91)
 * - Negative Exposure / Refunds: absolute sum of negative balances (e.g., 1,700.00)
 * - Net Inflow: Gross Inflow - Negative Exposure (e.g., 27,319.91)
 * - Confidence Score: unified cell-integrity score (e.g., 99.7% Cleaned)
 */
function computeSynchronizedMetrics(job: CleanJobRecord): SynchronizedExportMetrics {
  const headers = job.cleanedHeaders;
  const rawHeaders = job.rawHeaders;

  const findHeader = (list: string[], regex: RegExp, exclude?: RegExp): string =>
    list.find((h) => regex.test(h) && (!exclude || !exclude.test(h))) || '';

  const normalizedAmtCol = headers.includes('normalized_amount') ? 'normalized_amount' : '';
  const explicitTotalCol = findHeader(
    headers,
    /^(total[\s_-]?amount|line[\s_-]?total|net[\s_-]?total|grand[\s_-]?total|total|amount|revenue|monthly_recurring_revenue|mrr|balance)$/i,
    /raw_amount|unit[\s_-]?price|tax|rate|qty|quantity/i
  );
  const partialTotalCol = findHeader(
    headers,
    /(total|amount|revenue|mrr|balance|subtotal|net_sales)/i,
    /raw_amount|unit[\s_-]?price|tax|rate|qty|quantity/i
  );
  const qtyCol = findHeader(headers, /\b(qty|quantity|units)\b|qty_sold|quantity_sold|units_sold/i);
  const rawQtyCol = findHeader(
    rawHeaders,
    /\b(qty|quantity|units)\b|qty_sold|quantity_sold|units_sold/i
  );
  const unitPriceCol = findHeader(
    headers,
    /\b(unit[\s_-]?price|unit[\s_-]?cost|price)\b/i,
    /total|tax|discount|rate/i
  );
  const rawUnitPriceCol = findHeader(
    rawHeaders,
    /\b(unit[\s_-]?price|unit[\s_-]?cost|price)\b/i,
    /total|tax|discount|rate/i
  );
  const rawTotalKey = findHeader(
    rawHeaders,
    /(total[\s_-]?amount|line[\s_-]?total|total|amount|revenue|mrr|balance)/i,
    /unit[\s_-]?price|tax|rate/i
  );

  const candidateTotalCols = Array.from(
    new Set(
      [
        normalizedAmtCol,
        job.auditMetadata?.primaryAmountColumn || '',
        explicitTotalCol,
        partialTotalCol,
      ].filter(Boolean)
    )
  );

  let grossInflow = 0;
  let negativeExposure = 0;
  let algebraicSum = 0;
  let computedInputSum = 0;
  const currencySet = new Set<string>(job.auditMetadata?.detectedCurrencies ?? []);
  const currencyPositiveTotals = new Map<string, number>();

  const rowCount = Math.max(job.cleanedRows.length, job.rawRows.length);
  for (let i = 0; i < rowCount; i++) {
    const cleanRow = job.cleanedRows[i] || {};
    const rawRow = job.rawRows[i] || {};

    let rowAmount: number | null = null;
    let sawExplicitZero = false;
    for (const col of candidateTotalCols) {
      const parsed = parseNumericStrict(cleanRow[col]);
      if (parsed !== null) {
        if (parsed !== 0) {
          rowAmount = parsed;
          break;
        }
        sawExplicitZero = true;
      }
    }

    const qtyVal =
      (qtyCol ? parseNumericStrict(cleanRow[qtyCol]) : null) ??
      (rawQtyCol ? parseNumericStrict(rawRow[rawQtyCol]) : null);
    const unitPriceVal =
      (unitPriceCol ? parseNumericStrict(cleanRow[unitPriceCol]) : null) ??
      (rawUnitPriceCol ? parseNumericStrict(rawRow[rawUnitPriceCol]) : null);

    if (qtyVal !== null && unitPriceVal !== null) {
      const computedLine = Number((qtyVal * unitPriceVal).toFixed(2));
      if (rowAmount === null && (computedLine !== 0 || !sawExplicitZero)) {
        rowAmount = computedLine;
      }
    }

    if (rowAmount === null && rawTotalKey) {
      const rawParsed = parseNumericStrict(rawRow[rawTotalKey]);
      if (rawParsed !== null && rawParsed !== 0) {
        rowAmount = rawParsed;
      }
    }
    if (rowAmount === null && sawExplicitZero) {
      rowAmount = 0;
    }

    let rowCurrency: string | null = null;
    const curField = String(cleanRow.currency_code ?? '').trim().toUpperCase();
    if (curField && curField !== 'N/A') {
      rowCurrency = curField;
    } else {
      for (const col of candidateTotalCols) {
        const c = detectCurrencyCode(cleanRow[col]);
        if (c) {
          rowCurrency = c;
          break;
        }
      }
      if (!rowCurrency && unitPriceCol) rowCurrency = detectCurrencyCode(cleanRow[unitPriceCol]);
      if (!rowCurrency && rawTotalKey) rowCurrency = detectCurrencyCode(rawRow[rawTotalKey]);
      if (!rowCurrency && rawUnitPriceCol) {
        rowCurrency = detectCurrencyCode(rawRow[rawUnitPriceCol]);
      }
    }

    if (rowCurrency) currencySet.add(rowCurrency);

    if (rowAmount !== null) {
      algebraicSum += rowAmount;
      if (rowAmount > 0) {
        grossInflow += rowAmount;
        if (rowCurrency) {
          currencyPositiveTotals.set(
            rowCurrency,
            Number(((currencyPositiveTotals.get(rowCurrency) ?? 0) + rowAmount).toFixed(2))
          );
        }
      } else if (rowAmount < 0) {
        negativeExposure += Math.abs(rowAmount);
      }
    }

    if (rawTotalKey) {
      const rawNum = parseNumericStrict(rawRow[rawTotalKey]);
      if (rawNum !== null) computedInputSum += rawNum;
    }
  }

  // Synchronized Reconciliation Confidence Score (matches Dashboard & Cleaner: excludes raw_amount lineage & benign empty markers)
  const activeHeaders = headers.filter((h) => h !== 'raw_amount');
  const totalCells = Math.max(1, job.cleanedRows.length * Math.max(1, activeHeaders.length));
  let unresolvedErrorCells = 0;
  for (const row of job.cleanedRows) {
    for (const h of activeHeaders) {
      const v = String(row[h] ?? '').trim();
      if (/^\[ERROR:/i.test(v)) {
        unresolvedErrorCells++;
      }
    }
  }
  const highPriorityCount = job.anomalies.filter(
    (a) => a.severity === 'critical' && /financial|currency|negative|fx/i.test(`${a.category} ${a.explanation}`)
  ).length;
  const criticalPenalty = Math.min(2.5, highPriorityCount * 0.15);
  const computedConfidence = Number(
    Math.max(
      0,
      Math.min(100, ((totalCells - unresolvedErrorCells) / totalCells) * 100 - criticalPenalty)
    ).toFixed(1)
  );

  // If auditMetadata already holds an accurate high-confidence score matching active error state, prefer it;
  // otherwise use the synchronized computedConfidence (preventing legacy 90.4% mismatches).
  const storedScore = job.auditMetadata?.reconciliationConfidenceScore;
  const confidenceScore =
    storedScore !== undefined && Math.abs(storedScore - computedConfidence) <= 1.0
      ? storedScore
      : computedConfidence;

  const roundedGross = Number(grossInflow.toFixed(2));
  const roundedNeg = Number(negativeExposure.toFixed(2));
  const roundedNet = Number((roundedGross - roundedNeg).toFixed(2));
  const roundedAlgebraic = Number(algebraicSum.toFixed(2));
  const resolvedInputSum =
    job.auditMetadata && (job.auditMetadata.inputSum !== 0 || computedInputSum === 0)
      ? job.auditMetadata.inputSum
      : Number(computedInputSum.toFixed(2));
  const resolvedOutputSum = roundedAlgebraic !== 0 ? roundedAlgebraic : job.auditMetadata?.outputSum ?? 0;

  const fallbackHash = crypto
    .createHash('sha256')
    .update(JSON.stringify({ fileName: job.fileName, rawHeaders: job.rawHeaders, rawRows: job.rawRows }))
    .digest('hex');

  const detectedCurrencies = Array.from(currencySet);
  const currencySummary = Array.from(currencyPositiveTotals.entries())
    .map(([code, total]) => ({ code, total }))
    .sort((a, b) => b.total - a.total);

  const meta: AuditMetadata = {
    fileHashSha256: job.auditMetadata?.fileHashSha256 || fallbackHash,
    timestampUtc: job.auditMetadata?.timestampUtc || job.createdAt,
    rowsIngested: job.auditMetadata?.rowsIngested ?? (job.rawRows.length || job.rowCount),
    rowsCleaned: job.auditMetadata?.rowsCleaned ?? job.cleanedRows.length,
    rowChecksumMatch:
      (job.auditMetadata?.rowsIngested ?? (job.rawRows.length || job.rowCount)) ===
      (job.auditMetadata?.rowsCleaned ?? job.cleanedRows.length),
    inputSum: resolvedInputSum,
    outputSum: resolvedOutputSum,
    reconciledVariance: Number((resolvedOutputSum - resolvedInputSum).toFixed(2)),
    primaryAmountColumn:
      job.auditMetadata?.primaryAmountColumn ?? (candidateTotalCols[0] || null),
    detectedCurrencies,
    leakageRecoveredValue: Math.max(job.auditMetadata?.leakageRecoveredValue ?? 0, roundedNeg),
    reconciliationConfidenceScore: confidenceScore,
  };

  return {
    meta,
    grossInflow: roundedGross,
    negativeExposure: roundedNeg,
    netInflow: roundedNet,
    confidenceScore,
    detectedCurrencies,
    currencySummary,
    isMultiCurrency: detectedCurrencies.length > 1 || currencySummary.length > 1,
  };
}

/**
 * Generates clean UTF-8 CSV with BOM (\uFEFF) so Excel decodes €, £, ¥ cleanly without mojibake,
 * starting directly on Row 1 with column headers (no `# ...` comment lines corrupting columns).
 */
export function generateCsvBuffer(job: CleanJobRecord): Buffer {
  const rowsAsMatrix: string[][] = [job.cleanedHeaders];
  for (const row of job.cleanedRows) {
    rowsAsMatrix.push(
      job.cleanedHeaders.map((h) => sanitizeMojibake(String(row[h] ?? '')))
    );
  }
  const csvString = `\uFEFF${stringifyCsv(rowsAsMatrix)}`;
  return Buffer.from(csvString, 'utf8');
}

/**
 * Generates a production-grade multi-tab XLSX workbook using ExcelJS:
 * - Strict UTF-8 encoding (zero mojibake for €, £, $, ¥)
 * - Tab 1 ("Cleaned_Data"): Bold stylized Row 1 headers, frozen top row, strict column typing:
 *   * qty_sold -> numeric integer (#,##0)
 *   * unit_price -> numeric currency float with native Excel currency format
 *   * tax_rate -> numeric percentage float (0% / 0.00%)
 *   * total_amount -> live Excel formula (=F2*G2) with native currency format
 *   * contact_phone -> forced Text/String (@) so Excel never renders 5.55E+09
 * - Tab 2 ("Pre-Audit_Attestation"): Institutional SHA-256, UTC Timestamp, Row Checksum,
 *   Synchronized Confidence Score, Detected Currencies, Synchronized Gross/Net Totals,
 *   and live SUMIFS isolated currency subtotals.
 */
export async function generateXlsxBuffer(job: CleanJobRecord): Promise<Buffer> {
  const synced = computeSynchronizedMetrics(job);
  const { meta, grossInflow, negativeExposure, netInflow, confidenceScore, currencySummary, isMultiCurrency } = synced;

  const wb = new ExcelJS.Workbook();
  wb.creator = 'Rafi Digital Studio — DocuCleanse Enterprise';
  wb.created = new Date();
  wb.modified = new Date();

  const headers = job.cleanedHeaders;
  const mappingByHeader = new Map(job.schemaMappings.map((m) => [m.normalizedHeader, m]));
  const formulaRepairedKeys = new Set(
    job.cellDiffs
      .filter((d) => d.changeType === 'formula_error')
      .map((d) => `${d.rowIndex}:${d.column}`)
  );

  // Column role detection
  const qtyColIdx = headers.findIndex((h) =>
    /\b(qty|quantity|units)\b|qty_sold|quantity_sold|units_sold/i.test(h)
  );
  const unitPriceColIdx = headers.findIndex(
    (h) =>
      /\b(unit[\s_-]?price|unit[\s_-]?cost|price)\b/i.test(h) &&
      !/total|tax|discount|rate/i.test(h)
  );
  const taxRateColIdx = headers.findIndex((h) =>
    /tax[\s_-]?rate|tax[\s_-]?pct|tax[\s_-]?percent|tax[\s_-]?%|\btax\b.*\brate\b|rate[\s_-]?pct/i.test(
      h
    )
  );
  const totalColIdx = headers.findIndex(
    (h) =>
      h !== 'raw_amount' &&
      h !== 'normalized_amount' &&
      /\b(total[\s_-]?amount|line[\s_-]?total|net[\s_-]?total|total|amount|revenue|mrr|balance)\b/i.test(
        h
      ) &&
      !/unit[\s_-]?price|tax|rate|qty|quantity/i.test(h)
  );
  const normalizedAmtColIdx = headers.indexOf('normalized_amount');
  const currencyCodeColIdx = headers.indexOf('currency_code');

  const qtyColLetter = qtyColIdx >= 0 ? colIndexToExcelLetter(qtyColIdx) : '';
  const unitPriceColLetter = unitPriceColIdx >= 0 ? colIndexToExcelLetter(unitPriceColIdx) : '';
  const totalColLetter = totalColIdx >= 0 ? colIndexToExcelLetter(totalColIdx) : '';

  const headerFill: ExcelJS.Fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FF0F172A' },
  };
  const headerFont: Partial<ExcelJS.Font> = {
    name: 'Calibri',
    size: 11,
    bold: true,
    color: { argb: 'FFFFFFFF' },
  };
  const bodyFont: Partial<ExcelJS.Font> = {
    name: 'Calibri',
    size: 10.5,
    color: { argb: 'FF0F172A' },
  };
  const thinBorder: Partial<ExcelJS.Borders> = {
    top: { style: 'thin', color: { argb: 'FFE2E8F0' } },
    bottom: { style: 'thin', color: { argb: 'FFE2E8F0' } },
    left: { style: 'thin', color: { argb: 'FFE2E8F0' } },
    right: { style: 'thin', color: { argb: 'FFE2E8F0' } },
  };
  const zebraFill: ExcelJS.Fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FFF8FAFC' },
  };

  // ============================================================================
  // TAB 1: Cleaned_Data (Starts directly on Row 1, frozen header, strict typing)
  // ============================================================================
  const wsData = wb.addWorksheet('Cleaned_Data', {
    views: [{ state: 'frozen', ySplit: 1 }],
  });

  // Row 1: Bold stylized headers
  const headerRow = wsData.addRow(headers);
  headerRow.height = 26;
  headerRow.eachCell((cell) => {
    cell.fill = headerFill;
    cell.font = headerFont;
    cell.alignment = { vertical: 'middle', horizontal: 'left', indent: 1 };
    cell.border = thinBorder;
  });

  const colMaxWidths = headers.map((h) => Math.max(14, h.length + 5));

  // Data Rows (Row 2..N+1)
  job.cleanedRows.forEach((row, rIdx) => {
    const excelRowNum = rIdx + 2;
    const rawRow = job.rawRows[rIdx] || {};
    const excelRow = wsData.getRow(excelRowNum);
    excelRow.height = 21;

    const explicitCur = String(row.currency_code ?? '').trim().toUpperCase();
    const rowCurrency =
      (explicitCur && explicitCur !== 'N/A' ? explicitCur : null) ||
      (totalColIdx >= 0 ? detectCurrencyCode(row[headers[totalColIdx]]) : null) ||
      (unitPriceColIdx >= 0 ? detectCurrencyCode(row[headers[unitPriceColIdx]]) : null);

    const rowQty = qtyColIdx >= 0 ? parseNumericStrict(row[headers[qtyColIdx]]) : null;
    const rowUnitPrice =
      unitPriceColIdx >= 0 ? parseNumericStrict(row[headers[unitPriceColIdx]]) : null;

    headers.forEach((h, cIdx) => {
      const cell = excelRow.getCell(cIdx + 1);
      const rawStr = sanitizeMojibake(String(row[h] ?? '')).trim();
      const mapping = mappingByHeader.get(h);
      const lower = h.toLowerCase();

      cell.font = bodyFont;
      cell.border = thinBorder;
      if (rIdx % 2 === 1) {
        cell.fill = zebraFill;
      }

      colMaxWidths[cIdx] = Math.min(40, Math.max(colMaxWidths[cIdx], rawStr.length + 4));

      // 1. Phone numbers, IDs, codes, raw_amount, dates, emails, statuses -> STRICT TEXT ('@')
      const looksLikePhoneValue =
        cIdx !== qtyColIdx &&
        cIdx !== unitPriceColIdx &&
        cIdx !== totalColIdx &&
        cIdx !== normalizedAmtColIdx &&
        cIdx !== taxRateColIdx &&
        /^(\+\d[\d\s().-]{7,}|\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}|\d{10,15})$/.test(rawStr);
      const isPhoneCol =
        mapping?.detectedType === 'phone' ||
        /(phone|tel|mobile|whatsapp|contact_phone|contact_num)/i.test(lower) ||
        looksLikePhoneValue;
      const isStrictTextCol =
        isPhoneCol ||
        lower === 'raw_amount' ||
        lower === 'currency_code' ||
        mapping?.detectedType === 'email' ||
        mapping?.detectedType === 'date' ||
        mapping?.detectedType === 'status' ||
        /\b(txn_id|order_id|invoice_id|id|code|zip|postal)\b/i.test(lower) ||
        rawStr === '' ||
        rawStr.startsWith('[ERROR') ||
        rawStr === '[MISSING]';

      if (isStrictTextCol) {
        cell.value = String(rawStr);
        cell.numFmt = '@';
        cell.alignment = { vertical: 'middle', horizontal: 'left' };
        return;
      }

      // 2. Quantity column (e.g., Column F: qty_sold) -> STRICT numeric integer, NEVER currency
      if (cIdx === qtyColIdx) {
        const qtyVal = parseNumericStrict(rawStr);
        if (qtyVal !== null) {
          cell.value = qtyVal;
          cell.numFmt = Number.isInteger(qtyVal) ? '#,##0' : '#,##0.00';
          cell.alignment = { vertical: 'middle', horizontal: 'right' };
          return;
        }
      }

      // 3. Tax Rate / Percentage column (e.g., Column H: tax_rate) -> numeric percentage float formatted as %
      if (cIdx === taxRateColIdx || rawStr.endsWith('%')) {
        const pct = parseTaxRateFraction(rawStr);
        if (pct !== null) {
          cell.value = pct;
          const pctTimes100 = Number((pct * 100).toFixed(4));
          cell.numFmt = Number.isInteger(pctTimes100) ? '0%' : '0.00%';
          cell.alignment = { vertical: 'middle', horizontal: 'right' };
          return;
        }
      }

      // 4. Unit Price column (e.g., Column G: unit_price) -> numeric currency float with native Excel currency format
      if (cIdx === unitPriceColIdx) {
        const priceVal = parseNumericStrict(rawStr);
        if (priceVal !== null) {
          const priceCur = detectCurrencyCode(rawStr) || rowCurrency;
          cell.value = priceVal;
          cell.numFmt = excelNumberFormatForCurrency(priceCur);
          cell.alignment = { vertical: 'middle', horizontal: 'right' };
          return;
        }
      }

      // 5. Total Amount column (e.g., Column I: total_amount) -> calculated formula (qty_sold * unit_price) with currency format
      if (cIdx === totalColIdx) {
        let totalVal = parseNumericStrict(rawStr);
        const totalCur = detectCurrencyCode(rawStr) || rowCurrency;
        const numFmt = excelNumberFormatForCurrency(totalCur);

        if (qtyColLetter && unitPriceColLetter && rowQty !== null && rowUnitPrice !== null) {
          const calcLine = Number((rowQty * rowUnitPrice).toFixed(2));
          if (totalVal === null || (totalVal === 0 && calcLine !== 0)) {
            totalVal = calcLine;
          }
          const wasFormulaError =
            formulaRepairedKeys.has(`${rIdx}:${h}`) ||
            /^=?#(REF!|DIV\/0!|VALUE!|NAME\?|N\/A)/i.test(String(rawRow[mapping?.rawHeader || h] ?? '').trim());

          if (wasFormulaError || Math.abs(calcLine - totalVal) <= 0.02) {
            cell.value = {
              formula: `${qtyColLetter}${excelRowNum}*${unitPriceColLetter}${excelRowNum}`,
              result: totalVal,
            };
            cell.numFmt = numFmt;
            cell.alignment = { vertical: 'middle', horizontal: 'right' };
            return;
          }
        }

        if (totalVal !== null) {
          cell.value = totalVal;
          cell.numFmt = numFmt;
          cell.alignment = { vertical: 'middle', horizontal: 'right' };
          return;
        }
      }

      // 6. normalized_amount -> live reference to total_amount (or numeric currency float)
      if (cIdx === normalizedAmtColIdx) {
        const normVal = parseNumericStrict(rawStr);
        const normCur = detectCurrencyCode(rawStr) || rowCurrency;
        const numFmt = excelNumberFormatForCurrency(normCur);
        if (normVal !== null) {
          if (totalColLetter && totalColIdx !== normalizedAmtColIdx) {
            const primaryVal = parseNumericStrict(row[headers[totalColIdx]]);
            if (primaryVal !== null && Math.abs(primaryVal - normVal) <= 0.02) {
              cell.value = {
                formula: `${totalColLetter}${excelRowNum}`,
                result: normVal,
              };
              cell.numFmt = numFmt;
              cell.alignment = { vertical: 'middle', horizontal: 'right' };
              return;
            }
          }
          cell.value = normVal;
          cell.numFmt = numFmt;
          cell.alignment = { vertical: 'middle', horizontal: 'right' };
          return;
        }
      }

      // 7. Any other numeric or currency column
      const genericNum = parseNumericStrict(rawStr);
      const detectedCellCur = detectCurrencyCode(rawStr);
      if (
        genericNum !== null &&
        (mapping?.detectedType === 'currency' ||
          mapping?.detectedType === 'number' ||
          detectedCellCur !== null)
      ) {
        cell.value = genericNum;
        cell.numFmt =
          mapping?.detectedType === 'currency' || detectedCellCur !== null
            ? excelNumberFormatForCurrency(detectedCellCur || rowCurrency)
            : Number.isInteger(genericNum)
            ? '#,##0'
            : '#,##0.00';
        cell.alignment = { vertical: 'middle', horizontal: 'right' };
        return;
      }

      // Default: clean UTF-8 string
      cell.value = rawStr;
      cell.alignment = { vertical: 'middle', horizontal: 'left' };
    });
  });

  if (headers.length > 0) {
    wsData.autoFilter = {
      from: { row: 1, column: 1 },
      to: { row: 1, column: headers.length },
    };
  }
  headers.forEach((_, idx) => {
    wsData.getColumn(idx + 1).width = Math.max(14, colMaxWidths[idx]);
  });

  // ============================================================================
  // TAB 2: Pre-Audit_Attestation (Institutional Metadata & Synchronized Totals)
  // ============================================================================
  const wsCert = wb.addWorksheet('Pre-Audit_Attestation', {
    views: [{ state: 'frozen', ySplit: 2 }],
  });

  wsCert.mergeCells('A1:B1');
  const titleCell = wsCert.getCell('A1');
  titleCell.value = 'DocuCleanse — Formal Pre-Audit Attestation & Reconciliation Certificate';
  titleCell.fill = headerFill;
  titleCell.font = { name: 'Calibri', size: 13, bold: true, color: { argb: 'FFFFFFFF' } };
  titleCell.alignment = { vertical: 'middle', horizontal: 'left', indent: 1 };
  wsCert.getRow(1).height = 30;

  const certSubHeader = wsCert.addRow(['Compliance / Reconciliation Field', 'Verified Value']);
  certSubHeader.height = 24;
  certSubHeader.eachCell((cell) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E293B' } };
    cell.font = { name: 'Calibri', size: 10.5, bold: true, color: { argb: 'FFFFFFFF' } };
    cell.alignment = { vertical: 'middle', horizontal: 'left', indent: 1 };
    cell.border = thinBorder;
  });

  const lastDataRow = Math.max(2, job.cleanedRows.length + 1);
  const sumTargetIdx = normalizedAmtColIdx >= 0 ? normalizedAmtColIdx : totalColIdx;
  const sumColLetter = sumTargetIdx >= 0 ? colIndexToExcelLetter(sumTargetIdx) : '';
  const dataAmtRange = sumColLetter ? `'Cleaned_Data'!${sumColLetter}2:${sumColLetter}${lastDataRow}` : '';
  const singleCurFmt =
    meta.detectedCurrencies.length === 1
      ? excelNumberFormatForCurrency(meta.detectedCurrencies[0])
      : '#,##0.00';

  type CertEntry = {
    label: string;
    value: ExcelJS.CellValue;
    numFmt?: string;
    bold?: boolean;
  };

  const certEntries: CertEntry[] = [
    { label: 'Issuing Authority', value: 'Rafi Digital Studio — DocuCleanse Enterprise' },
    {
      label: 'Enterprise Privacy Shield',
      value: 'Ephemeral RAM Processing · Zero Permanent Data Storage · GDPR & Pre-Audit Ready',
    },
    { label: 'Certificate / Job ID', value: job.id },
    { label: 'Source File Name', value: job.fileName },
    { label: 'Document Classification', value: job.documentCategory.replace('_', ' ') },
    { label: 'File Hash (SHA-256)', value: meta.fileHashSha256, numFmt: '@' },
    { label: 'Execution Timestamp (UTC)', value: formatUtcTimestamp(meta.timestampUtc), numFmt: '@' },
    { label: 'Total Rows Ingested', value: meta.rowsIngested, numFmt: '#,##0' },
    { label: 'Total Rows Cleaned', value: meta.rowsCleaned, numFmt: '#,##0' },
    {
      label: 'Row Verification Checksum',
      value: `${meta.rowsIngested} Ingested / ${meta.rowsCleaned} Cleaned (${meta.rowChecksumMatch ? 'VERIFIED' : 'VARIANCE'})`,
    },
    {
      label: 'Reconciliation Confidence Score',
      value: `${confidenceScore.toFixed(1)}% Cleaned`,
      bold: true,
    },
    {
      label: 'Detected Currencies (ISO-4217)',
      value: meta.detectedCurrencies.length > 0 ? meta.detectedCurrencies.join(', ') : 'N/A',
    },
    {
      label: 'Primary Monetary Column',
      value: meta.primaryAmountColumn || 'N/A',
    },
  ];

  // Track exact row numbers for synchronized Gross, Leakage, Net, and Input/Output formulas
  const grossRowNum = 3 + certEntries.length;
  const negRowNum = grossRowNum + 1;
  const netRowNum = grossRowNum + 2;
  const inputRowNum = grossRowNum + 3;
  const outputRowNum = grossRowNum + 4;

  certEntries.push(
    {
      label: isMultiCurrency
        ? `Gross Inflow — Unconverted Multi-Currency Face Value (${meta.detectedCurrencies.join(' · ')})`
        : 'Total Revenue / Gross Inflow (Positive Totals)',
      value: dataAmtRange
        ? { formula: `SUMIF(${dataAmtRange},">0")`, result: grossInflow }
        : grossInflow,
      numFmt: singleCurFmt,
      bold: true,
    },
    {
      label: 'Identified Leakage / Negative Balance Exposure',
      value: dataAmtRange
        ? { formula: `ABS(SUMIF(${dataAmtRange},"<0"))`, result: negativeExposure }
        : negativeExposure,
      numFmt: singleCurFmt,
    },
    {
      label: isMultiCurrency
        ? 'Net Reconciled Inflow (Gross − Negative Exposure, Unconverted)'
        : 'Net Reconciled Inflow (Gross − Refunds/Negatives)',
      value: { formula: `B${grossRowNum}-B${negRowNum}`, result: netInflow },
      numFmt: singleCurFmt,
      bold: true,
    },
    {
      label: 'Total Input Sum (Raw Parseable Values)',
      value: meta.inputSum,
      numFmt: singleCurFmt,
    },
    {
      label: 'Total Output Sum (Algebraic Ledger Sum)',
      value: dataAmtRange ? { formula: `SUM(${dataAmtRange})`, result: meta.outputSum } : meta.outputSum,
      numFmt: singleCurFmt,
    },
    {
      label: 'Reconciled Net Variance (Output − Input)',
      value: { formula: `B${outputRowNum}-B${inputRowNum}`, result: meta.reconciledVariance },
      numFmt: '+0.00;-0.00;0.00',
    },
    {
      label: 'Total Cells Normalized',
      value: job.cellDiffs.length,
      numFmt: '#,##0',
    },
    {
      label: 'Total Audit Findings',
      value: job.anomalies.length,
      numFmt: '#,##0',
    }
  );

  certEntries.forEach((entry, idx) => {
    const r = wsCert.addRow([entry.label, entry.value]);
    r.height = 21;
    const c1 = r.getCell(1);
    const c2 = r.getCell(2);
    c1.font = { ...bodyFont, bold: true, color: { argb: 'FF334155' } };
    c2.font = { ...bodyFont, bold: Boolean(entry.bold) };
    c1.border = thinBorder;
    c2.border = thinBorder;
    c1.alignment = { vertical: 'middle', horizontal: 'left', indent: 1 };
    c2.alignment = {
      vertical: 'middle',
      horizontal: typeof entry.value === 'number' || (typeof entry.value === 'object' && entry.value !== null && 'formula' in entry.value) ? 'right' : 'left',
    };
    if (entry.numFmt) {
      c2.numFmt = entry.numFmt;
    }
    if (idx % 2 === 1) {
      c1.fill = zebraFill;
      c2.fill = zebraFill;
    }
  });

  // Isolated Multi-Currency Breakdown Table on Tab 2 with live SUMIFS
  if (currencySummary.length > 0 && dataAmtRange) {
    wsCert.addRow([]);
    const sectionRow = wsCert.addRow([
      'Isolated Multi-Currency Gross Inflow Subtotals (No Cross-FX Mixing)',
      'Positive Subtotal',
    ]);
    sectionRow.height = 24;
    sectionRow.eachCell((cell) => {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E293B' } };
      cell.font = { name: 'Calibri', size: 10.5, bold: true, color: { argb: 'FFFFFFFF' } };
      cell.border = thinBorder;
      cell.alignment = { vertical: 'middle', horizontal: 'left', indent: 1 };
    });

    const curCodeLetter =
      currencyCodeColIdx >= 0 ? colIndexToExcelLetter(currencyCodeColIdx) : '';

    currencySummary.forEach((entry, idx) => {
      const valuePayload: ExcelJS.CellValue = curCodeLetter
        ? {
            formula: `SUMIFS(${dataAmtRange},'Cleaned_Data'!${curCodeLetter}2:${curCodeLetter}${lastDataRow},"${entry.code}",${dataAmtRange},">0")`,
            result: entry.total,
          }
        : entry.total;

      const r = wsCert.addRow([entry.code, valuePayload]);
      r.height = 21;
      const c1 = r.getCell(1);
      const c2 = r.getCell(2);
      c1.font = { ...bodyFont, bold: true };
      c2.font = { ...bodyFont, bold: true };
      c1.border = thinBorder;
      c2.border = thinBorder;
      c1.alignment = { vertical: 'middle', horizontal: 'left', indent: 1 };
      c2.alignment = { vertical: 'middle', horizontal: 'right' };
      c2.numFmt = excelNumberFormatForCurrency(entry.code);
      if (idx % 2 === 1) {
        c1.fill = zebraFill;
        c2.fill = zebraFill;
      }
    });
  }

  wsCert.getColumn(1).width = 58;
  wsCert.getColumn(2).width = 74;

  // ============================================================================
  // TAB 3: Anomaly_Audit_Log
  // ============================================================================
  const wsAnom = wb.addWorksheet('Anomaly_Audit_Log', {
    views: [{ state: 'frozen', ySplit: 1 }],
  });
  const anomHeaders = ['Severity', 'Category', 'Location', 'Raw Value', 'Normalized / Suggested', 'Explanation'];
  const anomHeadRow = wsAnom.addRow(anomHeaders);
  anomHeadRow.height = 26;
  anomHeadRow.eachCell((cell) => {
    cell.fill = headerFill;
    cell.font = headerFont;
    cell.border = thinBorder;
    cell.alignment = { vertical: 'middle', horizontal: 'left', indent: 1 };
  });

  job.anomalies.forEach((a, idx) => {
    const r = wsAnom.addRow([
      a.severity.toUpperCase(),
      sanitizeMojibake(a.category),
      sanitizeMojibake(a.location),
      sanitizeMojibake(a.rawValue),
      sanitizeMojibake(a.suggestedOrFixedValue),
      sanitizeMojibake(a.explanation),
    ]);
    r.height = 22;
    r.eachCell((cell, colNum) => {
      cell.font = bodyFont;
      cell.border = thinBorder;
      cell.numFmt = '@';
      cell.alignment = { vertical: 'middle', horizontal: 'left', wrapText: colNum === 6 };
      if (colNum === 1) {
        cell.font = {
          ...bodyFont,
          bold: true,
          color: {
            argb:
              a.severity === 'critical'
                ? 'FFDC2626'
                : a.severity === 'warning'
                ? 'FFD97706'
                : 'FF15803D',
          },
        };
      } else if (idx % 2 === 1) {
        cell.fill = zebraFill;
      }
    });
  });

  wsAnom.getColumn(1).width = 14;
  wsAnom.getColumn(2).width = 28;
  wsAnom.getColumn(3).width = 30;
  wsAnom.getColumn(4).width = 26;
  wsAnom.getColumn(5).width = 30;
  wsAnom.getColumn(6).width = 62;

  // ============================================================================
  // TAB 4: Schema_Mapping
  // ============================================================================
  const wsMap = wb.addWorksheet('Schema_Mapping', {
    views: [{ state: 'frozen', ySplit: 1 }],
  });
  const mapHeadRow = wsMap.addRow(['Raw Header', 'Normalized Header', 'Detected Type', 'Mapping Rationale']);
  mapHeadRow.height = 26;
  mapHeadRow.eachCell((cell) => {
    cell.fill = headerFill;
    cell.font = headerFont;
    cell.border = thinBorder;
    cell.alignment = { vertical: 'middle', horizontal: 'left', indent: 1 };
  });

  job.schemaMappings.forEach((m, idx) => {
    const r = wsMap.addRow([m.rawHeader, m.normalizedHeader, m.detectedType, m.reason]);
    r.height = 21;
    r.eachCell((cell) => {
      cell.font = bodyFont;
      cell.border = thinBorder;
      cell.alignment = { vertical: 'middle', horizontal: 'left' };
      if (idx % 2 === 1) cell.fill = zebraFill;
    });
  });

  wsMap.getColumn(1).width = 26;
  wsMap.getColumn(2).width = 26;
  wsMap.getColumn(3).width = 16;
  wsMap.getColumn(4).width = 54;

  const arrayBuffer = await wb.xlsx.writeBuffer();
  return Buffer.from(arrayBuffer);
}

export async function generateSummaryPdfBuffer(job: CleanJobRecord): Promise<Buffer> {
  const synced = computeSynchronizedMetrics(job);
  const { meta, grossInflow, netInflow, confidenceScore, currencySummary, isMultiCurrency } = synced;

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'LETTER',
      margin: 44,
      info: {
        Title: `Formal Pre-Audit Attestation Certificate — ${job.fileName}`,
        Author: 'Rafi Digital Studio — DocuCleanse Enterprise',
        Subject: `SHA-256: ${meta.fileHashSha256}`,
      },
    });

    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    // Formal Certificate Banner Header
    const bannerTop = 36;
    doc.rect(44, bannerTop, 524, 66).fill('#0F172A');

    doc
      .fillColor('#93C5FD')
      .font('Helvetica-Bold')
      .fontSize(8)
      .text('RAFI DIGITAL STUDIO  |  DOCUCLEANSE INSTITUTIONAL ASSURANCE', 58, bannerTop + 12, {
        characterSpacing: 1.0,
      });

    doc
      .fillColor('#FFFFFF')
      .font('Helvetica-Bold')
      .fontSize(15.5)
      .text('Formal Pre-Audit Attestation Certificate', 58, bannerTop + 26);

    doc
      .fillColor('#CBD5E1')
      .font('Helvetica')
      .fontSize(7.5)
      .text(
        'Enterprise Privacy Shield: Ephemeral RAM Processing · Zero Permanent Data Storage · GDPR & Pre-Audit Ready',
        58,
        bannerTop + 48
      );

    doc
      .fillColor('#E2E8F0')
      .font('Courier-Bold')
      .fontSize(8.5)
      .text(`CERT ID: ${job.id.toUpperCase()}`, 380, bannerTop + 13, { width: 174, align: 'right' });

    doc
      .fillColor('#93C5FD')
      .font('Courier')
      .fontSize(8.5)
      .text(formatUtcTimestamp(meta.timestampUtc), 380, bannerTop + 27, {
        width: 174,
        align: 'right',
      });

    doc.y = bannerTop + 78;

    // Formal Compliance & Integrity Metadata Box
    const hasMultiCurLine = currencySummary.length > 1;
    const boxTop = doc.y;
    const boxHeight = hasMultiCurLine ? 186 : 154;
    doc
      .roundedRect(44, boxTop, 524, boxHeight, 4)
      .fillAndStroke('#F8FAFC', '#CBD5E1');

    // Row 1: Source File & Category
    doc
      .fillColor('#64748B')
      .font('Helvetica-Bold')
      .fontSize(7.5)
      .text('SOURCE DOCUMENT', 56, boxTop + 10);
    doc
      .fillColor('#0F172A')
      .font('Helvetica-Bold')
      .fontSize(9.5)
      .text(job.fileName, 56, boxTop + 21, { width: 250 });

    doc
      .fillColor('#64748B')
      .font('Helvetica-Bold')
      .fontSize(7.5)
      .text('CLASSIFICATION & DETECTED CURRENCIES', 320, boxTop + 10);
    doc
      .fillColor('#0F172A')
      .font('Helvetica-Bold')
      .fontSize(9.5)
      .text(
        `${job.documentCategory.replace('_', ' ').toUpperCase()}   |   ${
          meta.detectedCurrencies.length > 0 ? meta.detectedCurrencies.join(', ') : 'NON-FINANCIAL'
        }`,
        320,
        boxTop + 21,
        { width: 235 }
      );

    // Row 2: SHA-256 Integrity Signature (full 64-char cryptographic digest matching UI)
    doc
      .fillColor('#64748B')
      .font('Helvetica-Bold')
      .fontSize(7.5)
      .text('FILE INTEGRITY HASH (SHA-256 SIGNATURE)', 56, boxTop + 42);
    doc
      .fillColor('#1E293B')
      .font('Courier')
      .fontSize(8)
      .text(meta.fileHashSha256, 56, boxTop + 53, { width: 500 });

    // Divider inside box
    doc
      .strokeColor('#E2E8F0')
      .lineWidth(0.75)
      .moveTo(56, boxTop + 70)
      .lineTo(556, boxTop + 70)
      .stroke();

    // Row 3: Row Checksum & Reconciliation Confidence Score
    doc
      .fillColor('#64748B')
      .font('Helvetica-Bold')
      .fontSize(7.5)
      .text('ROW VERIFICATION CHECKSUM', 56, boxTop + 78);
    doc
      .fillColor(meta.rowChecksumMatch ? '#15803D' : '#DC2626')
      .font('Courier-Bold')
      .fontSize(9.5)
      .text(
        `${meta.rowsIngested} Ingested / ${meta.rowsCleaned} Cleaned (${meta.rowChecksumMatch ? 'VERIFIED' : 'VARIANCE'})`,
        56,
        boxTop + 89
      );

    doc
      .fillColor('#64748B')
      .font('Helvetica-Bold')
      .fontSize(7.5)
      .text('RECONCILIATION CONFIDENCE SCORE', 320, boxTop + 78);
    doc
      .fillColor('#1D4ED8')
      .font('Courier-Bold')
      .fontSize(9.5)
      .text(`${confidenceScore.toFixed(1)}% Cleaned`, 320, boxTop + 89);

    // Row 4: Reconciled Gross & Net Totals (Synchronized with Dashboard)
    doc
      .fillColor('#64748B')
      .font('Helvetica-Bold')
      .fontSize(7.5)
      .text(
        meta.primaryAmountColumn
          ? isMultiCurrency
            ? `RECONCILED TOTALS — UNCONVERTED MULTI-CURRENCY FACE VALUE (${meta.detectedCurrencies.join(' · ')})`
            : 'RECONCILED GROSS & NET TOTALS'
          : 'DATASET LEDGER PROFILE',
        56,
        boxTop + 112
      );
    const deltaSign = meta.reconciledVariance >= 0 ? '+' : '';
    const varianceLine = meta.primaryAmountColumn
      ? `Gross Inflow: ${formatMoney(grossInflow, meta.detectedCurrencies)}   |   Net Inflow: ${formatMoney(netInflow, meta.detectedCurrencies)}   |   Delta: ${deltaSign}${formatMoney(meta.reconciledVariance, meta.detectedCurrencies)}`
      : `Non-Financial Dataset (${job.cleanedHeaders.length} columns · No monetary amount columns detected)`;
    doc
      .fillColor('#0F172A')
      .font('Courier-Bold')
      .fontSize(9)
      .text(varianceLine, 56, boxTop + 124, { width: 500 });

    if (hasMultiCurLine) {
      const multiLine = currencySummary
        .map((c) => formatIsoCurrencyTotal(c.total, c.code))
        .join('  ·  ');

      doc
        .fillColor('#64748B')
        .font('Helvetica-Bold')
        .fontSize(7)
        .text('ISOLATED MULTI-CURRENCY GROSS INFLOW SUBTOTALS (NO CROSS-FX MIXING)', 56, boxTop + 148);
      doc
        .fillColor('#1E3A8A')
        .font('Courier-Bold')
        .fontSize(8.5)
        .text(multiLine, 56, boxTop + 160, { width: 500 });
    }

    doc.y = boxTop + boxHeight + 14;

    // Audit KPI Line
    const criticalCount = job.anomalies.filter((a) => a.severity === 'critical').length;
    const warningCount = job.anomalies.filter((a) => a.severity === 'warning').length;
    const fixedCount = job.anomalies.filter((a) => a.severity === 'fixed').length;

    const kpiSummaryText = meta.primaryAmountColumn
      ? `Cells Normalized: ${job.cellDiffs.length}     Critical / High-Priority Alerts: ${criticalCount}     Warnings: ${warningCount}     Auto-Fixed: ${fixedCount}     Leakage Flagged: ${formatMoney(meta.leakageRecoveredValue, meta.detectedCurrencies)}`
      : `Cells Normalized: ${job.cellDiffs.length}     Critical Alerts: ${criticalCount}     Warnings: ${warningCount}     Auto-Fixed: ${fixedCount}`;

    doc
      .fillColor('#0F172A')
      .font('Helvetica-Bold')
      .fontSize(9.5)
      .text(kpiSummaryText);

    // Executive Summary
    doc.moveDown(0.75);
    doc.fillColor('#0F172A').font('Helvetica-Bold').fontSize(11).text('Executive Reconciliation Summary');
    doc
      .moveDown(0.25)
      .fillColor('#334155')
      .font('Helvetica')
      .fontSize(9.5)
      .text(sanitizeMojibake(job.executiveSummary), { lineGap: 3 });

    // Anomaly & High-Priority Alerts Log
    doc.moveDown(0.85);
    doc
      .fillColor('#0F172A')
      .font('Helvetica-Bold')
      .fontSize(11)
      .text(
        meta.primaryAmountColumn
          ? 'High-Priority Financial Alerts & Anomaly Log'
          : 'Data Integrity & Anomaly Log'
      );
    doc.moveDown(0.35);

    if (job.anomalies.length === 0) {
      doc
        .fillColor('#16A34A')
        .font('Helvetica')
        .fontSize(9.5)
        .text('No anomalies detected. Dataset matches canonical institutional schema.');
    } else {
      for (const anom of job.anomalies.slice(0, 22)) {
        if (doc.y > 665) {
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
          .fontSize(8.5)
          .text(`[${anom.severity.toUpperCase()}] ${sanitizeMojibake(anom.category)} — ${sanitizeMojibake(anom.location)}`);

        doc
          .fillColor('#334155')
          .font('Helvetica')
          .fontSize(8.5)
          .text(`Raw: "${sanitizeMojibake(anom.rawValue)}"  ->  Reconciled: "${sanitizeMojibake(anom.suggestedOrFixedValue)}"`);

        doc
          .fillColor('#64748B')
          .font('Helvetica')
          .fontSize(8)
          .text(sanitizeMojibake(anom.explanation), { lineGap: 2 });

        doc.moveDown(0.4);
      }
    }

    // Preview of Normalized Records
    if (doc.y > 570) {
      doc.addPage();
    } else {
      doc.moveDown(0.6);
    }

    doc
      .fillColor('#0F172A')
      .font('Helvetica-Bold')
      .fontSize(11)
      .text(
        `Normalized Record Preview (First ${Math.min(18, job.cleanedRows.length)} of ${job.cleanedRows.length} rows)`
      );
    doc.moveDown(0.35);

    const previewHeaders = job.cleanedHeaders.slice(0, 7);
    doc
      .fillColor('#0F172A')
      .font('Helvetica-Bold')
      .fontSize(7.5)
      .text(previewHeaders.join('  |  '));

    doc
      .moveDown(0.2)
      .strokeColor('#E2E8F0')
      .lineWidth(0.5)
      .moveTo(44, doc.y)
      .lineTo(568, doc.y)
      .stroke();
    doc.moveDown(0.28);

    for (const row of job.cleanedRows.slice(0, 18)) {
      if (doc.y > 670) {
        doc.addPage();
      }
      const line = previewHeaders
        .map((h) => sanitizeMojibake(String(row[h] ?? '')).replace(/₹/g, 'INR ').slice(0, 20))
        .join('  |  ');
      doc.fillColor('#334155').font('Courier').fontSize(7.5).text(line);
      doc.moveDown(0.15);
    }

    // Formal Executive Attestation & Signature Block for Rafi Digital Studio
    if (doc.y > 610) {
      doc.addPage();
    } else {
      doc.moveDown(1.1);
    }

    const sigTop = doc.y;
    doc
      .roundedRect(44, sigTop, 524, 114, 4)
      .fillAndStroke('#F8FAFC', '#94A3B8');

    doc
      .fillColor('#0F172A')
      .font('Helvetica-Bold')
      .fontSize(8.5)
      .text('FORMAL PRE-AUDIT ATTESTATION & EXECUTIVE SIGN-OFF', 58, sigTop + 11);

    doc
      .fillColor('#475569')
      .font('Helvetica')
      .fontSize(7.8)
      .text(
        `This certificate attests that ${meta.rowsIngested} source records were deterministically normalized into ${meta.rowsCleaned} verified records in ephemeral RAM with zero permanent data storage (GDPR & Pre-Audit Ready), cryptographically bound to SHA-256 digest ${meta.fileHashSha256.slice(0, 32)}... at ${formatUtcTimestamp(meta.timestampUtc)}.`,
        58,
        sigTop + 24,
        { width: 496, lineGap: 2 }
      );

    // Left Signature Line: Rafi Digital Studio
    doc
      .fillColor('#0F172A')
      .font('Helvetica-Oblique')
      .fontSize(12)
      .text('Rafi Digital Studio', 58, sigTop + 59);

    doc
      .strokeColor('#334155')
      .lineWidth(0.9)
      .moveTo(58, sigTop + 76)
      .lineTo(276, sigTop + 76)
      .stroke();

    doc
      .fillColor('#0F172A')
      .font('Helvetica-Bold')
      .fontSize(8)
      .text('Authorized Signatory — Rafi Digital Studio', 58, sigTop + 81);

    doc
      .fillColor('#64748B')
      .font('Helvetica')
      .fontSize(7.5)
      .text('Institutional Data Assurance & Pre-Audit Compliance', 58, sigTop + 93);

    // Right Cryptographic Seal Box
    doc
      .roundedRect(334, sigTop + 56, 220, 48, 3)
      .fillAndStroke('#FFFFFF', '#CBD5E1');

    doc
      .fillColor('#15803D')
      .font('Helvetica-Bold')
      .fontSize(7.5)
      .text('VERIFIED PRE-AUDIT SEAL', 344, sigTop + 63);

    doc
      .fillColor('#1E293B')
      .font('Courier')
      .fontSize(7.2)
      .text(`UTC:      ${formatUtcTimestamp(meta.timestampUtc)}`, 344, sigTop + 75)
      .text(
        `CHECKSUM: ${meta.rowsIngested}/${meta.rowsCleaned} (${meta.rowChecksumMatch ? 'MATCH' : 'DELTA'})`,
        344,
        sigTop + 85
      )
      .text(`SHA-256:  ${meta.fileHashSha256.slice(0, 20)}...`, 344, sigTop + 94);

    doc.end();
  });
}
