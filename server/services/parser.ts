import path from 'node:path';
import { parse as parseCsv } from 'csv-parse/sync';
import * as XLSX from 'xlsx';

export interface FormulaErrorCell {
  rowIndex: number; // 0-based data row index
  column: string;
  cellAddress: string;
  errorToken: string;
  formula?: string;
}

export interface ParsedTabularInput {
  kind: 'tabular';
  fileType: 'csv' | 'xlsx' | 'xls';
  headers: string[];
  rows: Record<string, string>[];
  formulaErrors: FormulaErrorCell[];
  jaggedRowsDetected: number;
}

export interface ParsedBinaryDocumentInput {
  kind: 'multimodal';
  fileType: 'pdf' | 'image';
  mimeType: string;
  base64Data: string;
}

export type ParsedUploadResult = ParsedTabularInput | ParsedBinaryDocumentInput;

export const LARGE_DATASET_THRESHOLD = 100;
export const SCHEMA_SAMPLE_ROW_COUNT = 40;

/**
 * Extracts a bounded sample of the first N rows for LLM schema, date, and currency detection
 * so large datasets (>100 rows) avoid token limits and timeouts.
 */
export function extractSampleRows(
  rows: Record<string, string>[],
  sampleSize = SCHEMA_SAMPLE_ROW_COUNT
): Record<string, string>[] {
  return rows.slice(0, Math.min(rows.length, sampleSize));
}

const FORMULA_ERROR_REGEX = /^=?#(REF!|DIV\/0!|VALUE!|NAME\?|N\/A|NUM!|NULL!|SPILL!|CALC!)$/i;

function normalizeHeaderName(raw: string, fallbackIndex: number): string {
  const trimmed = String(raw ?? '').trim();
  return trimmed.length > 0 ? trimmed : `Column_${fallbackIndex + 1}`;
}

function makeUniqueHeaders(rawHeaders: string[]): string[] {
  const seen = new Map<string, number>();
  return rawHeaders.map((h, idx) => {
    const base = normalizeHeaderName(h, idx);
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    return count === 0 ? base : `${base}_${count + 1}`;
  });
}

function isExcelMimeType(mimeType: string): boolean {
  const lower = mimeType.toLowerCase();
  return (
    lower.includes('spreadsheetml') ||
    lower.includes('ms-excel') ||
    lower.includes('application/vnd.ms-excel') ||
    lower.includes('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  );
}

function pickBestWorksheetName(workbook: XLSX.WorkBook): string | undefined {
  const sheetNames = workbook.SheetNames || [];
  if (sheetNames.length === 0) return undefined;

  // 1. Respect workbook activeTab if it points to a non-empty sheet
  const activeTabIdx = (
    workbook.Workbook?.Views?.[0] as { activeTab?: number } | undefined
  )?.activeTab;
  if (
    typeof activeTabIdx === 'number' &&
    activeTabIdx >= 0 &&
    activeTabIdx < sheetNames.length
  ) {
    const activeName = sheetNames[activeTabIdx];
    const activeSheet = workbook.Sheets[activeName];
    if (activeSheet && activeSheet['!ref']) {
      return activeName;
    }
  }

  // 2. Prefer explicit raw data sheets if present (e.g. "Messy_Raw_Data")
  const namedRaw = sheetNames.find(
    (name) => /raw|data|ledger|transactions/i.test(name) && Boolean(workbook.Sheets[name]?.['!ref'])
  );
  if (namedRaw) return namedRaw;

  // 3. Otherwise choose the first non-empty worksheet
  return sheetNames.find((name) => Boolean(workbook.Sheets[name]?.['!ref'])) ?? sheetNames[0];
}

function getFullWorksheetRange(sheet: XLSX.WorkSheet): XLSX.Range | null {
  let minR = Number.POSITIVE_INFINITY;
  let minC = Number.POSITIVE_INFINITY;
  let maxR = -1;
  let maxC = -1;

  if (sheet['!ref']) {
    const refRange = XLSX.utils.decode_range(sheet['!ref']);
    minR = refRange.s.r;
    minC = refRange.s.c;
    maxR = refRange.e.r;
    maxC = refRange.e.c;
  }

  // Also scan actual cell keys in case generator wrote an incomplete !ref
  for (const key of Object.keys(sheet)) {
    if (key.startsWith('!')) continue;
    try {
      const pos = XLSX.utils.decode_cell(key);
      if (pos.r < minR) minR = pos.r;
      if (pos.c < minC) minC = pos.c;
      if (pos.r > maxR) maxR = pos.r;
      if (pos.c > maxC) maxC = pos.c;
    } catch {
      // Ignore non-cell metadata keys
    }
  }

  if (maxR < 0 || maxC < 0 || !Number.isFinite(minR) || !Number.isFinite(minC)) {
    return null;
  }

  return { s: { r: minR, c: minC }, e: { r: maxR, c: maxC } };
}

function extractExcelCellText(cell: XLSX.CellObject | undefined): {
  text: string;
  isFormulaError: boolean;
  errorToken: string;
} {
  if (!cell) {
    return { text: '', isFormulaError: false, errorToken: '' };
  }

  const rawFormula = cell.f ? String(cell.f).trim() : '';
  const formulaWithEquals = rawFormula
    ? rawFormula.startsWith('=')
      ? rawFormula
      : `=${rawFormula}`
    : '';

  // Case 1: Native Excel error cell (cell.t === 'e')
  if (cell.t === 'e') {
    const token = String(cell.w || cell.v || '#ERROR!').trim();
    const display = formulaWithEquals && FORMULA_ERROR_REGEX.test(formulaWithEquals)
      ? formulaWithEquals
      : token;
    return { text: display, isFormulaError: true, errorToken: token.toUpperCase() };
  }

  // Case 2: Formula string itself is an error literal (e.g., openpyxl wrote "=#REF!", "=#DIV/0!", "=#VALUE!")
  if (rawFormula && FORMULA_ERROR_REGEX.test(rawFormula)) {
    const normalizedToken = rawFormula.replace(/^=/, '').toUpperCase();
    return {
      text: `=${normalizedToken}`,
      isFormulaError: true,
      errorToken: normalizedToken,
    };
  }

  // Case 3: Native Date object cell
  if (cell.t === 'd' && cell.v instanceof Date && !Number.isNaN(cell.v.getTime())) {
    return {
      text: cell.v.toISOString().slice(0, 10),
      isFormulaError: false,
      errorToken: '',
    };
  }

  let textVal = '';
  if (cell.w !== undefined && String(cell.w).trim() !== '') {
    textVal = String(cell.w);
  } else if (cell.v !== undefined && cell.v !== null) {
    textVal = String(cell.v);
  } else if (formulaWithEquals) {
    // Uncalculated formula without cached value
    textVal = formulaWithEquals;
  }

  const trimmed = textVal.trim();
  if (FORMULA_ERROR_REGEX.test(trimmed)) {
    return {
      text: trimmed,
      isFormulaError: true,
      errorToken: trimmed.replace(/^=/, '').toUpperCase(),
    };
  }

  return { text: textVal, isFormulaError: false, errorToken: '' };
}

export function parseUploadedFile(
  buffer: Buffer,
  originalName: string,
  mimeType: string
): ParsedUploadResult {
  const ext = path.extname(originalName).toLowerCase();

  // Route 1: Tabular CSV files (never classified as receipt scans)
  if (ext === '.csv' || mimeType === 'text/csv') {
    const text = buffer.toString('utf8').replace(/^\uFEFF/, '');
    const records = parseCsv(text, {
      relax_column_count: true,
      skip_empty_lines: true,
      trim: false,
    }) as string[][];

    if (records.length === 0) {
      throw new Error('The uploaded CSV file is empty.');
    }

    const rawHeaderRow = records[0];
    const maxCols = records.reduce((max, r) => Math.max(max, r.length), rawHeaderRow.length);
    const paddedRawHeaders = Array.from({ length: maxCols }, (_, i) => rawHeaderRow[i] ?? '');
    const headers = makeUniqueHeaders(paddedRawHeaders);

    const rows: Record<string, string>[] = [];
    const formulaErrors: FormulaErrorCell[] = [];
    let jaggedRowsDetected = 0;

    for (let rIdx = 1; rIdx < records.length; rIdx++) {
      const record = records[rIdx];
      if (record.length !== rawHeaderRow.length) {
        jaggedRowsDetected++;
      }
      const rowObj: Record<string, string> = {};
      for (let cIdx = 0; cIdx < headers.length; cIdx++) {
        const val = String(record[cIdx] ?? '');
        rowObj[headers[cIdx]] = val;
        if (FORMULA_ERROR_REGEX.test(val.trim())) {
          formulaErrors.push({
            rowIndex: rIdx - 1,
            column: headers[cIdx],
            cellAddress: `${XLSX.utils.encode_col(cIdx)}${rIdx + 1}`,
            errorToken: val.trim().replace(/^=/, '').toUpperCase(),
            formula: val.trim().startsWith('=') ? val.trim() : undefined,
          });
        }
      }
      rows.push(rowObj);
    }

    if (rows.length === 0) {
      throw new Error('The uploaded CSV contains headers but zero data rows.');
    }

    return {
      kind: 'tabular',
      fileType: 'csv',
      headers,
      rows,
      formulaErrors,
      jaggedRowsDetected,
    };
  }

  // Route 2: Tabular Excel workbooks (.xlsx, .xls) — strictly parsed as Tabular Dataset, NEVER as Receipt
  if (ext === '.xlsx' || ext === '.xls' || isExcelMimeType(mimeType)) {
    const workbook = XLSX.read(buffer, {
      type: 'buffer',
      cellFormula: true,
      cellNF: true,
      cellText: true,
      cellDates: false,
      raw: false,
    });

    const targetSheetName = pickBestWorksheetName(workbook);
    if (!targetSheetName) {
      throw new Error('The Excel workbook does not contain any worksheets.');
    }

    const sheet = workbook.Sheets[targetSheetName];
    const range = getFullWorksheetRange(sheet);
    if (!range) {
      throw new Error('The active worksheet is empty.');
    }

    interface ExtractedCellEntry {
      text: string;
      isFormulaError: boolean;
      errorToken: string;
      formula?: string;
      sheetRow: number;
      sheetCol: number;
    }

    const extractedRows: ExtractedCellEntry[][] = [];

    for (let R = range.s.r; R <= range.e.r; R++) {
      const rowEntries: ExtractedCellEntry[] = [];
      let hasNonEmpty = false;

      for (let C = range.s.c; C <= range.e.c; C++) {
        const addr = XLSX.utils.encode_cell({ r: R, c: C });
        const cell = sheet[addr] as XLSX.CellObject | undefined;
        const parsedCell = extractExcelCellText(cell);

        if (parsedCell.text.trim().length > 0 || parsedCell.isFormulaError) {
          hasNonEmpty = true;
        }

        rowEntries.push({
          text: parsedCell.text,
          isFormulaError: parsedCell.isFormulaError,
          errorToken: parsedCell.errorToken,
          formula: cell?.f ? `=${String(cell.f).replace(/^=/, '')}` : undefined,
          sheetRow: R,
          sheetCol: C,
        });
      }

      if (hasNonEmpty) {
        extractedRows.push(rowEntries);
      }
    }

    if (extractedRows.length < 2) {
      throw new Error('The spreadsheet must include a header row and at least one data row.');
    }

    // Identify true header row: Row 1 (index 0) unless Row 1 is a single-cell title banner above a multi-column header row
    let headerRowIdx = 0;
    const row0NonEmpty = extractedRows[0].filter((c) => c.text.trim().length > 0).length;
    if (extractedRows.length > 2 && row0NonEmpty === 1) {
      const row1NonEmpty = extractedRows[1].filter((c) => c.text.trim().length > 0).length;
      if (row1NonEmpty >= 3) {
        headerRowIdx = 1;
      }
    }

    const rawHeaderCells = extractedRows[headerRowIdx];
    // Trim trailing completely-empty columns across the whole table while preserving every populated column
    let lastPopulatedCol = rawHeaderCells.length - 1;
    while (lastPopulatedCol > 0) {
      const colHasValue = extractedRows
        .slice(headerRowIdx)
        .some((row) => {
          const entry = row[lastPopulatedCol];
          return Boolean(entry && (entry.text.trim().length > 0 || entry.isFormulaError));
        });
      if (colHasValue) break;
      lastPopulatedCol--;
    }

    const activeColCount = lastPopulatedCol + 1;
    const headers = makeUniqueHeaders(
      rawHeaderCells.slice(0, activeColCount).map((c) => c.text)
    );

    const rows: Record<string, string>[] = [];
    const formulaErrors: FormulaErrorCell[] = [];

    for (let rIdx = headerRowIdx + 1; rIdx < extractedRows.length; rIdx++) {
      const dataRowIndex = rows.length;
      const rowObj: Record<string, string> = {};
      const entries = extractedRows[rIdx];

      for (let cIdx = 0; cIdx < activeColCount; cIdx++) {
        const entry = entries[cIdx];
        const val = entry?.text ?? '';
        rowObj[headers[cIdx]] = val;

        if (entry?.isFormulaError || FORMULA_ERROR_REGEX.test(val.trim())) {
          formulaErrors.push({
            rowIndex: dataRowIndex,
            column: headers[cIdx],
            cellAddress: XLSX.utils.encode_cell({
              r: entry?.sheetRow ?? range.s.r + rIdx,
              c: entry?.sheetCol ?? range.s.c + cIdx,
            }),
            errorToken:
              entry?.errorToken || val.trim().replace(/^=/, '').toUpperCase() || '#ERROR!',
            formula: entry?.formula || (val.trim().startsWith('=') ? val.trim() : undefined),
          });
        }
      }
      rows.push(rowObj);
    }

    return {
      kind: 'tabular',
      fileType: ext === '.xls' ? 'xls' : 'xlsx',
      headers,
      rows,
      formulaErrors,
      jaggedRowsDetected: 0,
    };
  }

  // Route 3: Receipt / Document scans strictly reserved for PDF and Image files
  if (ext === '.pdf' || mimeType === 'application/pdf') {
    return {
      kind: 'multimodal',
      fileType: 'pdf',
      mimeType: 'application/pdf',
      base64Data: buffer.toString('base64'),
    };
  }

  if (
    ['.png', '.jpg', '.jpeg', '.webp'].includes(ext) ||
    mimeType.startsWith('image/')
  ) {
    const resolvedMime =
      mimeType && mimeType.startsWith('image/')
        ? mimeType
        : ext === '.png'
        ? 'image/png'
        : ext === '.webp'
        ? 'image/webp'
        : 'image/jpeg';

    return {
      kind: 'multimodal',
      fileType: 'image',
      mimeType: resolvedMime,
      base64Data: buffer.toString('base64'),
    };
  }

  throw new Error(
    `Unsupported file format (${ext || mimeType}). Please upload .csv, .xlsx, .xls, .pdf, .png, .jpg, or .webp.`
  );
}
