import crypto from 'node:crypto';
import { GoogleGenAI, ThinkingLevel, Type } from '@google/genai';
import type {
  AnomalyItem,
  CellDiff,
  CleanJobRecord,
  DocumentCategory,
  SchemaMapping,
} from '../types.ts';
import type { ParsedBinaryDocumentInput, ParsedTabularInput } from './parser.ts';

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

export async function cleanTabularDocument(params: {
  userId: string;
  fileName: string;
  parsed: ParsedTabularInput;
}): Promise<CleanJobRecord> {
  const startMs = Date.now();
  const ai = getAiClient();
  const { parsed } = params;

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

  // Process in batches of up to 60 rows so large Pro sheets stay fast and accurate
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
