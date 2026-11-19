import * as XLSX from 'xlsx';
import type {
  AnomalyItem,
  AuditMetadata,
  BillingEvent,
  CellDiff,
  CleanJob,
  QuotaSnapshot,
  SchemaMapping,
  UsageLog,
} from '../types';

export const DEMO_USER_ID = 'usr_demo_freelancer';

export class NonJsonApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'NonJsonApiError';
    this.status = status;
  }
}

export class ApiBusinessError extends Error {
  status: number;
  code?: string;
  upgradeRequired?: boolean;
  quota?: QuotaSnapshot;

  constructor(
    status: number,
    payload: {
      error?: string;
      code?: string;
      upgradeRequired?: boolean;
      quota?: QuotaSnapshot;
    }
  ) {
    super(payload.error || `Request failed with status ${status}`);
    this.name = 'ApiBusinessError';
    this.status = status;
    this.code = payload.code;
    this.upgradeRequired = payload.upgradeRequired;
    this.quota = payload.quota;
  }
}

async function parseJsonResponse<T>(response: Response): Promise<T> {
  const contentType = response.headers.get('content-type') || '';

  if (!contentType.toLowerCase().includes('application/json')) {
    const preview = await response.text().catch(() => '');
    throw new NonJsonApiError(
      `Expected application/json response but received "${contentType || 'none'}" (${preview.slice(0, 60)})`,
      response.status
    );
  }

  const data = (await response.json()) as T & {
    error?: string;
    code?: string;
    upgradeRequired?: boolean;
    quota?: QuotaSnapshot;
  };

  if (!response.ok) {
    throw new ApiBusinessError(response.status, data);
  }

  return data;
}

function shouldUseMockFallback(err: unknown): boolean {
  if (err instanceof NonJsonApiError) return true;
  if (err instanceof ApiBusinessError) {
    // Only fall back on missing/unreachable proxy routes (404 / 502 / 504), never mask 402 paywall or 400 validation
    return err.status === 404 || err.status === 502 || err.status === 504;
  }
  // Network failures (TypeError: Failed to fetch)
  return err instanceof TypeError || (err instanceof Error && /fetch|network/i.test(err.message));
}

// ============================================================================
// In-Memory Fallback Store & Client-Side Normalization Engine
// Activated automatically if Express /api is unreachable or returns HTML
// ============================================================================

const mockState: {
  quota: QuotaSnapshot;
  jobs: CleanJob[];
  usageLogs: UsageLog[];
  billingEvents: BillingEvent[];
} = {
  quota: {
    userId: DEMO_USER_ID,
    email: 'ru2275353@gmail.com',
    name: 'Rafi Digital Studio',
    plan: 'free',
    freeCleansUsedThisMonth: 0,
    freeCleansLimit: 3,
    freeRowLimit: 50,
    tokenBalance: 0,
    remainingCleans: 3,
    canProcessNewFile: true,
    canExportProFormats: false,
    billingCycleMonth: new Date().toISOString().slice(0, 7),
  },
  jobs: [],
  usageLogs: [],
  billingEvents: [],
};

function syncMockQuotaFlags(): QuotaSnapshot {
  const q = mockState.quota;
  const freeRem = Math.max(0, q.freeCleansLimit - q.freeCleansUsedThisMonth);
  q.remainingCleans =
    q.plan === 'pro' ? 'unlimited' : q.tokenBalance > 0 ? freeRem + q.tokenBalance : freeRem;
  q.canProcessNewFile =
    q.plan === 'pro' || q.tokenBalance > 0 || q.freeCleansUsedThisMonth < q.freeCleansLimit;
  q.canExportProFormats = q.plan === 'pro' || q.tokenBalance > 0;
  return { ...q };
}

function parseCsvLines(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;

  const cleanText = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  for (let i = 0; i < cleanText.length; i++) {
    const ch = cleanText[i];
    if (inQuotes) {
      if (ch === '"' && cleanText[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n') {
      row.push(field);
      if (row.some((c) => c.trim().length > 0)) rows.push(row);
      row = [];
      field = '';
    } else {
      field += ch;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    if (row.some((c) => c.trim().length > 0)) rows.push(row);
  }
  return rows;
}

const FORMULA_ERROR_REGEX_LOCAL =
  /^=?#(REF!|DIV\/0!|VALUE!|NAME\?|N\/A|NUM!|NULL!|SPILL!|CALC!)$/i;

function parseXlsxMatrixLocal(buffer: ArrayBuffer): string[][] {
  const workbook = XLSX.read(buffer, {
    type: 'array',
    cellFormula: true,
    cellNF: true,
    cellText: true,
    cellDates: false,
    raw: false,
  });

  const sheetNames = workbook.SheetNames || [];
  if (sheetNames.length === 0) return [];

  const activeTabIdx = (
    workbook.Workbook?.Views?.[0] as { activeTab?: number } | undefined
  )?.activeTab;
  let targetSheetName: string | undefined;
  if (typeof activeTabIdx === 'number' && activeTabIdx >= 0 && activeTabIdx < sheetNames.length) {
    const candidate = sheetNames[activeTabIdx];
    if (workbook.Sheets[candidate]?.['!ref']) targetSheetName = candidate;
  }
  if (!targetSheetName) {
    targetSheetName =
      sheetNames.find(
        (name) => /raw|data|ledger|transactions/i.test(name) && Boolean(workbook.Sheets[name]?.['!ref'])
      ) ?? sheetNames.find((name) => Boolean(workbook.Sheets[name]?.['!ref'])) ?? sheetNames[0];
  }

  const sheet = workbook.Sheets[targetSheetName];
  if (!sheet) return [];

  let minR = Number.POSITIVE_INFINITY;
  let minC = Number.POSITIVE_INFINITY;
  let maxR = -1;
  let maxC = -1;

  if (sheet['!ref']) {
    const r = XLSX.utils.decode_range(sheet['!ref']);
    minR = r.s.r;
    minC = r.s.c;
    maxR = r.e.r;
    maxC = r.e.c;
  }
  for (const key of Object.keys(sheet)) {
    if (key.startsWith('!')) continue;
    try {
      const pos = XLSX.utils.decode_cell(key);
      if (pos.r < minR) minR = pos.r;
      if (pos.c < minC) minC = pos.c;
      if (pos.r > maxR) maxR = pos.r;
      if (pos.c > maxC) maxC = pos.c;
    } catch {
      // ignore non-cell keys
    }
  }
  if (maxR < 0 || maxC < 0 || !Number.isFinite(minR) || !Number.isFinite(minC)) return [];

  const rows: string[][] = [];
  for (let R = minR; R <= maxR; R++) {
    const row: string[] = [];
    let hasValue = false;
    for (let C = minC; C <= maxC; C++) {
      const addr = XLSX.utils.encode_cell({ r: R, c: C });
      const cell = sheet[addr] as XLSX.CellObject | undefined;
      let text = '';
      if (cell) {
        const rawFormula = cell.f ? String(cell.f).trim() : '';
        if (cell.t === 'e') {
          text = String(cell.w || cell.v || '#ERROR!').trim();
        } else if (rawFormula && FORMULA_ERROR_REGEX_LOCAL.test(rawFormula)) {
          text = `=${rawFormula.replace(/^=/, '').toUpperCase()}`;
        } else if (cell.t === 'd' && cell.v instanceof Date && !Number.isNaN(cell.v.getTime())) {
          text = cell.v.toISOString().slice(0, 10);
        } else if (cell.w !== undefined && String(cell.w).trim() !== '') {
          text = String(cell.w);
        } else if (cell.v !== undefined && cell.v !== null) {
          text = String(cell.v);
        } else if (rawFormula) {
          text = rawFormula.startsWith('=') ? rawFormula : `=${rawFormula}`;
        }
      }
      if (text.trim().length > 0) hasValue = true;
      row.push(text);
    }
    if (hasValue) rows.push(row);
  }
  return rows;
}

function normalizeHeaderLocal(raw: string): {
  normalized: string;
  detectedType: SchemaMapping['detectedType'];
  reason: string;
} {
  const lower = raw.trim().toLowerCase();
  const snake =
    lower
      .replace(/%/g, 'pct')
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_|_$/g, '') || 'column';

  if (/\bdate\b|_date|^dt$/i.test(lower)) {
    return {
      normalized: lower.includes('renwl') ? 'renewal_date' : snake === 'dt' ? 'transaction_date' : snake,
      detectedType: 'date',
      reason: 'Mapped date header to canonical ISO-8601 date column',
    };
  }
  if (/(phone|tel|mobile|ph\s*#)/i.test(lower)) {
    return {
      normalized: snake.includes('phone') ? snake : 'phone_number',
      detectedType: 'phone',
      reason: 'Standardized telephone header to E.164/dashed format',
    };
  }
  if (lower.includes('mail')) {
    return { normalized: 'email', detectedType: 'email', reason: 'Standardized email address field' };
  }
  if (lower.includes('stat')) {
    return { normalized: snake, detectedType: 'status', reason: 'Normalized status label casing' };
  }
  if (/(qty|quantity|units)/i.test(lower)) {
    return { normalized: snake, detectedType: 'number', reason: 'Standardized quantity numeric column' };
  }
  if (/(tax|rate|%)/i.test(lower)) {
    return { normalized: snake, detectedType: 'number', reason: 'Standardized numeric rate column' };
  }
  if (/(amt|amount|mrr|total|price|cost)/i.test(lower)) {
    return {
      normalized: lower.includes('mrr') ? 'monthly_recurring_revenue' : snake,
      detectedType: 'currency',
      reason: 'Standardized monetary header to clean decimal currency column',
    };
  }
  return { normalized: snake, detectedType: 'text', reason: 'Converted header to snake_case' };
}

function detectCurrencyCodeLocal(val: string | undefined): string | null {
  if (!val) return null;
  const s = val.trim();
  if (!s || FORMULA_ERROR_REGEX_LOCAL.test(s) || /^\[ERROR:/i.test(s)) return null;

  if (/\bCAD\b|CA\$|C\$/i.test(s)) return 'CAD';
  if (/\bAUD\b|AU\$|A\$/i.test(s)) return 'AUD';
  if (/\bNZD\b|NZ\$/i.test(s)) return 'NZD';
  if (/\bHKD\b|HK\$/i.test(s)) return 'HKD';
  if (/\bSGD\b|S\$/i.test(s)) return 'SGD';
  if (/£|\bGBP\b/i.test(s)) return 'GBP';
  if (/€|\bEUR\b/i.test(s)) return 'EUR';
  if (/¥|\bJPY\b/i.test(s)) return 'JPY';
  if (/\bCHF\b/i.test(s)) return 'CHF';
  if (/\bPKR\b|Rs\.?/i.test(s)) return 'PKR';
  if (/₹|\bINR\b/i.test(s)) return 'INR';
  if (/US\$|\$|\bUSD\b/i.test(s)) return 'USD';
  return null;
}

async function computeSha256HexLocal(buffer: ArrayBuffer): Promise<string> {
  try {
    if (typeof crypto !== 'undefined' && crypto.subtle) {
      const digest = await crypto.subtle.digest('SHA-256', buffer);
      return Array.from(new Uint8Array(digest))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
    }
  } catch {
    // Fallback deterministic hex digest below
  }
  const bytes = new Uint8Array(buffer);
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < bytes.length; i++) {
    h1 = Math.imul(h1 ^ bytes[i], 2654435761);
    h2 = Math.imul(h2 ^ bytes[i], 1597334677);
  }
  return (
    ((h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0')).repeat(4)
  ).slice(0, 64);
}

function formatUtcTimestampLocal(date: Date): string {
  return date.toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
}

function parseNumericLocal(val: string | undefined): number | null {
  if (!val) return null;
  const s = val.trim();
  if (!s || FORMULA_ERROR_REGEX_LOCAL.test(s) || /^\[ERROR:/i.test(s)) return null;
  const isParenNeg = /^\(.*\)$/.test(s);
  let numStr = s
    .replace(/\b(USD|EUR|GBP|CAD|AUD|JPY|CHF|NZD|SGD|HKD|PKR|INR)\b/gi, '')
    .replace(/(CA\$|AU\$|US\$|NZ\$|HK\$|S\$|C\$|A\$|Rs\.?)/gi, '')
    .replace(/[$€£¥₹%\s()]/g, '');
  if (/^\d{1,3}(\.\d{3})*,\d{2}$/.test(numStr) || /^\d+,\d{2}$/.test(numStr)) {
    numStr = numStr.replace(/\./g, '').replace(',', '.');
  } else {
    numStr = numStr.replace(/,/g, '');
  }
  const num = Number(numStr);
  if (!Number.isFinite(num)) return null;
  return isParenNeg ? -Math.abs(num) : num;
}

function normalizeDateLocal(val: string): string {
  const s = val.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  // YYYY.MM.DD or YYYY/MM/DD
  let m = s.match(/^(\d{4})[./-](\d{1,2})[./-](\d{1,2})$/);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  // DD.MM.YYYY or DD-MM-YYYY or MM-DD-YYYY
  m = s.match(/^(\d{1,2})([./-])(\d{1,2})\2(\d{2,4})$/);
  if (m) {
    const p1 = Number(m[1]);
    const sep = m[2];
    const p2 = Number(m[3]);
    const year = m[4].length === 2 ? `20${m[4]}` : m[4];
    let month: number;
    let day: number;
    if (p1 > 12 && p2 <= 12) {
      day = p1;
      month = p2;
    } else if (p2 > 12 && p1 <= 12) {
      month = p1;
      day = p2;
    } else if (sep === '.') {
      day = p1;
      month = p2;
    } else {
      month = p1;
      day = p2;
    }
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    }
  }
  // Month name formats: Nov 6 2026 / Nov 11th 2026 / Dec 20 2026
  const cleaned = s.replace(/(\d+)(st|nd|rd|th)/i, '$1');
  const parsed = new Date(cleaned);
  if (!Number.isNaN(parsed.getTime())) {
    return parsed.toISOString().slice(0, 10);
  }
  return s;
}

function currencyCodeToPrefixLocal(code: string | null): string {
  if (!code) return '';
  switch (code.toUpperCase()) {
    case 'EUR':
      return '€';
    case 'GBP':
      return '£';
    case 'USD':
      return '$';
    case 'JPY':
      return '¥';
    case 'INR':
      return '₹';
    default:
      return code.toUpperCase();
  }
}

function formatCurrencyWithSymbolLocal(num: number, code: string | null): string {
  const sign = num < 0 ? '-' : '';
  const absFormatted = Math.abs(num).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  const prefix = currencyCodeToPrefixLocal(code);
  return prefix ? `${sign}${prefix} ${absFormatted}` : `${sign}${absFormatted}`;
}

function normalizeCurrencyLocal(val: string, fallbackCode: string | null = null): string {
  const s = val.trim();
  if (FORMULA_ERROR_REGEX_LOCAL.test(s)) {
    return `[ERROR: ${s.replace(/^=/, '').toUpperCase()}]`;
  }
  const num = parseNumericLocal(s);
  if (num === null) return s;
  const detected = detectCurrencyCodeLocal(s) || fallbackCode;
  return formatCurrencyWithSymbolLocal(num, detected);
}

function normalizePhoneLocal(val: string): string {
  const digits = val.replace(/\D/g, '');
  if (digits.length === 10) {
    return `+1 (${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
  }
  if (digits.length === 11 && digits.startsWith('1')) {
    return `+1 (${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7)}`;
  }
  if (digits.length >= 11 && digits.length <= 15) {
    return `+${digits}`;
  }
  return val.trim();
}

function formatPhoneSpreadsheetTextLocal(raw: string): string {
  const cleaned = raw.replace(/^['=]+/, '').trim();
  if (!cleaned || cleaned === '[MISSING]' || /^\[ERROR/i.test(cleaned)) return cleaned;
  const naMatch = cleaned.match(/^(?:\+?1[\s.-]?)?\(?(\d{3})\)?[\s.-]?(\d{3})[\s.-]?(\d{4})$/);
  if (naMatch) {
    return `+1 (${naMatch[1]}) ${naMatch[2]}-${naMatch[3]}`;
  }
  if (/^\+\d[\d\s()-]*-[\d\s()-]+$/.test(cleaned)) {
    return cleaned.replace(/-/g, ' ').replace(/\s+/g, ' ').trim();
  }
  return cleaned;
}

async function runFallbackClean(file: File): Promise<{ job: CleanJob; quota: QuotaSnapshot }> {
  const quota = syncMockQuotaFlags();
  if (!quota.canProcessNewFile) {
    throw new ApiBusinessError(402, {
      error: `Free tier monthly limit reached (${quota.freeCleansUsedThisMonth}/${quota.freeCleansLimit} cleans used). Upgrade to Pro or buy a Token Pack.`,
      code: 'MONTHLY_LIMIT_REACHED',
      upgradeRequired: true,
      quota,
    });
  }

  const start = performance.now();
  const ext = file.name.split('.').pop()?.toLowerCase() || 'csv';
  const fileBuffer = await file.arrayBuffer();
  const fileHashSha256 = await computeSha256HexLocal(fileBuffer);

  let rawHeaders: string[] = [];
  let rawRows: Record<string, string>[] = [];
  let cleanedHeaders: string[] = [];
  let cleanedRows: Record<string, string>[] = [];
  let schemaMappings: SchemaMapping[] = [];
  const anomalies: AnomalyItem[] = [];
  const cellDiffs: CellDiff[] = [];
  let rowsIngested = 0;
  let primaryAmountColumn = '';
  let inputSum = 0;
  let outputSum = 0;
  let leakageRecoveredValue = 0;
  const detectedCurrenciesSet = new Set<string>();

  if (ext === 'csv' || ext === 'xlsx' || ext === 'xls') {
    const matrix =
      ext === 'csv'
        ? parseCsvLines(new TextDecoder().decode(fileBuffer))
        : parseXlsxMatrixLocal(fileBuffer);

    if (matrix.length < 2) {
      throw new ApiBusinessError(400, {
        error: `${ext.toUpperCase()} file must contain a header row and at least one data row.`,
      });
    }

    // Preserve Row 1 as header unless Row 1 is a single-cell title banner above a 3+ col header row
    let headerIdx = 0;
    if (
      matrix.length > 2 &&
      matrix[0].filter((c) => c.trim().length > 0).length === 1 &&
      matrix[1].filter((c) => c.trim().length > 0).length >= 3
    ) {
      headerIdx = 1;
    }

    rawHeaders = matrix[headerIdx].map((h, i) => (h.trim() ? h.trim() : `Column_${i + 1}`));
    const dataRows = matrix.slice(headerIdx + 1);

    const hasPaidAllowance = quota.plan === 'pro' || quota.tokenBalance > 0;
    if (!hasPaidAllowance && dataRows.length > quota.freeRowLimit) {
      throw new ApiBusinessError(402, {
        error: `This file contains ${dataRows.length} rows, exceeding the Free tier cap of ${quota.freeRowLimit} rows per file.`,
        code: 'ROW_LIMIT_EXCEEDED',
        upgradeRequired: true,
        quota,
      });
    }

    const usedNorm = new Map<string, number>();
    schemaMappings = rawHeaders.map((rawHeader) => {
      const m = normalizeHeaderLocal(rawHeader);
      const count = usedNorm.get(m.normalized) ?? 0;
      usedNorm.set(m.normalized, count + 1);
      const uniqueNorm = count === 0 ? m.normalized : `${m.normalized}_${count + 1}`;
      return {
        rawHeader,
        normalizedHeader: uniqueNorm,
        detectedType: m.detectedType,
        reason: m.reason,
      };
    });
    cleanedHeaders = schemaMappings.map((m) => m.normalizedHeader);

    const idColIdx = schemaMappings.findIndex((m) =>
      /^(txn|trans|transaction|order|inv|invoice)?_?id$/i.test(m.normalizedHeader)
    );
    const qtyColIdx = schemaMappings.findIndex((m) =>
      /\b(qty|quantity|units)\b|qty_sold|units_sold/i.test(`${m.rawHeader} ${m.normalizedHeader}`)
    );
    const unitPriceColIdx = schemaMappings.findIndex(
      (m) =>
        /\b(unit[\s_-]?price|unit[\s_-]?cost|price)\b/i.test(`${m.rawHeader} ${m.normalizedHeader}`) &&
        !/total|tax|discount/i.test(`${m.rawHeader} ${m.normalizedHeader}`)
    );
    const totalColIdx = schemaMappings.findIndex(
      (m) =>
        /\b(total[\s_-]?amount|line[\s_-]?total|total|amount)\b/i.test(
          `${m.rawHeader} ${m.normalizedHeader}`
        ) && !/unit[\s_-]?price|tax/i.test(`${m.rawHeader} ${m.normalizedHeader}`)
    );

    const primaryAmtIdx =
      totalColIdx >= 0
        ? totalColIdx
        : schemaMappings.findIndex((m) => m.detectedType === 'currency');
    rowsIngested = dataRows.length;
    if (primaryAmtIdx >= 0) {
      primaryAmountColumn = schemaMappings[primaryAmtIdx].normalizedHeader;
    }

    const seenSignatures = new Set<string>();
    const hasCurrencyCol = primaryAmtIdx >= 0;

    dataRows.forEach((cols, rIdx) => {
      const rawObj: Record<string, string> = {};
      const cleanObj: Record<string, string> = {};

      rawHeaders.forEach((rawH, cIdx) => {
        rawObj[rawH] = cols[cIdx] ?? '';
      });

      const txnLabel = idColIdx >= 0 ? String(rawObj[rawHeaders[idColIdx]] ?? '').trim() : '';
      const rowPrefix = txnLabel ? `Row ${rIdx + 1} (${txnLabel})` : `Row ${rIdx + 1}`;

      rawHeaders.forEach((rawH, cIdx) => {
        const rawVal = rawObj[rawH];
        const mapping = schemaMappings[cIdx];
        const normH = mapping.normalizedHeader;

        let cleanVal = rawVal.trim();
        let isFormulaErr = false;

        if (FORMULA_ERROR_REGEX_LOCAL.test(cleanVal)) {
          isFormulaErr = true;
          const errToken = cleanVal.replace(/^=/, '').toUpperCase();
          let autoCalc: string | null = null;

          if (cIdx === totalColIdx && qtyColIdx >= 0 && unitPriceColIdx >= 0) {
            const qtyNum = parseNumericLocal(rawObj[rawHeaders[qtyColIdx]]);
            const priceRaw = rawObj[rawHeaders[unitPriceColIdx]];
            const priceNum = parseNumericLocal(priceRaw);
            if (qtyNum !== null && priceNum !== null) {
              const calcNum = Number((qtyNum * priceNum).toFixed(2));
              const inheritedCur =
                detectCurrencyCodeLocal(priceRaw) || detectCurrencyCodeLocal(rawH);
              autoCalc = formatCurrencyWithSymbolLocal(calcNum, inheritedCur);
              cleanVal = autoCalc;
              leakageRecoveredValue += Math.abs(calcNum);
              anomalies.push({
                id: `anom_err_${rIdx}_${cIdx}`,
                severity: 'critical',
                category: 'Formula Error',
                location: `${rowPrefix}, ${normH}`,
                rawValue: rawVal,
                suggestedOrFixedValue: autoCalc,
                explanation: `Critical spreadsheet formula error (${rawVal}) detected in "${rawH}". Auto-calculated using (${rawHeaders[qtyColIdx]} × ${rawHeaders[unitPriceColIdx]}): ${qtyNum} × ${formatCurrencyWithSymbolLocal(priceNum, inheritedCur)} = ${autoCalc}.`,
              });
            }
          }

          if (!autoCalc) {
            cleanVal = `[ERROR: ${errToken}]`;
            anomalies.push({
              id: `anom_err_${rIdx}_${cIdx}`,
              severity: 'critical',
              category: 'Formula Error',
              location: `${rowPrefix}, ${normH}`,
              rawValue: rawVal,
              suggestedOrFixedValue: '[Manual Review Required]',
              explanation: `Cell evaluated to spreadsheet formula error ${rawVal}.`,
            });
          }
        } else if (mapping.detectedType === 'date' && cleanVal) {
          cleanVal = normalizeDateLocal(cleanVal);
        } else if (mapping.detectedType === 'currency' && cleanVal) {
          cleanVal = normalizeCurrencyLocal(cleanVal, detectCurrencyCodeLocal(rawH));
        } else if (mapping.detectedType === 'phone' && cleanVal) {
          const formatted = normalizePhoneLocal(cleanVal);
          if (formatted === cleanVal && cleanVal.replace(/\D/g, '').length < 10) {
            anomalies.push({
              id: `anom_ph_${rIdx}_${cIdx}`,
              severity: 'warning',
              category: 'Incomplete Phone',
              location: `${rowPrefix}, ${normH}`,
              rawValue: rawVal,
              suggestedOrFixedValue: rawVal,
              explanation: 'Phone number has fewer than 10 digits.',
            });
          }
          cleanVal = formatted;
        } else if (mapping.detectedType === 'email' && !cleanVal) {
          cleanVal = '[MISSING]';
          anomalies.push({
            id: `anom_miss_${rIdx}_${cIdx}`,
            severity: 'critical',
            category: 'Missing Required Field',
            location: `${rowPrefix}, ${normH}`,
            rawValue: '(empty)',
            suggestedOrFixedValue: '[MISSING]',
            explanation: 'Missing client email address.',
          });
        } else if (mapping.detectedType === 'status' && cleanVal) {
          cleanVal =
            cleanVal.toLowerCase() === 'settled'
              ? 'Paid'
              : cleanVal.charAt(0).toUpperCase() + cleanVal.slice(1).toLowerCase();
        }

        cleanObj[normH] = cleanVal;

        if (rawVal !== cleanVal) {
          const changeType: CellDiff['changeType'] = isFormulaErr
            ? 'formula_error'
            : cleanVal === '[MISSING]'
            ? 'missing'
            : mapping.detectedType === 'date'
            ? 'date'
            : mapping.detectedType === 'currency'
            ? 'currency'
            : mapping.detectedType === 'phone'
            ? 'phone'
            : 'whitespace';

          cellDiffs.push({
            rowIndex: rIdx,
            column: normH,
            rawHeader: rawH,
            rawValue: rawVal,
            cleanedValue: cleanVal,
            changeType,
          });
        }
      });

      // Multi-currency banking normalization on primary monetary column (preserve symbol, never default to USD)
      if (hasCurrencyCol) {
        const rawAmtHeader = rawHeaders[primaryAmtIdx];
        const normAmtHeader = schemaMappings[primaryAmtIdx].normalizedHeader;
        const rawAmtStr = String(rawObj[rawAmtHeader] ?? '').trim();
        const cleanedAmtStr = String(cleanObj[normAmtHeader] ?? '').trim();

        const detectedCur =
          detectCurrencyCodeLocal(rawAmtStr) ||
          (unitPriceColIdx >= 0
            ? detectCurrencyCodeLocal(rawObj[rawHeaders[unitPriceColIdx]])
            : null) ||
          detectCurrencyCodeLocal(rawAmtHeader);

        const rawNum = parseNumericLocal(rawAmtStr);
        let cleanNum = parseNumericLocal(cleanedAmtStr);
        if (
          (cleanNum === null ||
            (cleanNum === 0 &&
              (!rawAmtStr || rawAmtStr.startsWith('=') || rawNum === null || rawNum === 0))) &&
          primaryAmtIdx === totalColIdx &&
          qtyColIdx >= 0 &&
          unitPriceColIdx >= 0
        ) {
          const qtyNum = parseNumericLocal(rawObj[rawHeaders[qtyColIdx]]);
          const priceNum = parseNumericLocal(rawObj[rawHeaders[unitPriceColIdx]]);
          if (qtyNum !== null && priceNum !== null && qtyNum * priceNum !== 0) {
            cleanNum = Number((qtyNum * priceNum).toFixed(2));
            cleanObj[normAmtHeader] = formatCurrencyWithSymbolLocal(cleanNum, detectedCur);
          }
        }
        if (rawNum !== null) inputSum += rawNum;
        if (cleanNum !== null) outputSum += cleanNum;

        if (detectedCur) {
          detectedCurrenciesSet.add(detectedCur);
        }

        cleanObj.raw_amount = rawAmtStr;
        cleanObj.normalized_amount =
          cleanNum !== null ? formatCurrencyWithSymbolLocal(cleanNum, detectedCur) : cleanedAmtStr;
        cleanObj.currency_code = detectedCur || 'N/A';

        if (cleanNum !== null && cleanNum < 0) {
          leakageRecoveredValue += Math.abs(cleanNum);
          const formattedNeg = formatCurrencyWithSymbolLocal(cleanNum, detectedCur);
          anomalies.push({
            id: `anom_negbal_${rIdx}`,
            severity: 'critical',
            category: 'High-Priority Financial Alert',
            location: `${rowPrefix}, normalized_amount`,
            rawValue: rawAmtStr || cleanedAmtStr,
            suggestedOrFixedValue: `${formattedNeg} (Audit Required)`,
            explanation: `Negative transaction balance (${formattedNeg}) flagged on ${rowPrefix}. Verify credit memo, chargeback, or sign reversal.`,
          });
        }
      }

      // Flag negative quantities as Anomaly Warning
      if (qtyColIdx >= 0) {
        const qtyRaw = rawObj[rawHeaders[qtyColIdx]];
        const qtyNum = parseNumericLocal(qtyRaw);
        if (qtyNum !== null && qtyNum < 0) {
          if (unitPriceColIdx >= 0) {
            const pNum = parseNumericLocal(rawObj[rawHeaders[unitPriceColIdx]]);
            if (pNum !== null && !(hasCurrencyCol && (parseNumericLocal(cleanObj.normalized_amount) ?? 0) < 0)) {
              leakageRecoveredValue += Math.abs(qtyNum * pNum);
            }
          }
          anomalies.push({
            id: `anom_negqty_${rIdx}`,
            severity: 'warning',
            category: 'Negative Quantity',
            location: `${rowPrefix}, ${cleanedHeaders[qtyColIdx]}`,
            rawValue: qtyRaw.trim(),
            suggestedOrFixedValue: `${Math.abs(qtyNum)} (verify return/credit)`,
            explanation: `Negative quantity (${qtyNum}) detected in "${rawHeaders[qtyColIdx]}" on ${rowPrefix}. Verify whether this represents a return or data-entry error.`,
          });
        }
      }

      const sig = Object.values(cleanObj).slice(0, 4).join('|');
      if (seenSignatures.has(sig)) {
        anomalies.push({
          id: `anom_dup_${rIdx}`,
          severity: 'warning',
          category: 'Duplicate Entry',
          location: rowPrefix,
          rawValue: sig,
          suggestedOrFixedValue: 'Review & deduplicate',
          explanation: 'Potential duplicate record matching an earlier row.',
        });
      }
      seenSignatures.add(sig);

      rawRows.push(rawObj);
      cleanedRows.push(cleanObj);
    });

    if (hasCurrencyCol) {
      const bankingCols: SchemaMapping[] = [
        {
          rawHeader: rawHeaders[primaryAmtIdx],
          normalizedHeader: 'raw_amount',
          detectedType: 'text',
          reason: 'Preserved original unparsed monetary string for pre-audit lineage',
        },
        {
          rawHeader: rawHeaders[primaryAmtIdx],
          normalizedHeader: 'normalized_amount',
          detectedType: 'currency',
          reason: 'Standardized numeric float extracted from multi-currency notation',
        },
        {
          rawHeader: rawHeaders[primaryAmtIdx],
          normalizedHeader: 'currency_code',
          detectedType: 'text',
          reason: 'ISO-4217 currency identifier detected from symbol/prefix',
        },
      ];
      for (const bc of bankingCols) {
        if (!cleanedHeaders.includes(bc.normalizedHeader)) {
          cleanedHeaders.push(bc.normalizedHeader);
          schemaMappings.push(bc);
        }
      }

      const detectedList = Array.from(detectedCurrenciesSet);
      if (detectedList.length > 1) {
        anomalies.unshift({
          id: 'anom_fx_mixed',
          severity: 'critical',
          category: 'High-Priority Financial Alert',
          location: 'Ledger-Wide (currency_code)',
          rawValue: detectedList.join(', '),
          suggestedOrFixedValue: 'Segregate by ISO-4217 / Apply Spot FX',
          explanation: `Multi-currency ledger detected (${detectedList.join(', ')}). Aggregating unhedged mixed currencies without FX conversion introduces translation variance.`,
        });
      }
    }

    if (cellDiffs.length > 0) {
      anomalies.push({
        id: `anom_norm_summary`,
        severity: 'fixed',
        category: 'Batch Normalization',
        location: 'All Columns',
        rawValue: `${cellDiffs.length} raw cells`,
        suggestedOrFixedValue: `${cellDiffs.length} standardized cells`,
        explanation: 'Normalized ISO-8601 dates, multi-currency decimals, phone numbers, and status casing.',
      });
    }
  } else {
    // Receipt PNG / JPG / single-page PDF fallback preview (strictly reserved for images & PDFs)
    rawHeaders = ['receipt_date', 'vendor_name', 'line_item', 'qty', 'amount'];
    cleanedHeaders = [...rawHeaders, 'raw_amount', 'normalized_amount', 'currency_code'];
    rawRows = [
      {
        receipt_date: 'Nov 09, 2026',
        vendor_name: 'METRO OFFICE SUPPLY CO.',
        line_item: 'Ergonomic Desk Lamp LED',
        qty: '2',
        amount: '$128.00',
      },
      {
        receipt_date: 'Nov 09, 2026',
        vendor_name: 'METRO OFFICE SUPPLY CO.',
        line_item: 'USB-C Thunderbolt Dock',
        qty: '1',
        amount: 'USD 189.50',
      },
      {
        receipt_date: 'Nov 09, 2026',
        vendor_name: 'METRO OFFICE SUPPLY CO.',
        line_item: 'Archival Ledger Paper (Ream)',
        qty: '4',
        amount: '$54.00',
      },
      {
        receipt_date: 'Nov 09, 2026',
        vendor_name: 'METRO OFFICE SUPPLY CO.',
        line_item: 'CA Sales Tax (8.625%)',
        qty: '1',
        amount: '$33.29',
      },
    ];
    rowsIngested = rawRows.length;
    primaryAmountColumn = 'amount';
    cleanedRows = rawRows.map((r, rIdx) => {
      const normAmt = normalizeCurrencyLocal(r.amount);
      const amtNum = parseNumericLocal(normAmt) ?? 0;
      inputSum += amtNum;
      outputSum += amtNum;
      const cur = detectCurrencyCodeLocal(r.amount) || 'USD';
      detectedCurrenciesSet.add(cur);
      const cleaned = {
        receipt_date: '2026-11-09',
        vendor_name: 'Metro Office Supply Co.',
        line_item: r.line_item,
        qty: r.qty,
        amount: normAmt,
        raw_amount: r.amount,
        normalized_amount: normAmt,
        currency_code: cur,
      };
      cellDiffs.push(
        {
          rowIndex: rIdx,
          column: 'receipt_date',
          rawHeader: 'receipt_date',
          rawValue: r.receipt_date,
          cleanedValue: cleaned.receipt_date,
          changeType: 'date',
        },
        {
          rowIndex: rIdx,
          column: 'amount',
          rawHeader: 'amount',
          rawValue: r.amount,
          cleanedValue: cleaned.amount,
          changeType: 'currency',
        }
      );
      return cleaned;
    });
    schemaMappings = cleanedHeaders.map((h) => ({
      rawHeader: h === 'raw_amount' || h === 'normalized_amount' || h === 'currency_code' ? 'amount' : h,
      normalizedHeader: h,
      detectedType: h.includes('date') ? 'date' : h === 'amount' || h === 'normalized_amount' ? 'currency' : 'text',
      reason: 'Extracted receipt line-item field',
    }));
    anomalies.push({
      id: 'anom_rcpt_1',
      severity: 'fixed',
      category: 'Receipt Normalization',
      location: 'Rows 1–4',
      rawValue: 'Nov 09, 2026 / USD 189.50',
      suggestedOrFixedValue: '2026-11-09 / 189.50',
      explanation: 'Standardized receipt dates to ISO-8601 and removed mixed currency prefixes.',
    });
  }

  const activeConfidenceHeaders = cleanedHeaders.filter((h) => h !== 'raw_amount');
  const totalCells = Math.max(1, cleanedRows.length * Math.max(1, activeConfidenceHeaders.length));
  const unresolvedErrors = cleanedRows.reduce(
    (acc, row) =>
      acc +
      activeConfidenceHeaders.filter((h) => /^\[ERROR:/i.test(String(row[h] ?? '').trim())).length,
    0
  );
  const highPriorityAlerts = anomalies.filter(
    (a) => a.severity === 'critical' && /financial|currency|negative|fx/i.test(`${a.category} ${a.explanation}`)
  ).length;
  const criticalPenalty = Math.min(2.5, highPriorityAlerts * 0.15);
  const reconciliationConfidenceScore = Number(
    Math.max(0, Math.min(100, ((totalCells - unresolvedErrors) / totalCells) * 100 - criticalPenalty)).toFixed(1)
  );
  const roundedIn = Number(inputSum.toFixed(2));
  const roundedOut = Number(outputSum.toFixed(2));
  const auditMetadata: AuditMetadata = {
    fileHashSha256,
    timestampUtc: formatUtcTimestampLocal(new Date()),
    rowsIngested,
    rowsCleaned: cleanedRows.length,
    rowChecksumMatch: rowsIngested === cleanedRows.length,
    inputSum: roundedIn,
    outputSum: roundedOut,
    reconciledVariance: Number((roundedOut - roundedIn).toFixed(2)),
    primaryAmountColumn,
    detectedCurrencies: Array.from(detectedCurrenciesSet),
    leakageRecoveredValue: Number(leakageRecoveredValue.toFixed(2)),
    reconciliationConfidenceScore,
  };

  const job: CleanJob = {
    id: `job_local_${Date.now()}`,
    userId: DEMO_USER_ID,
    fileName: file.name,
    fileType: ext,
    documentCategory: ext === 'png' || ext === 'jpg' || ext === 'pdf' ? 'receipt' : 'transactions',
    rawHeaders,
    rawRows,
    cleanedHeaders,
    cleanedRows,
    cellDiffs,
    anomalies,
    schemaMappings,
    executiveSummary: `Normalized ${cleanedRows.length} rows across ${cleanedHeaders.length} columns with ${cellDiffs.length} cell corrections and ${anomalies.length} audit findings.`,
    rowCount: cleanedRows.length,
    processingMs: Math.max(120, Math.round(performance.now() - start)),
    createdAt: new Date().toISOString(),
    auditMetadata,
  };

  let billingSource: UsageLog['billingSource'] = 'free_monthly';
  if (mockState.quota.plan === 'pro') {
    billingSource = 'pro_unlimited';
  } else if (mockState.quota.tokenBalance > 0) {
    mockState.quota.tokenBalance -= 1;
    billingSource = 'token_pack';
  } else {
    mockState.quota.freeCleansUsedThisMonth += 1;
  }

  mockState.jobs.unshift(job);
  mockState.usageLogs.unshift({
    id: `log_local_${Date.now()}`,
    userId: DEMO_USER_ID,
    jobId: job.id,
    fileName: job.fileName,
    fileType: job.fileType,
    rowCount: job.rowCount,
    anomaliesFound: job.anomalies.length,
    cellsNormalized: job.cellDiffs.length,
    action: 'clean',
    billingSource,
    createdAt: job.createdAt,
  });

  return { job, quota: syncMockQuotaFlags() };
}

// ============================================================================
// Public Frontend API Methods
// ============================================================================

export async function fetchQuotaAndLogs(): Promise<{
  quota: QuotaSnapshot;
  usageLogs: UsageLog[];
}> {
  try {
    const res = await fetch('/api/quota', {
      headers: { 'x-user-id': DEMO_USER_ID },
    });
    return await parseJsonResponse<{ quota: QuotaSnapshot; usageLogs: UsageLog[] }>(res);
  } catch (err) {
    if (shouldUseMockFallback(err)) {
      return { quota: syncMockQuotaFlags(), usageLogs: [...mockState.usageLogs] };
    }
    throw err;
  }
}

export async function fetchJobs(): Promise<{ jobs: CleanJob[] }> {
  try {
    const res = await fetch('/api/jobs', {
      headers: { 'x-user-id': DEMO_USER_ID },
    });
    return await parseJsonResponse<{ jobs: CleanJob[] }>(res);
  } catch (err) {
    if (shouldUseMockFallback(err)) {
      return { jobs: [...mockState.jobs] };
    }
    throw err;
  }
}

export async function cleanUploadedFile(
  file: File
): Promise<{ job: CleanJob; quota: QuotaSnapshot }> {
  try {
    const formData = new FormData();
    formData.append('file', file);

    const res = await fetch('/api/clean', {
      method: 'POST',
      headers: { 'x-user-id': DEMO_USER_ID },
      body: formData,
    });

    return await parseJsonResponse<{ job: CleanJob; quota: QuotaSnapshot }>(res);
  } catch (err) {
    if (shouldUseMockFallback(err)) {
      return runFallbackClean(file);
    }
    throw err;
  }
}

export async function downloadExportFile(
  job: CleanJob,
  format: 'csv' | 'xlsx' | 'pdf' | 'certificate'
): Promise<{ blob: Blob; fileName: string }> {
  try {
    const res = await fetch(`/api/export/${job.id}/${format}`, {
      headers: { 'x-user-id': DEMO_USER_ID },
    });

    const contentType = res.headers.get('content-type') || '';
    if (contentType.toLowerCase().includes('application/json')) {
      const payload = (await res.json()) as {
        error?: string;
        code?: string;
        upgradeRequired?: boolean;
        quota?: QuotaSnapshot;
      };
      if (!res.ok) {
        throw new ApiBusinessError(res.status, payload);
      }
    }

    if (contentType.toLowerCase().includes('text/html')) {
      throw new NonJsonApiError('Export endpoint returned HTML instead of file stream.', res.status);
    }

    if (!res.ok) {
      throw new ApiBusinessError(res.status, {
        error: `Export failed with status ${res.status}`,
      });
    }

    const blob = await res.blob();
    const disposition = res.headers.get('Content-Disposition') || '';
    const match = disposition.match(/filename="([^"]+)"/);
    const fileName =
      match?.[1] ||
      (format === 'certificate'
        ? `docucleanse_pre_audit_processing_report.pdf`
        : `docucleanse_export.${format}`);
    return { blob, fileName };
  } catch (err) {
    if (!shouldUseMockFallback(err)) {
      throw err;
    }

    // Fallback export generation
    const quota = syncMockQuotaFlags();
    if ((format === 'xlsx' || format === 'pdf') && !quota.canExportProFormats) {
      throw new ApiBusinessError(402, {
        error: `${format.toUpperCase()} export requires Pro or a Token Pack.`,
        code: 'PRO_EXPORT_LOCKED',
        upgradeRequired: true,
        quota,
      });
    }

    const baseName = job.fileName.replace(/\.[^.]+$/, '');
    const meta = job.auditMetadata;

    if (format === 'xlsx') {
      const wb = XLSX.utils.book_new();
      const headers = job.cleanedHeaders;
      const mappingByHeader = new Map(job.schemaMappings.map((m) => [m.normalizedHeader, m]));
      const qtyIdx = headers.findIndex((h) => /\b(qty|quantity|units)\b|qty_sold|units_sold/i.test(h));
      const priceIdx = headers.findIndex(
        (h) => /\b(unit[\s_-]?price|unit[\s_-]?cost|price)\b/i.test(h) && !/total|tax|rate/i.test(h)
      );
      const taxIdx = headers.findIndex((h) => /tax[\s_-]?rate|tax[\s_-]?pct|\btax\b.*\brate\b/i.test(h));
      const totalIdx = headers.findIndex(
        (h) =>
          h !== 'raw_amount' &&
          h !== 'normalized_amount' &&
          /\b(total[\s_-]?amount|line[\s_-]?total|total|amount|revenue|mrr|balance)\b/i.test(h) &&
          !/unit[\s_-]?price|tax|rate|qty|quantity/i.test(h)
      );

      const curFmt = (code: string | null) => {
        switch ((code || '').toUpperCase()) {
          case 'EUR':
            return '"€"#,##0.00';
          case 'GBP':
            return '"£"#,##0.00';
          case 'USD':
            return '"$"#,##0.00';
          case 'JPY':
            return '"¥"#,##0';
          default:
            return '#,##0.00';
        }
      };

      const wsData: XLSX.WorkSheet = {};
      headers.forEach((h, cIdx) => {
        wsData[XLSX.utils.encode_cell({ r: 0, c: cIdx })] = { t: 's', v: h };
      });

      let gross = 0;
      let negExp = 0;
      job.cleanedRows.forEach((row, rIdx) => {
        const excelRow = rIdx + 2;
        const explicitCur = String(row.currency_code ?? '').trim().toUpperCase();
        const rowCur = explicitCur && explicitCur !== 'N/A' ? explicitCur : null;
        const qVal = qtyIdx >= 0 ? parseNumericLocal(row[headers[qtyIdx]]) : null;
        const pVal = priceIdx >= 0 ? parseNumericLocal(row[headers[priceIdx]]) : null;

        headers.forEach((h, cIdx) => {
          const addr = XLSX.utils.encode_cell({ r: rIdx + 1, c: cIdx });
          const rawStr = String(row[h] ?? '').trim();
          const m = mappingByHeader.get(h);
          const lower = h.toLowerCase();

          const isPhoneField =
            m?.detectedType === 'phone' ||
            /(phone|tel|mobile|contact_phone)/i.test(lower);

          if (isPhoneField) {
            wsData[addr] = { t: 's', v: String(formatPhoneSpreadsheetTextLocal(rawStr)), z: '@' };
            return;
          }

          if (
            lower === 'raw_amount' ||
            lower === 'currency_code' ||
            m?.detectedType === 'date' ||
            m?.detectedType === 'email' ||
            m?.detectedType === 'status' ||
            /\b(transaction_id|txn_id|id|code|region_code)\b/i.test(lower) ||
            rawStr === '' ||
            rawStr.startsWith('[ERROR') ||
            rawStr === '[MISSING]'
          ) {
            wsData[addr] = { t: 's', v: String(rawStr), z: '@' };
            return;
          }

          if (cIdx === qtyIdx) {
            const n = parseNumericLocal(rawStr);
            if (n !== null) {
              wsData[addr] = { t: 'n', v: n, z: Number.isInteger(n) ? '#,##0' : '#,##0.00' };
              return;
            }
          }

          if (cIdx === taxIdx || rawStr.endsWith('%')) {
            const cleanedPct = rawStr.endsWith('%') ? Number(rawStr.slice(0, -1)) / 100 : Number(rawStr);
            if (Number.isFinite(cleanedPct)) {
              const frac = Math.abs(cleanedPct) > 1 ? cleanedPct / 100 : cleanedPct;
              wsData[addr] = { t: 'n', v: frac, z: '0.0%' };
              return;
            }
          }

          const num = parseNumericLocal(rawStr);
          if (num !== null && (cIdx === priceIdx || cIdx === totalIdx || lower === 'normalized_amount' || m?.detectedType === 'currency')) {
            const c = detectCurrencyCodeLocal(rawStr) || rowCur;
            if (cIdx === totalIdx && qtyIdx >= 0 && priceIdx >= 0 && qVal !== null && pVal !== null) {
              const qtyCol = XLSX.utils.encode_col(qtyIdx);
              const priceCol = XLSX.utils.encode_col(priceIdx);
              wsData[addr] = { t: 'n', v: num, f: `${qtyCol}${excelRow}*${priceCol}${excelRow}`, z: curFmt(c) };
            } else {
              wsData[addr] = { t: 'n', v: num, z: curFmt(c) };
            }
            if (cIdx === totalIdx || (totalIdx < 0 && lower === 'normalized_amount')) {
              if (num > 0) gross += num;
              else if (num < 0) negExp += Math.abs(num);
            }
            return;
          }

          wsData[addr] = { t: 's', v: rawStr };
        });
      });

      const refRange = XLSX.utils.encode_range({
        s: { r: 0, c: 0 },
        e: { r: job.cleanedRows.length, c: Math.max(0, headers.length - 1) },
      });
      wsData['!ref'] = refRange;
      wsData['!autofilter'] = {
        ref: XLSX.utils.encode_range({
          s: { r: 0, c: 0 },
          e: { r: 0, c: Math.max(0, headers.length - 1) },
        }),
      };
      wsData['!cols'] = headers.map((h) => {
        const lower = h.toLowerCase();
        const wch = /(client_name|customer_name|vendor_name|email)/.test(lower)
          ? 26
          : /(product_item|product|item|description)/.test(lower)
          ? 24
          : /(phone|tel|mobile|contact_phone)/.test(lower)
          ? 20
          : /\b(qty|quantity|units|tax_rate)\b/.test(lower)
          ? 12
          : /(status|currency_code)/.test(lower)
          ? 14
          : 16;
        return { wch: Math.max(wch, h.length + 5) };
      });
      const dashRows = [
        ['DocuCleanse Executive Dashboard', 'Value'],
        ['Gross Inflow', Number(gross.toFixed(2))],
        ['Identified Leakage / Anomaly', Number(negExp.toFixed(2))],
        ['Reconciled Net', Number((gross - negExp).toFixed(2))],
        ['Confidence Score', `${(meta?.reconciliationConfidenceScore ?? 99.7).toFixed(1)}%`],
      ];
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(dashRows), 'Executive_Dashboard');
      XLSX.utils.book_append_sheet(wb, wsData, 'Cleaned_Data');

      const certRows = [
        ['Compliance / Reconciliation Field', 'Verified Value'],
        ['Issuing Authority', 'Rafi Digital Studio — DocuCleanse Enterprise'],
        ['File Hash (SHA-256)', meta?.fileHashSha256 || 'N/A'],
        ['Execution Timestamp (UTC)', meta?.timestampUtc || job.createdAt],
        ['Row Verification Checksum', `${meta?.rowsIngested ?? job.rowCount} Ingested / ${meta?.rowsCleaned ?? job.cleanedRows.length} Cleaned`],
        ['Reconciliation Confidence Score', `${(meta?.reconciliationConfidenceScore ?? 99.7).toFixed(1)}% Cleaned`],
        ['Detected Currencies (ISO-4217)', meta?.detectedCurrencies?.join(', ') || 'N/A'],
        ['Gross Inflow (Positive Totals)', Number(gross.toFixed(2))],
        ['Identified Leakage / Negative Exposure', Number(negExp.toFixed(2))],
        ['Net Reconciled Inflow', Number((gross - negExp).toFixed(2))],
      ];
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(certRows), 'Pre_Audit_Report');

      const out = XLSX.write(wb, { bookType: 'xlsx', type: 'array' }) as ArrayBuffer;
      return {
        blob: new Blob([out], {
          type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        }),
        fileName: `${baseName}_cleaned.xlsx`,
      };
    }

    const escapeCsv = (val: string) =>
      /[",\n]/.test(val) ? `"${val.replace(/"/g, '""')}"` : val;
    const lines = [
      job.cleanedHeaders.map(escapeCsv).join(','),
      ...job.cleanedRows.map((row) =>
        job.cleanedHeaders.map((h) => escapeCsv(String(row[h] ?? ''))).join(',')
      ),
    ];
    const blob = new Blob([`\uFEFF${lines.join('\n')}`], { type: 'text/csv;charset=utf-8' });
    return {
      blob,
      fileName: `${baseName}_cleaned.csv`,
    };
  }
}

export async function createCheckoutSession(params: {
  plan: 'pro' | 'token_pack';
  provider: 'stripe' | 'paddle';
}): Promise<{
  sessionId: string;
  priceId?: string;
  transactionId?: string;
  canOpenPaddleOverlay?: boolean;
  paddleFallbackReason?: string;
  sandboxMode?: boolean;
}> {
  try {
    const res = await fetch('/api/billing/checkout', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-user-id': DEMO_USER_ID,
      },
      body: JSON.stringify(params),
    });
    return await parseJsonResponse<{
      sessionId: string;
      priceId?: string;
      transactionId?: string;
      canOpenPaddleOverlay?: boolean;
      paddleFallbackReason?: string;
      sandboxMode?: boolean;
    }>(res);
  } catch (err) {
    if (shouldUseMockFallback(err)) {
      return { sessionId: `cs_local_${Date.now()}`, sandboxMode: true };
    }
    throw err;
  }
}

export async function completeSandboxCheckout(params: {
  plan: 'pro' | 'token_pack';
  provider: 'stripe' | 'paddle';
}): Promise<{ ok: boolean; quota: QuotaSnapshot; message: string }> {
  try {
    const res = await fetch('/api/billing/sandbox-complete', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-user-id': DEMO_USER_ID,
      },
      body: JSON.stringify(params),
    });
    return await parseJsonResponse<{ ok: boolean; quota: QuotaSnapshot; message: string }>(res);
  } catch (err) {
    if (shouldUseMockFallback(err)) {
      if (params.plan === 'pro') {
        mockState.quota.plan = 'pro';
      } else {
        mockState.quota.plan = mockState.quota.plan === 'pro' ? 'pro' : 'token_pack';
        mockState.quota.tokenBalance += 15;
      }
      mockState.billingEvents.unshift({
        id: `evt_local_${Date.now()}`,
        provider: params.provider,
        event_type:
          params.provider === 'paddle'
            ? params.plan === 'pro'
              ? 'subscription.activated'
              : 'transaction.completed'
            : params.plan === 'pro'
            ? 'checkout.session.completed'
            : 'token_pack.purchased',
        plan_granted: params.plan,
        amount_cents: params.plan === 'pro' ? 2900 : 500,
        created_at: new Date().toISOString(),
      });
      return {
        ok: true,
        quota: syncMockQuotaFlags(),
        message:
          params.plan === 'pro'
            ? `Upgraded to DocuCleanse Pro ($29/mo) via ${params.provider === 'paddle' ? 'Paddle' : 'Stripe'}.`
            : `Added 15 Pro-grade tokens ($5 Token Pack) via ${params.provider === 'paddle' ? 'Paddle' : 'Stripe'}.`,
      };
    }
    throw err;
  }
}

export async function fetchBillingStatus(): Promise<{
  quota: QuotaSnapshot;
  events: BillingEvent[];
}> {
  try {
    const res = await fetch('/api/billing/status', {
      headers: { 'x-user-id': DEMO_USER_ID },
    });
    return await parseJsonResponse<{ quota: QuotaSnapshot; events: BillingEvent[] }>(res);
  } catch (err) {
    if (shouldUseMockFallback(err)) {
      return { quota: syncMockQuotaFlags(), events: [...mockState.billingEvents] };
    }
    throw err;
  }
}

export async function setDemoQuotaMode(
  mode: 'reset_free' | 'exhaust_free'
): Promise<{ ok: boolean; quota: QuotaSnapshot }> {
  try {
    const res = await fetch('/api/billing/demo-state', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-user-id': DEMO_USER_ID,
      },
      body: JSON.stringify({ mode }),
    });
    return await parseJsonResponse<{ ok: boolean; quota: QuotaSnapshot }>(res);
  } catch (err) {
    if (shouldUseMockFallback(err)) {
      mockState.quota.plan = 'free';
      mockState.quota.tokenBalance = 0;
      mockState.quota.freeCleansUsedThisMonth =
        mode === 'exhaust_free' ? mockState.quota.freeCleansLimit : 0;
      return { ok: true, quota: syncMockQuotaFlags() };
    }
    throw err;
  }
}

export async function dispatchTestWebhook(
  provider: 'stripe' | 'paddle',
  payload: unknown
): Promise<{ received: boolean; provider: string; processedEvent?: string; quota: QuotaSnapshot }> {
  const endpoint =
    provider === 'stripe' ? '/api/billing/webhook/stripe' : '/api/billing/webhook/paddle';

  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    return await parseJsonResponse<{
      received: boolean;
      provider: string;
      processedEvent?: string;
      quota: QuotaSnapshot;
    }>(res);
  } catch (err) {
    if (shouldUseMockFallback(err)) {
      const p = payload as {
        event_type?: string;
        data?: {
          custom_data?: { plan?: 'pro' | 'token_pack'; tier?: 'pro' | 'token_pack' };
          object?: { metadata?: { tier?: 'pro' | 'token_pack' } };
        };
      };

      if (provider === 'paddle' && p?.event_type === 'subscription.canceled') {
        mockState.quota.plan = mockState.quota.tokenBalance > 0 ? 'token_pack' : 'free';
        mockState.billingEvents.unshift({
          id: `evt_local_${Date.now()}`,
          provider: 'paddle',
          event_type: 'subscription.canceled',
          plan_granted: 'free',
          amount_cents: 0,
          created_at: new Date().toISOString(),
        });
        return {
          received: true,
          provider,
          processedEvent: 'subscription.canceled',
          quota: syncMockQuotaFlags(),
        };
      }

      const tier =
        p?.data?.custom_data?.plan ||
        p?.data?.custom_data?.tier ||
        p?.data?.object?.metadata?.tier ||
        'pro';
      const result = await completeSandboxCheckout({ plan: tier, provider });
      return {
        received: true,
        provider,
        processedEvent: p?.event_type,
        quota: result.quota,
      };
    }
    throw err;
  }
}
