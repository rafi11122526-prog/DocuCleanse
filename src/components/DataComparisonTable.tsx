import { useMemo, useState } from 'react';
import {
  ArrowRight,
  Download,
  FileSpreadsheet,
  FileText,
  Lock,
  Search,
} from 'lucide-react';
import type { CellDiff, CleanJob, QuotaSnapshot } from '../types';

interface DataComparisonTableProps {
  job: CleanJob;
  quota: QuotaSnapshot | null;
  onExport: (jobId: string, format: 'csv' | 'xlsx' | 'pdf') => void;
  exportingFormat: string | null;
}

type TableViewMode = 'split' | 'cleaned' | 'schema';

export function DataComparisonTable({
  job,
  quota,
  onExport,
  exportingFormat,
}: DataComparisonTableProps) {
  const [viewMode, setViewMode] = useState<TableViewMode>('split');
  const [searchQuery, setSearchQuery] = useState('');
  const [onlyModifiedRows, setOnlyModifiedRows] = useState(false);
  const [page, setPage] = useState(1);
  const PAGE_SIZE = 100;

  const proExportsUnlocked = quota?.canExportProFormats ?? false;
  const freeQuotaExhausted =
    !proExportsUnlocked &&
    (quota?.freeCleansUsedThisMonth ?? 0) >= (quota?.freeCleansLimit ?? 3);

  const diffLookup = useMemo(() => {
    const map = new Map<string, CellDiff>();
    for (const d of job.cellDiffs) {
      map.set(`${d.rowIndex}:${d.column}`, d);
    }
    return map;
  }, [job.cellDiffs]);

  const modifiedRowIndices = useMemo(() => {
    return new Set(job.cellDiffs.map((d) => d.rowIndex));
  }, [job.cellDiffs]);

  const filteredRowIndices = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    const indices: number[] = [];

    for (let i = 0; i < job.cleanedRows.length; i++) {
      if (onlyModifiedRows && !modifiedRowIndices.has(i)) continue;

      if (q) {
        const rawValues = Object.values(job.rawRows[i] || {}).join(' ').toLowerCase();
        const cleanValues = Object.values(job.cleanedRows[i] || {}).join(' ').toLowerCase();
        if (!rawValues.includes(q) && !cleanValues.includes(q)) continue;
      }

      indices.push(i);
    }
    return indices;
  }, [job.cleanedRows, job.rawRows, modifiedRowIndices, onlyModifiedRows, searchQuery]);

  const totalPages = Math.max(1, Math.ceil(filteredRowIndices.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const visibleRowIndices = useMemo(() => {
    const start = (safePage - 1) * PAGE_SIZE;
    return filteredRowIndices.slice(start, start + PAGE_SIZE);
  }, [filteredRowIndices, safePage]);

  return (
    <section className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900">
      {/* Toolbar Header */}
      <div className="flex flex-col xl:flex-row xl:items-center justify-between gap-4 border-b border-slate-200 dark:border-slate-800 px-5 py-4">
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-1 rounded-lg bg-slate-100 dark:bg-slate-800 p-1">
            {(
              [
                { id: 'split', label: 'Side-by-Side (Raw vs. Cleaned)' },
                { id: 'cleaned', label: 'Cleaned Output' },
                { id: 'schema', label: `Schema Map (${job.schemaMappings.length})` },
              ] as const
            ).map((tab) => (
              <button
                key={tab.id}
                type="button"
                onClick={() => setViewMode(tab.id)}
                className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                  viewMode === tab.id
                    ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 shadow-xs'
                    : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>

          {viewMode !== 'schema' && (
            <>
              <div className="relative">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => {
                    setSearchQuery(e.target.value);
                    setPage(1);
                  }}
                  placeholder="Filter rows..."
                  className="h-8 w-44 sm:w-56 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 pl-8 pr-3 text-xs text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:border-blue-600 focus:outline-none"
                />
              </div>

              <label className="flex items-center gap-2 text-xs font-medium text-slate-600 dark:text-slate-300 cursor-pointer select-none whitespace-nowrap shrink-0">
                <input
                  type="checkbox"
                  checked={onlyModifiedRows}
                  onChange={(e) => {
                    setOnlyModifiedRows(e.target.checked);
                    setPage(1);
                  }}
                  className="h-3.5 w-3.5 rounded border-slate-300 text-blue-600 focus:ring-blue-600"
                />
                <span>Modified rows only ({modifiedRowIndices.size})</span>
              </label>
            </>
          )}
        </div>

        {/* Export Actions */}
        <div className="flex flex-wrap items-center gap-2 shrink-0">
          <button
            type="button"
            disabled={exportingFormat !== null}
            onClick={() => onExport(job.id, 'csv')}
            className="flex items-center gap-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-2 text-xs font-semibold text-slate-800 dark:text-slate-100 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors whitespace-nowrap shrink-0 disabled:opacity-60"
          >
            {freeQuotaExhausted ? (
              <Lock className="h-3.5 w-3.5 text-amber-600 dark:text-amber-400" />
            ) : (
              <Download className="h-3.5 w-3.5" />
            )}
            <span>{exportingFormat === 'csv' ? 'Exporting...' : 'Export CSV'}</span>
          </button>

          <button
            type="button"
            disabled={exportingFormat !== null}
            onClick={() => onExport(job.id, 'xlsx')}
            className={`flex items-center gap-1.5 rounded-lg border px-3 py-2 text-xs font-semibold transition-colors whitespace-nowrap shrink-0 disabled:opacity-60 ${
              proExportsUnlocked
                ? 'border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-800 dark:text-slate-100 hover:bg-slate-100 dark:hover:bg-slate-800'
                : 'border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950 text-slate-600 dark:text-slate-300 hover:border-blue-500'
            }`}
          >
            {proExportsUnlocked ? (
              <FileSpreadsheet className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
            ) : (
              <Lock className="h-3.5 w-3.5 text-amber-600 dark:text-amber-400" />
            )}
            <span>{exportingFormat === 'xlsx' ? 'Building XLSX...' : 'Export XLSX'}</span>
          </button>

          <button
            type="button"
            disabled={exportingFormat !== null}
            onClick={() => onExport(job.id, 'pdf')}
            className={`flex items-center gap-1.5 rounded-lg px-3.5 py-2 text-xs font-semibold transition-colors whitespace-nowrap shrink-0 disabled:opacity-60 ${
              proExportsUnlocked
                ? 'bg-blue-600 text-white hover:bg-blue-700'
                : 'bg-slate-900 dark:bg-blue-600 text-white hover:bg-slate-800 dark:hover:bg-blue-700'
            }`}
          >
            {proExportsUnlocked ? (
              <FileText className="h-3.5 w-3.5" />
            ) : (
              <Lock className="h-3.5 w-3.5 text-amber-300" />
            )}
            <span>{exportingFormat === 'pdf' ? 'Rendering PDF...' : 'Summary PDF'}</span>
          </button>
        </div>
      </div>

      {/* View 1: Schema Mapping Table */}
      {viewMode === 'schema' && (
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950/50 text-[11px] font-semibold text-slate-500 dark:text-slate-400">
                <th className="py-2.5 px-4">Raw Header</th>
                <th className="py-2.5 px-4">Normalized Column</th>
                <th className="py-2.5 px-4">Inferred Type</th>
                <th className="py-2.5 px-4">Normalization Rule Applied</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200 dark:divide-slate-800 text-xs">
              {job.schemaMappings.map((mapping, idx) => (
                <tr key={`${mapping.rawHeader}-${idx}`} className="hover:bg-slate-50 dark:hover:bg-slate-800/40">
                  <td className="py-3 px-4 font-mono text-slate-600 dark:text-slate-400">
                    {mapping.rawHeader}
                  </td>
                  <td className="py-3 px-4 font-mono font-semibold text-blue-600 dark:text-blue-400">
                    {mapping.normalizedHeader}
                  </td>
                  <td className="py-3 px-4 font-mono text-slate-700 dark:text-slate-300">
                    {mapping.detectedType}
                  </td>
                  <td className="py-3 px-4 text-slate-600 dark:text-slate-300">
                    {mapping.reason}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* View 2: Side-by-Side (Raw vs. Cleaned) */}
      {viewMode === 'split' && (
        <div className="grid grid-cols-1 lg:grid-cols-2 divide-y lg:divide-y-0 lg:divide-x divide-slate-200 dark:divide-slate-800">
          {/* Left Pane: Raw Input */}
          <div className="min-w-0">
            <div className="flex items-center justify-between border-b border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950/60 px-4 py-2 text-xs font-semibold text-slate-600 dark:text-slate-300">
              <span>Raw Input ({job.fileName})</span>
              <span className="font-mono tabular-nums text-[11px] text-slate-500">
                {filteredRowIndices.length} rows shown
              </span>
            </div>
            <div className="overflow-x-auto max-h-[460px]">
              <table className="w-full text-left border-collapse">
                <thead className="sticky top-0 z-10 bg-slate-50 dark:bg-slate-950 border-b border-slate-200 dark:border-slate-800">
                  <tr className="text-[11px] font-semibold text-slate-500 dark:text-slate-400">
                    <th className="py-2 px-3 w-10 font-mono">#</th>
                    {job.rawHeaders.map((h) => (
                      <th key={h} className="py-2 px-3 whitespace-nowrap">
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800/70 text-xs font-mono tabular-nums">
                  {visibleRowIndices.map((rIdx) => {
                    const row = job.rawRows[rIdx] || {};
                    return (
                      <tr key={rIdx} className="h-10 hover:bg-slate-50 dark:hover:bg-slate-800/40">
                        <td className="py-2 px-3 text-slate-400 dark:text-slate-500">
                          {rIdx + 1}
                        </td>
                        {job.rawHeaders.map((rawH, cIdx) => {
                          const normH = job.cleanedHeaders[cIdx] || rawH;
                          const diff = diffLookup.get(`${rIdx}:${normH}`);
                          const val = row[rawH] ?? '';
                          const isFormulaErr = /^#(REF!|DIV\/0!|VALUE!|NAME\?|N\/A|NUM!)/i.test(
                            val.trim()
                          );

                          return (
                            <td
                              key={`${rIdx}-${rawH}`}
                              className={`py-2 px-3 whitespace-nowrap max-w-[180px] truncate ${
                                isFormulaErr
                                  ? 'bg-red-50 dark:bg-red-950/50 text-red-700 dark:text-red-300 font-semibold'
                                  : diff
                                  ? 'bg-amber-50/70 dark:bg-amber-950/30 text-amber-800 dark:text-amber-300'
                                  : 'text-slate-600 dark:text-slate-300'
                              }`}
                              title={val}
                            >
                              {val || <span className="text-slate-400 italic">empty</span>}
                            </td>
                          );
                        })}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          {/* Right Pane: Cleaned Output */}
          <div className="min-w-0">
            <div className="flex items-center justify-between border-b border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950/60 px-4 py-2 text-xs font-semibold text-slate-900 dark:text-slate-100">
              <span>Cleaned &amp; Normalized Output</span>
              <span className="font-mono tabular-nums text-[11px] text-emerald-600 dark:text-emerald-400">
                {job.cellDiffs.length} cells corrected
              </span>
            </div>
            <div className="overflow-x-auto max-h-[460px]">
              <table className="w-full text-left border-collapse">
                <thead className="sticky top-0 z-10 bg-slate-50 dark:bg-slate-950 border-b border-slate-200 dark:border-slate-800">
                  <tr className="text-[11px] font-semibold text-slate-500 dark:text-slate-400">
                    <th className="py-2 px-3 w-10 font-mono">#</th>
                    {job.cleanedHeaders.map((h) => (
                      <th key={h} className="py-2 px-3 whitespace-nowrap text-blue-700 dark:text-blue-400">
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800/70 text-xs font-mono tabular-nums">
                  {visibleRowIndices.map((rIdx) => {
                    const row = job.cleanedRows[rIdx] || {};
                    return (
                      <tr key={rIdx} className="h-10 hover:bg-slate-50 dark:hover:bg-slate-800/40">
                        <td className="py-2 px-3 text-slate-400 dark:text-slate-500">
                          {rIdx + 1}
                        </td>
                        {job.cleanedHeaders.map((normH) => {
                          const diff = diffLookup.get(`${rIdx}:${normH}`);
                          const val = row[normH] ?? '';
                          const isErrorMarker = val.startsWith('[ERROR') || val === '[MISSING]';

                          return (
                            <td
                              key={`${rIdx}-${normH}`}
                              className={`py-2 px-3 whitespace-nowrap max-w-[180px] truncate ${
                                isErrorMarker
                                  ? 'bg-red-50 dark:bg-red-950/50 text-red-700 dark:text-red-300 font-semibold'
                                  : diff
                                  ? 'bg-emerald-50/70 dark:bg-emerald-950/30 text-emerald-800 dark:text-emerald-300 font-medium'
                                  : 'text-slate-800 dark:text-slate-200'
                              }`}
                              title={
                                diff
                                  ? `Changed from "${diff.rawValue}" → "${diff.cleanedValue}"`
                                  : val
                              }
                            >
                              {val || <span className="text-slate-400">—</span>}
                            </td>
                          );
                        })}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* View 3: Full-Width Cleaned Table with Inline Diff Tooltip */}
      {viewMode === 'cleaned' && (
        <div className="overflow-x-auto max-h-[520px]">
          <table className="w-full text-left border-collapse">
            <thead className="sticky top-0 z-10 bg-slate-50 dark:bg-slate-950 border-b border-slate-200 dark:border-slate-800">
              <tr className="text-[11px] font-semibold text-slate-500 dark:text-slate-400">
                <th className="py-2.5 px-4 w-12 font-mono">#</th>
                {job.cleanedHeaders.map((h) => (
                  <th key={h} className="py-2.5 px-4 whitespace-nowrap">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800/70 text-xs font-mono tabular-nums">
              {visibleRowIndices.map((rIdx) => {
                const row = job.cleanedRows[rIdx] || {};
                return (
                  <tr key={rIdx} className="h-10 hover:bg-slate-50 dark:hover:bg-slate-800/40">
                    <td className="py-2 px-4 text-slate-400 dark:text-slate-500">{rIdx + 1}</td>
                    {job.cleanedHeaders.map((normH) => {
                      const diff = diffLookup.get(`${rIdx}:${normH}`);
                      const val = row[normH] ?? '';
                      const isErrorMarker = val.startsWith('[ERROR') || val === '[MISSING]';
                      return (
                        <td
                          key={`${rIdx}-${normH}`}
                          className={`py-2 px-4 whitespace-nowrap ${
                            isErrorMarker
                              ? 'text-red-600 dark:text-red-400 font-semibold'
                              : diff
                              ? 'bg-emerald-50/60 dark:bg-emerald-950/25 text-emerald-800 dark:text-emerald-300'
                              : 'text-slate-800 dark:text-slate-200'
                          }`}
                        >
                          <div className="flex items-center gap-2">
                            <span>{val || '—'}</span>
                            {diff && !isErrorMarker && (
                              <span className="inline-flex items-center gap-1 text-[10px] text-slate-400 dark:text-slate-500">
                                <ArrowRight className="h-2.5 w-2.5" />
                                <span className="line-through">{diff.rawValue || 'empty'}</span>
                              </span>
                            )}
                          </div>
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {filteredRowIndices.length === 0 && viewMode !== 'schema' && (
        <div className="py-10 text-center text-xs text-slate-500 dark:text-slate-400">
          No rows match your current filter.
        </div>
      )}

      {viewMode !== 'schema' && filteredRowIndices.length > PAGE_SIZE && (
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-200 dark:border-slate-800 px-5 py-3 text-xs text-slate-500 dark:text-slate-400">
          <span className="font-mono tabular-nums">
            Showing {((safePage - 1) * PAGE_SIZE + 1).toLocaleString()}–
            {Math.min(safePage * PAGE_SIZE, filteredRowIndices.length).toLocaleString()} of{' '}
            {filteredRowIndices.length.toLocaleString()} rows
          </span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={safePage <= 1}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              className="rounded-md border border-slate-200 dark:border-slate-700 px-2.5 py-1 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-40 whitespace-nowrap shrink-0"
            >
              Previous
            </button>
            <span className="font-mono tabular-nums text-slate-700 dark:text-slate-200">
              Page {safePage} / {totalPages}
            </span>
            <button
              type="button"
              disabled={safePage >= totalPages}
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              className="rounded-md border border-slate-200 dark:border-slate-700 px-2.5 py-1 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-40 whitespace-nowrap shrink-0"
            >
              Next
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
