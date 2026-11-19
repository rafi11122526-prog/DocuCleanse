import crypto from 'node:crypto';
import { stringify as stringifyCsv } from 'csv-stringify/sync';
import ExcelJS from 'exceljs';
import PDFDocument from 'pdfkit';
import type { AuditMetadata, CleanJobRecord } from '../types.ts';
import { injectNativeDashboardCharts } from './xlsxCharts.ts';

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

/**
 * Formats phone numbers strictly as non-formula literal display text so Excel / Google Sheets
 * never evaluates leading `+` and hyphenated segments (e.g. `+1-555-234-5678` -> `-6466`).
 */
function formatPhoneForSpreadsheetText(raw: string): string {
  const cleaned = sanitizeMojibake(raw).replace(/^['=]+/, '').trim();
  if (!cleaned || cleaned === '[MISSING]' || /^\[ERROR/i.test(cleaned)) {
    return cleaned;
  }
  // North American 10 or 11-digit phone (+1-555-234-5678 / 555-234-5678 / 5552345678) -> "+1 (555) 234-5678"
  const naMatch = cleaned.match(/^(?:\+?1[\s.-]?)?\(?(\d{3})\)?[\s.-]?(\d{3})[\s.-]?(\d{4})$/);
  if (naMatch) {
    return `+1 (${naMatch[1]}) ${naMatch[2]}-${naMatch[3]}`;
  }
  // International phone starting with "+" and hyphens (e.g. "+44-20-7946-0958") -> replace hyphens with spaces
  if (/^\+\d[\d\s()-]*-[\d\s()-]+$/.test(cleaned)) {
    return cleaned.replace(/-/g, ' ').replace(/\s+/g, ' ').trim();
  }
  return cleaned;
}

function resolveColumnLayout(
  header: string,
  detectedType?: string
): { minWidth: number; alignment: 'left' | 'center' | 'right' } {
  const lower = header.trim().toLowerCase();

  if (/\b(transaction_id|txn_id|order_id|invoice_id|record_id|id)\b/.test(lower)) {
    return { minWidth: 16, alignment: 'center' };
  }
  if (detectedType === 'date' || /\bdate\b|_date|^dt$/.test(lower)) {
    return { minWidth: 16, alignment: 'center' };
  }
  if (/(client_name|customer_name|vendor_name|account_name|company_name|\bclient\b|\bcustomer\b|\bvendor\b)/.test(lower)) {
    return { minWidth: 26, alignment: 'left' };
  }
  if (/(region_code|\bregion\b|country_code|\bcountry\b|\bstate\b|territory)/.test(lower)) {
    return { minWidth: 16, alignment: 'center' };
  }
  if (/(product_item|\bproduct\b|\bitem\b|line_item|description|service|category)/.test(lower)) {
    return { minWidth: 24, alignment: 'left' };
  }
  if (/\b(qty|quantity|units)\b|qty_sold|quantity_sold|units_sold/.test(lower)) {
    return { minWidth: 12, alignment: 'right' };
  }
  if (/\b(unit[\s_-]?price|unit[\s_-]?cost|price)\b/.test(lower) && !/total|tax|discount|rate/.test(lower)) {
    return { minWidth: 16, alignment: 'right' };
  }
  if (/tax[\s_-]?rate|tax[\s_-]?pct|tax[\s_-]?percent|tax[\s_-]?%|\btax\b.*\brate\b|rate[\s_-]?pct/.test(lower)) {
    return { minWidth: 12, alignment: 'right' };
  }
  if (lower === 'raw_amount') {
    return { minWidth: 16, alignment: 'right' };
  }
  if (
    lower === 'normalized_amount' ||
    /\b(total[\s_-]?amount|line[\s_-]?total|net[\s_-]?total|total|amount|revenue|mrr|balance)\b/.test(lower)
  ) {
    return { minWidth: 16, alignment: 'right' };
  }
  if (detectedType === 'status' || /\bstatus\b/.test(lower)) {
    return { minWidth: 14, alignment: 'center' };
  }
  if (detectedType === 'phone' || /(phone|tel|mobile|whatsapp|contact_phone|contact_num)/.test(lower)) {
    return { minWidth: 20, alignment: 'center' };
  }
  if (lower === 'currency_code' || lower === 'currency') {
    return { minWidth: 14, alignment: 'center' };
  }
  if (detectedType === 'email' || /email/.test(lower)) {
    return { minWidth: 26, alignment: 'left' };
  }
  if (detectedType === 'currency' || detectedType === 'number') {
    return { minWidth: 16, alignment: 'right' };
  }
  return { minWidth: 16, alignment: 'left' };
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

interface CurrencyBreakdownEntry {
  code: string;
  total: number;
  negativeTotal: number;
  txCount: number;
}

interface SynchronizedExportMetrics {
  meta: AuditMetadata;
  grossInflow: number;
  negativeExposure: number;
  netInflow: number;
  confidenceScore: number;
  detectedCurrencies: string[];
  currencySummary: CurrencyBreakdownEntry[];
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
  const currencyNegativeTotals = new Map<string, number>();
  const currencyTxCounts = new Map<string, number>();

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

    if (rowCurrency) {
      currencySet.add(rowCurrency);
      currencyTxCounts.set(rowCurrency, (currencyTxCounts.get(rowCurrency) ?? 0) + 1);
    }

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
        if (rowCurrency) {
          currencyNegativeTotals.set(
            rowCurrency,
            Number(((currencyNegativeTotals.get(rowCurrency) ?? 0) + Math.abs(rowAmount)).toFixed(2))
          );
        }
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
  const allCurKeys = Array.from(
    new Set([...detectedCurrencies, ...currencyPositiveTotals.keys(), ...currencyTxCounts.keys()])
  );
  const currencySummary: CurrencyBreakdownEntry[] = allCurKeys
    .map((code) => ({
      code,
      total: Number((currencyPositiveTotals.get(code) ?? 0).toFixed(2)),
      negativeTotal: Number((currencyNegativeTotals.get(code) ?? 0).toFixed(2)),
      txCount: currencyTxCounts.get(code) ?? 0,
    }))
    .sort((a, b) => b.total - a.total || b.txCount - a.txCount);

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
  const phoneHeaders = new Set(
    job.schemaMappings
      .filter((m) => m.detectedType === 'phone' || /(phone|tel|mobile|contact_phone)/i.test(m.normalizedHeader))
      .map((m) => m.normalizedHeader)
  );
  const rowsAsMatrix: string[][] = [job.cleanedHeaders];
  for (const row of job.cleanedRows) {
    rowsAsMatrix.push(
      job.cleanedHeaders.map((h) => {
        const val = sanitizeMojibake(String(row[h] ?? ''));
        return phoneHeaders.has(h) ? formatPhoneForSpreadsheetText(val) : val;
      })
    );
  }
  const csvString = `\uFEFF${stringifyCsv(rowsAsMatrix)}`;
  return Buffer.from(csvString, 'utf8');
}

/**
 * Generates an institutional 3-Tab XLSX workbook with native Excel charts:
 * - Tab 1 ("Executive_Dashboard"): First active tab with KPI cards (Gross Inflow, Identified Leakage,
 *   Reconciled Net, Confidence Score), live SUMIFS & COUNTIFS currency table, and two native OOXML charts
 *   (Bar Chart: Gross Volume by Currency + Doughnut Chart: Transaction Count by Currency).
 * - Tab 2 ("Cleaned_Data"): Deep navy (#1E293B) frozen Row 1 header, AutoFilter, strict typing
 *   (phone_number forced to Text/String '@' to prevent arithmetic subtraction, integer quantity,
 *   native currency unit_price, 0.0% tax_rate, live formula total_amount), auto-fit widths, zebra rows.
 * - Tab 3 ("Pre_Audit_Report"): Cryptographic SHA-256 hash, UTC timestamp, row checksums,
 *   compliance disclosures, reconciled totals, and embedded anomaly / schema audit summary.
 */
export async function generateXlsxBuffer(job: CleanJobRecord): Promise<Buffer> {
  const synced = computeSynchronizedMetrics(job);
  const { meta, grossInflow, negativeExposure, netInflow, confidenceScore, currencySummary, isMultiCurrency } = synced;

  const wb = new ExcelJS.Workbook();
  wb.creator = 'Rafi Digital Studio — DocuCleanse Enterprise';
  wb.created = new Date();
  wb.modified = new Date();
  // Ensure Tab 1 ("Executive_Dashboard") opens as the active visible tab
  wb.views = [
    {
      x: 0,
      y: 0,
      width: 10000,
      height: 20000,
      firstSheet: 0,
      activeTab: 0,
      visibility: 'visible',
    },
  ];

  const headers = job.cleanedHeaders;
  const mappingByHeader = new Map(job.schemaMappings.map((m) => [m.normalizedHeader, m]));
  const formulaRepairedKeys = new Set(
    job.cellDiffs
      .filter((d) => d.changeType === 'formula_error')
      .map((d) => `${d.rowIndex}:${d.column}`)
  );

  // Column role detection for Tab 2 ("Cleaned_Data")
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
  const lastDataRow = Math.max(2, job.cleanedRows.length + 1);
  const sumTargetIdx = normalizedAmtColIdx >= 0 ? normalizedAmtColIdx : totalColIdx;
  const sumColLetter = sumTargetIdx >= 0 ? colIndexToExcelLetter(sumTargetIdx) : '';
  const curCodeLetter = currencyCodeColIdx >= 0 ? colIndexToExcelLetter(currencyCodeColIdx) : '';
  const dataAmtRange = sumColLetter ? `'Cleaned_Data'!${sumColLetter}2:${sumColLetter}${lastDataRow}` : '';
  const dataCurRange = curCodeLetter ? `'Cleaned_Data'!${curCodeLetter}2:${curCodeLetter}${lastDataRow}` : '';
  const singleCurFmt =
    meta.detectedCurrencies.length === 1
      ? excelNumberFormatForCurrency(meta.detectedCurrencies[0])
      : '#,##0.00';

  // Shared Corporate Theme Tokens (#1E293B Deep Navy, Segoe UI, subtle #E2E8F0 borders)
  const navyHeaderFill: ExcelJS.Fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FF1E293B' },
  };
  const slateSubHeaderFill: ExcelJS.Fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FF334155' },
  };
  const softBannerFill: ExcelJS.Fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FFF1F5F9' },
  };
  const headerFont: Partial<ExcelJS.Font> = {
    name: 'Segoe UI',
    size: 11,
    bold: true,
    color: { argb: 'FFFFFFFF' },
  };
  const bodyFont: Partial<ExcelJS.Font> = {
    name: 'Segoe UI',
    size: 10,
    color: { argb: 'FF0F172A' },
  };
  const headerBorder: Partial<ExcelJS.Borders> = {
    bottom: { style: 'medium', color: { argb: 'FF0F172A' } },
  };
  const dataRowBorder: Partial<ExcelJS.Borders> = {
    bottom: { style: 'thin', color: { argb: 'FFE2E8F0' } },
  };
  const thinBorder: Partial<ExcelJS.Borders> = {
    top: { style: 'thin', color: { argb: 'FFE2E8F0' } },
    bottom: { style: 'thin', color: { argb: 'FFE2E8F0' } },
    left: { style: 'thin', color: { argb: 'FFE2E8F0' } },
    right: { style: 'thin', color: { argb: 'FFE2E8F0' } },
  };
  const whiteFill: ExcelJS.Fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FFFFFFFF' },
  };
  const zebraFill: ExcelJS.Fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FFF8FAFC' },
  };

  // ============================================================================
  // TAB 1: Executive_Dashboard (Active Tab · KPI Cards · SUMIFS/COUNTIFS · Native Charts)
  // ============================================================================
  const wsDash = wb.addWorksheet('Executive_Dashboard', {
    views: [{ showGridLines: false }],
  });

  // Balanced 9-column executive canvas (Col A = slim left margin, Cols B..I = 4 KPI pairs + table + 2 charts)
  wsDash.getColumn(1).width = 3;
  wsDash.getColumn(2).width = 20;
  wsDash.getColumn(3).width = 22;
  wsDash.getColumn(4).width = 22;
  wsDash.getColumn(5).width = 22;
  wsDash.getColumn(6).width = 20;
  wsDash.getColumn(7).width = 18;
  wsDash.getColumn(8).width = 18;
  wsDash.getColumn(9).width = 18;

  wsDash.getRow(1).height = 10;

  // Row 2: Corporate Navy Banner
  wsDash.mergeCells('B2:I2');
  const dashTitle = wsDash.getCell('B2');
  dashTitle.value = 'DocuCleanse Executive Dashboard — Financial Reconciliation & Currency Analytics';
  dashTitle.fill = navyHeaderFill;
  dashTitle.font = { name: 'Segoe UI', size: 14, bold: true, color: { argb: 'FFFFFFFF' } };
  dashTitle.alignment = { vertical: 'middle', horizontal: 'left', indent: 1 };
  wsDash.getRow(2).height = 34;

  // Row 3: Subtitle & Multi-Currency Disclosure
  wsDash.mergeCells('B3:I3');
  const dashSub = wsDash.getCell('B3');
  const disclosureNote = isMultiCurrency
    ? `Unconverted Multi-Currency Face Value (${meta.detectedCurrencies.join(' · ')}) · Live SUMIFS / COUNTIFS Linked`
    : 'Live Formula-Linked Executive Summary · Enterprise Privacy Shield (Zero Disk Retention)';
  dashSub.value = `Source: ${job.fileName}  ·  UTC: ${formatUtcTimestamp(meta.timestampUtc)}  ·  ${disclosureNote}`;
  dashSub.fill = softBannerFill;
  dashSub.font = { name: 'Segoe UI', size: 9.5, color: { argb: 'FF475569' } };
  dashSub.alignment = { vertical: 'middle', horizontal: 'left', indent: 1 };
  wsDash.getRow(3).height = 22;

  wsDash.getRow(4).height = 12;

  // Rows 5-8: 4 Executive KPI Cards (B:C, D:E, F:G, H:I)
  wsDash.getRow(5).height = 20;
  wsDash.getRow(6).height = 28;
  wsDash.getRow(7).height = 20;

  type KpiCardSpec = {
    startCol: string;
    endCol: string;
    accentArgb: string;
    label: string;
    value: ExcelJS.CellValue;
    numFmt: string;
    valueColorArgb: string;
    subtitle: string;
  };

  const kpiCards: KpiCardSpec[] = [
    {
      startCol: 'B',
      endCol: 'C',
      accentArgb: 'FF2563EB',
      label: isMultiCurrency ? 'GROSS INFLOW (UNCONVERTED)' : 'GROSS INFLOW',
      value: dataAmtRange ? { formula: `SUMIF(${dataAmtRange},">0")`, result: grossInflow } : grossInflow,
      numFmt: singleCurFmt,
      valueColorArgb: 'FF0F172A',
      subtitle: isMultiCurrency
        ? `Face Value (${meta.detectedCurrencies.join(' · ')})`
        : 'Sum of positive ledger entries',
    },
    {
      startCol: 'D',
      endCol: 'E',
      accentArgb: 'FFDC2626',
      label: 'IDENTIFIED LEAKAGE / ANOMALY',
      value: dataAmtRange
        ? { formula: `ABS(SUMIF(${dataAmtRange},"<0"))`, result: negativeExposure }
        : negativeExposure,
      numFmt: singleCurFmt,
      valueColorArgb: 'FFB91C1C',
      subtitle: `${job.anomalies.length} audit findings · ${job.cellDiffs.length} cells repaired`,
    },
    {
      startCol: 'F',
      endCol: 'G',
      accentArgb: 'FF059669',
      label: 'RECONCILED NET',
      value: { formula: 'B6-D6', result: netInflow },
      numFmt: singleCurFmt,
      valueColorArgb: 'FF047857',
      subtitle: 'Gross Inflow minus Identified Leakage',
    },
    {
      startCol: 'H',
      endCol: 'I',
      accentArgb: 'FF4F46E5',
      label: 'CONFIDENCE SCORE',
      value: Number((confidenceScore / 100).toFixed(4)),
      numFmt: '0.0%',
      valueColorArgb: 'FF1D4ED8',
      subtitle: `${meta.rowsIngested}/${meta.rowsCleaned} rows checksum verified`,
    },
  ];

  const colLetterToIdx = (letter: string): number => letter.charCodeAt(0) - 64;

  for (const card of kpiCards) {
    wsDash.mergeCells(`${card.startCol}5:${card.endCol}5`);
    wsDash.mergeCells(`${card.startCol}6:${card.endCol}6`);
    wsDash.mergeCells(`${card.startCol}7:${card.endCol}7`);

    const cStart = colLetterToIdx(card.startCol);
    const cEnd = colLetterToIdx(card.endCol);

    const lblCell = wsDash.getCell(`${card.startCol}5`);
    lblCell.value = card.label;
    lblCell.font = { name: 'Segoe UI', size: 8.5, bold: true, color: { argb: 'FF64748B' } };
    lblCell.alignment = { vertical: 'middle', horizontal: 'left', indent: 1 };

    const valCell = wsDash.getCell(`${card.startCol}6`);
    valCell.value = card.value;
    valCell.numFmt = card.numFmt;
    valCell.font = { name: 'Segoe UI', size: 16, bold: true, color: { argb: card.valueColorArgb } };
    valCell.alignment = { vertical: 'middle', horizontal: 'left', indent: 1 };

    const subCell = wsDash.getCell(`${card.startCol}7`);
    subCell.value = card.subtitle;
    subCell.font = { name: 'Segoe UI', size: 8.5, color: { argb: 'FF64748B' } };
    subCell.alignment = { vertical: 'middle', horizontal: 'left', indent: 1 };

    // Apply crisp card fill & perimeter borders across merged rows 5..7
    for (let r = 5; r <= 7; r++) {
      for (let c = cStart; c <= cEnd; c++) {
        const cell = wsDash.getRow(r).getCell(c);
        cell.fill = whiteFill;
        cell.border = {
          top: r === 5 ? { style: 'medium', color: { argb: card.accentArgb } } : undefined,
          bottom: r === 7 ? { style: 'thin', color: { argb: 'FFCBD5E1' } } : undefined,
          left: c === cStart ? { style: 'thin', color: { argb: 'FFCBD5E1' } } : undefined,
          right: c === cEnd ? { style: 'thin', color: { argb: 'FFCBD5E1' } } : undefined,
        };
      }
    }
  }

  wsDash.getRow(8).height = 14;

  // Row 9: Dynamic Summary Table Section Banner
  wsDash.mergeCells('B9:I9');
  const tableBanner = wsDash.getCell('B9');
  tableBanner.value = 'Currency Volume & Transaction Distribution (Live SUMIFS & COUNTIFS Formulas)';
  tableBanner.fill = navyHeaderFill;
  tableBanner.font = { name: 'Segoe UI', size: 10.5, bold: true, color: { argb: 'FFFFFFFF' } };
  tableBanner.alignment = { vertical: 'middle', horizontal: 'left', indent: 1 };
  wsDash.getRow(9).height = 26;

  // Row 10: Dynamic Summary Table Headers (Unmerged cells so Excel Charts bind cleanly to $B$11:$D$N)
  const summaryHeaders = [
    'Currency',
    'Gross Volume (SUMIFS)',
    'Transaction Count (COUNTIFS)',
    'Negative / Leakage (SUMIFS)',
    'Net Reconciled Volume',
    'Gross Share (%)',
    'Avg Ticket Size',
    'FX Isolation Status',
  ];
  const sumHeadRow = wsDash.getRow(10);
  sumHeadRow.height = 24;
  summaryHeaders.forEach((label, idx) => {
    const cell = sumHeadRow.getCell(idx + 2); // Cols B..I
    cell.value = label;
    cell.fill = slateSubHeaderFill;
    cell.font = { name: 'Segoe UI', size: 9.5, bold: true, color: { argb: 'FFFFFFFF' } };
    cell.alignment = { vertical: 'middle', horizontal: 'center' };
    cell.border = headerBorder;
  });

  // Build ordered currency list (all detected currencies + USD, EUR, GBP baseline so SUMIFS/COUNTIFS always cover core currencies)
  const currencyLookup = new Map(currencySummary.map((c) => [c.code, c]));
  const dashboardCurrencyCodes = Array.from(
    new Set([...currencySummary.map((c) => c.code), 'USD', 'EUR', 'GBP'])
  );

  const firstSummaryRow = 11;
  const lastSummaryRow = firstSummaryRow + dashboardCurrencyCodes.length - 1;
  const totalSummaryRow = lastSummaryRow + 1;
  const totalGrossForShare = dashboardCurrencyCodes.reduce(
    (acc, code) => acc + (currencyLookup.get(code)?.total ?? 0),
    0
  );

  const chartSeriesItems: Array<{ label: string; volume: number; count: number }> = [];

  dashboardCurrencyCodes.forEach((code, idx) => {
    const rowNum = firstSummaryRow + idx;
    const stats = currencyLookup.get(code) ?? { code, total: 0, negativeTotal: 0, txCount: 0 };
    const netVal = Number((stats.total - stats.negativeTotal).toFixed(2));
    const shareVal = totalGrossForShare > 0 ? stats.total / totalGrossForShare : 0;
    const avgVal = stats.txCount > 0 ? Number((stats.total / stats.txCount).toFixed(2)) : 0;
    const cFmt = excelNumberFormatForCurrency(code);

    chartSeriesItems.push({
      label: code,
      volume: stats.total,
      count: stats.txCount,
    });

    const r = wsDash.getRow(rowNum);
    r.height = 21;
    const rowFill = idx % 2 === 1 ? zebraFill : whiteFill;

    // Col B: Currency Code
    const cCode = r.getCell(2);
    cCode.value = code;
    cCode.numFmt = '@';
    cCode.font = { ...bodyFont, bold: true };
    cCode.alignment = { vertical: 'middle', horizontal: 'center' };

    // Col C: Gross Volume via live SUMIFS
    const cGross = r.getCell(3);
    cGross.value =
      dataAmtRange && dataCurRange
        ? {
            formula: `SUMIFS(${dataAmtRange},${dataCurRange},B${rowNum},${dataAmtRange},">0")`,
            result: stats.total,
          }
        : stats.total;
    cGross.numFmt = cFmt;
    cGross.font = { ...bodyFont, bold: true };
    cGross.alignment = { vertical: 'middle', horizontal: 'right' };

    // Col D: Transaction Count via live COUNTIFS
    const cCount = r.getCell(4);
    cCount.value = dataCurRange
      ? {
          formula: `COUNTIFS(${dataCurRange},B${rowNum})`,
          result: stats.txCount,
        }
      : stats.txCount;
    cCount.numFmt = '#,##0';
    cCount.font = bodyFont;
    cCount.alignment = { vertical: 'middle', horizontal: 'right' };

    // Col E: Negative / Leakage via live SUMIFS
    const cNeg = r.getCell(5);
    cNeg.value =
      dataAmtRange && dataCurRange
        ? {
            formula: `ABS(SUMIFS(${dataAmtRange},${dataCurRange},B${rowNum},${dataAmtRange},"<0"))`,
            result: stats.negativeTotal,
          }
        : stats.negativeTotal;
    cNeg.numFmt = cFmt;
    cNeg.font = {
      ...bodyFont,
      color: { argb: stats.negativeTotal > 0 ? 'FFB91C1C' : 'FF475569' },
    };
    cNeg.alignment = { vertical: 'middle', horizontal: 'right' };

    // Col F: Net Reconciled Volume (Gross - Leakage)
    const cNet = r.getCell(6);
    cNet.value = { formula: `C${rowNum}-E${rowNum}`, result: netVal };
    cNet.numFmt = cFmt;
    cNet.font = { ...bodyFont, bold: true, color: { argb: 'FF047857' } };
    cNet.alignment = { vertical: 'middle', horizontal: 'right' };

    // Col G: Volume Share (%)
    const cShare = r.getCell(7);
    cShare.value = {
      formula: `IF($C$${totalSummaryRow}=0,0,C${rowNum}/$C$${totalSummaryRow})`,
      result: Number(shareVal.toFixed(4)),
    };
    cShare.numFmt = '0.0%';
    cShare.font = bodyFont;
    cShare.alignment = { vertical: 'middle', horizontal: 'right' };

    // Col H: Average Ticket Size
    const cAvg = r.getCell(8);
    cAvg.value = {
      formula: `IF(D${rowNum}=0,0,C${rowNum}/D${rowNum})`,
      result: avgVal,
    };
    cAvg.numFmt = cFmt;
    cAvg.font = bodyFont;
    cAvg.alignment = { vertical: 'middle', horizontal: 'right' };

    // Col I: FX Isolation Status
    const cIso = r.getCell(9);
    cIso.value = stats.txCount > 0 ? 'Isolated (ISO-4217)' : 'No Activity';
    cIso.numFmt = '@';
    cIso.font = {
      ...bodyFont,
      size: 9,
      color: { argb: stats.txCount > 0 ? 'FF15803D' : 'FF94A3B8' },
    };
    cIso.alignment = { vertical: 'middle', horizontal: 'center' };

    for (let col = 2; col <= 9; col++) {
      const cell = r.getCell(col);
      cell.fill = rowFill;
      cell.border = dataRowBorder;
    }
  });

  // Total Summary Row
  const totRow = wsDash.getRow(totalSummaryRow);
  totRow.height = 24;
  const totalTxCount = chartSeriesItems.reduce((acc, item) => acc + item.count, 0);
  const totalGrossSum = Number(chartSeriesItems.reduce((acc, item) => acc + item.volume, 0).toFixed(2));
  const totalNegSum = Number(
    dashboardCurrencyCodes.reduce((acc, code) => acc + (currencyLookup.get(code)?.negativeTotal ?? 0), 0).toFixed(2)
  );
  const totalNetSum = Number((totalGrossSum - totalNegSum).toFixed(2));

  totRow.getCell(2).value = isMultiCurrency ? 'Total (Unconverted)' : 'Total';
  totRow.getCell(2).alignment = { vertical: 'middle', horizontal: 'center' };
  totRow.getCell(3).value = {
    formula: `SUM(C${firstSummaryRow}:C${lastSummaryRow})`,
    result: totalGrossSum,
  };
  totRow.getCell(3).numFmt = singleCurFmt;
  totRow.getCell(3).alignment = { vertical: 'middle', horizontal: 'right' };

  totRow.getCell(4).value = {
    formula: `SUM(D${firstSummaryRow}:D${lastSummaryRow})`,
    result: totalTxCount,
  };
  totRow.getCell(4).numFmt = '#,##0';
  totRow.getCell(4).alignment = { vertical: 'middle', horizontal: 'right' };

  totRow.getCell(5).value = {
    formula: `SUM(E${firstSummaryRow}:E${lastSummaryRow})`,
    result: totalNegSum,
  };
  totRow.getCell(5).numFmt = singleCurFmt;
  totRow.getCell(5).alignment = { vertical: 'middle', horizontal: 'right' };

  totRow.getCell(6).value = {
    formula: `SUM(F${firstSummaryRow}:F${lastSummaryRow})`,
    result: totalNetSum,
  };
  totRow.getCell(6).numFmt = singleCurFmt;
  totRow.getCell(6).alignment = { vertical: 'middle', horizontal: 'right' };

  totRow.getCell(7).value = {
    formula: `SUM(G${firstSummaryRow}:G${lastSummaryRow})`,
    result: totalGrossSum > 0 ? 1 : 0,
  };
  totRow.getCell(7).numFmt = '0.0%';
  totRow.getCell(7).alignment = { vertical: 'middle', horizontal: 'right' };

  totRow.getCell(8).value = {
    formula: `IF(D${totalSummaryRow}=0,0,C${totalSummaryRow}/D${totalSummaryRow})`,
    result: totalTxCount > 0 ? Number((totalGrossSum / totalTxCount).toFixed(2)) : 0,
  };
  totRow.getCell(8).numFmt = singleCurFmt;
  totRow.getCell(8).alignment = { vertical: 'middle', horizontal: 'right' };

  totRow.getCell(9).value = isMultiCurrency ? 'No Cross-FX Mixing' : 'Reconciled';
  totRow.getCell(9).alignment = { vertical: 'middle', horizontal: 'center' };

  for (let col = 2; col <= 9; col++) {
    const cell = totRow.getCell(col);
    cell.fill = softBannerFill;
    cell.font = { ...bodyFont, bold: true };
    cell.border = {
      top: { style: 'thin', color: { argb: 'FF94A3B8' } },
      bottom: { style: 'medium', color: { argb: 'FF1E293B' } },
    };
  }

  // Reserve clean spacing rows below summary table for the 2 side-by-side native Excel charts
  const chartStartRowZeroBased = totalSummaryRow + 1; // 1 blank spacer row below totals
  const chartEndRowZeroBased = chartStartRowZeroBased + 16;

  // ============================================================================
  // TAB 2: Cleaned_Data (Frozen Row 1 Header · AutoFilter · #1E293B Navy · Strict Typing)
  // ============================================================================
  const wsData = wb.addWorksheet('Cleaned_Data', {
    views: [{ state: 'frozen', ySplit: 1 }],
  });

  // Row 1: Deep corporate navy (#1E293B), bold white 11pt Segoe UI, 28pt height, centered
  const headerRow = wsData.addRow(headers);
  headerRow.height = 28;
  headerRow.eachCell((cell) => {
    cell.fill = navyHeaderFill;
    cell.font = headerFont;
    cell.alignment = { vertical: 'middle', horizontal: 'center' };
    cell.border = headerBorder;
  });

  const colLayouts = headers.map((h) => resolveColumnLayout(h, mappingByHeader.get(h)?.detectedType));
  const colMaxWidths = headers.map((h, idx) => Math.max(colLayouts[idx].minWidth, h.length + 5));

  // Data Rows (Row 2..N+1): 20pt height, alternating white/#F8FAFC zebra striping, subtle #E2E8F0 bottom border
  job.cleanedRows.forEach((row, rIdx) => {
    const excelRowNum = rIdx + 2;
    const rawRow = job.rawRows[rIdx] || {};
    const excelRow = wsData.getRow(excelRowNum);
    excelRow.height = 20;

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
      const layout = colLayouts[cIdx];
      const lower = h.toLowerCase();

      cell.font = bodyFont;
      cell.border = dataRowBorder;
      cell.fill = rIdx % 2 === 1 ? zebraFill : whiteFill;

      // 1. Phone numbers -> STRICT non-formula String/Text ('@') so Excel NEVER evaluates "+1-555-234-5678" as -6466
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

      if (isPhoneCol) {
        const safePhoneStr = formatPhoneForSpreadsheetText(rawStr);
        cell.value = String(safePhoneStr);
        cell.numFmt = '@';
        cell.alignment = { vertical: 'middle', horizontal: layout.alignment };
        colMaxWidths[cIdx] = Math.min(46, Math.max(colMaxWidths[cIdx], safePhoneStr.length + 5));
        return;
      }

      colMaxWidths[cIdx] = Math.min(46, Math.max(colMaxWidths[cIdx], rawStr.length + 4));

      // 2. IDs, codes, raw_amount, dates, emails, statuses -> STRICT TEXT ('@')
      const isStrictTextCol =
        lower === 'raw_amount' ||
        lower === 'currency_code' ||
        mapping?.detectedType === 'email' ||
        mapping?.detectedType === 'date' ||
        mapping?.detectedType === 'status' ||
        /\b(transaction_id|txn_id|order_id|invoice_id|id|code|zip|postal|region_code)\b/i.test(lower) ||
        rawStr === '' ||
        rawStr.startsWith('[ERROR') ||
        rawStr === '[MISSING]';

      if (isStrictTextCol) {
        cell.value = String(rawStr);
        cell.numFmt = '@';
        cell.alignment = { vertical: 'middle', horizontal: layout.alignment };
        return;
      }

      // 3. Quantity column (e.g., Column F: quantity / qty_sold) -> STRICT numeric integer (#,##0), right-aligned
      if (cIdx === qtyColIdx) {
        const qtyVal = parseNumericStrict(rawStr);
        if (qtyVal !== null) {
          cell.value = qtyVal;
          cell.numFmt = Number.isInteger(qtyVal) ? '#,##0' : '#,##0.00';
          cell.alignment = { vertical: 'middle', horizontal: 'right' };
          return;
        }
      }

      // 4. Tax Rate / Percentage column (e.g., Column H: tax_rate) -> numeric percentage float (0.0%), right-aligned
      if (cIdx === taxRateColIdx || rawStr.endsWith('%')) {
        const pct = parseTaxRateFraction(rawStr);
        if (pct !== null) {
          cell.value = pct;
          cell.numFmt = '0.0%';
          cell.alignment = { vertical: 'middle', horizontal: 'right' };
          return;
        }
      }

      // 5. Unit Price column (e.g., Column G: unit_price) -> numeric currency float with native Excel currency format
      if (cIdx === unitPriceColIdx) {
        const priceVal = parseNumericStrict(rawStr);
        if (priceVal !== null) {
          const priceCur = detectCurrencyCode(rawStr) || rowCurrency;
          cell.value = priceVal;
          cell.numFmt = excelNumberFormatForCurrency(priceCur);
          cell.alignment = { vertical: 'middle', horizontal: 'right' };
          colMaxWidths[cIdx] = Math.min(46, Math.max(colMaxWidths[cIdx], priceVal.toFixed(2).length + 7));
          return;
        }
      }

      // 6. Total Amount column (e.g., Column I: total_amount) -> calculated formula (qty * unit_price) with currency format
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
            colMaxWidths[cIdx] = Math.min(46, Math.max(colMaxWidths[cIdx], totalVal.toFixed(2).length + 7));
            return;
          }
        }

        if (totalVal !== null) {
          cell.value = totalVal;
          cell.numFmt = numFmt;
          cell.alignment = { vertical: 'middle', horizontal: 'right' };
          colMaxWidths[cIdx] = Math.min(46, Math.max(colMaxWidths[cIdx], totalVal.toFixed(2).length + 7));
          return;
        }
      }

      // 7. normalized_amount -> live reference to total_amount (or numeric currency float)
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
              colMaxWidths[cIdx] = Math.min(46, Math.max(colMaxWidths[cIdx], normVal.toFixed(2).length + 7));
              return;
            }
          }
          cell.value = normVal;
          cell.numFmt = numFmt;
          cell.alignment = { vertical: 'middle', horizontal: 'right' };
          colMaxWidths[cIdx] = Math.min(46, Math.max(colMaxWidths[cIdx], normVal.toFixed(2).length + 7));
          return;
        }
      }

      // 8. Any other numeric or currency column
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
      cell.value = String(rawStr);
      cell.alignment = { vertical: 'middle', horizontal: layout.alignment };
    });
  });

  if (headers.length > 0) {
    wsData.autoFilter = {
      from: { row: 1, column: 1 },
      to: { row: 1, column: headers.length },
    };
  }
  headers.forEach((_, idx) => {
    wsData.getColumn(idx + 1).width = Math.max(colLayouts[idx].minWidth, colMaxWidths[idx]);
  });

  // ============================================================================
  // TAB 3: Pre_Audit_Report (SHA-256 · UTC · Checksums · Compliance Disclosures · Findings)
  // ============================================================================
  const wsReport = wb.addWorksheet('Pre_Audit_Report', {
    views: [{ state: 'frozen', ySplit: 2 }],
  });

  wsReport.mergeCells('A1:D1');
  const titleCell = wsReport.getCell('A1');
  titleCell.value = 'DocuCleanse — Pre-Audit Processing Report & Compliance Disclosures';
  titleCell.fill = navyHeaderFill;
  titleCell.font = { name: 'Segoe UI', size: 12.5, bold: true, color: { argb: 'FFFFFFFF' } };
  titleCell.alignment = { vertical: 'middle', horizontal: 'left', indent: 1 };
  wsReport.getRow(1).height = 30;

  wsReport.mergeCells('B2:D2');
  const certSubHeader = wsReport.getRow(2);
  certSubHeader.height = 26;
  certSubHeader.getCell(1).value = 'Compliance / Reconciliation Field';
  certSubHeader.getCell(2).value = 'Verified Value & Audit Disclosure';
  for (let c = 1; c <= 4; c++) {
    const cell = certSubHeader.getCell(c);
    cell.fill = slateSubHeaderFill;
    cell.font = { name: 'Segoe UI', size: 10.5, bold: true, color: { argb: 'FFFFFFFF' } };
    cell.alignment = { vertical: 'middle', horizontal: 'left', indent: 1 };
    cell.border = thinBorder;
  }

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
    {
      label: 'LLM Training & Retention Disclosure',
      value: 'Zero external LLM model training on client files · Volatile memory buffer zeroized immediately after processing',
    },
    { label: 'Report / Job ID', value: job.id },
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
      label: 'Accounting FX Disclosure',
      value: isMultiCurrency
        ? `Unconverted Multi-Currency Face Value (${meta.detectedCurrencies.join(' · ')}) — see Executive_Dashboard for isolated SUMIFS subtotals`
        : 'Single-currency ledger — no cross-FX conversion required',
    },
    {
      label: 'Primary Monetary Column',
      value: meta.primaryAmountColumn || 'N/A',
    },
  ];

  const grossRowNum = 3 + certEntries.length;
  const negRowNum = grossRowNum + 1;
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
        ? 'Reconciled Net Inflow (Gross − Negative Exposure, Unconverted)'
        : 'Reconciled Net Inflow (Gross − Refunds/Negatives)',
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
    const rowIdx = 3 + idx;
    wsReport.mergeCells(`B${rowIdx}:D${rowIdx}`);
    const r = wsReport.getRow(rowIdx);
    r.height = 20;
    const c1 = r.getCell(1);
    const c2 = r.getCell(2);
    c1.value = entry.label;
    c2.value = entry.value;
    c1.font = { ...bodyFont, bold: true, color: { argb: 'FF334155' } };
    c2.font = { ...bodyFont, bold: Boolean(entry.bold) };
    c1.alignment = { vertical: 'middle', horizontal: 'left', indent: 1 };
    const isNumericOrFormula =
      typeof entry.value === 'number' ||
      (typeof entry.value === 'object' && entry.value !== null && 'formula' in entry.value);
    c2.alignment = {
      vertical: 'middle',
      horizontal: isNumericOrFormula ? 'right' : 'left',
      indent: isNumericOrFormula ? 0 : 1,
    };
    if (entry.numFmt) {
      c2.numFmt = entry.numFmt;
    }
    const rowFill = idx % 2 === 1 ? zebraFill : whiteFill;
    for (let c = 1; c <= 4; c++) {
      const cell = r.getCell(c);
      cell.fill = rowFill;
      cell.border = dataRowBorder;
    }
  });

  // Embedded Anomaly Audit Log section inside Tab 3 ("Pre_Audit_Report")
  if (job.anomalies.length > 0) {
    const spacerRowNum = 3 + certEntries.length + 1;
    wsReport.getRow(spacerRowNum).height = 12;

    const anomSectionRowNum = spacerRowNum + 1;
    wsReport.mergeCells(`A${anomSectionRowNum}:D${anomSectionRowNum}`);
    const anomBanner = wsReport.getCell(`A${anomSectionRowNum}`);
    anomBanner.value = `Pre-Audit Findings & Anomaly Log (${job.anomalies.length} Entries)`;
    anomBanner.fill = navyHeaderFill;
    anomBanner.font = { name: 'Segoe UI', size: 10.5, bold: true, color: { argb: 'FFFFFFFF' } };
    anomBanner.alignment = { vertical: 'middle', horizontal: 'left', indent: 1 };
    wsReport.getRow(anomSectionRowNum).height = 26;

    const anomHeadRowNum = anomSectionRowNum + 1;
    const anomHead = wsReport.getRow(anomHeadRowNum);
    anomHead.height = 24;
    ['Severity · Category', 'Location', 'Raw → Reconciled Value', 'Audit Explanation'].forEach(
      (title, i) => {
        const cell = anomHead.getCell(i + 1);
        cell.value = title;
        cell.fill = slateSubHeaderFill;
        cell.font = { name: 'Segoe UI', size: 9.5, bold: true, color: { argb: 'FFFFFFFF' } };
        cell.alignment = { vertical: 'middle', horizontal: 'center' };
        cell.border = headerBorder;
      }
    );

    job.anomalies.forEach((a, idx) => {
      const r = wsReport.getRow(anomHeadRowNum + 1 + idx);
      r.height = 22;
      r.getCell(1).value = `[${a.severity.toUpperCase()}] ${sanitizeMojibake(a.category)}`;
      r.getCell(2).value = sanitizeMojibake(a.location);
      r.getCell(3).value = `${sanitizeMojibake(a.rawValue)} → ${sanitizeMojibake(a.suggestedOrFixedValue)}`;
      r.getCell(4).value = sanitizeMojibake(a.explanation);

      const rowFill = idx % 2 === 1 ? zebraFill : whiteFill;
      for (let c = 1; c <= 4; c++) {
        const cell = r.getCell(c);
        cell.font = bodyFont;
        cell.numFmt = '@';
        cell.fill = rowFill;
        cell.border = dataRowBorder;
        cell.alignment = { vertical: 'middle', horizontal: 'left', wrapText: c === 4 };
      }
      r.getCell(1).font = {
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
    });
  }

  wsReport.getColumn(1).width = 44;
  wsReport.getColumn(2).width = 30;
  wsReport.getColumn(3).width = 36;
  wsReport.getColumn(4).width = 62;

  const rawXlsxBuffer = Buffer.from(await wb.xlsx.writeBuffer());

  // Inject native OOXML Bar Chart & Doughnut Chart onto Tab 1 ("Executive_Dashboard")
  return injectNativeDashboardCharts(rawXlsxBuffer, {
    sheetName: 'Executive_Dashboard',
    firstDataRow: firstSummaryRow,
    lastDataRow: lastSummaryRow,
    labelColLetter: 'B',
    volumeColLetter: 'C',
    countColLetter: 'D',
    anchorStartRowZeroBased: chartStartRowZeroBased,
    anchorEndRowZeroBased: chartEndRowZeroBased,
    barTitle: 'Gross Volume by Currency (SUMIFS)',
    donutTitle: 'Transaction Count by Currency (COUNTIFS)',
    items: chartSeriesItems,
  });
}

export async function generateSummaryPdfBuffer(job: CleanJobRecord): Promise<Buffer> {
  const synced = computeSynchronizedMetrics(job);
  const { meta, grossInflow, netInflow, confidenceScore, currencySummary, isMultiCurrency } = synced;

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'LETTER',
      margin: 44,
      info: {
        Title: `Pre-Audit Processing Report — ${job.fileName}`,
        Author: 'Rafi Digital Studio — DocuCleanse Enterprise',
        Subject: `SHA-256: ${meta.fileHashSha256}`,
      },
    });

    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    // Pre-Audit Processing Report Banner Header
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
      .fontSize(16)
      .text('Pre-Audit Processing Report', 58, bannerTop + 26);

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
      .text(`REPORT ID: ${job.id.toUpperCase()}`, 380, bannerTop + 13, { width: 174, align: 'right' });

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

    // Pre-Audit Processing Summary & Executive Sign-Off Block for Rafi Digital Studio
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
      .text('PRE-AUDIT PROCESSING SUMMARY & EXECUTIVE SIGN-OFF', 58, sigTop + 11);

    doc
      .fillColor('#475569')
      .font('Helvetica')
      .fontSize(7.8)
      .text(
        `This Pre-Audit Processing Report confirms that ${meta.rowsIngested} source records were deterministically normalized into ${meta.rowsCleaned} verified records in ephemeral RAM with zero permanent data storage (GDPR & Pre-Audit Ready), cryptographically bound to SHA-256 digest ${meta.fileHashSha256.slice(0, 32)}... at ${formatUtcTimestamp(meta.timestampUtc)}.`,
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
      .text('PRE-AUDIT INTEGRITY SEAL', 344, sigTop + 63);

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
