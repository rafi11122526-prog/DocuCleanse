import { useMemo, useState } from 'react';
import { AlertCircle, AlertTriangle, CheckCircle2 } from 'lucide-react';
import type { AnomalySeverity, CleanJob } from '../types';

interface AnomalyCardsProps {
  job: CleanJob;
}

export function AnomalyCards({ job }: AnomalyCardsProps) {
  const [severityFilter, setSeverityFilter] = useState<'all' | AnomalySeverity>('all');

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
            <span>Critical Formula / Data Errors</span>
          </div>
          <div className="mt-1.5 font-mono text-2xl font-semibold tabular-nums text-slate-900 dark:text-slate-100">
            {counts.critical}
          </div>
          <div className="mt-1 text-xs text-slate-500 dark:text-slate-400">
            Requires manual review
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
