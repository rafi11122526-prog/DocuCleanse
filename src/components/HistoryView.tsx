import { useMemo, useState } from 'react';
import { ArrowUpRight, Download, FileSpreadsheet, FileText, Lock, Search } from 'lucide-react';
import type { CleanJob, UsageLog } from '../types';

interface HistoryViewProps {
  jobs: CleanJob[];
  usageLogs: UsageLog[];
  isPro?: boolean;
  onOpenJob: (job: CleanJob) => void;
  onExport: (jobId: string, format: 'csv' | 'xlsx' | 'pdf') => void;
  onGoToUpload: () => void;
}

export function HistoryView({
  jobs,
  usageLogs,
  isPro = false,
  onOpenJob,
  onExport,
  onGoToUpload,
}: HistoryViewProps) {
  const [search, setSearch] = useState('');
  const [view, setView] = useState<'jobs' | 'logs'>('jobs');

  const filteredJobs = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return jobs;
    return jobs.filter(
      (j) =>
        j.fileName.toLowerCase().includes(q) ||
        j.documentCategory.toLowerCase().includes(q)
    );
  }, [jobs, search]);

  const filteredLogs = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return usageLogs;
    return usageLogs.filter(
      (l) =>
        l.fileName.toLowerCase().includes(q) ||
        l.action.toLowerCase().includes(q) ||
        l.billingSource.toLowerCase().includes(q)
    );
  }, [usageLogs, search]);

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold text-slate-900 dark:text-slate-100">
            Audit History &amp; Usage Ledger
          </h1>
          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
            Every processed file, cell normalization count, and export action persisted in SQLite.
          </p>
        </div>

        <div className="flex items-center gap-3">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search files or actions..."
              className="h-9 w-52 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 pl-8 pr-3 text-xs text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:border-blue-600 focus:outline-none"
            />
          </div>

          <div className="flex items-center gap-1 rounded-lg bg-slate-200/70 dark:bg-slate-800 p-1">
            <button
              type="button"
              onClick={() => setView('jobs')}
              className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                view === 'jobs'
                  ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 shadow-xs'
                  : 'text-slate-600 dark:text-slate-400'
              }`}
            >
              Cleaned Files ({jobs.length})
            </button>
            <button
              type="button"
              onClick={() => setView('logs')}
              className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                view === 'logs'
                  ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 shadow-xs'
                  : 'text-slate-600 dark:text-slate-400'
              }`}
            >
              Usage Logs ({usageLogs.length})
            </button>
          </div>
        </div>
      </div>

      {view === 'jobs' ? (
        filteredJobs.length === 0 ? (
          <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-6 py-14 text-center space-y-3">
            <FileSpreadsheet className="mx-auto h-8 w-8 text-slate-400" />
            <div className="text-sm font-semibold text-slate-900 dark:text-slate-100">
              No processed documents yet
            </div>
            <p className="text-xs text-slate-500 dark:text-slate-400 max-w-md mx-auto">
              Upload a raw transaction CSV, Excel ledger, or supplier receipt to inspect side-by-side cleaning and anomaly audits.
            </p>
            <button
              type="button"
              onClick={onGoToUpload}
              className="mt-2 rounded-lg bg-blue-600 px-4 py-2 text-xs font-semibold text-white hover:bg-blue-700 transition-colors"
            >
              Go to Data Cleaner
            </button>
          </div>
        ) : (
          <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950/60 text-[11px] font-semibold text-slate-500 dark:text-slate-400">
                  <th className="py-3 px-4">File Name</th>
                  <th className="py-3 px-4">Category</th>
                  <th className="py-3 px-4 text-right">Rows</th>
                  <th className="py-3 px-4 text-right">Cells Fixed</th>
                  <th className="py-3 px-4 text-right">Anomalies</th>
                  <th className="py-3 px-4">Processed</th>
                  <th className="py-3 px-4 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200 dark:divide-slate-800 text-xs">
                {filteredJobs.map((job) => (
                  <tr key={job.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/40">
                    <td className="py-3 px-4 font-mono font-medium text-slate-900 dark:text-slate-100">
                      {job.fileName}
                    </td>
                    <td className="py-3 px-4 capitalize text-slate-600 dark:text-slate-300">
                      {job.documentCategory.replace('_', ' ')}
                    </td>
                    <td className="py-3 px-4 text-right font-mono tabular-nums text-slate-700 dark:text-slate-300">
                      {job.rowCount}
                    </td>
                    <td className="py-3 px-4 text-right font-mono tabular-nums text-emerald-600 dark:text-emerald-400">
                      {job.cellDiffs.length}
                    </td>
                    <td className="py-3 px-4 text-right font-mono tabular-nums text-amber-600 dark:text-amber-400">
                      {job.anomalies.length}
                    </td>
                    <td className="py-3 px-4 font-mono tabular-nums text-slate-500 dark:text-slate-400 whitespace-nowrap">
                      {new Date(job.createdAt).toLocaleString('en-US', {
                        month: 'short',
                        day: 'numeric',
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </td>
                    <td className="py-3 px-4 text-right">
                      <div className="inline-flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => onOpenJob(job)}
                          className="inline-flex items-center gap-1 rounded-md border border-slate-200 dark:border-slate-700 px-2.5 py-1 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 whitespace-nowrap shrink-0"
                        >
                          <span>Inspect</span>
                          <ArrowUpRight className="h-3 w-3" />
                        </button>
                        <button
                          type="button"
                          onClick={() => onExport(job.id, 'csv')}
                          className="inline-flex items-center gap-1 rounded-md border border-slate-200 dark:border-slate-700 px-2.5 py-1 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 whitespace-nowrap shrink-0"
                        >
                          <Download className="h-3 w-3" />
                          <span>CSV</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => onExport(job.id, 'xlsx')}
                          className="inline-flex items-center gap-1 rounded-md border border-slate-200 dark:border-slate-700 px-2.5 py-1 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 whitespace-nowrap shrink-0"
                          title={isPro ? 'Export XLSX workbook' : 'Upgrade to Pro ($40/mo) to export XLSX'}
                        >
                          {isPro ? (
                            <FileSpreadsheet className="h-3 w-3 text-emerald-600 dark:text-emerald-400" />
                          ) : (
                            <Lock className="h-3 w-3 text-amber-600 dark:text-amber-400" />
                          )}
                          <span>XLSX</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => onExport(job.id, 'pdf')}
                          className="inline-flex items-center gap-1 rounded-md border border-slate-200 dark:border-slate-700 px-2.5 py-1 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 whitespace-nowrap shrink-0"
                          title={isPro ? 'Export Pre-Audit PDF' : 'Upgrade to Pro ($40/mo) to export Pre-Audit PDF'}
                        >
                          {isPro ? (
                            <FileText className="h-3 w-3 text-blue-600 dark:text-blue-400" />
                          ) : (
                            <Lock className="h-3 w-3 text-amber-600 dark:text-amber-400" />
                          )}
                          <span>PDF</span>
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      ) : (
        <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950/60 text-[11px] font-semibold text-slate-500 dark:text-slate-400">
                <th className="py-3 px-4">Timestamp</th>
                <th className="py-3 px-4">Action</th>
                <th className="py-3 px-4">File</th>
                <th className="py-3 px-4 text-right">Rows</th>
                <th className="py-3 px-4">Billing Source</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200 dark:divide-slate-800 text-xs">
              {filteredLogs.length === 0 ? (
                <tr>
                  <td colSpan={5} className="py-8 text-center text-slate-500 dark:text-slate-400">
                    No usage events recorded yet.
                  </td>
                </tr>
              ) : (
                filteredLogs.map((log) => (
                  <tr key={log.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/40">
                    <td className="py-2.5 px-4 font-mono tabular-nums text-slate-500 dark:text-slate-400 whitespace-nowrap">
                      {new Date(log.createdAt).toLocaleString('en-US', {
                        month: 'short',
                        day: 'numeric',
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </td>
                    <td className="py-2.5 px-4 font-mono font-medium text-slate-900 dark:text-slate-100">
                      {log.action}
                    </td>
                    <td className="py-2.5 px-4 font-mono text-slate-700 dark:text-slate-300">
                      {log.fileName}
                    </td>
                    <td className="py-2.5 px-4 text-right font-mono tabular-nums text-slate-700 dark:text-slate-300">
                      {log.rowCount}
                    </td>
                    <td className="py-2.5 px-4 font-mono text-slate-600 dark:text-slate-300">
                      {log.billingSource}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
