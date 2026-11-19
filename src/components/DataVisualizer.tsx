import { useEffect, useMemo, useState } from 'react';
import {
  AlertOctagon,
  BarChart3,
  Calendar,
  Coins,
  Database,
  Layers,
  Minimize2,
  PieChart,
  Presentation,
  ShieldAlert,
  ShieldCheck,
  TrendingUp,
} from 'lucide-react';
import type { CleanJob } from '../types';

export type ChartViewType = 'bar' | 'donut' | 'anomalies' | 'trend';
export type AggregationMode = 'sum' | 'avg' | 'count';

interface DataVisualizerProps {
  job: CleanJob;
}

interface AggregatedDatum {
  label: string;
  value: number;
  count: number;
  color: string;
}

interface TrendPoint {
  date: string;
  value: number;
  count: number;
}

const SERIES_PALETTE = [
  '#2563EB', // blue-600
  '#0EA5E9', // sky-500
  '#10B981', // emerald-500
  '#6366F1', // indigo-500
  '#F59E0B', // amber-500
  '#EC4899', // pink-500
  '#14B8A6', // teal-500
  '#8B5CF6', // violet-500
  '#64748B', // slate-500
];

function detectCurrencyFromValue(raw: string | undefined): string | null {
  if (!raw) return null;
  const s = raw.trim();
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
  if (/\bUSD\b|US\$|\$/i.test(s)) return 'USD';
  return null;
}

function currencyCodeToDisplayPrefix(code: string): string {
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

function parseNumericValue(raw: string | undefined): number | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (
    !trimmed ||
    trimmed.startsWith('=') ||
    trimmed.startsWith('[ERROR') ||
    trimmed === '[MISSING]' ||
    trimmed.endsWith('%')
  ) {
    return null;
  }
  const isParenNeg = /^\(.*\)$/.test(trimmed);
  let cleaned = trimmed
    .replace(/([-(\s\u00A0]|^)(?:CA|AU|US|NZ|HK|SG|C|A|S)\$/gi, '$1')
    .replace(/\b(USD|EUR|GBP|CAD|AUD|JPY|CHF|NZD|SGD|HKD|PKR|INR|AED|SAR|RS\.?)\b/gi, '')
    .replace(/[$€£¥₹₩₽\s\u00A0()]/g, '');

  // Handle European decimals (e.g., 1.250,50 or 450,00) vs US thousand commas (1,250.50)
  if (/^-?\d{1,3}(\.\d{3})*,\d{1,2}$/.test(cleaned) || /^-?\d+,\d{1,2}$/.test(cleaned)) {
    cleaned = cleaned.replace(/\./g, '').replace(',', '.');
  } else {
    cleaned = cleaned.replace(/,/g, '');
  }

  if (!/^-?\d+(\.\d+)?$/.test(cleaned)) return null;
  const num = Number(cleaned);
  if (!Number.isFinite(num)) return null;
  return isParenNeg ? -Math.abs(num) : num;
}

function formatExecutiveCurrency(val: number, currencies: string[] = []): string {
  const sign = val < 0 ? '-' : '';
  const absFormatted = Math.abs(val).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  if (currencies.length === 1) {
    return `${sign}${currencyCodeToDisplayPrefix(currencies[0])} ${absFormatted}`;
  }
  return `${sign}${absFormatted}`;
}

function formatCurrencyWithCode(val: number, code: string): string {
  const sign = val < 0 ? '-' : '';
  const absFormatted = Math.abs(val).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  const upper = code.toUpperCase();
  const symMap: Record<string, string> = {
    USD: '$',
    EUR: '€',
    GBP: '£',
    JPY: '¥',
    INR: '₹',
    CAD: 'CA$',
    AUD: 'A$',
  };
  const sym = symMap[upper];
  if (sym) {
    return `${upper} ${sign}${sym}${absFormatted}`;
  }
  return `${upper} ${sign}${absFormatted}`;
}

function formatMetricValue(
  val: number,
  isCurrency: boolean,
  mode: AggregationMode,
  currencies: string[] = []
): string {
  if (mode === 'count') {
    return Math.round(val).toLocaleString('en-US');
  }
  if (isCurrency) {
    const sign = val < 0 ? '-' : '';
    const absFormatted = Math.abs(val).toLocaleString('en-US', {
      minimumFractionDigits: Math.abs(val) >= 1000 ? 0 : 2,
      maximumFractionDigits: 2,
    });
    if (currencies.length === 1) {
      return `${sign}${currencyCodeToDisplayPrefix(currencies[0])} ${absFormatted}`;
    }
    return `${sign}${absFormatted}`;
  }
  return val.toLocaleString('en-US', {
    maximumFractionDigits: 2,
  });
}

function polarToCartesian(cx: number, cy: number, r: number, angleDeg: number) {
  const rad = ((angleDeg - 90) * Math.PI) / 180;
  return {
    x: cx + r * Math.cos(rad),
    y: cy + r * Math.sin(rad),
  };
}

function describeDonutArc(
  cx: number,
  cy: number,
  outerR: number,
  innerR: number,
  startAngle: number,
  endAngle: number
): string {
  const safeEnd = Math.min(endAngle, startAngle + 359.99);
  const startOuter = polarToCartesian(cx, cy, outerR, safeEnd);
  const endOuter = polarToCartesian(cx, cy, outerR, startAngle);
  const startInner = polarToCartesian(cx, cy, innerR, safeEnd);
  const endInner = polarToCartesian(cx, cy, innerR, startAngle);
  const largeArc = safeEnd - startAngle <= 180 ? '0' : '1';

  return [
    'M',
    startOuter.x,
    startOuter.y,
    'A',
    outerR,
    outerR,
    0,
    largeArc,
    0,
    endOuter.x,
    endOuter.y,
    'L',
    endInner.x,
    endInner.y,
    'A',
    innerR,
    innerR,
    0,
    largeArc,
    1,
    startInner.x,
    startInner.y,
    'Z',
  ].join(' ');
}

export function DataVisualizer({ job }: DataVisualizerProps) {
  const [chartType, setChartType] = useState<ChartViewType>('bar');
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
  const [isBoardMode, setIsBoardMode] = useState(false);

  // Escape key exits Board Presentation mode cleanly
  useEffect(() => {
    if (!isBoardMode) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setIsBoardMode(false);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isBoardMode]);

  // Automatic schema & metric column detection
  const detectedSchema = useMemo(() => {
    const numericCols: Array<{ header: string; isCurrency: boolean; priority: number }> = [];
    const dateCols: string[] = [];
    const categoricalCols: Array<{ header: string; score: number }> = [];

    const mappingLookup = new Map(
      job.schemaMappings.map((m) => [m.normalizedHeader, m.detectedType])
    );

    for (const header of job.cleanedHeaders) {
      const mappedType = mappingLookup.get(header);
      const lower = header.toLowerCase();
      // Preserve raw_amount as audit reference rather than chart metric
      if (lower === 'raw_amount') {
        continue;
      }

      const values = job.cleanedRows.map((r) => String(r[header] ?? '').trim());
      const nonEmpty = values.filter(
        (v) => v.length > 0 && !v.startsWith('[ERROR') && v !== '[MISSING]'
      );

      // 1. Date column check
      const dateMatches = nonEmpty.filter((v) => /^\d{4}-\d{2}-\d{2}/.test(v)).length;
      if (
        mappedType === 'date' ||
        /date|dt|renewal|created|timestamp/.test(lower) ||
        (nonEmpty.length > 0 && dateMatches / nonEmpty.length >= 0.6)
      ) {
        dateCols.push(header);
        continue;
      }

      // 2. Numeric / Currency column check
      const numericMatches = nonEmpty.filter((v) => parseNumericValue(v) !== null).length;
      const hasCurrencyValues = nonEmpty.some((v) => detectCurrencyFromValue(v) !== null);
      const isRateOrPct = /tax[\s_-]?rate|\brate\b|_rate|pct|percent/.test(lower);
      const isCurrencyName =
        !isRateOrPct &&
        (lower === 'normalized_amount' ||
          /\b(amount|amt|total|price|cost|mrr|revenue|fee|balance|spend|budget|salary|pay|wage|invoice|subtotal)\b|total_amount|unit_price|line_total/.test(
            lower
          ));
      const isCurrencyCol =
        !isRateOrPct &&
        lower !== 'currency_code' &&
        (mappedType === 'currency' || isCurrencyName || hasCurrencyValues);

      if (
        lower !== 'currency_code' &&
        (isCurrencyCol ||
          mappedType === 'number' ||
          (nonEmpty.length > 0 && numericMatches / nonEmpty.length >= 0.65))
      ) {
        const priority =
          lower === 'normalized_amount'
            ? 100
            : /total[\s_-]?amount|line[\s_-]?total|net[\s_-]?total|grand[\s_-]?total|\btotal\b|revenue|mrr/.test(
                lower
              ) && !isRateOrPct
            ? 85
            : isCurrencyCol && !/unit[\s_-]?price|unit[\s_-]?cost/.test(lower)
            ? 70
            : isCurrencyCol
            ? 50
            : 20;
        numericCols.push({
          header,
          isCurrency: isCurrencyCol,
          priority,
        });
        continue;
      }

      // 3. Categorical column scoring (exclude phones/emails/long notes/IDs)
      if (mappedType === 'phone' || mappedType === 'email' || /phone|email|note|id$/.test(lower)) {
        continue;
      }

      const distinct = new Set(nonEmpty).size;
      if (distinct >= 1) {
        let score = 1;
        if (lower === 'currency_code') {
          score += 6;
        } else if (/category|cat|department|dept|region|status|stat|type|method|role|stage|country|city|team|tier|currency/.test(lower)) {
          score += 5;
        } else if (/vendor|merchant|payee|client|company|product|warehouse|owner|manager/.test(lower)) {
          score += 3;
        }
        // Prefer columns with clean grouping cardinality
        if (distinct >= 2 && distinct <= 12) {
          score += 3;
        }
        categoricalCols.push({ header, score });
      }
    }

    numericCols.sort((a, b) => b.priority - a.priority);
    categoricalCols.sort((a, b) => b.score - a.score);

    // Fallback: if no categorical columns scored, include any non-numeric header present in job.cleanedHeaders
    const fallbackCategories =
      categoricalCols.length > 0
        ? categoricalCols.map((c) => c.header)
        : job.cleanedHeaders.filter(
            (h) => h !== 'raw_amount' && !numericCols.some((n) => n.header === h) && !dateCols.includes(h)
          );

    const hasFinancialColumn = numericCols.some((c) => c.isCurrency);

    return {
      numericCols,
      dateCols,
      categoricalCols:
        fallbackCategories.length > 0 ? fallbackCategories : job.cleanedHeaders,
      hasFinancialColumn,
    };
  }, [job]);

  // Executive KPIs (Total Revenue / Gross Inflow, Identified Leakage, Reconciliation Confidence)
  const executiveKpis = useMemo(() => {
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

    const qtyCol = findHeader(
      headers,
      /\b(qty|quantity|units)\b|qty_sold|quantity_sold|units_sold/i
    );
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

    const candidateTotalCols = Array.from(
      new Set(
        [
          normalizedAmtCol,
          job.auditMetadata?.primaryAmountColumn || '',
          explicitTotalCol,
          partialTotalCol,
          detectedSchema.numericCols.find(
            (n) => n.isCurrency && !/unit[\s_-]?price|unit[\s_-]?cost/i.test(n.header)
          )?.header || '',
        ].filter(Boolean)
      )
    );

    const primaryCol =
      candidateTotalCols[0] ||
      detectedSchema.numericCols.find((n) => n.isCurrency)?.header ||
      detectedSchema.numericCols[0]?.header ||
      '';

    let grossInflow = 0;
    let netTotal = 0;
    let negativeExposure = 0;
    let computedInputSum = 0;
    const currencySet = new Set<string>(job.auditMetadata?.detectedCurrencies ?? []);
    const currencyPositiveTotals = new Map<string, number>();

    const rawTotalKey = findHeader(
      rawHeaders,
      /(total[\s_-]?amount|line[\s_-]?total|total|amount|revenue|mrr|balance)/i,
      /unit[\s_-]?price|tax|rate/i
    );

    const rowCount = Math.max(job.cleanedRows.length, job.rawRows.length);
    for (let i = 0; i < rowCount; i++) {
      const cleanRow = job.cleanedRows[i] || {};
      const rawRow = job.rawRows[i] || {};

      // 1. Try reading a valid normalized transaction total from candidate total columns (preferring non-zero values)
      let rowAmount: number | null = null;
      let sawExplicitZero = false;
      for (const col of candidateTotalCols) {
        const parsed = parseNumericValue(cleanRow[col]);
        if (parsed !== null) {
          if (parsed !== 0) {
            rowAmount = parsed;
            break;
          }
          sawExplicitZero = true;
        }
      }

      // 2. Compute (quantity * unit_price) whenever total_amount is missing, uncalculated, error, or 0 while qty*price is non-zero
      const qtyVal =
        (qtyCol ? parseNumericValue(cleanRow[qtyCol]) : null) ??
        (rawQtyCol ? parseNumericValue(rawRow[rawQtyCol]) : null);
      const unitPriceVal =
        (unitPriceCol ? parseNumericValue(cleanRow[unitPriceCol]) : null) ??
        (rawUnitPriceCol ? parseNumericValue(rawRow[rawUnitPriceCol]) : null);

      if (qtyVal !== null && unitPriceVal !== null) {
        const computedLine = Number((qtyVal * unitPriceVal).toFixed(2));
        if (rowAmount === null && computedLine !== 0) {
          rowAmount = computedLine;
        } else if (rowAmount === null && !sawExplicitZero) {
          rowAmount = computedLine;
        }
      }

      // 3. Fallback to raw total column if cleaned total was empty/unparsed
      if (rowAmount === null && rawTotalKey) {
        const rawParsed = parseNumericValue(rawRow[rawTotalKey]);
        if (rawParsed !== null && rawParsed !== 0) {
          rowAmount = rawParsed;
        }
      }

      // 4. Final fallback to first numeric currency column or explicit zero
      if (rowAmount === null && primaryCol) {
        rowAmount = parseNumericValue(cleanRow[primaryCol]);
      }
      if (rowAmount === null && sawExplicitZero) {
        rowAmount = 0;
      }

      // Detect row-level ISO currency code without defaulting to USD
      let rowCurrency: string | null = null;
      const curField = String(cleanRow.currency_code ?? '').trim().toUpperCase();
      if (curField && curField !== 'N/A') {
        rowCurrency = curField;
      } else {
        for (const col of candidateTotalCols) {
          const c = detectCurrencyFromValue(cleanRow[col]);
          if (c) {
            rowCurrency = c;
            break;
          }
        }
        if (!rowCurrency && unitPriceCol) {
          rowCurrency = detectCurrencyFromValue(cleanRow[unitPriceCol]);
        }
        if (!rowCurrency && rawTotalKey) {
          rowCurrency = detectCurrencyFromValue(rawRow[rawTotalKey]);
        }
        if (!rowCurrency && rawUnitPriceCol) {
          rowCurrency = detectCurrencyFromValue(rawRow[rawUnitPriceCol]);
        }
      }

      if (rowCurrency) {
        currencySet.add(rowCurrency);
      }

      if (rowAmount !== null) {
        netTotal += rowAmount;
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

      // Track raw input sum for fallback variance display on legacy jobs
      if (rawTotalKey) {
        const rawNum = parseNumericValue(rawRow[rawTotalKey]);
        if (rawNum !== null) computedInputSum += rawNum;
      }
    }

    const currencyBreakdown = Array.from(currencyPositiveTotals.entries())
      .map(([code, total]) => ({ code, total }))
      .sort((a, b) => b.total - a.total);

    // Compute Unique Entities count for non-financial / operational datasets
    const uniqueEntityCol =
      job.cleanedHeaders.find((h) =>
        /(student|employee|emp|member|client|customer|person|assignee|full[\s_-]?name|name|email|entity)/i.test(
          h
        )
      ) ||
      job.cleanedHeaders.find((h) => /\bid\b|_id$/i.test(h)) ||
      detectedSchema.categoricalCols[0] ||
      job.cleanedHeaders[0] ||
      '';
    const uniqueEntitySet = new Set<string>();
    if (uniqueEntityCol) {
      for (const row of job.cleanedRows) {
        const val = String(row[uniqueEntityCol] ?? '').trim();
        if (val && val !== '[MISSING]') {
          uniqueEntitySet.add(val.toLowerCase());
        }
      }
    }
    const uniqueEntitiesCount = uniqueEntitySet.size;

    // Fallback leakage calculation if auditMetadata isn't present on legacy jobs
    let formulaRepairValue = 0;
    if (job.auditMetadata?.leakageRecoveredValue === undefined) {
      for (const diff of job.cellDiffs) {
        if (diff.changeType === 'formula_error') {
          const parsed = parseNumericValue(diff.cleanedValue);
          if (parsed !== null) {
            formulaRepairValue += Math.abs(parsed);
          }
        }
      }
    }

    const leakageValue =
      job.auditMetadata?.leakageRecoveredValue !== undefined &&
      (job.auditMetadata.leakageRecoveredValue > 0 || (formulaRepairValue === 0 && negativeExposure === 0))
        ? job.auditMetadata.leakageRecoveredValue
        : Number((formulaRepairValue + negativeExposure).toFixed(2));

    const effectiveLeakageOrRefunds = Math.max(leakageValue, negativeExposure);
    const roundedGross = Number(grossInflow.toFixed(2));
    const netVarianceInflow = Number((roundedGross - effectiveLeakageOrRefunds).toFixed(2));

    const activeConfidenceHeaders = job.cleanedHeaders.filter((h) => h !== 'raw_amount');
    const totalCells = Math.max(
      1,
      job.cleanedRows.length * Math.max(1, activeConfidenceHeaders.length)
    );
    const unresolvedCount = job.cleanedRows.reduce(
      (acc, row) =>
        acc +
        activeConfidenceHeaders.filter((h) => /^\[ERROR:/i.test(String(row[h] ?? '').trim()))
          .length,
      0
    );
    const highPriorityFinAlerts = job.anomalies.filter(
      (a) =>
        a.severity === 'critical' &&
        /financial|currency|negative|fx/i.test(`${a.category} ${a.explanation}`)
    ).length;
    const criticalPenalty = Math.min(2.5, highPriorityFinAlerts * 0.15);
    const computedConfidence = Number(
      Math.max(
        0,
        Math.min(100, ((totalCells - unresolvedCount) / totalCells) * 100 - criticalPenalty)
      ).toFixed(1)
    );
    const storedScore = job.auditMetadata?.reconciliationConfidenceScore;
    const confidenceScore =
      storedScore !== undefined && Math.abs(storedScore - computedConfidence) <= 1.0
        ? storedScore
        : computedConfidence;

    const criticalFinancialCount = job.anomalies.filter((a) => a.severity === 'critical').length;
    const roundedNet = Number(netTotal.toFixed(2));
    const resolvedOutputSum =
      job.auditMetadata && (job.auditMetadata.outputSum !== 0 || roundedNet === 0)
        ? job.auditMetadata.outputSum
        : roundedNet;
    const resolvedInputSum =
      job.auditMetadata && (job.auditMetadata.inputSum !== 0 || computedInputSum === 0)
        ? job.auditMetadata.inputSum
        : Number(computedInputSum.toFixed(2));
    const resolvedVariance =
      job.auditMetadata && (job.auditMetadata.outputSum !== 0 || roundedNet === 0)
        ? job.auditMetadata.reconciledVariance
        : Number((resolvedOutputSum - resolvedInputSum).toFixed(2));

    return {
      hasFinancialColumn: detectedSchema.hasFinancialColumn,
      grossInflow: roundedGross,
      netTotal: roundedNet,
      netVarianceInflow,
      leakageValue: Number(effectiveLeakageOrRefunds.toFixed(2)),
      confidenceScore,
      currencies: Array.from(currencySet),
      currencyBreakdown,
      uniqueEntitiesCount,
      uniqueEntityCol,
      primaryCol,
      criticalFinancialCount,
      rowsIngested: job.auditMetadata?.rowsIngested ?? job.rowCount,
      rowsCleaned: job.auditMetadata?.rowsCleaned ?? job.rowCount,
      rowChecksumMatch: job.auditMetadata?.rowChecksumMatch ?? true,
      reconciledVariance: resolvedVariance,
      inputSum: resolvedInputSum,
      outputSum: resolvedOutputSum,
      timestampUtc: (() => {
        const rawTs = job.auditMetadata?.timestampUtc ?? job.createdAt;
        if (rawTs.endsWith(' UTC')) return rawTs;
        const dt = new Date(rawTs);
        return Number.isNaN(dt.getTime())
          ? `${rawTs} UTC`
          : `${dt.toISOString().replace('T', ' ').slice(0, 19)} UTC`;
      })(),
      fileHashPreview: job.auditMetadata?.fileHashSha256
        ? `${job.auditMetadata.fileHashSha256.slice(0, 12)}…${job.auditMetadata.fileHashSha256.slice(-8)}`
        : 'Legacy Record',
    };
  }, [job, detectedSchema.numericCols, detectedSchema.categoricalCols, detectedSchema.hasFinancialColumn]);

  const [selectedCategory, setSelectedCategory] = useState<string>(
    detectedSchema.categoricalCols[0] || job.cleanedHeaders[0] || ''
  );
  const [selectedNumeric, setSelectedNumeric] = useState<string>(
    detectedSchema.numericCols[0]?.header || ''
  );
  const [aggregation, setAggregation] = useState<AggregationMode>(
    detectedSchema.numericCols.length > 0 ? 'sum' : 'count'
  );

  // Sync defaults when user switches to a different cleaned file
  useEffect(() => {
    setSelectedCategory(detectedSchema.categoricalCols[0] || job.cleanedHeaders[0] || '');
    const firstNum = detectedSchema.numericCols[0]?.header || '';
    setSelectedNumeric(firstNum);
    setAggregation(firstNum ? 'sum' : 'count');
    setHoveredIndex(null);
  }, [job.id, detectedSchema, job.cleanedHeaders]);

  // Strictly ground selected dropdown fields to columns that exist in the active dataset
  const effectiveCategory = detectedSchema.categoricalCols.includes(selectedCategory)
    ? selectedCategory
    : detectedSchema.categoricalCols[0] || job.cleanedHeaders[0] || '';

  const effectiveNumeric = detectedSchema.numericCols.some((n) => n.header === selectedNumeric)
    ? selectedNumeric
    : detectedSchema.numericCols[0]?.header || '';

  const activeNumericMeta = useMemo(
    () => detectedSchema.numericCols.find((n) => n.header === effectiveNumeric),
    [detectedSchema.numericCols, effectiveNumeric]
  );

  const effectiveAggregation: AggregationMode =
    !effectiveNumeric || aggregation === 'count' ? 'count' : aggregation;
  const isCurrencyMetric =
    effectiveAggregation !== 'count' && Boolean(activeNumericMeta?.isCurrency);

  // Grouped categorical data for Bar & Donut charts
  const groupedData = useMemo<AggregatedDatum[]>(() => {
    if (!effectiveCategory) return [];

    const buckets = new Map<string, { sum: number; count: number }>();
    for (const row of job.cleanedRows) {
      const rawGroup = String(row[effectiveCategory] ?? '').trim();
      const label =
        !rawGroup || rawGroup === '[MISSING]' ? 'Unspecified' : rawGroup;

      const entry = buckets.get(label) || { sum: 0, count: 0 };
      entry.count += 1;

      if (effectiveAggregation !== 'count' && effectiveNumeric) {
        const num = parseNumericValue(row[effectiveNumeric]);
        if (num !== null) {
          entry.sum += num;
        }
      }
      buckets.set(label, entry);
    }

    const items = Array.from(buckets.entries()).map(([label, stats]) => {
      const val =
        effectiveAggregation === 'count'
          ? stats.count
          : effectiveAggregation === 'avg'
          ? stats.sum / Math.max(1, stats.count)
          : stats.sum;
      return {
        label,
        value: Number(val.toFixed(2)),
        count: stats.count,
      };
    });

    items.sort((a, b) => Math.abs(b.value) - Math.abs(a.value));
    return items.slice(0, 9).map((item, idx) => ({
      ...item,
      color: SERIES_PALETTE[idx % SERIES_PALETTE.length],
    }));
  }, [job.cleanedRows, effectiveCategory, effectiveNumeric, effectiveAggregation]);

  const totalGroupedValue = useMemo(
    () => groupedData.reduce((acc, d) => acc + Math.max(0, d.value), 0),
    [groupedData]
  );

  // Chronological Trend data
  const activeDateCol = detectedSchema.dateCols[0] || '';
  const trendData = useMemo<TrendPoint[]>(() => {
    if (!activeDateCol) return [];
    const buckets = new Map<string, { sum: number; count: number }>();

    for (const row of job.cleanedRows) {
      const dt = String(row[activeDateCol] ?? '').trim();
      if (!/^\d{4}-\d{2}-\d{2}/.test(dt)) continue;
      const dateKey = dt.slice(0, 10);
      const entry = buckets.get(dateKey) || { sum: 0, count: 0 };
      entry.count += 1;
      if (effectiveAggregation !== 'count' && effectiveNumeric) {
        const num = parseNumericValue(row[effectiveNumeric]);
        if (num !== null) entry.sum += num;
      }
      buckets.set(dateKey, entry);
    }

    return Array.from(buckets.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, stats]) => ({
        date,
        count: stats.count,
        value: Number(
          (effectiveAggregation === 'count'
            ? stats.count
            : effectiveAggregation === 'avg'
            ? stats.sum / Math.max(1, stats.count)
            : stats.sum
          ).toFixed(2)
        ),
      }));
  }, [activeDateCol, job.cleanedRows, effectiveAggregation, effectiveNumeric]);

  // Anomaly distribution data
  const anomalyStats = useMemo(() => {
    let critical = 0;
    let warning = 0;
    let fixed = 0;
    const byCategory = new Map<string, { count: number; severity: 'critical' | 'warning' | 'fixed' }>();

    for (const a of job.anomalies) {
      if (a.severity === 'critical') critical++;
      else if (a.severity === 'warning') warning++;
      else fixed++;

      const prev = byCategory.get(a.category);
      if (prev) {
        prev.count += 1;
      } else {
        byCategory.set(a.category, { count: 1, severity: a.severity });
      }
    }

    const severities: AggregatedDatum[] = [
      { label: 'Critical Errors', value: critical, count: critical, color: '#DC2626' },
      { label: 'Warnings & Duplicates', value: warning, count: warning, color: '#D97706' },
      { label: 'Auto-Fixed Fields', value: fixed, count: fixed, color: '#16A34A' },
    ].filter((s) => s.value > 0);

    const categories = Array.from(byCategory.entries())
      .map(([category, info]) => ({ category, ...info }))
      .sort((a, b) => b.count - a.count);

    return {
      total: job.anomalies.length,
      severities,
      categories,
    };
  }, [job.anomalies]);

  const maxBarValue = useMemo(() => {
    const m = Math.max(...groupedData.map((d) => Math.abs(d.value)), 0);
    return m === 0 ? 1 : m;
  }, [groupedData]);

  const isMultiCurrency =
    executiveKpis.currencyBreakdown.length > 1 || executiveKpis.currencies.length > 1;
  const displayCurrencyCodes =
    executiveKpis.currencyBreakdown.length > 0
      ? executiveKpis.currencyBreakdown.map((c) => c.code)
      : executiveKpis.currencies;

  const executiveKpiStrip = executiveKpis.hasFinancialColumn ? (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-3.5">
      {/* KPI 1: Total Revenue / Gross Inflow */}
      <div
        className={`rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 ${
          isBoardMode ? 'p-6 dark:border-slate-700/80 dark:bg-slate-900/95' : 'p-4'
        }`}
      >
        <div className="flex items-start justify-between gap-2 text-xs font-medium text-slate-500 dark:text-slate-400">
          <div className="min-w-0">
            <div>Total Revenue / Gross Inflow</div>
            {isMultiCurrency && (
              <div className="mt-0.5 text-[11px] font-semibold text-amber-700 dark:text-amber-400">
                Unconverted Multi-Currency Face Value ({displayCurrencyCodes.join(' · ')})
              </div>
            )}
          </div>
          <Coins className="h-4 w-4 text-blue-600 dark:text-sky-400 shrink-0 mt-0.5" />
        </div>
        <div
          className={`mt-2 font-mono font-semibold tabular-nums text-slate-900 dark:text-white ${
            isBoardMode ? 'text-3xl tracking-tight' : 'text-2xl'
          }`}
        >
          {formatExecutiveCurrency(executiveKpis.grossInflow, executiveKpis.currencies)}
        </div>
        <div className="mt-1.5 flex flex-wrap items-center gap-x-2 text-xs text-slate-500 dark:text-slate-400 tabular-nums">
          <span>
            Net Variance / Inflow{isMultiCurrency ? ' (Unconverted)' : ''}:{' '}
            <strong className="font-mono font-semibold text-slate-700 dark:text-slate-200">
              {formatExecutiveCurrency(executiveKpis.netVarianceInflow, executiveKpis.currencies)}
            </strong>
          </span>
          {executiveKpis.currencies.length === 1 && (
            <>
              <span aria-hidden="true">·</span>
              <span className="font-mono text-[11px]">{executiveKpis.currencies[0]}</span>
            </>
          )}
        </div>
        {executiveKpis.currencyBreakdown.length > 1 && (
          <div className="mt-2.5 rounded-lg border border-slate-200/90 dark:border-slate-700/80 bg-slate-50 dark:bg-slate-800/80 px-3 py-2">
            <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
              Isolated Currency Subtotals (No Cross-FX Mixing)
            </div>
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
              {executiveKpis.currencyBreakdown.map((c) => (
                <span
                  key={c.code}
                  className="inline-flex items-center rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-2 py-0.5 font-mono text-[11px] font-semibold text-slate-800 dark:text-slate-100 tabular-nums"
                >
                  {formatCurrencyWithCode(c.total, c.code)}
                </span>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* KPI 2: Identified Leakage / Anomaly Value */}
      <div
        className={`rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 ${
          isBoardMode ? 'p-6 dark:border-slate-700/80 dark:bg-slate-900/95' : 'p-4'
        }`}
      >
        <div className="flex items-center justify-between gap-2 text-xs font-medium text-slate-500 dark:text-slate-400">
          <span>Identified Leakage / Anomaly Value</span>
          <AlertOctagon
            className={`h-4 w-4 shrink-0 ${
              executiveKpis.leakageValue > 0
                ? 'text-amber-600 dark:text-amber-400'
                : 'text-emerald-600 dark:text-emerald-400'
            }`}
          />
        </div>
        <div
          className={`mt-2 font-mono font-semibold tabular-nums ${
            executiveKpis.leakageValue > 0
              ? 'text-amber-600 dark:text-amber-400'
              : 'text-emerald-600 dark:text-emerald-400'
          } ${isBoardMode ? 'text-3xl tracking-tight' : 'text-2xl'}`}
        >
          {formatExecutiveCurrency(executiveKpis.leakageValue, executiveKpis.currencies)}
        </div>
        <div className="mt-1.5 text-xs text-slate-500 dark:text-slate-400 tabular-nums">
          {executiveKpis.leakageValue > 0
            ? `Recovered from formula repairs & negative balances (${executiveKpis.criticalFinancialCount} critical flags)`
            : 'Zero formula leakage or negative balance exposure detected'}
        </div>
      </div>

      {/* KPI 3: Reconciliation Confidence Score */}
      <div
        className={`rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 ${
          isBoardMode ? 'p-6 dark:border-slate-700/80 dark:bg-slate-900/95' : 'p-4'
        }`}
      >
        <div className="flex items-center justify-between gap-2 text-xs font-medium text-slate-500 dark:text-slate-400">
          <span>Reconciliation Confidence Score</span>
          <ShieldCheck className="h-4 w-4 text-emerald-600 dark:text-emerald-400 shrink-0" />
        </div>
        <div
          className={`mt-2 font-mono font-semibold tabular-nums text-emerald-600 dark:text-emerald-400 ${
            isBoardMode ? 'text-3xl tracking-tight' : 'text-2xl'
          }`}
        >
          {executiveKpis.confidenceScore.toFixed(1)}% Cleaned
        </div>
        <div className="mt-1.5 text-xs text-slate-500 dark:text-slate-400 tabular-nums">
          Checksum {executiveKpis.rowsIngested}/{executiveKpis.rowsCleaned} rows ·{' '}
          {executiveKpis.rowChecksumMatch ? 'Verified Match' : 'Variance Flagged'}
        </div>
      </div>
    </div>
  ) : (
    /* Non-Financial Dataset Adaptive KPI Strip (No Gross Inflow, Leakage, or Monetary Metrics) */
    <div className="grid grid-cols-1 md:grid-cols-3 gap-3.5">
      <div
        className={`rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 ${
          isBoardMode ? 'p-6 dark:border-slate-700/80 dark:bg-slate-900/95' : 'p-4'
        }`}
      >
        <div className="flex items-center justify-between gap-2 text-xs font-medium text-slate-500 dark:text-slate-400">
          <span>Total Records Ingested</span>
          <Database className="h-4 w-4 text-blue-600 dark:text-sky-400 shrink-0" />
        </div>
        <div
          className={`mt-2 font-mono font-semibold tabular-nums text-slate-900 dark:text-white ${
            isBoardMode ? 'text-3xl tracking-tight' : 'text-2xl'
          }`}
        >
          {executiveKpis.rowsIngested.toLocaleString('en-US')}
        </div>
        <div className="mt-1.5 text-xs text-slate-500 dark:text-slate-400 tabular-nums">
          {executiveKpis.rowsCleaned.toLocaleString('en-US')} normalized · {job.cleanedHeaders.length} columns
        </div>
      </div>

      <div
        className={`rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 ${
          isBoardMode ? 'p-6 dark:border-slate-700/80 dark:bg-slate-900/95' : 'p-4'
        }`}
      >
        <div className="flex items-center justify-between gap-2 text-xs font-medium text-slate-500 dark:text-slate-400">
          <span>Unique Entities</span>
          <Layers className="h-4 w-4 text-indigo-600 dark:text-indigo-400 shrink-0" />
        </div>
        <div
          className={`mt-2 font-mono font-semibold tabular-nums text-slate-900 dark:text-white ${
            isBoardMode ? 'text-3xl tracking-tight' : 'text-2xl'
          }`}
        >
          {executiveKpis.uniqueEntitiesCount.toLocaleString('en-US')}
        </div>
        <div className="mt-1.5 text-xs text-slate-500 dark:text-slate-400 truncate">
          Distinct records in{' '}
          <span className="font-mono text-slate-700 dark:text-slate-300">
            {executiveKpis.uniqueEntityCol || effectiveCategory || 'primary field'}
          </span>
        </div>
      </div>

      <div
        className={`rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 ${
          isBoardMode ? 'p-6 dark:border-slate-700/80 dark:bg-slate-900/95' : 'p-4'
        }`}
      >
        <div className="flex items-center justify-between gap-2 text-xs font-medium text-slate-500 dark:text-slate-400">
          <span>Reconciliation Confidence Score</span>
          <ShieldCheck className="h-4 w-4 text-emerald-600 dark:text-emerald-400 shrink-0" />
        </div>
        <div
          className={`mt-2 font-mono font-semibold tabular-nums text-emerald-600 dark:text-emerald-400 ${
            isBoardMode ? 'text-3xl tracking-tight' : 'text-2xl'
          }`}
        >
          {executiveKpis.confidenceScore.toFixed(1)}% Cleaned
        </div>
        <div className="mt-1.5 text-xs text-slate-500 dark:text-slate-400 tabular-nums">
          Checksum {executiveKpis.rowsIngested}/{executiveKpis.rowsCleaned} rows ·{' '}
          {executiveKpis.rowChecksumMatch ? 'Verified Match' : 'Variance Flagged'}
        </div>
      </div>
    </div>
  );

  const effectiveChartType: ChartViewType =
    chartType === 'trend' && detectedSchema.dateCols.length === 0 ? 'bar' : chartType;

  const chartPanel = (
    <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900">
      {/* Header & Controls */}
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 border-b border-slate-200 dark:border-slate-800 px-5 py-4">
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-1 rounded-lg bg-slate-100 dark:bg-slate-800 p-1">
            {(
              [
                { id: 'bar', label: 'Bar Chart', icon: BarChart3 },
                { id: 'donut', label: 'Pie / Donut', icon: PieChart },
                { id: 'anomalies', label: 'Anomaly Distribution', icon: ShieldAlert },
                ...(detectedSchema.dateCols.length > 0
                  ? [{ id: 'trend' as const, label: 'Trend / Line', icon: TrendingUp }]
                  : []),
              ] as const
            ).map((tab) => {
              const Icon = tab.icon;
              const active = effectiveChartType === tab.id;
              return (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => {
                    setChartType(tab.id);
                    setHoveredIndex(null);
                  }}
                  className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                    active
                      ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 shadow-xs'
                      : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100'
                  }`}
                >
                  <Icon className="h-3.5 w-3.5 shrink-0" />
                  <span>{tab.label}</span>
                </button>
              );
            })}
          </div>
        </div>

        {/* Dynamic Column, Aggregation & Board Presentation Controls */}
        <div className="flex flex-wrap items-center gap-2.5 text-xs">
          {effectiveChartType !== 'anomalies' && (
            <>
              {(effectiveChartType === 'bar' || effectiveChartType === 'donut') &&
                detectedSchema.categoricalCols.length > 0 && (
                  <label className="flex items-center gap-1.5 text-slate-500 dark:text-slate-400">
                    <span className="whitespace-nowrap">Group by</span>
                    <select
                      value={effectiveCategory}
                      onChange={(e) => {
                        setSelectedCategory(e.target.value);
                        setHoveredIndex(null);
                      }}
                      className="h-8 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 px-2.5 text-xs font-medium text-slate-900 dark:text-slate-100 focus:border-blue-600 focus:outline-none"
                    >
                      {detectedSchema.categoricalCols.map((col) => (
                        <option key={col} value={col}>
                          {col}
                        </option>
                      ))}
                    </select>
                  </label>
                )}

              {detectedSchema.numericCols.length > 0 && (
                <label className="flex items-center gap-1.5 text-slate-500 dark:text-slate-400">
                  <span className="whitespace-nowrap">Metric</span>
                  <select
                    value={effectiveNumeric}
                    onChange={(e) => {
                      setSelectedNumeric(e.target.value);
                      setHoveredIndex(null);
                    }}
                    className="h-8 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 px-2.5 text-xs font-medium text-slate-900 dark:text-slate-100 focus:border-blue-600 focus:outline-none"
                  >
                    {detectedSchema.numericCols.map((col) => (
                      <option key={col.header} value={col.header}>
                        {col.header}
                      </option>
                    ))}
                  </select>
                </label>
              )}

              {detectedSchema.numericCols.length > 0 && (
                <div className="flex items-center gap-0.5 rounded-lg bg-slate-100 dark:bg-slate-800 p-0.5">
                  {(
                    [
                      { id: 'sum' as const, label: 'Sum' },
                      { id: 'avg' as const, label: 'Avg' },
                      { id: 'count' as const, label: 'Count' },
                    ] as const
                  ).map((m) => (
                    <button
                      key={m.id}
                      type="button"
                      onClick={() => {
                        setAggregation(m.id);
                        setHoveredIndex(null);
                      }}
                      className={`rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors whitespace-nowrap shrink-0 ${
                        effectiveAggregation === m.id
                          ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 shadow-xs'
                          : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100'
                      }`}
                    >
                      {m.label}
                    </button>
                  ))}
                </div>
              )}
            </>
          )}

          {!isBoardMode && (
            <button
              type="button"
              onClick={() => setIsBoardMode(true)}
              className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors whitespace-nowrap shrink-0"
            >
              <Presentation className="h-3.5 w-3.5 text-blue-600 dark:text-blue-400 shrink-0" />
              <span>Board Presentation</span>
            </button>
          )}
        </div>
      </div>

      {/* Chart Canvas Area */}
      <div className={isBoardMode ? 'p-7' : 'p-5'}>
        {/* 1. BAR CHART */}
        {effectiveChartType === 'bar' && (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-500 dark:text-slate-400">
              <span>
                Showing{' '}
                <span className="font-semibold text-slate-900 dark:text-slate-100">
                  {effectiveAggregation === 'count'
                    ? 'Row Frequency'
                    : `${effectiveAggregation === 'avg' ? 'Average' : 'Total'} ${effectiveNumeric}`}
                </span>{' '}
                grouped by{' '}
                <span className="font-mono text-slate-800 dark:text-slate-200">
                  {effectiveCategory || 'group'}
                </span>
                {isCurrencyMetric && isMultiCurrency && (
                  <span className="ml-2 text-[11px] font-medium text-amber-700 dark:text-amber-400">
                    · Unconverted Multi-Currency Face Value ({displayCurrencyCodes.join(' · ')})
                  </span>
                )}
              </span>
              {hoveredIndex !== null && groupedData[hoveredIndex] && (
                <span className="font-mono tabular-nums text-slate-900 dark:text-slate-100">
                  {groupedData[hoveredIndex].label} ·{' '}
                  {formatMetricValue(
                    groupedData[hoveredIndex].value,
                    isCurrencyMetric,
                    effectiveAggregation,
                    executiveKpis.currencies
                  )}{' '}
                  ({groupedData[hoveredIndex].count} rows)
                </span>
              )}
            </div>

            {groupedData.length === 0 ? (
              <div className="py-12 text-center text-xs text-slate-500 dark:text-slate-400">
                No categorical values available to chart in this dataset.
              </div>
            ) : (
              <div className="space-y-2.5">
                {groupedData.map((item, idx) => {
                  const pct = Math.max(
                    2,
                    Math.round((Math.abs(item.value) / maxBarValue) * 100)
                  );
                  const isHovered = hoveredIndex === idx;
                  const share =
                    totalGroupedValue > 0
                      ? ((Math.max(0, item.value) / totalGroupedValue) * 100).toFixed(1)
                      : '0.0';

                  return (
                    <div
                      key={item.label}
                      onMouseEnter={() => setHoveredIndex(idx)}
                      onMouseLeave={() => setHoveredIndex(null)}
                      className={`group grid grid-cols-12 items-center gap-3 rounded-lg px-2.5 py-1.5 transition-colors ${
                        isHovered
                          ? 'bg-slate-50 dark:bg-slate-800/70'
                          : 'hover:bg-slate-50/70 dark:hover:bg-slate-800/40'
                      }`}
                    >
                      <div
                        className={`col-span-4 sm:col-span-3 truncate font-medium text-slate-700 dark:text-slate-100 ${
                          isBoardMode ? 'text-sm' : 'text-xs'
                        }`}
                        title={item.label}
                      >
                        {item.label}
                      </div>

                      <div
                        className={`col-span-5 sm:col-span-6 rounded-md bg-slate-100 dark:bg-slate-800 overflow-hidden flex items-center ${
                          isBoardMode ? 'h-7' : 'h-5'
                        }`}
                      >
                        <div
                          className="h-full rounded-md transition-all duration-300"
                          style={{
                            width: `${pct}%`,
                            backgroundColor: item.color,
                            opacity: hoveredIndex !== null && !isHovered ? 0.45 : 1,
                          }}
                        />
                      </div>

                      <div
                        className={`col-span-3 text-right font-mono tabular-nums text-slate-900 dark:text-white whitespace-nowrap ${
                          isBoardMode ? 'text-sm font-semibold' : 'text-xs'
                        }`}
                      >
                        {formatMetricValue(
                          item.value,
                          isCurrencyMetric,
                          effectiveAggregation,
                          executiveKpis.currencies
                        )}
                        <span className="hidden sm:inline text-[11px] text-slate-400 dark:text-slate-400 ml-1.5 font-normal">
                          ({share}%)
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* 2. PIE / DONUT CHART */}
        {effectiveChartType === 'donut' && (
          <div className="grid grid-cols-1 md:grid-cols-12 items-center gap-6">
            <div className="md:col-span-5 flex flex-col items-center justify-center relative">
              {groupedData.length === 0 || totalGroupedValue <= 0 ? (
                <div className="py-16 text-center text-xs text-slate-500 dark:text-slate-400">
                  No positive numeric or count values to display.
                </div>
              ) : (
                <div className={`relative ${isBoardMode ? 'w-72 h-72' : 'w-56 h-56'}`}>
                  <svg
                    viewBox="0 0 220 220"
                    className="w-full h-full overflow-visible"
                    role="img"
                    aria-label={`Donut distribution by ${effectiveCategory}`}
                  >
                    {(() => {
                      let angleCursor = 0;
                      return groupedData.map((slice, idx) => {
                        const positiveVal = Math.max(0, slice.value);
                        if (positiveVal === 0) return null;
                        const sliceAngle = (positiveVal / totalGroupedValue) * 360;
                        const startAngle = angleCursor;
                        const endAngle = angleCursor + sliceAngle;
                        angleCursor = endAngle;
                        const isHovered = hoveredIndex === idx;
                        const path = describeDonutArc(
                          110,
                          110,
                          isHovered ? 96 : 90,
                          58,
                          startAngle,
                          endAngle - (groupedData.length > 1 ? 1.5 : 0)
                        );
                        return (
                          <path
                            key={slice.label}
                            d={path}
                            fill={slice.color}
                            opacity={hoveredIndex !== null && !isHovered ? 0.45 : 1}
                            className="transition-all duration-200 cursor-pointer"
                            onMouseEnter={() => setHoveredIndex(idx)}
                            onMouseLeave={() => setHoveredIndex(null)}
                          />
                        );
                      });
                    })()}
                  </svg>

                  {/* Center Readout */}
                  <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center text-center px-6">
                    <span
                      className={`font-medium text-slate-500 dark:text-slate-300 truncate max-w-[120px] ${
                        isBoardMode ? 'text-xs' : 'text-[11px]'
                      }`}
                    >
                      {hoveredIndex !== null && groupedData[hoveredIndex]
                        ? groupedData[hoveredIndex].label
                        : 'Total'}
                    </span>
                    <span
                      className={`font-mono font-bold tabular-nums text-slate-900 dark:text-white ${
                        isBoardMode ? 'text-lg' : 'text-sm'
                      }`}
                    >
                      {hoveredIndex !== null && groupedData[hoveredIndex]
                        ? formatMetricValue(
                            groupedData[hoveredIndex].value,
                            isCurrencyMetric,
                            effectiveAggregation,
                            executiveKpis.currencies
                          )
                        : formatMetricValue(
                            totalGroupedValue,
                            isCurrencyMetric,
                            effectiveAggregation,
                            executiveKpis.currencies
                          )}
                    </span>
                  </div>
                </div>
              )}
            </div>

            {/* Interactive Legend */}
            <div className="md:col-span-7 divide-y divide-slate-100 dark:divide-slate-800 border border-slate-200 dark:border-slate-700/80 rounded-lg overflow-hidden">
              {groupedData.map((slice, idx) => {
                const share =
                  totalGroupedValue > 0
                    ? ((Math.max(0, slice.value) / totalGroupedValue) * 100).toFixed(1)
                    : '0.0';
                const isHovered = hoveredIndex === idx;
                return (
                  <div
                    key={slice.label}
                    onMouseEnter={() => setHoveredIndex(idx)}
                    onMouseLeave={() => setHoveredIndex(null)}
                    className={`flex items-center justify-between gap-3 transition-colors cursor-default ${
                      isBoardMode ? 'px-4 py-3 text-sm' : 'px-3.5 py-2 text-xs'
                    } ${
                      isHovered
                        ? 'bg-slate-50 dark:bg-slate-800'
                        : 'bg-white dark:bg-slate-900'
                    }`}
                  >
                    <div className="flex items-center gap-2.5 min-w-0">
                      <span
                        className="h-3 w-3 rounded-xs shrink-0"
                        style={{ backgroundColor: slice.color }}
                      />
                      <span className="font-medium text-slate-800 dark:text-slate-100 truncate">
                        {slice.label}
                      </span>
                      <span className="text-[11px] text-slate-400 dark:text-slate-400 tabular-nums shrink-0">
                        ({slice.count} rows)
                      </span>
                    </div>

                    <div className="flex items-center gap-3 font-mono tabular-nums shrink-0">
                      <span className="font-semibold text-slate-900 dark:text-white">
                        {formatMetricValue(
                          slice.value,
                          isCurrencyMetric,
                          effectiveAggregation,
                          executiveKpis.currencies
                        )}
                      </span>
                      <span className="w-12 text-right text-slate-500 dark:text-slate-300">
                        {share}%
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* 3. ANOMALY DISTRIBUTION */}
        {effectiveChartType === 'anomalies' && (
          <div className="grid grid-cols-1 md:grid-cols-12 items-center gap-6">
            <div className="md:col-span-5 flex flex-col items-center justify-center">
              {anomalyStats.total === 0 ? (
                <div className="py-14 text-center text-xs text-emerald-600 dark:text-emerald-400 font-medium">
                  Zero anomalies detected in this dataset.
                </div>
              ) : (
                <div className="relative w-52 h-52">
                  <svg
                    viewBox="0 0 220 220"
                    className="w-full h-full overflow-visible"
                    role="img"
                    aria-label="Anomaly severity breakdown"
                  >
                    {(() => {
                      let angleCursor = 0;
                      return anomalyStats.severities.map((slice, idx) => {
                        const sliceAngle = (slice.value / anomalyStats.total) * 360;
                        const startAngle = angleCursor;
                        const endAngle = angleCursor + sliceAngle;
                        angleCursor = endAngle;
                        const isHovered = hoveredIndex === idx;
                        const path = describeDonutArc(
                          110,
                          110,
                          isHovered ? 96 : 90,
                          58,
                          startAngle,
                          endAngle - (anomalyStats.severities.length > 1 ? 2 : 0)
                        );
                        return (
                          <path
                            key={slice.label}
                            d={path}
                            fill={slice.color}
                            opacity={hoveredIndex !== null && !isHovered ? 0.45 : 1}
                            className="transition-all duration-200 cursor-pointer"
                            onMouseEnter={() => setHoveredIndex(idx)}
                            onMouseLeave={() => setHoveredIndex(null)}
                          />
                        );
                      });
                    })()}
                  </svg>
                  <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center text-center">
                    <span className="text-[11px] font-medium text-slate-500 dark:text-slate-400">
                      {hoveredIndex !== null && anomalyStats.severities[hoveredIndex]
                        ? anomalyStats.severities[hoveredIndex].label.split(' ')[0]
                        : 'Total Findings'}
                    </span>
                    <span className="font-mono text-xl font-bold tabular-nums text-slate-900 dark:text-slate-100">
                      {hoveredIndex !== null && anomalyStats.severities[hoveredIndex]
                        ? anomalyStats.severities[hoveredIndex].value
                        : anomalyStats.total}
                    </span>
                  </div>
                </div>
              )}
            </div>

            <div className="md:col-span-7 space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
                {anomalyStats.severities.map((sev, idx) => {
                  const pct = ((sev.value / Math.max(1, anomalyStats.total)) * 100).toFixed(0);
                  return (
                    <div
                      key={sev.label}
                      onMouseEnter={() => setHoveredIndex(idx)}
                      onMouseLeave={() => setHoveredIndex(null)}
                      className="rounded-lg border border-slate-200 dark:border-slate-800 px-3.5 py-2.5 bg-slate-50/60 dark:bg-slate-950/60"
                    >
                      <div className="flex items-center gap-2 text-xs font-medium text-slate-700 dark:text-slate-200">
                        <span
                          className="h-2.5 w-2.5 rounded-xs shrink-0"
                          style={{ backgroundColor: sev.color }}
                        />
                        <span className="truncate">{sev.label}</span>
                      </div>
                      <div className="mt-1 flex items-baseline justify-between font-mono tabular-nums">
                        <span className="text-lg font-bold text-slate-900 dark:text-slate-100">
                          {sev.value}
                        </span>
                        <span className="text-xs text-slate-500 dark:text-slate-400">
                          {pct}%
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>

              {anomalyStats.categories.length > 0 && (
                <div className="rounded-lg border border-slate-200 dark:border-slate-800 divide-y divide-slate-100 dark:divide-slate-800">
                  {anomalyStats.categories.slice(0, 6).map((cat) => {
                    const barPct = Math.round(
                      (cat.count / Math.max(1, anomalyStats.total)) * 100
                    );
                    const color =
                      cat.severity === 'critical'
                        ? '#DC2626'
                        : cat.severity === 'warning'
                        ? '#D97706'
                        : '#16A34A';
                    return (
                      <div
                        key={cat.category}
                        className="flex items-center justify-between gap-4 px-3.5 py-2 text-xs"
                      >
                        <span className="font-medium text-slate-700 dark:text-slate-200 truncate">
                          {cat.category}
                        </span>
                        <div className="flex items-center gap-3 w-48 shrink-0">
                          <div className="flex-1 h-2 rounded-full bg-slate-100 dark:bg-slate-800 overflow-hidden">
                            <div
                              className="h-full rounded-full"
                              style={{ width: `${barPct}%`, backgroundColor: color }}
                            />
                          </div>
                          <span className="w-8 text-right font-mono tabular-nums text-slate-900 dark:text-slate-100">
                            {cat.count}
                          </span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        )}

        {/* 4. TREND / LINE CHART */}
        {effectiveChartType === 'trend' && (
          <div>
            {!activeDateCol || trendData.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-12 text-center space-y-2">
                <Calendar className="h-7 w-7 text-slate-400" />
                <div className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                  No chronological date series detected
                </div>
                <p className="text-xs text-slate-500 dark:text-slate-400 max-w-md">
                  Trend charts appear automatically when normalized ISO-8601 dates are present in the dataset.
                </p>
              </div>
            ) : (
              <div className="space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-500 dark:text-slate-400">
                  <span>
                    Timeline by{' '}
                    <span className="font-mono text-slate-800 dark:text-slate-200">
                      {activeDateCol}
                    </span>{' '}
                    ·{' '}
                    <span className="font-semibold text-slate-900 dark:text-slate-100">
                      {effectiveAggregation === 'count'
                        ? 'Entries per day'
                        : `${effectiveNumeric} (${effectiveAggregation})`}
                    </span>
                  </span>
                  {hoveredIndex !== null && trendData[hoveredIndex] && (
                    <span className="font-mono tabular-nums text-slate-900 dark:text-slate-100">
                      {trendData[hoveredIndex].date} ·{' '}
                      {formatMetricValue(
                        trendData[hoveredIndex].value,
                        isCurrencyMetric,
                        effectiveAggregation,
                        executiveKpis.currencies
                      )}{' '}
                      ({trendData[hoveredIndex].count} rows)
                    </span>
                  )}
                </div>

                {(() => {
                  const W = 760;
                  const H = 220;
                  const padL = 58;
                  const padR = 20;
                  const padT = 18;
                  const padB = 34;
                  const plotW = W - padL - padR;
                  const plotH = H - padT - padB;

                  const values = trendData.map((p) => p.value);
                  const minVal = Math.min(0, ...values);
                  const maxVal = Math.max(...values, 1);
                  const span = maxVal - minVal || 1;

                  const coords = trendData.map((pt, i) => {
                    const x =
                      trendData.length === 1
                        ? padL + plotW / 2
                        : padL + (i / (trendData.length - 1)) * plotW;
                    const y = padT + plotH - ((pt.value - minVal) / span) * plotH;
                    return { ...pt, x, y };
                  });

                  const linePath = coords
                    .map((c, idx) => `${idx === 0 ? 'M' : 'L'} ${c.x} ${c.y}`)
                    .join(' ');
                  const areaPath = `${linePath} L ${coords[coords.length - 1].x} ${
                    padT + plotH
                  } L ${coords[0].x} ${padT + plotH} Z`;

                  const ticks = [0, 0.5, 1].map((t) => ({
                    val: minVal + t * span,
                    y: padT + plotH - t * plotH,
                  }));

                  return (
                    <div className="w-full overflow-x-auto">
                      <svg
                        viewBox={`0 0 ${W} ${H}`}
                        className={`w-full min-w-[520px] ${isBoardMode ? 'h-80' : 'h-56'}`}
                        role="img"
                        aria-label="Chronological trend line chart"
                      >
                        <defs>
                          <linearGradient id="docucleanseTrendFill" x1="0" y1="0" x2="0" y2="1">
                            <stop
                              offset="0%"
                              stopColor={isBoardMode ? '#38BDF8' : '#2563EB'}
                              stopOpacity={isBoardMode ? '0.32' : '0.22'}
                            />
                            <stop
                              offset="100%"
                              stopColor={isBoardMode ? '#38BDF8' : '#2563EB'}
                              stopOpacity="0.01"
                            />
                          </linearGradient>
                        </defs>

                        {/* Horizontal Gridlines & Y Ticks */}
                        {ticks.map((tk, idx) => (
                          <g key={idx}>
                            <line
                              x1={padL}
                              x2={W - padR}
                              y1={tk.y}
                              y2={tk.y}
                              stroke="currentColor"
                              className="text-slate-200 dark:text-slate-700/80"
                              strokeDasharray="3 3"
                            />
                            <text
                              x={padL - 8}
                              y={tk.y + 4}
                              textAnchor="end"
                              className="fill-slate-500 dark:fill-slate-300 text-[10px] font-mono"
                            >
                              {formatMetricValue(
                                tk.val,
                                isCurrencyMetric,
                                effectiveAggregation,
                                executiveKpis.currencies
                              )}
                            </text>
                          </g>
                        ))}

                        {/* Area + Line */}
                        {coords.length > 1 && (
                          <path d={areaPath} fill="url(#docucleanseTrendFill)" />
                        )}
                        <path
                          d={linePath}
                          fill="none"
                          stroke={isBoardMode ? '#38BDF8' : '#2563EB'}
                          strokeWidth={isBoardMode ? '2.75' : '2.25'}
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />

                        {/* Interactive Nodes & X Labels */}
                        {coords.map((pt, idx) => {
                          const isHovered = hoveredIndex === idx;
                          const showLabel =
                            coords.length <= 8 ||
                            idx === 0 ||
                            idx === coords.length - 1 ||
                            idx % Math.ceil(coords.length / 6) === 0;

                          return (
                            <g
                              key={pt.date}
                              className="cursor-pointer"
                              onMouseEnter={() => setHoveredIndex(idx)}
                              onMouseLeave={() => setHoveredIndex(null)}
                            >
                              <circle
                                cx={pt.x}
                                cy={pt.y}
                                r={isHovered ? 6.5 : 4.25}
                                className={`fill-white dark:fill-slate-950 transition-all duration-150 ${
                                  isBoardMode ? 'stroke-sky-400' : 'stroke-blue-600'
                                }`}
                                strokeWidth={isHovered ? 3 : 2}
                              />
                              <circle cx={pt.x} cy={pt.y} r={14} fill="transparent" />
                              {showLabel && (
                                <text
                                  x={pt.x}
                                  y={H - 10}
                                  textAnchor="middle"
                                  className="fill-slate-500 dark:fill-slate-300 text-[10px] font-mono"
                                >
                                  {pt.date.slice(5)}
                                </text>
                              )}
                            </g>
                          );
                        })}
                      </svg>
                    </div>
                  );
                })()}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );

  if (isBoardMode) {
    return (
      <div
        className="fixed inset-0 z-50 dark bg-slate-950 text-slate-100 overflow-y-auto"
        role="dialog"
        aria-modal="true"
        aria-label="Board Presentation Mode"
      >
        <div className="mx-auto w-full max-w-[1600px] px-5 sm:px-10 py-7 space-y-6">
          {/* High-Contrast Dark-Mode Executive Board Masthead */}
          <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-slate-800 pb-5">
            <div className="space-y-1.5 min-w-0">
              <div className="flex flex-wrap items-center gap-2 text-xs text-slate-400">
                <Presentation className="h-4 w-4 text-sky-400 shrink-0" />
                <span className="font-semibold uppercase tracking-wider text-sky-400">
                  Executive Board Presentation
                </span>
                <span aria-hidden="true">·</span>
                <span className="font-medium text-slate-300">Rafi Digital Studio</span>
                <span aria-hidden="true">·</span>
                <span className="font-mono tabular-nums text-slate-400">
                  {executiveKpis.timestampUtc}
                </span>
              </div>
              <h2 className="text-2xl font-bold tracking-tight text-white truncate">
                {job.fileName}
              </h2>
            </div>

            <div className="flex flex-wrap items-center gap-3 shrink-0">
              <span className="hidden lg:inline font-mono text-xs text-slate-400 tabular-nums">
                SHA-256: {executiveKpis.fileHashPreview}
              </span>
              <button
                type="button"
                onClick={() => setIsBoardMode(false)}
                className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-900 px-3.5 text-xs font-semibold text-slate-100 hover:bg-slate-800 transition-colors whitespace-nowrap shrink-0"
              >
                <Minimize2 className="h-3.5 w-3.5 shrink-0" />
                <span>Exit Presentation (Esc)</span>
              </button>
            </div>
          </div>

          {/* Enlarged High-Contrast Executive KPI Cards */}
          {executiveKpiStrip}

          {/* Full-Width High-Contrast Dark Interactive Chart Panel */}
          {chartPanel}

          {/* Bottom Pre-Audit Variance & Zero-Retention Attestation Strip */}
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-800 bg-slate-900/95 px-5 py-4 text-xs text-slate-300">
            {executiveKpis.hasFinancialColumn ? (
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 font-mono tabular-nums">
                {isMultiCurrency && (
                  <>
                    <span className="font-sans text-[11px] font-semibold text-amber-400">
                      Unconverted Face Value ({displayCurrencyCodes.join(' · ')})
                    </span>
                    <span className="text-slate-600" aria-hidden="true">
                      ·
                    </span>
                  </>
                )}
                <span>
                  Input Sum:{' '}
                  <strong className="text-white">
                    {formatExecutiveCurrency(executiveKpis.inputSum, executiveKpis.currencies)}
                  </strong>
                </span>
                <span className="text-slate-600" aria-hidden="true">
                  ·
                </span>
                <span>
                  Reconciled Output:{' '}
                  <strong className="text-white">
                    {formatExecutiveCurrency(executiveKpis.outputSum, executiveKpis.currencies)}
                  </strong>
                </span>
                <span className="text-slate-600" aria-hidden="true">
                  ·
                </span>
                <span>
                  Variance:{' '}
                  <strong className="text-sky-400">
                    {executiveKpis.reconciledVariance >= 0 ? '+' : ''}
                    {formatExecutiveCurrency(
                      executiveKpis.reconciledVariance,
                      executiveKpis.currencies
                    )}
                  </strong>
                </span>
              </div>
            ) : (
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 font-mono tabular-nums">
                <span>
                  Records Verified:{' '}
                  <strong className="text-white">
                    {executiveKpis.rowsCleaned}/{executiveKpis.rowsIngested}
                  </strong>
                </span>
                <span className="text-slate-600" aria-hidden="true">
                  ·
                </span>
                <span>
                  Unique Entities:{' '}
                  <strong className="text-white">
                    {executiveKpis.uniqueEntitiesCount.toLocaleString('en-US')}
                  </strong>
                </span>
                <span className="text-slate-600" aria-hidden="true">
                  ·
                </span>
                <span className="text-slate-400">
                  Non-Financial Dataset · Categorical Analytics
                </span>
              </div>
            )}
            <span className="text-slate-400">
              Ephemeral RAM Processing · Pre-Audit Ready · Rafi Digital Studio
            </span>
          </div>
        </div>
      </div>
    );
  }

  return (
    <section className="space-y-4">
      {executiveKpiStrip}
      {chartPanel}
    </section>
  );
}
