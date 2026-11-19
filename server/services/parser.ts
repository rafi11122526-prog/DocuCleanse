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

const FORMULA_ERROR_REGEX = /^#(REF!|DIV\/0!|VALUE!|NAME\?|N\/A|NUM!|NULL!|SPILL!|CALC!)$/i;

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

export function parseUploadedFile(
  buffer: Buffer,
  originalName: string,
  mimeType: string
): ParsedUploadResult {
  const ext = path.extname(originalName).toLowerCase();

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
            errorToken: val.trim().toUpperCase(),
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

  if (ext === '.xlsx' || ext === '.xls') {
    const workbook = XLSX.read(buffer, {
      type: 'buffer',
      cellFormula: true,
      cellNF: true,
      cellText: true,
      raw: false,
    });

    const firstSheetName = workbook.SheetNames[0];
    if (!firstSheetName) {
      throw new Error('The Excel workbook does not contain any worksheets.');
    }

    const sheet = workbook.Sheets[firstSheetName];
    const ref = sheet['!ref'];
    if (!ref) {
      throw new Error('The primary worksheet is empty.');
    }

    const range = XLSX.utils.decode_range(ref);
    const matrix: string[][] = [];
    const rawCells: Array<Array<XLSX.CellObject | undefined>> = [];

    for (let R = range.s.r; R <= range.e.r; R++) {
      const rowValues: string[] = [];
      const rowCellObjs: Array<XLSX.CellObject | undefined> = [];
      let hasNonEmpty = false;

      for (let C = range.s.c; C <= range.e.c; C++) {
        const addr = XLSX.utils.encode_cell({ r: R, c: C });
        const cell = sheet[addr] as XLSX.CellObject | undefined;
        rowCellObjs.push(cell);

        let textVal = '';
        if (cell) {
          if (cell.t === 'e') {
            textVal = cell.w || String(cell.v ?? '#ERROR!');
          } else if (cell.w !== undefined) {
            textVal = String(cell.w);
          } else if (cell.v !== undefined) {
            textVal = String(cell.v);
          }
        }
        if (textVal.trim().length > 0) {
          hasNonEmpty = true;
        }
        rowValues.push(textVal);
      }

      if (hasNonEmpty) {
        matrix.push(rowValues);
        rawCells.push(rowCellObjs);
      }
    }

    if (matrix.length < 2) {
      throw new Error('The spreadsheet must include a header row and at least one data row.');
    }

    const headers = makeUniqueHeaders(matrix[0]);
    const rows: Record<string, string>[] = [];
    const formulaErrors: FormulaErrorCell[] = [];

    for (let rIdx = 1; rIdx < matrix.length; rIdx++) {
      const rowObj: Record<string, string> = {};
      for (let cIdx = 0; cIdx < headers.length; cIdx++) {
        const val = matrix[rIdx][cIdx] ?? '';
        const cell = rawCells[rIdx]?.[cIdx];
        rowObj[headers[cIdx]] = val;

        if (cell?.t === 'e' || FORMULA_ERROR_REGEX.test(val.trim())) {
          formulaErrors.push({
            rowIndex: rIdx - 1,
            column: headers[cIdx],
            cellAddress: XLSX.utils.encode_cell({ r: range.s.r + rIdx, c: range.s.c + cIdx }),
            errorToken: val.trim() || '#ERROR!',
            formula: cell?.f ? `=${cell.f}` : undefined,
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
