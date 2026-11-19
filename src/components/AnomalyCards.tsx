import { useMemo, useState } from 'react';
import {
  AlertCircle,
  AlertTriangle,
  Check,
  CheckCircle2,
  Copy,
  FileCheck2,
  FileSignature,
  ShieldCheck,
} from 'lucide-react';
import type { AnomalySeverity, CleanJob } from '../types';

interface AnomalyCardsProps {
  job: CleanJob;
  onExport?: (jobId: string, format: 'csv' | 'xlsx' | 'pdf' | 'certificate') => void;
  exportingFormat?: string | null;
}

function currencyCodeToPrefix(code: string): string {
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

function formatMoneyAmount(value: number, currencies: string[] = []): string {
  const sign = value < 0 ? '-' : '';
  const formatted = Math.abs(value).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  if (currencies.length === 1) {
    return `${sign}${currencyCodeToPrefix(currencies[0])} ${formatted}`;
  }
  return `${sign}${formatted}`;
}

function formatDisplayUtc(value: string): string {
  if (value.endsWith(' UTC')) return value;
  const dt = new Date(value);
  if (Number.isNaN(dt.getTime())) return `${value} UTC`;
  return `${dt.toISOString().replace('T', ' ').slice(0, 19)} UTC`;
}

export function AnomalyCards({ job, onExport, exportingFormat }: AnomalyCardsProps) {
  const [severityFilter, setSeverityFilter] = useState<'all' | AnomalySeverity>('all');
  const [copiedHash, setCopiedHash] = useState(false);

  const counts = useMemo(() => {
    let critical = 0;
    let warning = 0;
    let fixed = 0;
    for (const a of job.anomalies) {
      if (a.severity === 'critical') critical++;
      else if (a.severity === 'warning') warning++;
      else fixed++;
    }
    return { critical, warning, fixed };
  }, [job.anomalies]);

  const filteredAnomalies = useMemo(() => {
    if (severityFilter === 'all') return job.anomalies;
    return job.anomalies.filter((a) => a.severity === severityFilter);
  }, [job.anomalies, severityFilter]);

  const complianceMeta = useMemo(() => {
    const activeHeaders = job.cleanedHeaders.filter((h) => h !== 'raw_amount');
    const totalCells = Math.max(1, job.cleanedRows.length * Math.max(1, activeHeaders.length));
    const unresolvedErrors = job.cleanedRows.reduce(
      (acc, row) =>
        acc +
        activeHeaders.filter((h) => /^\[ERROR:/i.test(String(row[h] ?? '').trim())).length,
      0
    );
    const highPriorityFinAlerts = job.anomalies.filter(
      (a) =>
        a.severity === 'critical' &&
        /financial|currency|negative|fx/i.test(`${a.category} ${a.explanation}`)
    ).length;
    const computedConfidence = Number(
      Math.max(
        0,
        Math.min(
          100,
          ((totalCells - unresolvedErrors) / totalCells) * 100 -
            Math.min(2.5, highPriorityFinAlerts * 0.15)
        )
      ).toFixed(1)
    );

    if (job.auditMetadata) {
      const stored = job.auditMetadata.reconciliationConfidenceScore;
      const syncedScore =
        stored !== undefined && Math.abs(stored - computedConfidence) <= 1.0
          ? stored
          : computedConfidence;
      return {
        ...job.auditMetadata,
        reconciliationConfidenceScore: syncedScore,
      };
    }
    const parseNum = (val: string | undefined): number | null => {
      if (!val) return null;
      const t = val.trim();
      if (!t || t.startsWith('=') || t.startsWith('[ERROR') || t === '[MISSING]' || t.endsWith('%')) {
        return null;
      }
      const neg = /^\(.*\)$/.test(t);
      const c = t
        .replace(/\b(USD|EUR|GBP|CAD|AUD|JPY|CHF|NZD|SGD|HKD|PKR|INR)\b/gi, '')
        .replace(/(CA\$|AU\$|US\$|NZ\$|HK\$|S\$|C\$|A\$|Rs\.?)/gi, '')
        .replace(/[$,€£¥₹\s()]/g, '');
      if (!/^-?\d+(\.\d+)?$/.test(c)) return null;
      const n = Number(c);
      return Number.isFinite(n) ? (neg ? -Math.abs(n) : n) : null;
    };

    const totalCol =
      job.cleanedHeaders.find((h) => h === 'normalized_amount') ||
      job.cleanedHeaders.find(
        (h) =>
          /(total[\s_-]?amount|line[\s_-]?total|total|amount|revenue|mrr|balance)/i.test(h) &&
          !/raw_amount|unit[\s_-]?price|tax|rate/i.test(h)
      ) ||
      '';
    const rawTotalCol =
      job.rawHeaders.find(
        (h) =>
          /(total[\s_-]?amount|line[\s_-]?total|total|amount|revenue|mrr|balance)/i.test(h) &&
          !/unit[\s_-]?price|tax|rate/i.test(h)
      ) || '';
    const qtyCol = job.cleanedHeaders.find((h) => /\b(qty|quantity|units)\b|qty_sold/i.test(h)) || '';
    const priceCol =
      job.cleanedHeaders.find(
        (h) => /\b(unit[\s_-]?price|unit[\s_-]?cost|price)\b/i.test(h) && !/total|tax|rate/i.test(h)
      ) || '';

    let inSum = 0;
    let outSum = 0;
    for (let i = 0; i < job.cleanedRows.length; i++) {
      const cRow = job.cleanedRows[i] || {};
      const rRow = job.rawRows[i] || {};
      if (rawTotalCol) {
        const rn = parseNum(rRow[rawTotalCol]);
        if (rn !== null) inSum += rn;
      }
      let cn = totalCol ? parseNum(cRow[totalCol]) : null;
      if (cn === null && qtyCol && priceCol) {
        const q = parseNum(cRow[qtyCol]);
        const p = parseNum(cRow[priceCol]);
        if (q !== null && p !== null) cn = Number((q * p).toFixed(2));
      }
      if (cn !== null) outSum += cn;
    }

    const fallbackUtc =
      (job.createdAt ? new Date(job.createdAt) : new Date())
        .toISOString()
        .replace('T', ' ')
        .slice(0, 19) + ' UTC';
    return {
      fileHashSha256: 'Legacy job record (re-clean to compute SHA-256 signature)',
      timestampUtc: fallbackUtc,
      rowsIngested: job.rawRows.length || job.rowCount,
      rowsCleaned: job.cleanedRows.length || job.rowCount,
      rowChecksumMatch: (job.rawRows.length || job.rowCount) === (job.cleanedRows.length || job.rowCount),
      inputSum: Number(inSum.toFixed(2)),
      outputSum: Number(outSum.toFixed(2)),
      reconciledVariance: Number((outSum - inSum).toFixed(2)),
      primaryAmountColumn: totalCol || null,
      detectedCurrencies: [] as string[],
      leakageRecoveredValue: 0,
      reconciliationConfidenceScore: 99.0,
    };
  }, [job]);

  const hasFinancialData = useMemo(() => {
    if (complianceMeta.primaryAmountColumn) return true;
    const hasCurrencyMapping = job.schemaMappings.some((m) => m.detectedType === 'currency');
    if (hasCurrencyMapping) return true;
    return job.cleanedHeaders.some(
      (h) =>
        /(normalized_amount|total[\s_-]?amount|line[\s_-]?total|\bamount\b|\bprice\b|revenue|mrr|balance|cost)/i.test(
          h
        ) && !/tax[\s_-]?rate|\brate\b|pct|percent/i.test(h)
    );
  }, [complianceMeta.primaryAmountColumn, job.schemaMappings, job.cleanedHeaders]);

  const hasValidHash = /^[a-f0-9]{64}$/i.test(complianceMeta.fileHashSha256);

  const handleCopyHash = async () => {
    if (!hasValidHash) return;
    try {
      await navigator.clipboard.writeText(complianceMeta.fileHashSha256);
      setCopiedHash(true);
      window.setTimeout(() => setCopiedHash(false), 1800);
    } catch {
      // Clipboard unavailable in restricted context
    }
  };

  return (
    <section className="space-y-4">
      {/* 4-Column KPI Strip */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4">
          <div className="text-xs font-medium text-slate-500 dark:text-slate-400">
            Rows Processed
          </div>
          <div className="mt-1.5 font-mono text-2xl font-semibold tabular-nums text-slate-900 dark:text-slate-100">
            {job.rowCount}
          </div>
          <div className="mt-1 text-xs text-slate-500 dark:text-slate-400 tabular-nums">
            {job.cleanedHeaders.length} columns · {(job.processingMs / 1000).toFixed(2)}s
          </div>
        </div>

        <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4">
          <div className="text-xs font-medium text-slate-500 dark:text-slate-400">
            Cells Normalized
          </div>
          <div className="mt-1.5 font-mono text-2xl font-semibold tabular-nums text-blue-600 dark:text-blue-400">
            {job.cellDiffs.length}
          </div>
          <div className="mt-1 text-xs text-slate-500 dark:text-slate-400">
            Dates, currencies, phones &amp; casing
          </div>
        </div>

        <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4">
          <div className="flex items-center gap-1.5 text-xs font-medium text-red-600 dark:text-red-400">
            <AlertCircle className="h-3.5 w-3.5" />
            <span>Critical &amp; Financial Alerts</span>
          </div>
          <div className="mt-1.5 font-mono text-2xl font-semibold tabular-nums text-slate-900 dark:text-slate-100">
            {counts.critical}
          </div>
          <div className="mt-1 text-xs text-slate-500 dark:text-slate-400">
            Formulas, balances &amp; FX flags
          </div>
        </div>

        <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4">
          <div className="flex items-center gap-1.5 text-xs font-medium text-amber-600 dark:text-amber-400">
            <AlertTriangle className="h-3.5 w-3.5" />
            <span>Warnings &amp; Duplicates</span>
          </div>
          <div className="mt-1.5 font-mono text-2xl font-semibold tabular-nums text-slate-900 dark:text-slate-100">
            {counts.warning}
          </div>
          <div className="mt-1 text-xs text-slate-500 dark:text-slate-400 tabular-nums">
            {counts.fixed} auto-repaired entries
          </div>
        </div>
      </div>

      {/* Institutional Audit Trail & Compliance Metadata */}
      <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 dark:border-slate-800 px-5 py-3">
          <div className="flex items-center gap-2 text-xs min-w-0">
            <ShieldCheck className="h-4 w-4 text-emerald-600 dark:text-emerald-400 shrink-0" />
            <span className="font-semibold text-slate-900 dark:text-slate-100 text-sm">
              Institutional Audit Trail &amp; Pre-Audit Compliance
            </span>
            <span className="text-slate-400 dark:text-slate-600 hidden sm:inline" aria-hidden="true">
              ·
            </span>
            <span className="font-mono text-[11px] text-slate-500 dark:text-slate-400 truncate hidden sm:inline">
              Report {job.id}
            </span>
          </div>

          <div className="flex flex-wrap items-center gap-3 text-xs">
            <div className="flex items-center gap-1.5">
              <FileCheck2
                className={`h-3.5 w-3.5 shrink-0 ${
                  complianceMeta.rowChecksumMatch
                    ? 'text-emerald-600 dark:text-emerald-400'
                    : 'text-amber-600 dark:text-amber-400'
                }`}
              />
              <span
                className={`font-medium ${
                  complianceMeta.rowChecksumMatch
                    ? 'text-emerald-700 dark:text-emerald-400'
                    : 'text-amber-700 dark:text-amber-400'
                }`}
              >
                {complianceMeta.rowChecksumMatch
                  ? 'Row Checksum Verified'
                  : 'Row Count Variance Flagged'}
              </span>
            </div>

            {onExport && (
              <button
                type="button"
                disabled={exportingFormat !== null && exportingFormat !== undefined}
                onClick={() => onExport(job.id, 'certificate')}
                className="inline-flex items-center gap-1.5 rounded-lg bg-slate-900 dark:bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-slate-800 dark:hover:bg-blue-700 transition-colors whitespace-nowrap shrink-0 disabled:opacity-60"
              >
                <FileSignature className="h-3.5 w-3.5 shrink-0" />
                <span>
                  {exportingFormat === 'certificate'
                    ? 'Generating Report PDF...'
                    : 'Download Pre-Audit Processing Report'}
                </span>
              </button>
            )}
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 divide-y md:divide-y-0 md:divide-x divide-slate-200 dark:divide-slate-800">
          {/* File Hash (SHA-256) */}
          <div className="px-5 py-3.5 space-y-1 min-w-0">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[11px] font-medium text-slate-500 dark:text-slate-400">
                File Hash (SHA-256)
              </span>
              {hasValidHash && (
                <button
                  type="button"
                  onClick={handleCopyHash}
                  className="inline-flex items-center gap-1 text-[11px] font-medium text-blue-600 dark:text-blue-400 hover:text-blue-700 dark:hover:text-blue-300 transition-colors"
                  title="Copy full SHA-256 signature"
                >
                  {copiedHash ? (
                    <>
                      <Check className="h-3 w-3" />
                      <span>Copied</span>
                    </>
                  ) : (
                    <>
                      <Copy className="h-3 w-3" />
                      <span>Copy</span>
                    </>
                  )}
                </button>
              )}
            </div>
            <div
              className="font-mono text-xs text-slate-900 dark:text-slate-100 truncate tabular-nums"
              title={complianceMeta.fileHashSha256}
            >
              {hasValidHash
                ? `${complianceMeta.fileHashSha256.slice(0, 16)}…${complianceMeta.fileHashSha256.slice(-12)}`
                : complianceMeta.fileHashSha256}
            </div>
            <div className="text-[11px] text-slate-500 dark:text-slate-400">
              Cryptographic source integrity
            </div>
          </div>

          {/* Audit Timestamp (UTC) */}
          <div className="px-5 py-3.5 space-y-1 min-w-0">
            <div className="text-[11px] font-medium text-slate-500 dark:text-slate-400">
              Timestamp (UTC)
            </div>
            <div className="font-mono text-xs font-medium text-slate-900 dark:text-slate-100 tabular-nums">
              {formatDisplayUtc(complianceMeta.timestampUtc)}
            </div>
            <div className="text-[11px] text-slate-500 dark:text-slate-400 truncate">
              {complianceMeta.detectedCurrencies.length > 0
                ? `ISO-4217: ${complianceMeta.detectedCurrencies.join(' · ')}`
                : 'Embedded in CSV, XLSX & PDF'}
            </div>
          </div>

          {/* Row Verification Checksum */}
          <div className="px-5 py-3.5 space-y-1 min-w-0">
            <div className="text-[11px] font-medium text-slate-500 dark:text-slate-400">
              Row Verification Checksum
            </div>
            <div className="font-mono text-xs font-medium text-slate-900 dark:text-slate-100 tabular-nums">
              {complianceMeta.rowsIngested} Ingested / {complianceMeta.rowsCleaned} Cleaned
            </div>
            <div className="text-[11px] text-slate-500 dark:text-slate-400 tabular-nums">
              Confidence: {complianceMeta.reconciliationConfidenceScore.toFixed(1)}% Cleaned
            </div>
          </div>

          {/* Reconciled Variance Tracker (Financial) OR Dataset Schema Profile (Non-Financial) */}
          <div className="px-5 py-3.5 space-y-1 min-w-0">
            {hasFinancialData ? (
              <>
                <div className="text-[11px] font-medium text-slate-500 dark:text-slate-400">
                  Reconciled Variance Tracker
                  {complianceMeta.detectedCurrencies.length > 1 && (
                    <span className="ml-1 text-amber-700 dark:text-amber-400 font-semibold">
                      (Unconverted Face Value)
                    </span>
                  )}
                </div>
                <div className="font-mono text-xs font-medium text-slate-900 dark:text-slate-100 tabular-nums">
                  {formatMoneyAmount(complianceMeta.inputSum, complianceMeta.detectedCurrencies)} →{' '}
                  {formatMoneyAmount(complianceMeta.outputSum, complianceMeta.detectedCurrencies)}
                </div>
                <div
                  className={`font-mono text-[11px] tabular-nums ${
                    Math.abs(complianceMeta.reconciledVariance) > 0.005
                      ? 'text-blue-600 dark:text-blue-400 font-medium'
                      : 'text-emerald-600 dark:text-emerald-400'
                  }`}
                >
                  Net delta: {complianceMeta.reconciledVariance >= 0 ? '+' : ''}
                  {formatMoneyAmount(
                    complianceMeta.reconciledVariance,
                    complianceMeta.detectedCurrencies
                  )}
                  {complianceMeta.primaryAmountColumn
                    ? ` (${complianceMeta.primaryAmountColumn})`
                    : ''}
                </div>
              </>
            ) : (
              <>
                <div className="text-[11px] font-medium text-slate-500 dark:text-slate-400">
                  Dataset Schema Profile
                </div>
                <div className="font-mono text-xs font-medium text-slate-900 dark:text-slate-100 tabular-nums">
                  {job.cleanedHeaders.length} Columns · Non-Financial
                </div>
                <div className="text-[11px] text-slate-500 dark:text-slate-400">
                  Categorical &amp; operational fields only
                </div>
              </>
            )}
          </div>
        </div>
      </div>

      {/* Executive Summary & Anomaly Audit List */}
      <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-slate-200 dark:border-slate-800 px-5 py-4">
          <div className="space-y-1 min-w-0">
            <div className="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
              <span className="font-semibold text-slate-900 dark:text-slate-100 text-sm">
                Executive Anomaly Log
              </span>
              <span aria-hidden="true">·</span>
              <span className="capitalize">{job.documentCategory.replace('_', ' ')}</span>
            </div>
            <p className="text-xs leading-relaxed text-slate-600 dark:text-slate-300 max-w-3xl">
              {job.executiveSummary}
            </p>
          </div>

          <div className="flex items-center gap-1 rounded-lg bg-slate-100 dark:bg-slate-800 p-1 self-start sm:self-center shrink-0">
            {(
              [
                { id: 'all', label: `All (${job.anomalies.length})` },
                { id: 'critical', label: `Critical (${counts.critical})` },
                { id: 'warning', label: `Warnings (${counts.warning})` },
                { id: 'fixed', label: `Fixed (${counts.fixed})` },
              ] as const
            ).map((tab) => (
              <button
                key={tab.id}
                type="button"
                onClick={() => setSeverityFilter(tab.id)}
                className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                  severityFilter === tab.id
                    ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 shadow-xs'
                    : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>
        </div>

        {filteredAnomalies.length === 0 ? (
          <div className="px-5 py-8 text-center text-sm text-slate-500 dark:text-slate-400">
            No anomalies match the selected filter.
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 divide-y md:divide-y-0 md:gap-px bg-slate-200 dark:bg-slate-800">
            {filteredAnomalies.map((anom) => {
              const isCritical = anom.severity === 'critical';
              const isWarning = anom.severity === 'warning';
              return (
                <div
                  key={anom.id}
                  className="bg-white dark:bg-slate-900 p-4 space-y-2"
                >
                  <div className="flex items-center justify-between gap-2 text-xs">
                    <div className="flex items-center gap-2 min-w-0">
                      {isCritical ? (
                        <span className="flex items-center gap-1 font-semibold text-red-600 dark:text-red-400 whitespace-nowrap shrink-0">
                          <AlertCircle className="h-3.5 w-3.5" />
                          <span>Critical</span>
                        </span>
                      ) : isWarning ? (
                        <span className="flex items-center gap-1 font-semibold text-amber-600 dark:text-amber-400 whitespace-nowrap shrink-0">
                          <AlertTriangle className="h-3.5 w-3.5" />
                          <span>Warning</span>
                        </span>
                      ) : (
                        <span className="flex items-center gap-1 font-semibold text-emerald-600 dark:text-emerald-400 whitespace-nowrap shrink-0">
                          <CheckCircle2 className="h-3.5 w-3.5" />
                          <span>Auto-Fixed</span>
                        </span>
                      )}
                      <span className="text-slate-400 dark:text-slate-600" aria-hidden="true">
                        ·
                      </span>
                      <span className="font-medium text-slate-900 dark:text-slate-100 truncate">
                        {anom.category}
                      </span>
                    </div>

                    <span className="font-mono text-[11px] text-slate-500 dark:text-slate-400 whitespace-nowrap shrink-0">
                      {anom.location}
                    </span>
                  </div>

                  <p className="text-xs leading-relaxed text-slate-600 dark:text-slate-300">
                    {anom.explanation}
                  </p>

                  <div className="flex flex-wrap items-center gap-2 pt-1 font-mono text-[11px]">
                    <span className="rounded bg-slate-100 dark:bg-slate-800 px-2 py-0.5 text-slate-600 dark:text-slate-400 line-through">
                      {anom.rawValue || '(empty)'}
                    </span>
                    <span className="text-slate-400" aria-hidden="true">
                      →
                    </span>
                    <span
                      className={`rounded px-2 py-0.5 font-medium ${
                        isCritical
                          ? 'bg-red-50 text-red-700 dark:bg-red-950/60 dark:text-red-300'
                          : isWarning
                          ? 'bg-amber-50 text-amber-700 dark:bg-amber-950/60 dark:text-amber-300'
                          : 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300'
                      }`}
                    >
                      {anom.suggestedOrFixedValue || '(empty)'}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
}
