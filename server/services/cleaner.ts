import crypto from 'node:crypto';
import { GoogleGenAI, ThinkingLevel, Type } from '@google/genai';
import type {
  AnomalyItem,
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
      description: 'One of: transactions, receipt, client_roster, invoice, general_table',
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
      description: 'One of: transactions, receipt, client_roster, invoice, general_table',
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
  if (/^#(REF!|DIV\/0!|VALUE!|NAME\?|N\/A|NUM!|NULL!|SPILL!|CALC!)/i.test(rawVal.trim())) {
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

const FORMULA_TOKEN_REGEX = /^#(REF!|DIV\/0!|VALUE!|NAME\?|N\/A|NUM!|NULL!|SPILL!|CALC!)$/i;
const MAX_DETAILED_ANOMALIES = 250;
const MAX_TRACKED_CELL_DIFFS = 5000;
const DETERMINISTIC_CHUNK_SIZE = 2000;

function normalizeDateDeterministic(
  rawVal: string,
  dateFormatHint: DetectedPatternRules['dateFormatHint']
): { value: string; warning?: string } {
  const s = rawVal.trim();
  if (!s) return { value: '' };
  if (FORMULA_TOKEN_REGEX.test(s)) return { value: `[ERROR: ${s.toUpperCase()}]` };

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
  if (FORMULA_TOKEN_REGEX.test(s)) return { value: `[ERROR: ${s.toUpperCase()}]` };

  const isAccountingNeg = /^\(.*\)$/.test(s);
  let cleaned = s
    .replace(/[$€£¥₹₩₽]/g, '')
    .replace(/\b(USD|EUR|GBP|CAD|AUD|JPY|INR|PKR|AED|SAR|CHF|RS\.?)\b/gi, '')
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
    return { value: signed.toFixed(2) };
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
    return `[ERROR: ${trimmed.toUpperCase()}]`;
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

async function cleanLargeTabularDataset(params: {
  userId: string;
  fileName: string;
  parsed: ParsedTabularInput;
  startMs: number;
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
  const documentCategory = sanitizeCategory(ruleData.documentCategory);
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
  const mappingByRaw = new Map<string, SchemaMapping>();
  for (const m of ruleData.schemaMappings || []) {
    mappingByRaw.set(m.rawHeader, {
      rawHeader: m.rawHeader,
      normalizedHeader: m.normalizedHeader || fallbackSnakeHeader(m.rawHeader),
      detectedType: m.detectedType || 'text',
      reason: m.reason || 'Detected from 40-row AI schema sample',
    });
  }

  const usedNormHeaders = new Map<string, number>();
  const schemaMappings: SchemaMapping[] = parsed.headers.map((rawHeader) => {
    const matched = mappingByRaw.get(rawHeader);
    const baseNorm = matched?.normalizedHeader || fallbackSnakeHeader(rawHeader);
    const count = usedNormHeaders.get(baseNorm) ?? 0;
    usedNormHeaders.set(baseNorm, count + 1);
    const uniqueNorm = count === 0 ? baseNorm : `${baseNorm}_${count + 1}`;
    return {
      rawHeader,
      normalizedHeader: uniqueNorm,
      detectedType: matched?.detectedType || 'text',
      reason: matched?.reason || 'Inferred from header structure',
    };
  });

  const cleanedHeaders = schemaMappings.map((m) => m.normalizedHeader);
  const allCleanedRows: Record<string, string>[] = new Array(parsed.rows.length);
  const cellDiffs: CellDiff[] = [];
  const allAnomalies: AnomalyItem[] = [];
  let totalNormalizedCells = 0;
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

        if (rawVal !== cleanVal) {
          totalNormalizedCells++;
          if (cellDiffs.length < MAX_TRACKED_CELL_DIFFS) {
            cellDiffs.push({
              rowIndex: rIdx,
              column: mapping.normalizedHeader,
              rawHeader: mapping.rawHeader,
              rawValue: rawVal,
              cleanedValue: cleanVal,
              changeType: inferChangeType(mapping.normalizedHeader, rawVal, cleanVal),
            });
          }
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

  // Ensure deterministic inclusion of all SheetJS / CSV formula errors
  for (const fe of parsed.formulaErrors) {
    pushAnomaly({
      severity: 'critical',
      category: 'Formula Error',
      location: `Row ${fe.rowIndex + 1}, ${fe.column} (${fe.cellAddress})`,
      rawValue: fe.formula ? `${fe.errorToken} (${fe.formula})` : fe.errorToken,
      suggestedOrFixedValue: '[Manual Review Required]',
      explanation: `Spreadsheet cell ${fe.cellAddress} evaluated to ${fe.errorToken}.`,
    });
  }

  if (overflowAnomaliesCount > 0 || duplicateRowsCount > 25) {
    allAnomalies.push({
      id: `anom_${crypto.randomUUID().slice(0, 8)}`,
      severity: 'warning',
      category: 'High-Capacity Audit Rollup',
      location: `Rows 1–${parsed.rows.length}`,
      rawValue: `${overflowAnomaliesCount + Math.max(0, duplicateRowsCount - 25)} additional items`,
      suggestedOrFixedValue: 'Export full cleaned XLSX/CSV',
      explanation: `Chunked processing normalized ${totalNormalizedCells.toLocaleString()} cells across ${parsed.rows.length.toLocaleString()} rows using Gemini 40-row schema rules (${duplicateRowsCount} duplicate rows detected).`,
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
    cleanedHeaders,
    cleanedRows: allCleanedRows,
    cellDiffs,
    anomalies: allAnomalies,
    schemaMappings,
    executiveSummary: `${baseSummary} High-capacity chunked engine normalized ${totalNormalizedCells.toLocaleString()} cells across ${parsed.rows.length.toLocaleString()} rows.`,
    rowCount: parsed.rows.length,
    processingMs: Date.now() - startMs,
    createdAt: new Date().toISOString(),
  };
}

export async function cleanTabularDocument(params: {
  userId: string;
  fileName: string;
  parsed: ParsedTabularInput;
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
3. Currency & Amounts: Normalize inconsistent currency strings ("$1,250.00", "USD 1250", "1.250,00 €", "(45.50)") into clean decimal numbers with 2 decimal places (e.g. "1250.00", "-45.50"). If multiple currencies appear, preserve or create a clean currency code or note the currency in the column/anomaly log, and keep numbers strictly formatted as decimal strings like "1250.00".
4. Phone Numbers: Normalize messy phone numbers ("(415) 555-0192", "415.555.0192", "1 415 555 0192") into consistent "+1-415-555-0192" (or E.164 if international). Flag invalid/incomplete numbers as warnings.
5. Whitespace & Casing: Trim stray spaces, normalize vendor/client name casing to clean Title Case where appropriate, normalize status values ("paid", "PAID", "Settled" -> "Paid").
6. Formula Errors & Missing Critical Fields: Never fabricate numbers for #REF!, #DIV/0!, #VALUE!, #NAME?, or missing totals—preserve "[ERROR: #DIV/0!]" or "[MISSING]" and log a "critical" anomaly explaining how to fix it.
7. Duplicates: Detect exact or near-duplicate rows (same date + vendor + amount) and log a "warning" anomaly.
8. Preserve EVERY row index 0..N-1 in cleanedRows. Never drop rows.`;

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
      documentCategory = sanitizeCategory(aiData.documentCategory);
      schemaMappings = (aiData.schemaMappings || []).map((m) => ({
        rawHeader: m.rawHeader,
        normalizedHeader: m.normalizedHeader,
        detectedType: m.detectedType || 'text',
        reason: m.reason,
      }));
    }
    if (aiData.executiveSummary) {
      summaryParts.push(aiData.executiveSummary);
    }

    // Build header lookup so every column stays aligned
    const normalizedHeaders =
      schemaMappings.length > 0
        ? schemaMappings.map((m) => m.normalizedHeader)
        : parsed.headers;

    const rowMap = new Map<number, Record<string, string>>();
    for (const item of aiData.cleanedRows || []) {
      const record: Record<string, string> = {};
      for (const h of normalizedHeaders) {
        record[h] = '';
      }
      for (const cell of item.cells || []) {
        record[cell.column] = String(cell.value ?? '');
      }
      rowMap.set(item.rowIndex, record);
    }

    for (let i = 0; i < batchRows.length; i++) {
      const globalIdx = offset + i;
      const mapped = rowMap.get(globalIdx);
      if (mapped) {
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

  // Ensure deterministic inclusion of any Excel formula errors detected by SheetJS
  for (const fe of parsed.formulaErrors) {
    const alreadyLogged = allAnomalies.some(
      (a) =>
        a.location.includes(fe.cellAddress) ||
        a.rawValue.includes(fe.errorToken)
    );
    if (!alreadyLogged) {
      allAnomalies.unshift({
        id: `anom_${crypto.randomUUID().slice(0, 8)}`,
        severity: 'critical',
        category: 'Formula Error',
        location: `Row ${fe.rowIndex + 1}, ${fe.column} (${fe.cellAddress})`,
        rawValue: fe.formula ? `${fe.errorToken} (${fe.formula})` : fe.errorToken,
        suggestedOrFixedValue: '[Manual Review Required]',
        explanation: `Spreadsheet cell ${fe.cellAddress} evaluated to ${fe.errorToken}.`,
      });
    }
  }

  const cleanedHeaders =
    schemaMappings.length > 0
      ? schemaMappings.map((m) => m.normalizedHeader)
      : parsed.headers;

  // Compute accurate cell-level diffs comparing rawRows vs cleanedRows
  const cellDiffs: CellDiff[] = [];
  for (let rIdx = 0; rIdx < parsed.rows.length; rIdx++) {
    const rawRow = parsed.rows[rIdx];
    const cleanRow = allCleanedRows[rIdx] || {};

    for (let cIdx = 0; cIdx < parsed.headers.length; cIdx++) {
      const rawHeader = parsed.headers[cIdx];
      const normHeader = cleanedHeaders[cIdx] || rawHeader;
      const rawVal = String(rawRow[rawHeader] ?? '');
      const cleanVal = String(cleanRow[normHeader] ?? rawVal);

      if (rawVal !== cleanVal) {
        cellDiffs.push({
          rowIndex: rIdx,
          column: normHeader,
          rawHeader,
          rawValue: rawVal,
          cleanedValue: cleanVal,
          changeType: inferChangeType(normHeader, rawVal, cleanVal),
        });
      }
    }
  }

  return {
    id: `job_${crypto.randomUUID().slice(0, 12)}`,
    userId: params.userId,
    fileName: params.fileName,
    fileType: parsed.fileType,
    documentCategory,
    rawHeaders: parsed.headers,
    rawRows: parsed.rows,
    cleanedHeaders,
    cleanedRows: allCleanedRows,
    cellDiffs,
    anomalies: allAnomalies,
    schemaMappings,
    executiveSummary:
      summaryParts[0] ||
      `Normalized ${parsed.rows.length} rows across ${cleanedHeaders.length} columns with ${cellDiffs.length} cell corrections.`,
    rowCount: parsed.rows.length,
    processingMs: Date.now() - startMs,
    createdAt: new Date().toISOString(),
  };
}

export async function cleanMultimodalDocument(params: {
  userId: string;
  fileName: string;
  parsed: ParsedBinaryDocumentInput;
}): Promise<CleanJobRecord> {
  const startMs = Date.now();
  const ai = getAiClient();
  const { parsed } = params;

  const systemInstruction = `You are a receipt, invoice, and financial document extraction & normalization engine for DocuCleanse.
Extract all tabular line items or transaction records from the attached image or PDF into both rawRows (exact transcribed strings as seen on the receipt/document) and cleanedRows (strictly normalized ISO-8601 dates YYYY-MM-DD, decimal amounts like "124.50", clean vendor names, normalized currency codes).
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
    createdAt: new Date().toISOString(),
  };
}
