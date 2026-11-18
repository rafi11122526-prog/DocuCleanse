import { useRef, useState } from 'react';
import { FileSpreadsheet, Image as ImageIcon, Loader2, Lock, UploadCloud } from 'lucide-react';
import type { QuotaSnapshot } from '../types';

interface UploadDropzoneProps {
  onUploadFile: (file: File) => void;
  onRunSample: (sample: 'expenses' | 'roster' | 'receipt' | 'oversized') => void;
  isProcessing: boolean;
  processingFileName: string | null;
  quota: QuotaSnapshot | null;
  compact?: boolean;
}

export function UploadDropzone({
  onUploadFile,
  onRunSample,
  isProcessing,
  processingFileName,
  quota,
  compact = false,
}: UploadDropzoneProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [dragActive, setDragActive] = useState(false);

  const handleFiles = (files: FileList | null) => {
    if (!files || files.length === 0) return;
    onUploadFile(files[0]);
  };

  if (isProcessing) {
    return (
      <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-8">
        <div className="flex flex-col items-center justify-center text-center py-6 space-y-4">
          <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-blue-50 dark:bg-blue-950/60 text-blue-600 dark:text-blue-400">
            <Loader2 className="h-6 w-6 animate-spin" />
          </div>
          <div className="space-y-1">
            <h3 className="text-base font-semibold text-slate-900 dark:text-slate-100">
              Analyzing and normalizing document
            </h3>
            <p className="text-sm text-slate-500 dark:text-slate-400 font-mono">
              {processingFileName}
            </p>
          </div>
          <div className="w-full max-w-md space-y-2 pt-2">
            <div className="h-2.5 w-full rounded bg-slate-100 dark:bg-slate-800 animate-pulse" />
            <div className="h-2.5 w-4/5 mx-auto rounded bg-slate-100 dark:bg-slate-800 animate-pulse" />
          </div>
          <p className="text-xs text-slate-500 dark:text-slate-400">
            Standardizing ISO dates · Normalizing currency strings · Auditing formula errors
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragActive(true);
        }}
        onDragLeave={() => setDragActive(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragActive(false);
          handleFiles(e.dataTransfer.files);
        }}
        className={`relative rounded-xl border border-dashed transition-colors ${
          dragActive
            ? 'border-blue-600 bg-blue-50/60 dark:border-blue-500 dark:bg-blue-950/30'
            : 'border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 hover:border-slate-400 dark:hover:border-slate-600'
        } ${compact ? 'p-5' : 'p-10'}`}
      >
        <input
          ref={inputRef}
          type="file"
          accept=".csv,.xlsx,.xls,.pdf,.png,.jpg,.jpeg,.webp"
          className="hidden"
          onChange={(e) => {
            handleFiles(e.target.files);
            e.target.value = '';
          }}
        />

        <div className="flex flex-col items-center text-center space-y-3">
          <div className="flex h-11 w-11 items-center justify-center rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-slate-700 dark:text-slate-200">
            <UploadCloud className="h-5 w-5" />
          </div>

          <div className="space-y-1 max-w-lg">
            <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">
              Drop raw spreadsheets, transaction CSVs, or supplier receipts
            </h2>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Supports .csv, .xlsx, .xls, .pdf, .png, and .jpg up to 15 MB ·{' '}
              {quota?.plan === 'pro' || (quota?.tokenBalance ?? 0) > 0
                ? 'Unlimited rows enabled'
                : `Free tier: ${Math.max(
                    0,
                    (quota?.freeCleansLimit ?? 3) - (quota?.freeCleansUsedThisMonth ?? 0)
                  )} of ${quota?.freeCleansLimit ?? 3} cleans remaining · Max ${
                    quota?.freeRowLimit ?? 50
                  } rows/file`}
            </p>
          </div>

          <div className="pt-1">
            <button
              type="button"
              onClick={() => inputRef.current?.click()}
              className="rounded-lg bg-blue-600 px-4 py-2 text-xs font-semibold text-white hover:bg-blue-700 transition-colors whitespace-nowrap shrink-0"
            >
              Select File to Clean
            </button>
          </div>
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-4 py-3">
        <span className="text-xs font-medium text-slate-600 dark:text-slate-300">
          Try with realistic messy sample data:
        </span>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => onRunSample('expenses')}
            className="flex items-center gap-1.5 rounded-md border border-slate-200 dark:border-slate-700 px-3 py-1.5 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors whitespace-nowrap shrink-0"
          >
            <FileSpreadsheet className="h-3.5 w-3.5 text-blue-600 dark:text-blue-400" />
            <span>Messy Expenses CSV</span>
          </button>

          <button
            type="button"
            onClick={() => onRunSample('roster')}
            className="flex items-center gap-1.5 rounded-md border border-slate-200 dark:border-slate-700 px-3 py-1.5 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors whitespace-nowrap shrink-0"
          >
            <FileSpreadsheet className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
            <span>Client Roster CSV</span>
          </button>

          <button
            type="button"
            onClick={() => onRunSample('receipt')}
            className="flex items-center gap-1.5 rounded-md border border-slate-200 dark:border-slate-700 px-3 py-1.5 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors whitespace-nowrap shrink-0"
          >
            <ImageIcon className="h-3.5 w-3.5 text-amber-600 dark:text-amber-400" />
            <span>Supplier Receipt (PNG)</span>
          </button>

          <button
            type="button"
            onClick={() => onRunSample('oversized')}
            className="flex items-center gap-1.5 rounded-md border border-slate-200 dark:border-slate-700 px-3 py-1.5 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors whitespace-nowrap shrink-0"
            title="Tests the 50-row Free tier guardrail"
          >
            <Lock className="h-3.5 w-3.5 text-slate-500 dark:text-slate-400" />
            <span>65-Row Ledger (Guardrail Test)</span>
          </button>
        </div>
      </div>
    </div>
  );
}
