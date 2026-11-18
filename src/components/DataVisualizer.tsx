import { useEffect, useMemo, useState } from 'react';
import {
  BarChart3,
  Calendar,
  PieChart,
  ShieldAlert,
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

function parseNumericValue(raw: string | undefined): number | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.startsWith('[ERROR') || trimmed === '[MISSING]') {
    return null;
  }
  const cleaned = trimmed.replace(/[$,€£¥\s]/g, '');
  if (!/^-?\d+(\.\d+)?$/.test(cleaned)) return null;
  const num = Number(cleaned);
  return Number.isFinite(num) ? num : null;
}

function formatMetricValue(val: number, isCurrency: boolean, mode: AggregationMode): string {
  if (mode === 'count') {
    return Math.round(val).toLocaleString('en-US');
  }
  if (isCurrency) {
    return val.toLocaleString('en-US', {
      style: 'currency',
      currency: 'USD',
      maximumFractionDigits: Math.abs(val) >= 1000 ? 0 : 2,
    });
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

  // Automatic schema & metric column detection
  const detectedSchema = useMemo(() => {
    const numericCols: Array<{ header: string; isCurrency: boolean }> = [];
    const dateCols: string[] = [];
    const categoricalCols: Array<{ header: string; score: number }> = [];

    const mappingLookup = new Map(
      job.schemaMappings.map((m) => [m.normalizedHeader, m.detectedType])
    );

    for (const header of job.cleanedHeaders) {
      const mappedType = mappingLookup.get(header);
      const lower = header.toLowerCase();
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
      const isCurrencyName = /amount|amt|total|price|cost|mrr|revenue|fee|tax|balance|spend|budget/.test(
        lower
      );
      if (
        mappedType === 'currency' ||
        mappedType === 'number' ||
        isCurrencyName ||
        (nonEmpty.length > 0 && numericMatches / nonEmpty.length >= 0.65)
      ) {
        numericCols.push({
          header,
          isCurrency: mappedType === 'currency' || isCurrencyName,
        });
        continue;
      }

      // 3. Categorical column scoring (exclude phones/emails/long notes)
      if (mappedType === 'phone' || mappedType === 'email' || /phone|email|note|id$/.test(lower)) {
        continue;
      }

      const distinct = new Set(nonEmpty).size;
      if (distinct >= 1) {
        let score = 1;
        if (/category|cat|department|dept|status|stat|type|method|currency/.test(lower)) {
          score += 5;
        } else if (/vendor|merchant|payee|client|company/.test(lower)) {
          score += 3;
        }
        // Prefer columns with clean grouping cardinality
        if (distinct >= 2 && distinct <= 12) {
          score += 3;
        }
        categoricalCols.push({ header, score });
      }
    }

    categoricalCols.sort((a, b) => b.score - a.score);

    // Fallback: if no categorical columns scored, include any non-numeric header
    const fallbackCategories =
      categoricalCols.length > 0
        ? categoricalCols.map((c) => c.header)
        : job.cleanedHeaders.filter(
            (h) => !numericCols.some((n) => n.header === h) && !dateCols.includes(h)
          );

    return {
      numericCols,
      dateCols,
      categoricalCols:
        fallbackCategories.length > 0 ? fallbackCategories : job.cleanedHeaders,
    };
  }, [job]);

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

  const activeNumericMeta = useMemo(
    () => detectedSchema.numericCols.find((n) => n.header === selectedNumeric),
    [detectedSchema.numericCols, selectedNumeric]
  );

  const effectiveAggregation: AggregationMode =
    !selectedNumeric || aggregation === 'count' ? 'count' : aggregation;
  const isCurrencyMetric =
    effectiveAggregation !== 'count' && Boolean(activeNumericMeta?.isCurrency);

  // Grouped categorical data for Bar & Donut charts
  const groupedData = useMemo<AggregatedDatum[]>(() => {
    if (!selectedCategory) return [];

    const buckets = new Map<string, { sum: number; count: number }>();
    for (const row of job.cleanedRows) {
      const rawGroup = String(row[selectedCategory] ?? '').trim();
      const label =
        !rawGroup || rawGroup === '[MISSING]' ? 'Unspecified' : rawGroup;

      const entry = buckets.get(label) || { sum: 0, count: 0 };
      entry.count += 1;

      if (effectiveAggregation !== 'count' && selectedNumeric) {
        const num = parseNumericValue(row[selectedNumeric]);
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
  }, [job.cleanedRows, selectedCategory, selectedNumeric, effectiveAggregation]);

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
      if (effectiveAggregation !== 'count' && selectedNumeric) {
        const num = parseNumericValue(row[selectedNumeric]);
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
  }, [activeDateCol, job.cleanedRows, effectiveAggregation, selectedNumeric]);

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

  return (
    <section className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900">
      {/* Header & Controls */}
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 border-b border-slate-200 dark:border-slate-800 px-5 py-4">
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-1 rounded-lg bg-slate-100 dark:bg-slate-800 p-1">
            {(
              [
                { id: 'bar', label: 'Bar Chart', icon: BarChart3 },
                { id: 'donut', label: 'Pie / Donut', icon: PieChart },
                { id: 'anomalies', label: 'Anomaly Distribution', icon: ShieldAlert },
                { id: 'trend', label: 'Trend / Line', icon: TrendingUp },
              ] as const
            ).map((tab) => {
              const Icon = tab.icon;
              const active = chartType === tab.id;
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

        {/* Dynamic Column & Aggregation Controls */}
        {chartType !== 'anomalies' && (
          <div className="flex flex-wrap items-center gap-2.5 text-xs">
            {(chartType === 'bar' || chartType === 'donut') &&
              detectedSchema.categoricalCols.length > 0 && (
                <label className="flex items-center gap-1.5 text-slate-500 dark:text-slate-400">
                  <span className="whitespace-nowrap">Group by</span>
                  <select
                    value={selectedCategory}
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
                  value={selectedNumeric}
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

            <div className="flex items-center gap-0.5 rounded-lg bg-slate-100 dark:bg-slate-800 p-0.5">
              {(
                [
                  ...(detectedSchema.numericCols.length > 0
                    ? [
                        { id: 'sum' as const, label: 'Sum' },
                        { id: 'avg' as const, label: 'Avg' },
                      ]
                    : []),
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
          </div>
        )}
      </div>

      {/* Chart Canvas Area */}
      <div className="p-5">
        {/* 1. BAR CHART */}
        {chartType === 'bar' && (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-500 dark:text-slate-400">
              <span>
                Showing{' '}
                <span className="font-semibold text-slate-900 dark:text-slate-100">
                  {effectiveAggregation === 'count'
                    ? 'Row Frequency'
                    : `${effectiveAggregation === 'avg' ? 'Average' : 'Total'} ${selectedNumeric}`}
                </span>{' '}
                grouped by{' '}
                <span className="font-mono text-slate-800 dark:text-slate-200">
                  {selectedCategory || 'group'}
                </span>
              </span>
              {hoveredIndex !== null && groupedData[hoveredIndex] && (
                <span className="font-mono tabular-nums text-slate-900 dark:text-slate-100">
                  {groupedData[hoveredIndex].label} ·{' '}
                  {formatMetricValue(
                    groupedData[hoveredIndex].value,
                    isCurrencyMetric,
                    effectiveAggregation
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
                        className="col-span-4 sm:col-span-3 truncate text-xs font-medium text-slate-700 dark:text-slate-200"
                        title={item.label}
                      >
                        {item.label}
                      </div>

                      <div className="col-span-5 sm:col-span-6 h-5 rounded-md bg-slate-100 dark:bg-slate-800 overflow-hidden flex items-center">
                        <div
                          className="h-full rounded-md transition-all duration-300"
                          style={{
                            width: `${pct}%`,
                            backgroundColor: item.color,
                            opacity: hoveredIndex !== null && !isHovered ? 0.45 : 1,
                          }}
                        />
                      </div>

                      <div className="col-span-3 text-right font-mono text-xs tabular-nums text-slate-900 dark:text-slate-100 whitespace-nowrap">
                        {formatMetricValue(item.value, isCurrencyMetric, effectiveAggregation)}
                        <span className="hidden sm:inline text-[11px] text-slate-400 dark:text-slate-500 ml-1.5">
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
        {chartType === 'donut' && (
          <div className="grid grid-cols-1 md:grid-cols-12 items-center gap-6">
            <div className="md:col-span-5 flex flex-col items-center justify-center relative">
              {groupedData.length === 0 || totalGroupedValue <= 0 ? (
                <div className="py-16 text-center text-xs text-slate-500 dark:text-slate-400">
                  No positive numeric or count values to display.
                </div>
              ) : (
                <div className="relative w-56 h-56">
                  <svg
                    viewBox="0 0 220 220"
                    className="w-full h-full overflow-visible"
                    role="img"
                    aria-label={`Donut distribution by ${selectedCategory}`}
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
                    <span className="text-[11px] font-medium text-slate-500 dark:text-slate-400 truncate max-w-[100px]">
                      {hoveredIndex !== null && groupedData[hoveredIndex]
                        ? groupedData[hoveredIndex].label
                        : 'Total'}
                    </span>
                    <span className="font-mono text-sm font-bold tabular-nums text-slate-900 dark:text-slate-100">
                      {hoveredIndex !== null && groupedData[hoveredIndex]
                        ? formatMetricValue(
                            groupedData[hoveredIndex].value,
                            isCurrencyMetric,
                            effectiveAggregation
                          )
                        : formatMetricValue(
                            totalGroupedValue,
                            isCurrencyMetric,
                            effectiveAggregation
                          )}
                    </span>
                  </div>
                </div>
              )}
            </div>

            {/* Interactive Legend */}
            <div className="md:col-span-7 divide-y divide-slate-100 dark:divide-slate-800 border border-slate-200 dark:border-slate-800 rounded-lg overflow-hidden">
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
                    className={`flex items-center justify-between gap-3 px-3.5 py-2 text-xs transition-colors cursor-default ${
                      isHovered
                        ? 'bg-slate-50 dark:bg-slate-800/70'
                        : 'bg-white dark:bg-slate-900'
                    }`}
                  >
                    <div className="flex items-center gap-2.5 min-w-0">
                      <span
                        className="h-2.5 w-2.5 rounded-xs shrink-0"
                        style={{ backgroundColor: slice.color }}
                      />
                      <span className="font-medium text-slate-800 dark:text-slate-200 truncate">
                        {slice.label}
                      </span>
                      <span className="text-[11px] text-slate-400 dark:text-slate-500 tabular-nums shrink-0">
                        ({slice.count} rows)
                      </span>
                    </div>

                    <div className="flex items-center gap-3 font-mono tabular-nums shrink-0">
                      <span className="font-semibold text-slate-900 dark:text-slate-100">
                        {formatMetricValue(slice.value, isCurrencyMetric, effectiveAggregation)}
                      </span>
                      <span className="w-12 text-right text-slate-500 dark:text-slate-400">
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
        {chartType === 'anomalies' && (
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
        {chartType === 'trend' && (
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
                        : `${selectedNumeric} (${effectiveAggregation})`}
                    </span>
                  </span>
                  {hoveredIndex !== null && trendData[hoveredIndex] && (
                    <span className="font-mono tabular-nums text-slate-900 dark:text-slate-100">
                      {trendData[hoveredIndex].date} ·{' '}
                      {formatMetricValue(
                        trendData[hoveredIndex].value,
                        isCurrencyMetric,
                        effectiveAggregation
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
                        className="w-full min-w-[520px] h-56"
                        role="img"
                        aria-label="Chronological trend line chart"
                      >
                        <defs>
                          <linearGradient id="docucleanseTrendFill" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="0%" stopColor="#2563EB" stopOpacity="0.22" />
                            <stop offset="100%" stopColor="#2563EB" stopOpacity="0.01" />
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
                              className="text-slate-200 dark:text-slate-800"
                              strokeDasharray="3 3"
                            />
                            <text
                              x={padL - 8}
                              y={tk.y + 4}
                              textAnchor="end"
                              className="fill-slate-400 dark:fill-slate-500 text-[10px] font-mono"
                            >
                              {formatMetricValue(tk.val, isCurrencyMetric, effectiveAggregation)}
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
                          stroke="#2563EB"
                          strokeWidth="2.25"
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
                                r={isHovered ? 6 : 4}
                                className="fill-white dark:fill-slate-900 stroke-blue-600 transition-all duration-150"
                                strokeWidth={isHovered ? 3 : 2}
                              />
                              <circle cx={pt.x} cy={pt.y} r={14} fill="transparent" />
                              {showLabel && (
                                <text
                                  x={pt.x}
                                  y={H - 10}
                                  textAnchor="middle"
                                  className="fill-slate-500 dark:fill-slate-400 text-[10px] font-mono"
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
    </section>
  );
}
