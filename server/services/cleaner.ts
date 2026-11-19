import crypto from 'node:crypto';
import { GoogleGenAI, ThinkingLevel, Type } from '@google/genai';
import type {
  AnomalyItem,
  AuditMetadata,
  CellDiff,
  CleanJobRecord,
  DocumentCategory,
  SchemaMapping,
} from '../types.ts';
import {
  extractSampleRows,
  LARGE_DATASET_THRESHOLD,
  SCHEMA_SAMPLE_ROW_COUNT,
  type ParsedBinaryDocumentInput,
  type ParsedTabularInput,
} from './parser.ts';

let cachedAiClient: GoogleGenAI | null = null;

function getAiClient(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey === 'MY_GEMINI_API_KEY') {
    throw new Error(
      'GEMINI_API_KEY is missing or unconfigured. Please set GEMINI_API_KEY in the AI Studio Secrets panel.'
    );
  }
  if (!cachedAiClient) {
    cachedAiClient = new GoogleGenAI({
      apiKey,
      httpOptions: {
        headers: {
          'User-Agent': 'aistudio-build',
        },
      },
    });
  }
  return cachedAiClient;
}

interface GeminiTabularResponse {
  documentCategory: DocumentCategory;
  executiveSummary: string;
  schemaMappings: Array<{
    rawHeader: string;
    normalizedHeader: string;
    detectedType: SchemaMapping['detectedType'];
    reason: string;
  }>;
  cleanedRows: Array<{
    rowIndex: number;
    cells: Array<{
      column: string;
      value: string;
    }>;
  }>;
  anomalies: Array<{
    severity: 'critical' | 'warning' | 'fixed';
    category: string;
    location: string;
    rawValue: string;
    suggestedOrFixedValue: string;
    explanation: string;
  }>;
}

interface DetectedPatternRules {
  dateFormatHint: 'MDY' | 'DMY' | 'YMD' | 'AUTO';
  currencySymbolHint: string;
  decimalSeparatorHint: '.' | ',' | 'AUTO';
}

interface GeminiSchemaRuleResponse {
  documentCategory: DocumentCategory;
  executiveSummary: string;
  detectedPatterns: DetectedPatternRules;
  schemaMappings: Array<{
    rawHeader: string;
    normalizedHeader: string;
    detectedType: SchemaMapping['detectedType'];
    reason: string;
  }>;
  sampleAnomalies: Array<{
    severity: 'critical' | 'warning' | 'fixed';
    category: string;
    location: string;
    rawValue: string;
    suggestedOrFixedValue: string;
    explanation: string;
  }>;
}

interface GeminiMultimodalResponse {
  documentCategory: DocumentCategory;
  executiveSummary: string;
  headers: string[];
  rawRows: Array<{
    rowIndex: number;
    cells: Array<{
      column: string;
      value: string;
    }>;
  }>;
  cleanedRows: Array<{
    rowIndex: number;
    cells: Array<{
      column: string;
      value: string;
    }>;
  }>;
  anomalies: Array<{
    severity: 'critical' | 'warning' | 'fixed';
    category: string;
    location: string;
    rawValue: string;
    suggestedOrFixedValue: string;
    explanation: string;
  }>;
}

const TABULAR_RESPONSE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    documentCategory: {
      type: Type.STRING,
      description: 'One of: transactions, client_roster, invoice, general_table (NEVER receipt for tabular CSV/XLSX files)',
    },
    executiveSummary: {
      type: Type.STRING,
      description: 'Concise 2-sentence executive audit summary describing key normalizations and remaining critical issues.',
    },
    schemaMappings: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          rawHeader: { type: Type.STRING },
          normalizedHeader: { type: Type.STRING },
          detectedType: {
            type: Type.STRING,
            description: 'One of: date, currency, phone, email, text, number, status',
          },
          reason: { type: Type.STRING },
        },
        required: ['rawHeader', 'normalizedHeader', 'detectedType', 'reason'],
      },
    },
    cleanedRows: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          rowIndex: { type: Type.INTEGER },
          cells: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                column: { type: Type.STRING, description: 'Must match normalizedHeader' },
                value: { type: Type.STRING },
              },
              required: ['column', 'value'],
            },
          },
        },
        required: ['rowIndex', 'cells'],
      },
    },
    anomalies: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          severity: { type: Type.STRING, description: 'One of: critical, warning, fixed' },
          category: { type: Type.STRING },
          location: { type: Type.STRING },
          rawValue: { type: Type.STRING },
          suggestedOrFixedValue: { type: Type.STRING },
          explanation: { type: Type.STRING },
        },
        required: ['severity', 'category', 'location', 'rawValue', 'suggestedOrFixedValue', 'explanation'],
      },
    },
  },
  required: ['documentCategory', 'executiveSummary', 'schemaMappings', 'cleanedRows', 'anomalies'],
};

const SCHEMA_RULE_RESPONSE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    documentCategory: {
      type: Type.STRING,
      description: 'One of: transactions, client_roster, invoice, general_table (NEVER receipt for tabular CSV/XLSX files)',
    },
    executiveSummary: {
      type: Type.STRING,
      description: 'Concise 2-sentence executive audit summary describing schema findings and formatting patterns detected in the sample.',
    },
    detectedPatterns: {
      type: Type.OBJECT,
      properties: {
        dateFormatHint: {
          type: Type.STRING,
          description: 'Primary date order detected in sample rows: MDY, DMY, YMD, or AUTO',
        },
        currencySymbolHint: {
          type: Type.STRING,
          description: 'Primary currency symbol or code detected (e.g., $, €, £, USD, PKR, or empty string)',
        },
        decimalSeparatorHint: {
          type: Type.STRING,
          description: 'Primary decimal separator detected in numeric/currency columns: ".", ",", or "AUTO"',
        },
      },
      required: ['dateFormatHint', 'currencySymbolHint', 'decimalSeparatorHint'],
    },
    schemaMappings: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          rawHeader: { type: Type.STRING },
          normalizedHeader: { type: Type.STRING },
          detectedType: {
            type: Type.STRING,
            description: 'One of: date, currency, phone, email, text, number, status',
          },
          reason: { type: Type.STRING },
        },
        required: ['rawHeader', 'normalizedHeader', 'detectedType', 'reason'],
      },
    },
    sampleAnomalies: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          severity: { type: Type.STRING, description: 'One of: critical, warning, fixed' },
          category: { type: Type.STRING },
          location: { type: Type.STRING },
          rawValue: { type: Type.STRING },
          suggestedOrFixedValue: { type: Type.STRING },
          explanation: { type: Type.STRING },
        },
        required: ['severity', 'category', 'location', 'rawValue', 'suggestedOrFixedValue', 'explanation'],
      },
    },
  },
  required: ['documentCategory', 'executiveSummary', 'detectedPatterns', 'schemaMappings', 'sampleAnomalies'],
};

const MULTIMODAL_RESPONSE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    documentCategory: {
      type: Type.STRING,
      description: 'One of: receipt, invoice, transactions, client_roster, general_table',
    },
    executiveSummary: {
      type: Type.STRING,
      description: 'Concise 2-sentence summary of extracted receipt/invoice line items, totals, and anomalies.',
    },
    headers: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
      description: 'Canonical snake_case column headers such as receipt_date, vendor_name, line_item, quantity, unit_price, currency, line_total, tax_amount.',
    },
    rawRows: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          rowIndex: { type: Type.INTEGER },
          cells: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                column: { type: Type.STRING },
                value: { type: Type.STRING },
              },
              required: ['column', 'value'],
            },
          },
        },
        required: ['rowIndex', 'cells'],
      },
    },
    cleanedRows: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          rowIndex: { type: Type.INTEGER },
          cells: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                column: { type: Type.STRING },
                value: { type: Type.STRING },
              },
              required: ['column', 'value'],
            },
          },
        },
        required: ['rowIndex', 'cells'],
      },
    },
    anomalies: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          severity: { type: Type.STRING, description: 'One of: critical, warning, fixed' },
          category: { type: Type.STRING },
          location: { type: Type.STRING },
          rawValue: { type: Type.STRING },
          suggestedOrFixedValue: { type: Type.STRING },
          explanation: { type: Type.STRING },
        },
        required: ['severity', 'category', 'location', 'rawValue', 'suggestedOrFixedValue', 'explanation'],
      },
    },
  },
  required: ['documentCategory', 'executiveSummary', 'headers', 'rawRows', 'cleanedRows', 'anomalies'],
};

function inferChangeType(
  columnName: string,
  rawVal: string,
  cleanedVal: string
): CellDiff['changeType'] {
  const lower = columnName.toLowerCase();
  if (/^=?#(REF!|DIV\/0!|VALUE!|NAME\?|N\/A|NUM!|NULL!|SPILL!|CALC!)/i.test(rawVal.trim())) {
    return 'formula_error';
  }
  if (lower.includes('date') || lower.includes('time') || /\d{1,4}[\/\-.]\d{1,2}[\/\-.]\d{1,4}/.test(rawVal)) {
    return 'date';
  }
  if (lower.includes('phone') || lower.includes('tel') || lower.includes('mobile')) {
    return 'phone';
  }
  if (
    lower.includes('amount') ||
    lower.includes('price') ||
    lower.includes('total') ||
    lower.includes('cost') ||
    lower.includes('fee') ||
    lower.includes('revenue') ||
    /[$€£¥]/.test(rawVal)
  ) {
    return 'currency';
  }
  if (rawVal.trim() === '' && cleanedVal.trim() !== '') {
    return 'missing';
  }
  if (rawVal.trim() === cleanedVal.trim() && rawVal !== cleanedVal) {
    return 'whitespace';
  }
  return 'schema';
}

function sanitizeCategory(cat: string): DocumentCategory {
  const allowed: DocumentCategory[] = [
    'transactions',
    'receipt',
    'client_roster',
    'invoice',
    'general_table',
  ];
  return allowed.includes(cat as DocumentCategory)
    ? (cat as DocumentCategory)
    : 'general_table';
}

function sanitizeTabularCategory(cat: string): DocumentCategory {
  const sanitized = sanitizeCategory(cat);
  return sanitized === 'receipt' ? 'transactions' : sanitized;
}

function sanitizeSeverity(sev: string): AnomalyItem['severity'] {
  if (sev === 'critical' || sev === 'warning' || sev === 'fixed') return sev;
  return 'warning';
}

async function callWithRetry<T>(
  fn: (modelName: string, useLowThinking: boolean) => Promise<T>,
  maxRetries = 2
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn('gemini-4-hydrogen', true);
    } catch (err) {
      lastError = err;
      const msg = err instanceof Error ? err.message : String(err);
      const isTransient = msg.includes('503') || msg.includes('UNAVAILABLE') || msg.includes('429');
      if (!isTransient) {
        throw err;
      }
      if (attempt < maxRetries) {
        await new Promise((resolve) => setTimeout(resolve, 600 * (attempt + 1)));
      }
    }
  }

  // Fallback to gemini-3.1-flash-lite if gemini-4-hydrogen is experiencing transient 503 demand
  try {
    return await fn('gemini-3.1-flash-lite', false);
  } catch {
    throw lastError;
  }
}

const FORMULA_TOKEN_REGEX = /^=?#(REF!|DIV\/0!|VALUE!|NAME\?|N\/A|NUM!|NULL!|SPILL!|CALC!)$/i;
const MAX_DETAILED_ANOMALIES = 250;
const MAX_TRACKED_CELL_DIFFS = 5000;
const DETERMINISTIC_CHUNK_SIZE = 2000;

function stripFormulaLeadingEquals(token: string): string {
  return token.trim().replace(/^=/, '').toUpperCase();
}

function normalizeDateDeterministic(
  rawVal: string,
  dateFormatHint: DetectedPatternRules['dateFormatHint']
): { value: string; warning?: string } {
  const s = rawVal.trim();
  if (!s) return { value: '' };
  if (FORMULA_TOKEN_REGEX.test(s)) return { value: `[ERROR: ${stripFormulaLeadingEquals(s)}]` };

  // Already ISO YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return { value: s };

  // YYYY/MM/DD or YYYY.MM.DD or YYYY-M-D
  let m = s.match(/^(\d{4})[./-](\d{1,2})[./-](\d{1,2})(?:[ T].*)?$/);
  if (m) {
    const month = Number(m[2]);
    const day = Number(m[3]);
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      return { value: `${m[1]}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}` };
    }
  }

  // Slash/dot/dash separated 3-part numeric date (e.g., 11/4/26, 04.11.2026, 20-11-2026)
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
    } else if (dateFormatHint === 'DMY' || sep === '.') {
      day = p1;
      month = p2;
    } else {
      month = p1;
      day = p2;
    }

    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      return { value: `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}` };
    }
  }

  // Month name strings (e.g., "Nov 04, 2026", "4 Nov 2026", "Nov 11th 2026")
  const cleanedMonthStr = s.replace(/(\d+)(st|nd|rd|th)\b/gi, '$1');
  if (/[a-zA-Z]{3,}/.test(cleanedMonthStr)) {
    const parsed = new Date(cleanedMonthStr);
    if (!Number.isNaN(parsed.getTime()) && parsed.getFullYear() >= 1900 && parsed.getFullYear() <= 2100) {
      return { value: parsed.toISOString().slice(0, 10) };
    }
  }

  return { value: s, warning: `Unrecognized date format "${s}"` };
}

function normalizeCurrencyOrNumberDeterministic(
  rawVal: string,
  isCurrency: boolean,
  decimalSeparatorHint: DetectedPatternRules['decimalSeparatorHint']
): { value: string; warning?: string } {
  const s = rawVal.trim();
  if (!s) return { value: '' };
  if (FORMULA_TOKEN_REGEX.test(s)) return { value: `[ERROR: ${stripFormulaLeadingEquals(s)}]` };

  const detectedCode = isCurrency ? detectCurrencyCode(s) : null;
  const isAccountingNeg = /^\(.*\)$/.test(s);
  let cleaned = s
    .replace(/([-(\s]|^)(?:CA|AU|US|NZ|HK|SG|C|A)\$/gi, '$1')
    .replace(/[$€£¥₹₩₽]/g, '')
    .replace(/\b(USD|EUR|GBP|CAD|AUD|NZD|JPY|INR|PKR|AED|SAR|CHF|RS\.?)\b/gi, '')
    .replace(/[()\s]/g, '');

  const hasComma = cleaned.includes(',');
  const hasDot = cleaned.includes('.');

  if (hasComma && hasDot) {
    // Whichever appears last is the decimal separator
    if (cleaned.lastIndexOf(',') > cleaned.lastIndexOf('.')) {
      cleaned = cleaned.replace(/\./g, '').replace(',', '.');
    } else {
      cleaned = cleaned.replace(/,/g, '');
    }
  } else if (hasComma) {
    if (
      /^-?\d+,\d{1,2}$/.test(cleaned) ||
      (decimalSeparatorHint === ',' && /^-?\d+,\d+$/.test(cleaned))
    ) {
      cleaned = cleaned.replace(',', '.');
    } else {
      cleaned = cleaned.replace(/,/g, '');
    }
  }

  const num = Number(cleaned);
  if (Number.isNaN(num)) {
    return { value: s, warning: `Non-numeric value "${s}" in ${isCurrency ? 'currency' : 'numeric'} column` };
  }

  const signed = isAccountingNeg ? -Math.abs(num) : num;
  if (isCurrency) {
    return { value: formatCurrencyPreservingSymbol(signed, detectedCode) };
  }
  return { value: Number.isInteger(signed) ? String(signed) : String(Number(signed.toFixed(4))) };
}

function normalizePhoneDeterministic(rawVal: string): { value: string; warning?: string } {
  const s = rawVal.trim();
  if (!s) return { value: '' };

  const hasPlus = s.startsWith('+');
  const digits = s.replace(/\D/g, '');

  if (digits.length === 10) {
    return { value: `+1-${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6)}` };
  }
  if (digits.length === 11 && digits.startsWith('1')) {
    return { value: `+1-${digits.slice(1, 4)}-${digits.slice(4, 7)}-${digits.slice(7)}` };
  }
  if (digits.length >= 11 && digits.length <= 15) {
    return { value: hasPlus ? `+${digits}` : `+${digits}` };
  }
  if (digits.length < 7) {
    return { value: s, warning: `Incomplete phone number "${s}"` };
  }
  return { value: s };
}

function normalizeEmailDeterministic(rawVal: string): { value: string; warning?: string } {
  const s = rawVal.trim().replace(/\s+/g, '').toLowerCase();
  if (!s) return { value: '' };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) {
    return { value: s, warning: `Invalid email address "${rawVal.trim()}"` };
  }
  return { value: s };
}

function normalizeStatusDeterministic(rawVal: string): string {
  const s = rawVal.trim().replace(/\s+/g, ' ');
  if (!s) return '';
  const lower = s.toLowerCase();
  const canonicalMap: Record<string, string> = {
    paid: 'Paid',
    settled: 'Paid',
    completed: 'Completed',
    complete: 'Completed',
    pending: 'Pending',
    unpaid: 'Unpaid',
    overdue: 'Overdue',
    failed: 'Failed',
    refunded: 'Refunded',
    canceled: 'Canceled',
    cancelled: 'Canceled',
    active: 'Active',
    inactive: 'Inactive',
    approved: 'Approved',
    rejected: 'Rejected',
    draft: 'Draft',
  };
  if (canonicalMap[lower]) return canonicalMap[lower];
  return lower.replace(/\b\w/g, (ch) => ch.toUpperCase());
}

function normalizeTextDeterministic(rawVal: string): string {
  const trimmed = rawVal.trim().replace(/\s+/g, ' ');
  if (FORMULA_TOKEN_REGEX.test(trimmed)) {
    return `[ERROR: ${stripFormulaLeadingEquals(trimmed)}]`;
  }
  return trimmed;
}

function fallbackSnakeHeader(raw: string): string {
  return (
    raw
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_|_$/g, '') || 'column'
  );
}

function detectCurrencyCode(rawVal: string | undefined): string | null {
  if (!rawVal) return null;
  const s = String(rawVal).trim();
  if (!s) return null;
  // Check qualified dollar prefixes & explicit ISO-4217 codes BEFORE bare "$"
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
  if (/\bUSD\b|US\$|\$/i.test(s)) return 'USD';
  return null;
}

function currencyCodeToPrefix(code: string | null): string {
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

function formatCurrencyPreservingSymbol(num: number, currencyCode: string | null): string {
  const sign = num < 0 ? '-' : '';
  const absFormatted = Math.abs(num).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  const prefix = currencyCodeToPrefix(currencyCode);
  if (!prefix) {
    return `${sign}${absFormatted}`;
  }
  return `${sign}${prefix} ${absFormatted}`;
}

function parseNumericValue(val: string | undefined): number | null {
  if (val === undefined || val === null) return null;
  const s = String(val).trim();
  if (!s || s.startsWith('=') || FORMULA_TOKEN_REGEX.test(s) || /^\[ERROR:/i.test(s)) return null;

  const isAccountingNeg = /^\(.*\)$/.test(s);
  let cleaned = s
    .replace(/([-(\s]|^)(?:CA|AU|US|NZ|HK|SG|C|A|S)\$/gi, '$1')
    .replace(/[$€£¥₹₩₽%]/g, '')
    .replace(/\b(USD|EUR|GBP|CAD|AUD|NZD|SGD|HKD|JPY|INR|PKR|AED|SAR|CHF|RS\.?)\b/gi, '')
    .replace(/[()\s]/g, '');

  const hasComma = cleaned.includes(',');
  const hasDot = cleaned.includes('.');

  if (hasComma && hasDot) {
    if (cleaned.lastIndexOf(',') > cleaned.lastIndexOf('.')) {
      cleaned = cleaned.replace(/\./g, '').replace(',', '.');
    } else {
      cleaned = cleaned.replace(/,/g, '');
    }
  } else if (hasComma) {
    if (/^-?\d+,\d{1,2}$/.test(cleaned)) {
      cleaned = cleaned.replace(',', '.');
    } else {
      cleaned = cleaned.replace(/,/g, '');
    }
  }

  if (!cleaned) return null;
  const num = Number(cleaned);
  if (!Number.isFinite(num)) return null;
  return isAccountingNeg ? -Math.abs(num) : num;
}

function inferDetectedTypeFromHeader(
  rawHeader: string,
  normHeader: string,
  candidateType?: SchemaMapping['detectedType']
): SchemaMapping['detectedType'] {
  const combined = `${rawHeader} ${normHeader}`.toLowerCase();
  if (candidateType && ['date', 'currency', 'phone', 'email', 'text', 'number', 'status'].includes(candidateType)) {
    // Still upgrade generic 'text' if header unambiguously indicates date/phone/email
    if (candidateType === 'text') {
      if (/\bdate\b|_date|^dt$/i.test(combined)) return 'date';
      if (/(phone|tel|mobile|whatsapp)/i.test(combined)) return 'phone';
      if (/email|e-mail/i.test(combined)) return 'email';
    }
    return candidateType;
  }
  if (/\bdate\b|_date|^dt$/i.test(combined)) return 'date';
  if (/(phone|tel|mobile|whatsapp)/i.test(combined)) return 'phone';
  if (/email|e-mail/i.test(combined)) return 'email';
  if (/status|state/i.test(combined)) return 'status';
  if (/(amount|price|total|cost|revenue|fee|mrr|subtotal)/i.test(combined) && !/tax.*rate|%/i.test(combined)) {
    return 'currency';
  }
  if (/(qty|quantity|units|count|rate|tax|pct|%)/i.test(combined)) return 'number';
  return 'text';
}

function alignSchemaMappings(
  rawHeaders: string[],
  aiMappings: Array<{
    rawHeader: string;
    normalizedHeader: string;
    detectedType?: SchemaMapping['detectedType'];
    reason?: string;
  }>,
  defaultReason: string
): SchemaMapping[] {
  const byExact = new Map<string, (typeof aiMappings)[number]>();
  const byLower = new Map<string, (typeof aiMappings)[number]>();

  for (const m of aiMappings || []) {
    if (m.rawHeader) {
      byExact.set(m.rawHeader, m);
      byLower.set(m.rawHeader.trim().toLowerCase(), m);
    }
  }

  const usedNormHeaders = new Map<string, number>();
  return rawHeaders.map((rawHeader, idx) => {
    const matched =
      byExact.get(rawHeader) ||
      byLower.get(rawHeader.trim().toLowerCase()) ||
      (aiMappings.length === rawHeaders.length ? aiMappings[idx] : undefined);

    const baseNorm =
      matched?.normalizedHeader && matched.normalizedHeader.trim().length > 0
        ? fallbackSnakeHeader(matched.normalizedHeader)
        : fallbackSnakeHeader(rawHeader);
    const count = usedNormHeaders.get(baseNorm) ?? 0;
    usedNormHeaders.set(baseNorm, count + 1);
    const uniqueNorm = count === 0 ? baseNorm : `${baseNorm}_${count + 1}`;

    return {
      rawHeader,
      normalizedHeader: uniqueNorm,
      detectedType: inferDetectedTypeFromHeader(rawHeader, uniqueNorm, matched?.detectedType),
      reason: matched?.reason || defaultReason,
    };
  });
}

function reconcileTabularRowsAndAudit(params: {
  parsed: ParsedTabularInput;
  schemaMappings: SchemaMapping[];
  cleanedRows: Record<string, string>[];
  anomalies: AnomalyItem[];
  dateFormatHint?: DetectedPatternRules['dateFormatHint'];
  fileHashSha256?: string;
  timestampUtc?: string;
}): {
  cleanedHeaders: string[];
  cleanedRows: Record<string, string>[];
  schemaMappings: SchemaMapping[];
  anomalies: AnomalyItem[];
  cellDiffs: CellDiff[];
  totalNormalizedCells: number;
  auditMetadata: AuditMetadata;
} {
  const { parsed, schemaMappings, cleanedRows, dateFormatHint = 'AUTO' } = params;
  const baseCleanedHeaders = schemaMappings.map((m) => m.normalizedHeader);
  const timestampUtc = params.timestampUtc || new Date().toISOString();
  const fileHashSha256 =
    params.fileHashSha256 ||
    crypto
      .createHash('sha256')
      .update(JSON.stringify({ headers: parsed.headers, rows: parsed.rows }))
      .digest('hex');

  // Detect key column roles across both raw and normalized headers
  const idColIdx = schemaMappings.findIndex(
    (m) =>
      /^(txn|trans|transaction|order|inv|invoice|record)?[_\s-]?id$/i.test(m.rawHeader.trim()) ||
      /^(txn|trans|transaction|order|inv|invoice|record)?_?id$/i.test(m.normalizedHeader)
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
      /\b(total[\s_-]?amount|line[\s_-]?total|net[\s_-]?total|total|amount|balance|mrr|revenue)\b/i.test(
        `${m.rawHeader} ${m.normalizedHeader}`
      ) && !/unit[\s_-]?price|tax/i.test(`${m.rawHeader} ${m.normalizedHeader}`)
  );
  const primaryAmountIdx =
    totalColIdx >= 0
      ? totalColIdx
      : schemaMappings.findIndex((m) => m.detectedType === 'currency');
  const existingCurrencyIdx = schemaMappings.findIndex((m) =>
    /\b(currency|curr|ccy|currency_code)\b/i.test(`${m.rawHeader} ${m.normalizedHeader}`)
  );
  const fxRateColIdx = schemaMappings.findIndex((m) =>
    /\b(fx[\s_-]?rate|exchange[\s_-]?rate|conversion[\s_-]?rate)\b/i.test(
      `${m.rawHeader} ${m.normalizedHeader}`
    )
  );

  const dateColIndices = new Set<number>();
  const phoneColIndices = new Set<number>();
  schemaMappings.forEach((m, idx) => {
    const combined = `${m.rawHeader} ${m.normalizedHeader}`.toLowerCase();
    if (m.detectedType === 'date' || /\bdate\b|_date|^dt$/i.test(combined)) {
      dateColIndices.add(idx);
    }
    if (m.detectedType === 'phone' || /(phone|tel|mobile|whatsapp)/i.test(combined)) {
      phoneColIndices.add(idx);
    }
  });

  const currencyColIndices = new Set<number>();
  schemaMappings.forEach((m, idx) => {
    const combined = `${m.rawHeader} ${m.normalizedHeader}`.toLowerCase();
    const isRate = /tax[\s_-]?rate|\brate\b|_rate|pct|percent/.test(combined);
    if (
      !isRate &&
      (m.detectedType === 'currency' ||
        idx === unitPriceColIdx ||
        idx === primaryAmountIdx ||
        /\b(price|cost|amount|total|revenue|mrr|balance|fee|spend|budget)\b/i.test(combined))
    ) {
      currencyColIndices.add(idx);
    }
  });

  // Pre-scan currencies across primary monetary column, unit_price, currency column, and header hints (NEVER default to USD)
  const currencyCounts = new Map<string, number>();
  const scanCurrencyIndices = Array.from(
    new Set([primaryAmountIdx, unitPriceColIdx, existingCurrencyIdx].filter((i) => i >= 0))
  );
  for (const idx of scanCurrencyIndices) {
    const headerHint = detectCurrencyCode(schemaMappings[idx].rawHeader);
    if (headerHint) {
      currencyCounts.set(headerHint, (currencyCounts.get(headerHint) ?? 0) + 1);
    }
  }
  if (primaryAmountIdx >= 0) {
    const rawAmtHeader = schemaMappings[primaryAmountIdx].rawHeader;
    const rawUnitHeader = unitPriceColIdx >= 0 ? schemaMappings[unitPriceColIdx].rawHeader : null;
    const rawCurrHeader =
      existingCurrencyIdx >= 0 ? schemaMappings[existingCurrencyIdx].rawHeader : null;
    for (const row of parsed.rows) {
      const code =
        detectCurrencyCode(row[rawAmtHeader]) ||
        (rawUnitHeader ? detectCurrencyCode(row[rawUnitHeader]) : null) ||
        (rawCurrHeader ? detectCurrencyCode(row[rawCurrHeader]) : null);
      if (code) {
        currencyCounts.set(code, (currencyCounts.get(code) ?? 0) + 1);
      }
    }
  }
  const detectedCurrencies = Array.from(currencyCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([code]) => code);
  // Preserve null when no currency symbol or ISO code was present in the source file (never force USD)
  const dominantCurrency: string | null = detectedCurrencies[0] || null;
  const hasExplicitMultiCurrency = detectedCurrencies.length >= 2;
  const shouldEmitLedgerCurrencyColumns = primaryAmountIdx >= 0;

  // Index formula errors detected by parser by rowIndex + rawHeader
  const formulaErrorMap = new Map<string, ParsedTabularInput['formulaErrors'][number]>();
  for (const fe of parsed.formulaErrors) {
    formulaErrorMap.set(`${fe.rowIndex}:${fe.column}`, fe);
  }

  let reconciledAnomalies: AnomalyItem[] = [...params.anomalies];
  const highPriorityFinancialAlerts: AnomalyItem[] = [];
  const criticalFormulaAnomalies: AnomalyItem[] = [];
  const warningAnomaliesToAdd: AnomalyItem[] = [];

  let inputSum = 0;
  let outputSum = 0;
  let leakageRecoveredValue = 0;
  const fxRates: Array<{ rIdx: number; rowPrefix: string; rawVal: string; val: number }> = [];

  for (let rIdx = 0; rIdx < parsed.rows.length; rIdx++) {
    const rawRow = parsed.rows[rIdx];
    let cleanRow = cleanedRows[rIdx];
    if (!cleanRow) {
      cleanRow = {};
      cleanedRows[rIdx] = cleanRow;
    }

    // Ensure every mapped column exists on cleanRow
    for (let cIdx = 0; cIdx < schemaMappings.length; cIdx++) {
      const m = schemaMappings[cIdx];
      if (cleanRow[m.normalizedHeader] === undefined) {
        cleanRow[m.normalizedHeader] = String(rawRow[m.rawHeader] ?? '');
      }
    }

    const txnLabel =
      idColIdx >= 0
        ? String(
            cleanRow[baseCleanedHeaders[idColIdx]] || rawRow[schemaMappings[idColIdx].rawHeader] || ''
          ).trim()
        : '';
    const rowPrefix = txnLabel ? `Row ${rIdx + 1} (${txnLabel})` : `Row ${rIdx + 1}`;
    let rowLeakageCounted = false;

    // 1. Guarantee ISO-8601 (YYYY-MM-DD) dates across all rows
    for (const cIdx of dateColIndices) {
      const m = schemaMappings[cIdx];
      const rawVal = String(rawRow[m.rawHeader] ?? '').trim();
      const curVal = String(cleanRow[m.normalizedHeader] ?? '').trim();
      if (!rawVal || FORMULA_TOKEN_REGEX.test(rawVal)) continue;

      if (!/^\d{4}-\d{2}-\d{2}$/.test(curVal)) {
        const fromCur = curVal ? normalizeDateDeterministic(curVal, dateFormatHint) : null;
        if (fromCur && /^\d{4}-\d{2}-\d{2}$/.test(fromCur.value)) {
          cleanRow[m.normalizedHeader] = fromCur.value;
        } else {
          const fromRaw = normalizeDateDeterministic(rawVal, dateFormatHint);
          if (/^\d{4}-\d{2}-\d{2}$/.test(fromRaw.value)) {
            cleanRow[m.normalizedHeader] = fromRaw.value;
          }
        }
      }
    }

    // 2. Guarantee phone normalization across all rows
    for (const cIdx of phoneColIndices) {
      const m = schemaMappings[cIdx];
      const rawVal = String(rawRow[m.rawHeader] ?? '').trim();
      const curVal = String(cleanRow[m.normalizedHeader] ?? '').trim();
      if (!rawVal || FORMULA_TOKEN_REGEX.test(rawVal)) continue;

      const looksUnformatted =
        !curVal ||
        /[().\s]/.test(curVal) ||
        (/^\d{10,11}$/.test(curVal) && !curVal.startsWith('+'));
      if (looksUnformatted) {
        const normalized = normalizePhoneDeterministic(curVal || rawVal);
        if (!normalized.warning && normalized.value) {
          cleanRow[m.normalizedHeader] = normalized.value;
        }
      }
    }

    // 3. Detect & auto-calculate formula errors (=#REF!, =#DIV/0!, =#VALUE!, etc.)
    for (let cIdx = 0; cIdx < schemaMappings.length; cIdx++) {
      const m = schemaMappings[cIdx];
      const rawVal = String(rawRow[m.rawHeader] ?? '').trim();
      const curVal = String(cleanRow[m.normalizedHeader] ?? '').trim();
      const parserFe = formulaErrorMap.get(`${rIdx}:${m.rawHeader}`);

      const isFormulaErr =
        Boolean(parserFe) ||
        FORMULA_TOKEN_REGEX.test(rawVal) ||
        FORMULA_TOKEN_REGEX.test(curVal) ||
        /^\[ERROR:\s*#/i.test(curVal);

      if (!isFormulaErr) continue;

      const errorToken =
        parserFe?.errorToken ||
        (FORMULA_TOKEN_REGEX.test(rawVal)
          ? stripFormulaLeadingEquals(rawVal)
          : FORMULA_TOKEN_REGEX.test(curVal)
          ? stripFormulaLeadingEquals(curVal)
          : curVal.replace(/^\[ERROR:\s*|\]$/gi, '').trim().toUpperCase()) ||
        '#ERROR!';

      const rawDisplay = rawVal || parserFe?.formula || errorToken;
      const cellAddr = parserFe?.cellAddress;
      const location = `${rowPrefix}, ${m.normalizedHeader}${cellAddr ? ` (${cellAddr})` : ''}`;

      const matchesRowIndex = (text: string): boolean => {
        const lower = text.toLowerCase();
        if (txnLabel && lower.includes(txnLabel.toLowerCase())) return true;
        if (cellAddr && lower.includes(cellAddr.toLowerCase())) return true;
        if (new RegExp(`\\brow\\s*${rIdx + 1}\\b`, 'i').test(lower)) return true;
        if (new RegExp(`\\brow[\\s_]?index\\s*[:#]?\\s*${rIdx}\\b`, 'i').test(lower)) return true;
        return false;
      };

      // Remove any stale/duplicate Gemini anomaly for this exact formula error cell
      reconciledAnomalies = reconciledAnomalies.filter((a) => {
        const matchesRow = matchesRowIndex(`${a.location} ${a.explanation}`);
        const matchesErr =
          a.category.toLowerCase().includes('formula') ||
          a.rawValue.toUpperCase().includes(errorToken);
        return !(matchesRow && matchesErr);
      });

      let autoCalculated: string | null = null;
      let calcExplanation = `Critical spreadsheet formula error (${rawDisplay}) detected in "${m.rawHeader}".`;

      if (cIdx === totalColIdx && qtyColIdx >= 0 && unitPriceColIdx >= 0) {
        const qtyMapping = schemaMappings[qtyColIdx];
        const priceMapping = schemaMappings[unitPriceColIdx];
        const qtyNum = parseNumericValue(
          cleanRow[qtyMapping.normalizedHeader] || rawRow[qtyMapping.rawHeader]
        );
        const priceNum = parseNumericValue(
          cleanRow[priceMapping.normalizedHeader] || rawRow[priceMapping.rawHeader]
        );

        if (qtyNum !== null && priceNum !== null) {
          const calcNum = qtyNum * priceNum;
          const inheritedCur =
            detectCurrencyCode(rawRow[priceMapping.rawHeader]) ||
            (existingCurrencyIdx >= 0
              ? detectCurrencyCode(rawRow[schemaMappings[existingCurrencyIdx].rawHeader])
              : null) ||
            detectCurrencyCode(m.rawHeader) ||
            dominantCurrency;
          autoCalculated = formatCurrencyPreservingSymbol(calcNum, inheritedCur);
          cleanRow[m.normalizedHeader] = autoCalculated;
          leakageRecoveredValue += Math.abs(calcNum);
          rowLeakageCounted = true;
          calcExplanation = `Critical spreadsheet formula error (${rawDisplay}) detected in "${m.rawHeader}". Auto-calculated using (${qtyMapping.rawHeader} × ${priceMapping.rawHeader}): ${qtyNum} × ${formatCurrencyPreservingSymbol(priceNum, inheritedCur)} = ${autoCalculated}.`;
        }
      }

      if (!autoCalculated) {
        cleanRow[m.normalizedHeader] = `[ERROR: ${errorToken}]`;
      }

      criticalFormulaAnomalies.push({
        id: `anom_fe_${rIdx}_${cIdx}_${crypto.randomUUID().slice(0, 6)}`,
        severity: 'critical',
        category: 'Formula Error',
        location,
        rawValue: rawDisplay,
        suggestedOrFixedValue: autoCalculated ?? '[Manual Review Required]',
        explanation: calcExplanation,
      });
    }

    // 3b. Preserve original currency symbols across ALL monetary columns (unit_price, total_amount, price, cost, etc.)
    for (const cIdx of currencyColIndices) {
      const m = schemaMappings[cIdx];
      const rawVal = String(rawRow[m.rawHeader] ?? '').trim();
      const curVal = String(cleanRow[m.normalizedHeader] ?? '').trim();
      if (!curVal || curVal.startsWith('[ERROR:') || curVal === '[MISSING]') continue;

      const parsedVal = parseNumericValue(curVal) ?? parseNumericValue(rawVal);
      if (parsedVal === null) continue;

      const colCurrency =
        detectCurrencyCode(rawVal) ||
        detectCurrencyCode(curVal) ||
        detectCurrencyCode(m.rawHeader) ||
        (cIdx === primaryAmountIdx && unitPriceColIdx >= 0
          ? detectCurrencyCode(rawRow[schemaMappings[unitPriceColIdx].rawHeader])
          : null) ||
        (existingCurrencyIdx >= 0
          ? detectCurrencyCode(rawRow[schemaMappings[existingCurrencyIdx].rawHeader])
          : null);

      cleanRow[m.normalizedHeader] = formatCurrencyPreservingSymbol(parsedVal, colCurrency);
    }

    // 4. Multi-Currency Ledger Normalization (raw_amount, normalized_amount, currency_code) + Variance & Negative Balance Alerts
    if (shouldEmitLedgerCurrencyColumns && primaryAmountIdx >= 0) {
      const amtMapping = schemaMappings[primaryAmountIdx];
      const rawAmtStr = String(rawRow[amtMapping.rawHeader] ?? '').trim();
      let cleanAmtStr = String(cleanRow[amtMapping.normalizedHeader] ?? '').trim();

      const rawNum = parseNumericValue(rawAmtStr);
      let cleanNum = parseNumericValue(cleanAmtStr);

      const rowCurrency =
        detectCurrencyCode(rawAmtStr) ||
        (unitPriceColIdx >= 0
          ? detectCurrencyCode(rawRow[schemaMappings[unitPriceColIdx].rawHeader])
          : null) ||
        (existingCurrencyIdx >= 0
          ? detectCurrencyCode(rawRow[schemaMappings[existingCurrencyIdx].rawHeader])
          : null) ||
        detectCurrencyCode(amtMapping.rawHeader) ||
        dominantCurrency;

      if (cleanNum === null && rawNum !== null && rawNum !== 0) {
        cleanNum = rawNum;
        cleanAmtStr = formatCurrencyPreservingSymbol(rawNum, rowCurrency);
        cleanRow[amtMapping.normalizedHeader] = cleanAmtStr;
      }

      if (
        (cleanNum === null ||
          (cleanNum === 0 &&
            (!rawAmtStr || rawAmtStr.startsWith('=') || rawNum === null || rawNum === 0))) &&
        primaryAmountIdx === totalColIdx &&
        qtyColIdx >= 0 &&
        unitPriceColIdx >= 0
      ) {
        // Deterministically calculate quantity * unit_price for uncalculated Excel formulas (e.g., =F2*G2), cached zeros, or blank totals
        const qtyMapping = schemaMappings[qtyColIdx];
        const priceMapping = schemaMappings[unitPriceColIdx];
        const qtyNum = parseNumericValue(
          cleanRow[qtyMapping.normalizedHeader] || rawRow[qtyMapping.rawHeader]
        );
        const priceNum = parseNumericValue(
          cleanRow[priceMapping.normalizedHeader] || rawRow[priceMapping.rawHeader]
        );
        if (qtyNum !== null && priceNum !== null && qtyNum * priceNum !== 0) {
          cleanNum = Number((qtyNum * priceNum).toFixed(2));
          cleanAmtStr = formatCurrencyPreservingSymbol(cleanNum, rowCurrency);
          cleanRow[amtMapping.normalizedHeader] = cleanAmtStr;
        }
      } else if (cleanNum === null && rawNum !== null) {
        cleanNum = rawNum;
        cleanAmtStr = formatCurrencyPreservingSymbol(rawNum, rowCurrency);
        cleanRow[amtMapping.normalizedHeader] = cleanAmtStr;
      } else if (cleanNum !== null) {
        cleanAmtStr = formatCurrencyPreservingSymbol(cleanNum, rowCurrency);
        cleanRow[amtMapping.normalizedHeader] = cleanAmtStr;
      }

      cleanRow['raw_amount'] = rawAmtStr;
      cleanRow['normalized_amount'] =
        cleanNum !== null ? formatCurrencyPreservingSymbol(cleanNum, rowCurrency) : cleanAmtStr;
      cleanRow['currency_code'] = rowCurrency || 'N/A';

      if (rawNum !== null) {
        inputSum += rawNum;
      }
      if (cleanNum !== null) {
        outputSum += cleanNum;

        // Flag Negative Transaction Balances as High-Priority Financial Alert
        if (cleanNum < 0) {
          if (!rowLeakageCounted) {
            leakageRecoveredValue += Math.abs(cleanNum);
            rowLeakageCounted = true;
          }

          reconciledAnomalies = reconciledAnomalies.filter((a) => {
            const text = `${a.location} ${a.category} ${a.explanation}`.toLowerCase();
            const matchesRow =
              (txnLabel && text.includes(txnLabel.toLowerCase())) ||
              new RegExp(`\\brow\\s*${rIdx + 1}\\b`, 'i').test(text) ||
              new RegExp(`\\brow[\\s_]?index\\s*[:#]?\\s*${rIdx}\\b`, 'i').test(text);
            const mentionsNegBal =
              text.includes('negative') &&
              (text.includes('amount') || text.includes('balance') || text.includes('total'));
            return !(matchesRow && mentionsNegBal);
          });

          const formattedNeg = formatCurrencyPreservingSymbol(cleanNum, rowCurrency);
          highPriorityFinancialAlerts.push({
            id: `anom_finbal_${rIdx}_${crypto.randomUUID().slice(0, 6)}`,
            severity: 'critical',
            category: 'High-Priority Financial Alert',
            location: `${rowPrefix}, normalized_amount`,
            rawValue: rawAmtStr || formattedNeg,
            suggestedOrFixedValue: `${formattedNeg} (Verify Reversal / Credit)`,
            explanation: `Negative transaction balance (${formattedNeg}) detected on ${rowPrefix}. Flagged as High-Priority Financial Alert for pre-audit treasury review.`,
          });
        }
      }
    }

    // Track explicit FX rate column for outlier detection
    if (fxRateColIdx >= 0) {
      const fxMapping = schemaMappings[fxRateColIdx];
      const rawFx = String(rawRow[fxMapping.rawHeader] ?? '').trim();
      const fxNum = parseNumericValue(cleanRow[fxMapping.normalizedHeader] || rawFx);
      if (fxNum !== null) {
        fxRates.push({ rIdx, rowPrefix, rawVal: rawFx, val: fxNum });
      }
    }

    // 5. Flag negative quantities (e.g., TX-1006 with -2) as an Anomaly Warning
    if (qtyColIdx >= 0) {
      const qtyMapping = schemaMappings[qtyColIdx];
      const rawQtyStr = String(rawRow[qtyMapping.rawHeader] ?? '').trim();
      const cleanQtyStr = String(cleanRow[qtyMapping.normalizedHeader] ?? rawQtyStr).trim();
      const qtyNum = parseNumericValue(cleanQtyStr) ?? parseNumericValue(rawQtyStr);

      if (qtyNum !== null && qtyNum < 0) {
        if (!rowLeakageCounted && unitPriceColIdx >= 0) {
          const priceMapping = schemaMappings[unitPriceColIdx];
          const priceNum = parseNumericValue(
            cleanRow[priceMapping.normalizedHeader] || rawRow[priceMapping.rawHeader]
          );
          if (priceNum !== null) {
            leakageRecoveredValue += Math.abs(qtyNum * priceNum);
            rowLeakageCounted = true;
          }
        }

        reconciledAnomalies = reconciledAnomalies.filter((a) => {
          const text = `${a.location} ${a.category} ${a.explanation}`.toLowerCase();
          const matchesRow =
            (txnLabel && text.includes(txnLabel.toLowerCase())) ||
            new RegExp(`\\brow\\s*${rIdx + 1}\\b`, 'i').test(text) ||
            new RegExp(`\\brow[\\s_]?index\\s*[:#]?\\s*${rIdx}\\b`, 'i').test(text);
          const mentionsNegativeQty =
            text.includes('negative') &&
            (text.includes('qty') || text.includes('quantity') || text.includes('unit'));
          return !(matchesRow && mentionsNegativeQty);
        });

        warningAnomaliesToAdd.push({
          id: `anom_negqty_${rIdx}_${crypto.randomUUID().slice(0, 6)}`,
          severity: 'warning',
          category: 'Negative Quantity',
          location: `${rowPrefix}, ${qtyMapping.normalizedHeader}`,
          rawValue: rawQtyStr || String(qtyNum),
          suggestedOrFixedValue: `${Math.abs(qtyNum)} (verify return/credit)`,
          explanation: `Negative quantity (${qtyNum}) detected in "${qtyMapping.rawHeader}" on ${rowPrefix}. Verify whether this entry represents a customer return, credit memo, or data-entry error.`,
        });
      }
    }
  }

  // Flag multi-currency / FX anomalies as High-Priority Financial Alerts
  if (hasExplicitMultiCurrency) {
    const breakdown = Array.from(currencyCounts.entries())
      .map(([code, count]) => `${code}: ${count}`)
      .join(' · ');
    highPriorityFinancialAlerts.unshift({
      id: `anom_fxmix_${crypto.randomUUID().slice(0, 8)}`,
      severity: 'critical',
      category: 'High-Priority Financial Alert',
      location: `Multi-Currency Ledger (${detectedCurrencies.join(', ')})`,
      rawValue: breakdown,
      suggestedOrFixedValue: `Standardized to raw_amount, normalized_amount, currency_code`,
      explanation: `Mixed currency symbols (${detectedCurrencies.join(', ')}) detected without a unified FX conversion rate. Extracted ISO-4217 currency codes and decimal floats; verify spot exchange rates before consolidating cross-currency totals.`,
    });
  }

  if (fxRates.length >= 3) {
    const positiveRates = fxRates.map((r) => r.val).filter((v) => v > 0).sort((a, b) => a - b);
    const medianFx = positiveRates.length > 0 ? positiveRates[Math.floor(positiveRates.length / 2)] : 1;
    for (const entry of fxRates) {
      if (entry.val <= 0 || entry.val > medianFx * 3 || entry.val < medianFx * 0.25) {
        highPriorityFinancialAlerts.push({
          id: `anom_fxrate_${entry.rIdx}_${crypto.randomUUID().slice(0, 6)}`,
          severity: 'critical',
          category: 'High-Priority Financial Alert',
          location: `${entry.rowPrefix}, fx_rate`,
          rawValue: entry.rawVal || String(entry.val),
          suggestedOrFixedValue: `Review against median rate (~${medianFx.toFixed(4)})`,
          explanation: `Exchange rate anomaly (${entry.val}) detected on ${entry.rowPrefix} relative to ledger median (${medianFx.toFixed(4)}).`,
        });
      }
    }
  }

  // Build final schemaMappings & cleanedHeaders including multi-currency banking columns (raw_amount, normalized_amount, currency_code)
  const finalSchemaMappings: SchemaMapping[] = [...schemaMappings];
  if (shouldEmitLedgerCurrencyColumns && primaryAmountIdx >= 0) {
    const rawAmtHeader = schemaMappings[primaryAmountIdx].rawHeader;
    const existingNormSet = new Set(finalSchemaMappings.map((m) => m.normalizedHeader));

    if (!existingNormSet.has('raw_amount')) {
      finalSchemaMappings.push({
        rawHeader: rawAmtHeader,
        normalizedHeader: 'raw_amount',
        detectedType: 'text',
        reason: 'Preserved original unparsed monetary string for audit traceability',
      });
    }
    if (!existingNormSet.has('normalized_amount')) {
      finalSchemaMappings.push({
        rawHeader: rawAmtHeader,
        normalizedHeader: 'normalized_amount',
        detectedType: 'currency',
        reason: 'Standardized multi-currency numeric float for ledger aggregation',
      });
    }
    if (!existingNormSet.has('currency_code')) {
      finalSchemaMappings.push({
        rawHeader:
          existingCurrencyIdx >= 0 ? schemaMappings[existingCurrencyIdx].rawHeader : rawAmtHeader,
        normalizedHeader: 'currency_code',
        detectedType: 'status',
        reason: 'Extracted ISO-4217 currency code (USD, EUR, GBP, CAD, AUD)',
      });
    }
  }
  const finalCleanedHeaders = finalSchemaMappings.map((m) => m.normalizedHeader);

  // Place High-Priority Financial Alerts & Critical Formula Errors first
  const finalAnomalies = [
    ...highPriorityFinancialAlerts,
    ...criticalFormulaAnomalies,
    ...warningAnomaliesToAdd,
    ...reconciledAnomalies,
  ].slice(0, MAX_DETAILED_ANOMALIES + 25);

  // Recompute exact cell-level diffs against reconciled rows
  const cellDiffs: CellDiff[] = [];
  let totalNormalizedCells = 0;

  for (let rIdx = 0; rIdx < parsed.rows.length; rIdx++) {
    const rawRow = parsed.rows[rIdx];
    const cleanRow = cleanedRows[rIdx] || {};

    for (let cIdx = 0; cIdx < schemaMappings.length; cIdx++) {
      const m = schemaMappings[cIdx];
      const rawVal = String(rawRow[m.rawHeader] ?? '');
      const cleanVal = String(cleanRow[m.normalizedHeader] ?? rawVal);

      if (rawVal !== cleanVal) {
        totalNormalizedCells++;
        if (cellDiffs.length < MAX_TRACKED_CELL_DIFFS) {
          const hasFormulaErr =
            formulaErrorMap.has(`${rIdx}:${m.rawHeader}`) ||
            FORMULA_TOKEN_REGEX.test(rawVal.trim());
          cellDiffs.push({
            rowIndex: rIdx,
            column: m.normalizedHeader,
            rawHeader: m.rawHeader,
            rawValue: rawVal,
            cleanedValue: cleanVal,
            changeType: hasFormulaErr
              ? 'formula_error'
              : inferChangeType(m.normalizedHeader, rawVal, cleanVal),
          });
        }
      }
    }
  }

  // Compute Reconciliation Confidence Score (0-100%) — synchronized across Dashboard, XLSX, and PDF
  const activeConfidenceHeaders = finalCleanedHeaders.filter((h) => h !== 'raw_amount');
  const totalCells = Math.max(1, parsed.rows.length * Math.max(1, activeConfidenceHeaders.length));
  let unresolvedErrorCells = 0;
  for (const row of cleanedRows) {
    for (const h of activeConfidenceHeaders) {
      const v = String(row[h] ?? '').trim();
      if (/^\[ERROR:/i.test(v)) {
        unresolvedErrorCells++;
      }
    }
  }
  const unresolvedCriticalPenalty = Math.min(2.5, highPriorityFinancialAlerts.length * 0.15);
  const rawConfidence =
    ((totalCells - unresolvedErrorCells) / totalCells) * 100 - unresolvedCriticalPenalty;
  const reconciliationConfidenceScore = Number(
    Math.max(0, Math.min(100, rawConfidence)).toFixed(1)
  );

  const auditMetadata: AuditMetadata = {
    fileHashSha256,
    timestampUtc,
    rowsIngested: parsed.rows.length,
    rowsCleaned: cleanedRows.length,
    rowChecksumMatch: parsed.rows.length === cleanedRows.length,
    inputSum: Number(inputSum.toFixed(2)),
    outputSum: Number(outputSum.toFixed(2)),
    reconciledVariance: Number((outputSum - inputSum).toFixed(2)),
    primaryAmountColumn: primaryAmountIdx >= 0 ? 'normalized_amount' : null,
    detectedCurrencies,
    leakageRecoveredValue: Number(leakageRecoveredValue.toFixed(2)),
    reconciliationConfidenceScore,
  };

  return {
    cleanedHeaders: finalCleanedHeaders,
    cleanedRows,
    schemaMappings: finalSchemaMappings,
    anomalies: finalAnomalies,
    cellDiffs,
    totalNormalizedCells,
    auditMetadata,
  };
}

async function cleanLargeTabularDataset(params: {
  userId: string;
  fileName: string;
  parsed: ParsedTabularInput;
  startMs: number;
  fileHashSha256?: string;
}): Promise<CleanJobRecord> {
  const ai = getAiClient();
  const { parsed, startMs } = params;

  const sampleRows = extractSampleRows(parsed.rows, SCHEMA_SAMPLE_ROW_COUNT).map((row, idx) => ({
    rowIndex: idx,
    ...row,
  }));
  const sampleFormulaErrors = parsed.formulaErrors.filter(
    (fe) => fe.rowIndex < SCHEMA_SAMPLE_ROW_COUNT
  );

  const schemaSystemInstruction = `You are a precision financial & operations schema-detection engine for DocuCleanse.
You are inspecting a ${sampleRows.length}-row sample from a large ${parsed.rows.length}-row dataset.
Detect canonical snake_case column headers, exact column data types (date, currency, phone, email, text, number, status), primary date order (MDY, DMY, YMD, AUTO), currency symbol, and decimal separator so our deterministic streaming engine can normalize all ${parsed.rows.length} rows instantaneously without timeouts.
Return one schemaMapping entry for EVERY rawHeader in exact column order.`;

  const samplePromptPayload = {
    fileName: params.fileName,
    totalRowCount: parsed.rows.length,
    sampleRowCount: sampleRows.length,
    rawHeaders: parsed.headers,
    sampleFormulaErrors,
    jaggedRowsDetected: parsed.jaggedRowsDetected,
    sampleRows,
  };

  const response = await callWithRetry((modelName, useLowThinking) =>
    ai.models.generateContent({
      model: modelName,
      contents: `Analyze this ${sampleRows.length}-row sample to detect schema mappings and formatting rules:\n${JSON.stringify(samplePromptPayload)}`,
      config: {
        systemInstruction: schemaSystemInstruction,
        responseMimeType: 'application/json',
        responseSchema: SCHEMA_RULE_RESPONSE_SCHEMA,
        ...(useLowThinking ? { thinkingConfig: { thinkingLevel: ThinkingLevel.LOW } } : {}),
        seed: 42,
      },
    })
  );

  const jsonText = (response.text ?? '').trim();
  if (!jsonText) {
    throw new Error('Gemini returned an empty schema detection response.');
  }

  const ruleData = JSON.parse(jsonText) as GeminiSchemaRuleResponse;
  const documentCategory = sanitizeTabularCategory(ruleData.documentCategory);
  const patterns: DetectedPatternRules = {
    dateFormatHint:
      ruleData.detectedPatterns?.dateFormatHint === 'MDY' ||
      ruleData.detectedPatterns?.dateFormatHint === 'DMY' ||
      ruleData.detectedPatterns?.dateFormatHint === 'YMD'
        ? ruleData.detectedPatterns.dateFormatHint
        : 'AUTO',
    currencySymbolHint: ruleData.detectedPatterns?.currencySymbolHint || '',
    decimalSeparatorHint:
      ruleData.detectedPatterns?.decimalSeparatorHint === '.' ||
      ruleData.detectedPatterns?.decimalSeparatorHint === ','
        ? ruleData.detectedPatterns.decimalSeparatorHint
        : 'AUTO',
  };

  // Align schemaMappings strictly 1:1 with parsed.headers
  const schemaMappings = alignSchemaMappings(
    parsed.headers,
    ruleData.schemaMappings || [],
    'Detected from 40-row AI schema sample'
  );

  const allCleanedRows: Record<string, string>[] = new Array(parsed.rows.length);
  const allAnomalies: AnomalyItem[] = [];
  let overflowAnomaliesCount = 0;

  const pushAnomaly = (anom: Omit<AnomalyItem, 'id'>) => {
    if (allAnomalies.length < MAX_DETAILED_ANOMALIES) {
      allAnomalies.push({
        id: `anom_${crypto.randomUUID().slice(0, 8)}`,
        ...anom,
      });
    } else {
      overflowAnomaliesCount++;
    }
  };

  // Seed sample anomalies from Gemini
  for (const anom of ruleData.sampleAnomalies || []) {
    pushAnomaly({
      severity: sanitizeSeverity(anom.severity),
      category: anom.category || 'Sample Audit',
      location: anom.location || 'Sample Rows',
      rawValue: anom.rawValue ?? '',
      suggestedOrFixedValue: anom.suggestedOrFixedValue ?? '',
      explanation: anom.explanation || '',
    });
  }

  // Deterministic chunked normalization across all rows with event-loop yielding
  const seenSignatures = new Set<string>();
  let duplicateRowsCount = 0;

  for (let start = 0; start < parsed.rows.length; start += DETERMINISTIC_CHUNK_SIZE) {
    const end = Math.min(parsed.rows.length, start + DETERMINISTIC_CHUNK_SIZE);

    for (let rIdx = start; rIdx < end; rIdx++) {
      const rawRow = parsed.rows[rIdx];
      const cleanRow: Record<string, string> = {};
      const sigParts: string[] = [];

      for (let cIdx = 0; cIdx < schemaMappings.length; cIdx++) {
        const mapping = schemaMappings[cIdx];
        const rawVal = String(rawRow[mapping.rawHeader] ?? '');
        let cleanVal = rawVal;
        let warning: string | undefined;

        switch (mapping.detectedType) {
          case 'date': {
            const res = normalizeDateDeterministic(rawVal, patterns.dateFormatHint);
            cleanVal = res.value;
            warning = res.warning;
            break;
          }
          case 'currency': {
            const res = normalizeCurrencyOrNumberDeterministic(
              rawVal,
              true,
              patterns.decimalSeparatorHint
            );
            cleanVal = res.value;
            warning = res.warning;
            break;
          }
          case 'number': {
            const res = normalizeCurrencyOrNumberDeterministic(
              rawVal,
              false,
              patterns.decimalSeparatorHint
            );
            cleanVal = res.value;
            warning = res.warning;
            break;
          }
          case 'phone': {
            const res = normalizePhoneDeterministic(rawVal);
            cleanVal = res.value;
            warning = res.warning;
            break;
          }
          case 'email': {
            const res = normalizeEmailDeterministic(rawVal);
            cleanVal = res.value;
            warning = res.warning;
            break;
          }
          case 'status': {
            cleanVal = normalizeStatusDeterministic(rawVal);
            break;
          }
          default: {
            cleanVal = normalizeTextDeterministic(rawVal);
            break;
          }
        }

        cleanRow[mapping.normalizedHeader] = cleanVal;
        if (cIdx < 5) {
          sigParts.push(cleanVal.toLowerCase());
        }

        if (warning) {
          pushAnomaly({
            severity: 'warning',
            category: 'Format Warning',
            location: `Row ${rIdx + 1}, ${mapping.normalizedHeader}`,
            rawValue: rawVal,
            suggestedOrFixedValue: cleanVal,
            explanation: warning,
          });
        }

      }

      const sig = sigParts.join('|');
      if (sig.replace(/\|/g, '').length > 0) {
        if (seenSignatures.has(sig)) {
          duplicateRowsCount++;
          if (duplicateRowsCount <= 25) {
            pushAnomaly({
              severity: 'warning',
              category: 'Duplicate Row',
              location: `Row ${rIdx + 1}`,
              rawValue: sigParts.filter(Boolean).slice(0, 3).join(' · '),
              suggestedOrFixedValue: 'Review for deduplication',
              explanation: `Row ${rIdx + 1} matches an earlier record across primary columns.`,
            });
          }
        } else {
          seenSignatures.add(sig);
        }
      }

      allCleanedRows[rIdx] = cleanRow;
    }

    // Yield between chunks so Express stays responsive during high-capacity jobs
    if (end < parsed.rows.length) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }

  // Reconcile formula errors, multi-currency banking columns, financial alerts, and institutional audit metadata
  const createdAt = new Date().toISOString();
  const reconciled = reconcileTabularRowsAndAudit({
    parsed,
    schemaMappings,
    cleanedRows: allCleanedRows,
    anomalies: allAnomalies,
    dateFormatHint: patterns.dateFormatHint,
    fileHashSha256: params.fileHashSha256,
    timestampUtc: createdAt,
  });

  if (overflowAnomaliesCount > 0 || duplicateRowsCount > 25) {
    reconciled.anomalies.push({
      id: `anom_${crypto.randomUUID().slice(0, 8)}`,
      severity: 'warning',
      category: 'High-Capacity Audit Rollup',
      location: `Rows 1–${parsed.rows.length}`,
      rawValue: `${overflowAnomaliesCount + Math.max(0, duplicateRowsCount - 25)} additional items`,
      suggestedOrFixedValue: 'Export full cleaned XLSX/CSV',
      explanation: `Chunked processing normalized ${reconciled.totalNormalizedCells.toLocaleString()} cells across ${parsed.rows.length.toLocaleString()} rows using Gemini 40-row schema rules (${duplicateRowsCount} duplicate rows detected).`,
    });
  }

  const baseSummary =
    ruleData.executiveSummary ||
    `Analyzed first ${sampleRows.length} rows with Gemini to detect ${schemaMappings.length} column schemas and applied deterministic rules across all ${parsed.rows.length.toLocaleString()} rows.`;

  return {
    id: `job_${crypto.randomUUID().slice(0, 12)}`,
    userId: params.userId,
    fileName: params.fileName,
    fileType: parsed.fileType,
    documentCategory,
    rawHeaders: parsed.headers,
    rawRows: parsed.rows,
    cleanedHeaders: reconciled.cleanedHeaders,
    cleanedRows: reconciled.cleanedRows,
    cellDiffs: reconciled.cellDiffs,
    anomalies: reconciled.anomalies,
    schemaMappings: reconciled.schemaMappings,
    executiveSummary: `${baseSummary} High-capacity chunked engine normalized ${reconciled.totalNormalizedCells.toLocaleString()} cells across ${parsed.rows.length.toLocaleString()} rows.`,
    rowCount: parsed.rows.length,
    processingMs: Date.now() - startMs,
    createdAt,
    auditMetadata: reconciled.auditMetadata,
  };
}

export async function cleanTabularDocument(params: {
  userId: string;
  fileName: string;
  parsed: ParsedTabularInput;
  fileHashSha256?: string;
}): Promise<CleanJobRecord> {
  const startMs = Date.now();
  const { parsed } = params;

  // High-Capacity Chunked Path: for datasets > 100 rows, sample first 40 rows via Gemini
  // and apply detected schema/date/currency/phone rules deterministically across all remaining rows.
  if (parsed.rows.length > LARGE_DATASET_THRESHOLD) {
    return cleanLargeTabularDataset({
      ...params,
      startMs,
    });
  }

  const ai = getAiClient();

  const systemInstruction = `You are a precision financial & operations data-cleaning engine for DocuCleanse.
Your job is to inspect raw spreadsheet/CSV rows and return a normalized, audit-ready table plus an executive anomaly log.

Strict normalization rules:
1. Schema Mapping: Convert messy or inconsistent column headers into clean snake_case canonical headers (e.g., "Txn Dt" -> "transaction_date", "Amt ($)" -> "amount", "Ph #" -> "phone_number"). Keep exact correspondence in schemaMappings.
2. Dates: Normalize all dates to ISO-8601 format YYYY-MM-DD (e.g., "11/4/26" -> "2026-11-04", "Nov 04, 2026" -> "2026-11-04").
3. Currency & Amounts: ALWAYS preserve the original currency symbol or ISO code (€, £, $, ¥, USD, EUR, GBP, CAD, AUD). Format monetary values cleanly with thousands commas, 2 decimal places, and the detected currency symbol attached (e.g. "€ 1,450.50", "£ 2,500.00", "$ 120.00", "¥ 15,000.00", "CAD 450.00", "-$ 45.50"). NEVER strip currency symbols down to a plain float and NEVER default non-USD or symbol-less values to USD $.
4. Phone Numbers: Normalize messy phone numbers ("(415) 555-0192", "415.555.0192", "1 415 555 0192") into consistent "+1-415-555-0192" (or E.164 if international). Flag invalid/incomplete numbers as warnings.
5. Whitespace & Casing: Trim stray spaces, normalize vendor/client name casing to clean Title Case where appropriate, normalize status values ("paid", "PAID", "Settled" -> "Paid").
6. Formula Errors & Negative Quantities: Detect all spreadsheet formula errors (=#REF!, =#DIV/0!, =#VALUE!, #REF!, #DIV/0!, #VALUE!, #NAME?, #N/A) and log each as a "critical" anomaly with category "Formula Error". When a formula error occurs in a total/amount column and numeric quantity and unit_price columns exist on the same row, auto-calculate the repaired value as (quantity * unit_price) formatted to 2 decimal places. For any negative quantity (e.g., -2), preserve the numeric value and log a "warning" anomaly with category "Negative Quantity".
7. Duplicates: Detect exact or near-duplicate rows (same date + vendor + amount) and log a "warning" anomaly.
8. Preserve EVERY row index 0..N-1 and EVERY column in rawHeaders. Never drop rows or columns. Never classify a tabular spreadsheet as "receipt".`;

  // Standard AI batch path for small/medium datasets (<= 100 rows)
  const BATCH_SIZE = 60;
  const allCleanedRows: Record<string, string>[] = [];
  const allAnomalies: AnomalyItem[] = [];
  let schemaMappings: SchemaMapping[] = [];
  let documentCategory: DocumentCategory = 'general_table';
  let summaryParts: string[] = [];

  for (let offset = 0; offset < parsed.rows.length; offset += BATCH_SIZE) {
    const batchRows = parsed.rows.slice(offset, offset + BATCH_SIZE).map((row, idx) => ({
      rowIndex: offset + idx,
      ...row,
    }));

    const batchFormulaErrors = parsed.formulaErrors.filter(
      (fe) => fe.rowIndex >= offset && fe.rowIndex < offset + BATCH_SIZE
    );

    const promptPayload = {
      fileName: params.fileName,
      rawHeaders: parsed.headers,
      rowCountInBatch: batchRows.length,
      detectedExcelFormulaErrors: batchFormulaErrors,
      jaggedRowsDetected: parsed.jaggedRowsDetected,
      rows: batchRows,
    };

    const response = await callWithRetry((modelName, useLowThinking) =>
      ai.models.generateContent({
        model: modelName,
        contents: `Clean and normalize this dataset batch:\n${JSON.stringify(promptPayload)}`,
        config: {
          systemInstruction,
          responseMimeType: 'application/json',
          responseSchema: TABULAR_RESPONSE_SCHEMA,
          ...(useLowThinking ? { thinkingConfig: { thinkingLevel: ThinkingLevel.LOW } } : {}),
          seed: 42,
        },
      })
    );

    const jsonText = (response.text ?? '').trim();
    if (!jsonText) {
      throw new Error('Gemini returned an empty normalization response.');
    }

    const aiData = JSON.parse(jsonText) as GeminiTabularResponse;

    if (offset === 0) {
      documentCategory = sanitizeTabularCategory(aiData.documentCategory);
      schemaMappings = alignSchemaMappings(
        parsed.headers,
        aiData.schemaMappings || [],
        'Normalized tabular column header'
      );
    }
    if (aiData.executiveSummary) {
      summaryParts.push(aiData.executiveSummary);
    }

    // Build header lookup so every column stays aligned 1:1 with parsed.headers
    const normalizedHeaders = schemaMappings.map((m) => m.normalizedHeader);

    const rowMap = new Map<number, Record<string, string>>();
    for (const item of aiData.cleanedRows || []) {
      const record: Record<string, string> = {};
      for (const h of normalizedHeaders) {
        record[h] = '';
      }
      for (const cell of item.cells || []) {
        const normKey = fallbackSnakeHeader(cell.column);
        if (cell.column in record) {
          record[cell.column] = String(cell.value ?? '');
        } else if (normKey in record) {
          record[normKey] = String(cell.value ?? '');
        }
      }
      rowMap.set(item.rowIndex, record);
    }

    for (let i = 0; i < batchRows.length; i++) {
      const globalIdx = offset + i;
      const mapped = rowMap.get(globalIdx);
      if (mapped) {
        // Fill any blank cells that had raw values if AI omitted a column key
        parsed.headers.forEach((rawH, colIdx) => {
          const normH = normalizedHeaders[colIdx];
          if (mapped[normH] === '' && String(parsed.rows[globalIdx][rawH] ?? '').trim() !== '') {
            mapped[normH] = String(parsed.rows[globalIdx][rawH] ?? '');
          }
        });
        allCleanedRows.push(mapped);
      } else {
        // Fallback: preserve original values mapped to normalized headers
        const fallback: Record<string, string> = {};
        parsed.headers.forEach((rawH, colIdx) => {
          const normH = normalizedHeaders[colIdx] || rawH;
          fallback[normH] = parsed.rows[globalIdx][rawH] ?? '';
        });
        allCleanedRows.push(fallback);
      }
    }

    for (const anom of aiData.anomalies || []) {
      allAnomalies.push({
        id: `anom_${crypto.randomUUID().slice(0, 8)}`,
        severity: sanitizeSeverity(anom.severity),
        category: anom.category || 'Normalization',
        location: anom.location || 'Dataset',
        rawValue: anom.rawValue ?? '',
        suggestedOrFixedValue: anom.suggestedOrFixedValue ?? '',
        explanation: anom.explanation || '',
      });
    }
  }

  // Deterministic post-reconciliation: guarantees formula error auto-calculation, multi-currency banking columns,
  // High-Priority Financial Alerts, ISO-8601 dates, phone normalization, and Institutional AuditMetadata
  const createdAt = new Date().toISOString();
  const reconciled = reconcileTabularRowsAndAudit({
    parsed,
    schemaMappings,
    cleanedRows: allCleanedRows,
    anomalies: allAnomalies,
    fileHashSha256: params.fileHashSha256,
    timestampUtc: createdAt,
  });

  return {
    id: `job_${crypto.randomUUID().slice(0, 12)}`,
    userId: params.userId,
    fileName: params.fileName,
    fileType: parsed.fileType,
    documentCategory,
    rawHeaders: parsed.headers,
    rawRows: parsed.rows,
    cleanedHeaders: reconciled.cleanedHeaders,
    cleanedRows: reconciled.cleanedRows,
    cellDiffs: reconciled.cellDiffs,
    anomalies: reconciled.anomalies,
    schemaMappings: reconciled.schemaMappings,
    executiveSummary:
      summaryParts[0] ||
      `Normalized ${parsed.rows.length} rows across ${reconciled.cleanedHeaders.length} columns with ${reconciled.cellDiffs.length} cell corrections.`,
    rowCount: parsed.rows.length,
    processingMs: Date.now() - startMs,
    createdAt,
    auditMetadata: reconciled.auditMetadata,
  };
}

export async function cleanMultimodalDocument(params: {
  userId: string;
  fileName: string;
  parsed: ParsedBinaryDocumentInput;
  fileHashSha256?: string;
}): Promise<CleanJobRecord> {
  const startMs = Date.now();
  const ai = getAiClient();
  const { parsed } = params;

  const systemInstruction = `You are a receipt, invoice, and financial document extraction & normalization engine for DocuCleanse.
Extract all tabular line items or transaction records from the attached image or PDF into both rawRows (exact transcribed strings as seen on the receipt/document) and cleanedRows (strictly normalized ISO-8601 dates YYYY-MM-DD, cleanly formatted amounts that RETAIN their original currency symbol or code such as "€ 1,450.50", "£ 2,500.00", "$ 124.50", "¥ 15,000.00" — never stripping symbols or defaulting to USD $, clean vendor names, normalized currency codes).
If the receipt shows subtotal, tax, tip, or total discrepancies, or illegible/blurry fields, log them in anomalies with severity "critical" or "warning". Log normalized dates/currencies as "fixed".`;

  const response = await callWithRetry((modelName, useLowThinking) =>
    ai.models.generateContent({
      model: modelName,
      contents: {
        parts: [
          {
            inlineData: {
              mimeType: parsed.mimeType,
              data: parsed.base64Data,
            },
          },
          {
            text: `Extract and normalize all line items and financial metadata from "${params.fileName}" into structured tabular rows.`,
          },
        ],
      },
      config: {
        systemInstruction,
        responseMimeType: 'application/json',
        responseSchema: MULTIMODAL_RESPONSE_SCHEMA,
        ...(useLowThinking ? { thinkingConfig: { thinkingLevel: ThinkingLevel.LOW } } : {}),
        seed: 42,
      },
    })
  );

  const jsonText = (response.text ?? '').trim();
  if (!jsonText) {
    throw new Error('Gemini returned an empty document extraction response.');
  }

  const aiData = JSON.parse(jsonText) as GeminiMultimodalResponse;
  const headers =
    aiData.headers && aiData.headers.length > 0
      ? aiData.headers
      : ['receipt_date', 'vendor_name', 'line_item', 'currency', 'amount'];

  const rawRows: Record<string, string>[] = (aiData.rawRows || []).map((r) => {
    const obj: Record<string, string> = {};
    for (const h of headers) obj[h] = '';
    for (const c of r.cells || []) obj[c.column] = String(c.value ?? '');
    return obj;
  });

  const cleanedRows: Record<string, string>[] = (aiData.cleanedRows || []).map((r) => {
    const obj: Record<string, string> = {};
    for (const h of headers) obj[h] = '';
    for (const c of r.cells || []) obj[c.column] = String(c.value ?? '');
    return obj;
  });

  const cellDiffs: CellDiff[] = [];
  for (let rIdx = 0; rIdx < cleanedRows.length; rIdx++) {
    const rawR = rawRows[rIdx] || {};
    const cleanR = cleanedRows[rIdx] || {};
    for (const h of headers) {
      const rv = String(rawR[h] ?? '');
      const cv = String(cleanR[h] ?? '');
      if (rv !== cv) {
        cellDiffs.push({
          rowIndex: rIdx,
          column: h,
          rawHeader: h,
          rawValue: rv,
          cleanedValue: cv,
          changeType: inferChangeType(h, rv, cv),
        });
      }
    }
  }

  const anomalies: AnomalyItem[] = (aiData.anomalies || []).map((a) => ({
    id: `anom_${crypto.randomUUID().slice(0, 8)}`,
    severity: sanitizeSeverity(a.severity),
    category: a.category || 'Document Extraction',
    location: a.location || 'Document',
    rawValue: a.rawValue ?? '',
    suggestedOrFixedValue: a.suggestedOrFixedValue ?? '',
    explanation: a.explanation || '',
  }));

  const schemaMappings: SchemaMapping[] = headers.map((h) => ({
    rawHeader: h,
    normalizedHeader: h,
    detectedType: h.includes('date')
      ? 'date'
      : h.includes('amount') || h.includes('total') || h.includes('price') || h.includes('tax')
      ? 'currency'
      : 'text',
    reason: 'Extracted from document structure',
  }));

  const createdAt = new Date().toISOString();
  const amountCol = headers.find((h) => /total|amount|price/i.test(h)) || null;
  let inputSum = 0;
  let outputSum = 0;
  const detectedCurSet = new Set<string>();

  if (amountCol) {
    for (let i = 0; i < cleanedRows.length; i++) {
      const rv = parseNumericValue(rawRows[i]?.[amountCol]);
      const cv = parseNumericValue(cleanedRows[i]?.[amountCol]);
      const cur = detectCurrencyCode(rawRows[i]?.[amountCol]) || detectCurrencyCode(cleanedRows[i]?.['currency']);
      if (cur) detectedCurSet.add(cur);
      if (rv !== null) inputSum += rv;
      if (cv !== null) outputSum += cv;
    }
  }

  const fileHashSha256 =
    params.fileHashSha256 ||
    crypto.createHash('sha256').update(Buffer.from(parsed.base64Data, 'base64')).digest('hex');

  const multimodalAudit: AuditMetadata = {
    fileHashSha256,
    timestampUtc: createdAt,
    rowsIngested: rawRows.length > 0 ? rawRows.length : cleanedRows.length,
    rowsCleaned: cleanedRows.length,
    rowChecksumMatch: (rawRows.length > 0 ? rawRows.length : cleanedRows.length) === cleanedRows.length,
    inputSum: Number(inputSum.toFixed(2)),
    outputSum: Number(outputSum.toFixed(2)),
    reconciledVariance: Number((outputSum - inputSum).toFixed(2)),
    primaryAmountColumn: amountCol,
    detectedCurrencies: detectedCurSet.size > 0 ? Array.from(detectedCurSet) : ['USD'],
    leakageRecoveredValue: Number(Math.abs(outputSum - inputSum).toFixed(2)),
    reconciliationConfidenceScore: Number(
      Math.max(85, 100 - anomalies.filter((a) => a.severity === 'critical').length * 1.2).toFixed(1)
    ),
  };

  return {
    id: `job_${crypto.randomUUID().slice(0, 12)}`,
    userId: params.userId,
    fileName: params.fileName,
    fileType: parsed.fileType,
    documentCategory: sanitizeCategory(aiData.documentCategory),
    rawHeaders: headers,
    rawRows: rawRows.length > 0 ? rawRows : cleanedRows,
    cleanedHeaders: headers,
    cleanedRows,
    cellDiffs,
    anomalies,
    schemaMappings,
    executiveSummary:
      aiData.executiveSummary ||
      `Extracted and normalized ${cleanedRows.length} structured rows from ${params.fileName}.`,
    rowCount: cleanedRows.length,
    processingMs: Date.now() - startMs,
    createdAt,
    auditMetadata: multimodalAudit,
  };
}
