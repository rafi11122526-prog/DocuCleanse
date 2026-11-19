import { useEffect, useState } from 'react';
import {
  Check,
  Copy,
  Cpu,
  DatabaseZap,
  FileCheck2,
  Fingerprint,
  Lock,
  ShieldCheck,
  X,
} from 'lucide-react';
import type { CleanJob } from '../types';

interface SecurityArchitectureModalProps {
  open: boolean;
  activeJob?: CleanJob | null;
  onClose: () => void;
}

const ARCHITECTURE_BRIEF_TEXT = `DOCUCLEANSE — SECURITY & COMPLIANCE BRIEF (RAFI DIGITAL STUDIO)
----------------------------------------------------------------------
1. Ephemeral In-Memory RAM Processing
   - All incoming CSV, XLSX, PDF, and image uploads are ingested strictly via in-memory RAM buffers (multer.memoryStorage()).
   - No raw client files are staged to /tmp, local uploads/ directories, or unencrypted disk volumes.
   - Immediately upon parsing completion or error, raw file buffers are deterministically zeroized in a try/finally lifecycle block (buffer.fill(0)) with defensive fs.unlinkSync() cleanup.

2. Zero Permanent Raw File Persistence
   - Raw financial spreadsheets, ledgers, and supplier receipts are never written to third-party cloud buckets or permanent file storage.
   - Designed for GDPR data minimization and institutional pre-audit workflows.

3. Zero External LLM Model Training
   - Client documents are never used to train, fine-tune, or evaluate external foundation models.
   - Tabular reconciliation (date ISO-8601 standardization, multi-currency isolation, formula error repair, phone formatting, and variance checksums) runs deterministically inside isolated server memory.

4. Cryptographic SHA-256 Source Integrity Seals
   - A 64-character SHA-256 cryptographic digest is computed over the exact raw byte stream prior to parsing.
   - The identical SHA-256 hash, UTC execution timestamp, row verification checksum (Ingested / Cleaned), and reconciliation confidence score are embedded across the UI Audit Trail, HTTP export headers (X-DocuCleanse-SHA256), live-formula XLSX Audit_Metadata tabs, and PDF Pre-Audit Processing Reports.

5. Multi-Currency Accounting Precision & Export Integrity
   - Mixed currencies (USD, EUR, GBP, CAD, AUD, JPY, etc.) are isolated by ISO-4217 code without unhedged cross-FX mixing, and face-value totals are explicitly labeled as Unconverted Multi-Currency Face Value.
   - XLSX exports write typed Excel numeric cells, native currency formats, and live recalculated Excel formulas (=F2*G2, =SUM, =SUMIFS).`;

export function SecurityArchitectureModal({
  open,
  activeJob,
  onClose,
}: SecurityArchitectureModalProps) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  const activeMeta = activeJob?.auditMetadata;

  const handleCopyBrief = async () => {
    try {
      await navigator.clipboard.writeText(ARCHITECTURE_BRIEF_TEXT);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard unavailable in restricted context
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/75 p-4 backdrop-blur-[2px]"
      role="dialog"
      aria-modal="true"
      aria-labelledby="security-brief-title"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="flex max-h-[88vh] w-full max-w-3xl flex-col rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="flex items-start justify-between gap-4 border-b border-slate-200 dark:border-slate-800 bg-slate-900 px-6 py-4 text-white">
          <div className="flex items-start gap-3 min-w-0">
            <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-emerald-500/15 ring-1 ring-emerald-400/30">
              <ShieldCheck className="h-5 w-5 text-emerald-400" />
            </div>
            <div className="min-w-0">
              <div className="text-[10px] font-semibold uppercase tracking-widest text-emerald-400">
                Enterprise Privacy Shield · 1-Pager Brief
              </div>
              <h2
                id="security-brief-title"
                className="mt-0.5 text-base font-bold tracking-tight text-white"
              >
                Security &amp; Compliance Brief
              </h2>
              <p className="mt-0.5 text-xs text-slate-300">
                Rafi Digital Studio · Volatile RAM Processing, SHA-256 Source Integrity &amp; Zero LLM Training
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-800 hover:text-white transition-colors"
            aria-label="Close Security & Compliance Brief"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Scrollable 1-Pager Content */}
        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-4">
          {/* 4 Core Security Pillars */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
            <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-950/60 p-4 space-y-1.5">
              <div className="flex items-center gap-2 text-xs font-semibold text-slate-900 dark:text-slate-100">
                <Cpu className="h-4 w-4 text-blue-600 dark:text-sky-400 shrink-0" />
                <span>1. Ephemeral In-Memory RAM Processing</span>
              </div>
              <p className="text-xs leading-relaxed text-slate-600 dark:text-slate-300">
                Multipart uploads are ingested strictly into volatile RAM buffers via{' '}
                <code className="font-mono text-[11px] text-slate-800 dark:text-slate-200">
                  multer.memoryStorage()
                </code>
                . Raw files never touch <code className="font-mono text-[11px]">/tmp</code> or local
                disk, and buffers are deterministically zeroized (
                <code className="font-mono text-[11px]">buffer.fill(0)</code>) inside a{' '}
                <code className="font-mono text-[11px]">try/finally</code> block immediately after
                parsing or error.
              </p>
            </div>

            <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-950/60 p-4 space-y-1.5">
              <div className="flex items-center gap-2 text-xs font-semibold text-slate-900 dark:text-slate-100">
                <DatabaseZap className="h-4 w-4 text-emerald-600 dark:text-emerald-400 shrink-0" />
                <span>2. Zero Permanent Raw File Persistence</span>
              </div>
              <p className="text-xs leading-relaxed text-slate-600 dark:text-slate-300">
                Client spreadsheets, ledgers, and receipt images are never persisted to S3 buckets,
                third-party file hosts, or unencrypted disk directories. All cleaning, schema
                reconciliation, and XLSX/PDF export generation executes transiently in memory for
                GDPR &amp; pre-audit data minimization.
              </p>
            </div>

            <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-950/60 p-4 space-y-1.5">
              <div className="flex items-center gap-2 text-xs font-semibold text-slate-900 dark:text-slate-100">
                <Lock className="h-4 w-4 text-indigo-600 dark:text-indigo-400 shrink-0" />
                <span>3. Zero External LLM Model Training</span>
              </div>
              <p className="text-xs leading-relaxed text-slate-600 dark:text-slate-300">
                Uploaded client files are strictly excluded from training, fine-tuning, or
                evaluating external foundation models. Core tabular reconciliation—dates,
                multi-currency ISO-4217 extraction, formula error repair, and checksum validation—runs
                deterministically within isolated server RAM.
              </p>
            </div>

            <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-950/60 p-4 space-y-1.5">
              <div className="flex items-center gap-2 text-xs font-semibold text-slate-900 dark:text-slate-100">
                <Fingerprint className="h-4 w-4 text-amber-600 dark:text-amber-400 shrink-0" />
                <span>4. Cryptographic SHA-256 Ledger Integrity</span>
              </div>
              <p className="text-xs leading-relaxed text-slate-600 dark:text-slate-300">
                Every uploaded file is hashed via SHA-256 over its exact raw byte stream prior to
                parsing. The full 64-character digest, UTC timestamp, row verification checksum, and
                confidence score propagate identically into the UI, HTTP headers (
                <code className="font-mono text-[11px]">X-DocuCleanse-SHA256</code>), XLSX{' '}
                <code className="font-mono text-[11px]">Audit_Metadata</code>, and PDF Pre-Audit
                Processing Reports.
              </p>
            </div>
          </div>

          {/* Export & Multi-Currency Audit Standards */}
          <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-950/40 p-4 space-y-2">
            <div className="flex items-center gap-2 text-xs font-semibold text-slate-900 dark:text-slate-100">
              <FileCheck2 className="h-4 w-4 text-blue-600 dark:text-sky-400 shrink-0" />
              <span>Accounting Precision &amp; Deliverable Verification Controls</span>
            </div>
            <ul className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-1.5 text-xs text-slate-600 dark:text-slate-300 list-disc pl-4">
              <li>
                Mixed-currency ledgers display explicit{' '}
                <strong className="text-slate-800 dark:text-slate-100">
                  Unconverted Multi-Currency Face Value
                </strong>{' '}
                disclosures alongside isolated ISO-4217 currency subtotals.
              </li>
              <li>
                <strong className="text-slate-800 dark:text-slate-100">Export XLSX</strong> writes
                typed numeric cells, native currency formats, and live Excel formulas (
                <code className="font-mono text-[11px]">=Qty*Price</code>,{' '}
                <code className="font-mono text-[11px]">=SUM</code>,{' '}
                <code className="font-mono text-[11px]">=SUMIFS</code>).
              </li>
              <li>
                <strong className="text-slate-800 dark:text-slate-100">
                  Pre-Audit Processing Report
                </strong>{' '}
                embeds the verbatim 64-character SHA-256 digest, UTC timestamp, row checksums, and
                Rafi Digital Studio executive sign-off block.
              </li>
              <li>
                Billing &amp; PCI-DSS card handling is delegated exclusively to{' '}
                <strong className="text-slate-800 dark:text-slate-100">Paddle Billing</strong>{' '}
                (Merchant of Record) with HMAC SHA-256 webhook verification.
              </li>
            </ul>
          </div>

          {/* Active Session Live Verification Proof (shown when a dataset is open) */}
          {activeJob && activeMeta && (
            <div className="rounded-xl border border-emerald-200 dark:border-emerald-900/70 bg-emerald-50/70 dark:bg-emerald-950/30 p-4 space-y-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-xs font-semibold text-emerald-900 dark:text-emerald-300">
                  Live Active Document Cryptographic Proof — {activeJob.fileName}
                </span>
                <span className="font-mono text-[11px] font-semibold text-emerald-700 dark:text-emerald-400 tabular-nums">
                  {activeMeta.rowsIngested} Ingested / {activeMeta.rowsCleaned} Cleaned ·{' '}
                  {activeMeta.reconciliationConfidenceScore.toFixed(1)}% Cleaned
                </span>
              </div>
              <div className="font-mono text-[11px] text-slate-700 dark:text-slate-200 break-all bg-white/80 dark:bg-slate-900/80 rounded-lg border border-emerald-200/70 dark:border-emerald-900/60 px-3 py-2">
                SHA-256: {activeMeta.fileHashSha256}
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-200 dark:border-slate-800 bg-slate-50/80 dark:bg-slate-950/60 px-6 py-3.5">
          <span className="text-[11px] text-slate-500 dark:text-slate-400">
            Rafi Digital Studio · Security Contact: ru2275353@gmail.com
          </span>
          <div className="flex items-center gap-2.5">
            <button
              type="button"
              onClick={handleCopyBrief}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-3.5 py-2 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
            >
              {copied ? (
                <>
                  <Check className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
                  <span>Copied Brief</span>
                </>
              ) : (
                <>
                  <Copy className="h-3.5 w-3.5" />
                  <span>Copy 1-Pager Text</span>
                </>
              )}
            </button>
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg bg-slate-900 dark:bg-blue-600 px-4 py-2 text-xs font-semibold text-white hover:bg-slate-800 dark:hover:bg-blue-700 transition-colors"
            >
              Close
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
