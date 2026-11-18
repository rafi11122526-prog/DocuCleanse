import type {
  AnomalyItem,
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
    email: 'alex.morgan@studio-ledger.io',
    name: 'Alex Morgan',
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

function normalizeHeaderLocal(raw: string): {
  normalized: string;
  detectedType: SchemaMapping['detectedType'];
  reason: string;
} {
  const lower = raw.trim().toLowerCase();
  if (lower.includes('dt') || lower.includes('date')) {
    return {
      normalized: lower.includes('renwl') ? 'renewal_date' : 'transaction_date',
      detectedType: 'date',
      reason: 'Mapped date header to canonical ISO-8601 date column',
    };
  }
  if (lower.includes('amt') || lower.includes('amount') || lower.includes('mrr') || lower.includes('total')) {
    return {
      normalized: lower.includes('mrr') ? 'monthly_recurring_revenue' : 'amount',
      detectedType: 'currency',
      reason: 'Standardized monetary header to clean decimal currency column',
    };
  }
  if (lower.includes('ph') || lower.includes('phone') || lower.includes('tel')) {
    return {
      normalized: 'phone_number',
      detectedType: 'phone',
      reason: 'Standardized telephone header to E.164/dashed format',
    };
  }
  if (lower.includes('mail')) {
    return { normalized: 'email', detectedType: 'email', reason: 'Standardized email address field' };
  }
  if (lower.includes('stat')) {
    return { normalized: 'status', detectedType: 'status', reason: 'Normalized status label casing' };
  }
  if (lower.includes('cli') || lower.includes('vendor') || lower.includes('merchant')) {
    return {
      normalized: lower.includes('cli') ? 'client_name' : 'vendor_name',
      detectedType: 'text',
      reason: 'Mapped entity name to canonical snake_case identifier',
    };
  }
  const snake = lower.replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'column';
  return { normalized: snake, detectedType: 'text', reason: 'Converted header to snake_case' };
}

function normalizeDateLocal(val: string): string {
  const s = val.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  // YYYY.MM.DD or YYYY/MM/DD
  let m = s.match(/^(\d{4})[./-](\d{1,2})[./-](\d{1,2})$/);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  // DD.MM.YYYY or DD-MM-YYYY
  m = s.match(/^(\d{1,2})[.-](\d{1,2})[.-](\d{4})$/);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  // MM/DD/YY or MM/DD/YYYY
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (m) {
    const year = m[3].length === 2 ? `20${m[3]}` : m[3];
    return `${year}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  }
  // Month name formats: Nov 6 2026 / Nov 11th 2026 / Dec 20 2026
  const cleaned = s.replace(/(\d+)(st|nd|rd|th)/i, '$1');
  const parsed = new Date(cleaned);
  if (!Number.isNaN(parsed.getTime())) {
    return parsed.toISOString().slice(0, 10);
  }
  return s;
}

function normalizeCurrencyLocal(val: string): string {
  const s = val.trim();
  if (/^#(REF!|DIV\/0!|VALUE!|NAME\?|N\/A|NUM!)/i.test(s)) {
    return `[ERROR: ${s.toUpperCase()}]`;
  }
  const isParenNeg = /^\(.*\)$/.test(s);
  let numStr = s.replace(/[$€£¥USD\s()]/gi, '');
  // European format 89,50 or 1.250,00
  if (/^\d{1,3}(\.\d{3})*,\d{2}$/.test(numStr) || /^\d+,\d{2}$/.test(numStr)) {
    numStr = numStr.replace(/\./g, '').replace(',', '.');
  } else {
    numStr = numStr.replace(/,/g, '');
  }
  const num = Number(numStr);
  if (Number.isNaN(num)) return s;
  const signed = isParenNeg ? -Math.abs(num) : num;
  return signed.toFixed(2);
}

function normalizePhoneLocal(val: string): string {
  const digits = val.replace(/\D/g, '');
  if (digits.length === 10) {
    return `+1-${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6)}`;
  }
  if (digits.length === 11 && digits.startsWith('1')) {
    return `+1-${digits.slice(1, 4)}-${digits.slice(4, 7)}-${digits.slice(7)}`;
  }
  return val.trim();
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

  let rawHeaders: string[] = [];
  let rawRows: Record<string, string>[] = [];
  let cleanedHeaders: string[] = [];
  let cleanedRows: Record<string, string>[] = [];
  let schemaMappings: SchemaMapping[] = [];
  const anomalies: AnomalyItem[] = [];
  const cellDiffs: CellDiff[] = [];

  if (ext === 'csv') {
    const text = await file.text();
    const matrix = parseCsvLines(text);
    if (matrix.length < 2) {
      throw new ApiBusinessError(400, { error: 'CSV file must contain headers and data rows.' });
    }
    rawHeaders = matrix[0];
    const dataRows = matrix.slice(1);

    const hasPaidAllowance = quota.plan === 'pro' || quota.tokenBalance > 0;
    if (!hasPaidAllowance && dataRows.length > quota.freeRowLimit) {
      throw new ApiBusinessError(402, {
        error: `This file contains ${dataRows.length} rows, exceeding the Free tier cap of ${quota.freeRowLimit} rows per file.`,
        code: 'ROW_LIMIT_EXCEEDED',
        upgradeRequired: true,
        quota,
      });
    }

    schemaMappings = rawHeaders.map((rawHeader) => {
      const m = normalizeHeaderLocal(rawHeader);
      return {
        rawHeader,
        normalizedHeader: m.normalized,
        detectedType: m.detectedType,
        reason: m.reason,
      };
    });
    cleanedHeaders = schemaMappings.map((m) => m.normalizedHeader);

    const seenSignatures = new Set<string>();

    dataRows.forEach((cols, rIdx) => {
      const rawObj: Record<string, string> = {};
      const cleanObj: Record<string, string> = {};

      rawHeaders.forEach((rawH, cIdx) => {
        const rawVal = cols[cIdx] ?? '';
        rawObj[rawH] = rawVal;
        const mapping = schemaMappings[cIdx];
        const normH = mapping.normalizedHeader;

        let cleanVal = rawVal.trim();
        if (/^#(REF!|DIV\/0!|VALUE!|NAME\?|N\/A|NUM!)/i.test(cleanVal)) {
          cleanVal = `[ERROR: ${cleanVal.toUpperCase()}]`;
          anomalies.push({
            id: `anom_err_${rIdx}_${cIdx}`,
            severity: 'critical',
            category: 'Formula Error',
            location: `Row ${rIdx + 1}, ${normH}`,
            rawValue: rawVal,
            suggestedOrFixedValue: '[Manual Review Required]',
            explanation: `Cell evaluated to spreadsheet formula error ${rawVal}.`,
          });
        } else if (mapping.detectedType === 'date' && cleanVal) {
          cleanVal = normalizeDateLocal(cleanVal);
        } else if (mapping.detectedType === 'currency' && cleanVal) {
          cleanVal = normalizeCurrencyLocal(cleanVal);
        } else if (mapping.detectedType === 'phone' && cleanVal) {
          const formatted = normalizePhoneLocal(cleanVal);
          if (formatted === cleanVal && cleanVal.replace(/\D/g, '').length < 10) {
            anomalies.push({
              id: `anom_ph_${rIdx}_${cIdx}`,
              severity: 'warning',
              category: 'Incomplete Phone',
              location: `Row ${rIdx + 1}, ${normH}`,
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
            location: `Row ${rIdx + 1}, ${normH}`,
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
          const changeType: CellDiff['changeType'] = cleanVal.startsWith('[ERROR')
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

      const sig = Object.values(cleanObj).slice(0, 4).join('|');
      if (seenSignatures.has(sig)) {
        anomalies.push({
          id: `anom_dup_${rIdx}`,
          severity: 'warning',
          category: 'Duplicate Entry',
          location: `Row ${rIdx + 1}`,
          rawValue: sig,
          suggestedOrFixedValue: 'Review & deduplicate',
          explanation: 'Potential duplicate record matching an earlier row.',
        });
      }
      seenSignatures.add(sig);

      rawRows.push(rawObj);
      cleanedRows.push(cleanObj);
    });

    if (cellDiffs.length > 0) {
      anomalies.push({
        id: `anom_norm_summary`,
        severity: 'fixed',
        category: 'Batch Normalization',
        location: 'All Columns',
        rawValue: `${cellDiffs.length} raw cells`,
        suggestedOrFixedValue: `${cellDiffs.length} standardized cells`,
        explanation: 'Normalized ISO dates, decimal currencies, phone numbers, and status casing.',
      });
    }
  } else {
    // Receipt PNG / PDF / XLSX fallback preview
    rawHeaders = ['receipt_date', 'vendor_name', 'line_item', 'qty', 'amount'];
    cleanedHeaders = [...rawHeaders];
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
    cleanedRows = rawRows.map((r, rIdx) => {
      const cleaned = {
        receipt_date: '2026-11-09',
        vendor_name: 'Metro Office Supply Co.',
        line_item: r.line_item,
        qty: r.qty,
        amount: normalizeCurrencyLocal(r.amount),
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
    schemaMappings = rawHeaders.map((h) => ({
      rawHeader: h,
      normalizedHeader: h,
      detectedType: h.includes('date') ? 'date' : h === 'amount' ? 'currency' : 'text',
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
  format: 'csv' | 'xlsx' | 'pdf'
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
    const fileName = match?.[1] || `docucleanse_export.${format}`;
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

    const escapeCsv = (val: string) =>
      /[",\n]/.test(val) ? `"${val.replace(/"/g, '""')}"` : val;
    const lines = [
      job.cleanedHeaders.map(escapeCsv).join(','),
      ...job.cleanedRows.map((row) =>
        job.cleanedHeaders.map((h) => escapeCsv(String(row[h] ?? ''))).join(',')
      ),
    ];
    const baseName = job.fileName.replace(/\.[^.]+$/, '');
    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' });
    return {
      blob,
      fileName: `${baseName}_cleaned.${format === 'csv' ? 'csv' : 'csv'}`,
    };
  }
}

export async function createCheckoutSession(params: {
  plan: 'pro' | 'token_pack';
  provider: 'stripe' | 'lemonsqueezy';
}): Promise<{ sessionId: string }> {
  try {
    const res = await fetch('/api/billing/checkout', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-user-id': DEMO_USER_ID,
      },
      body: JSON.stringify(params),
    });
    return await parseJsonResponse<{ sessionId: string }>(res);
  } catch (err) {
    if (shouldUseMockFallback(err)) {
      return { sessionId: `cs_local_${Date.now()}` };
    }
    throw err;
  }
}

export async function completeSandboxCheckout(params: {
  plan: 'pro' | 'token_pack';
  provider: 'stripe' | 'lemonsqueezy';
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
        event_type: params.plan === 'pro' ? 'checkout.session.completed' : 'token_pack.purchased',
        plan_granted: params.plan,
        amount_cents: params.plan === 'pro' ? 1900 : 500,
        created_at: new Date().toISOString(),
      });
      return {
        ok: true,
        quota: syncMockQuotaFlags(),
        message:
          params.plan === 'pro'
            ? 'Upgraded to DocuCleanse Pro ($19/mo).'
            : 'Added 15 Pro-grade tokens ($5 Token Pack).',
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
  provider: 'stripe' | 'lemonsqueezy',
  payload: unknown
): Promise<{ received: boolean; provider: string; quota: QuotaSnapshot }> {
  const endpoint =
    provider === 'stripe' ? '/api/billing/webhook/stripe' : '/api/billing/webhook/lemonsqueezy';

  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    return await parseJsonResponse<{
      received: boolean;
      provider: string;
      quota: QuotaSnapshot;
    }>(res);
  } catch (err) {
    if (shouldUseMockFallback(err)) {
      const p = payload as {
        data?: { object?: { metadata?: { tier?: 'pro' | 'token_pack' } } };
        meta?: { custom_data?: { tier?: 'pro' | 'token_pack' } };
      };
      const tier =
        p?.data?.object?.metadata?.tier || p?.meta?.custom_data?.tier || 'pro';
      const result = await completeSandboxCheckout({ plan: tier, provider });
      return { received: true, provider, quota: result.quota };
    }
    throw err;
  }
}
