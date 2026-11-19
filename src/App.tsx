import { useCallback, useEffect, useState } from 'react';
import {
  AlertCircle,
  BarChart3,
  CheckCircle2,
  Columns2,
  Table2,
  X,
} from 'lucide-react';
import { AnomalyCards } from './components/AnomalyCards';
import { BillingWebhooksView } from './components/BillingWebhooksView';
import { DataComparisonTable } from './components/DataComparisonTable';
import { DataVisualizer } from './components/DataVisualizer';
import { Footer } from './components/Footer';
import { HistoryView } from './components/HistoryView';
import { LegalModal, type LegalDocSection } from './components/LegalModal';
import { PaywallModal } from './components/PaywallModal';
import { SecurityArchitectureModal } from './components/SecurityArchitectureModal';
import { Sidebar, type ActiveTab } from './components/Sidebar';
import { TopBar } from './components/TopBar';
import { UploadDropzone } from './components/UploadDropzone';
import {
  createSampleCsvFile,
  createSampleReceiptImageFile,
} from './data/sampleDatasets';
import {
  ApiBusinessError,
  cleanUploadedFile,
  clearAllProTokensFromStorage,
  createDefaultFreeQuota,
  downloadExportFile,
  enforceVerifiedSubscriptionOnQuota,
  fetchJobs,
  fetchQuotaAndLogs,
  hasVerifiedPaddleSubscription,
  setDemoQuotaMode,
} from './services/api';
import type { CleanJob, PaywallContext, QuotaSnapshot, UsageLog } from './types';

export default function App() {
  const [theme, setTheme] = useState<'light' | 'dark'>(() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem('docucleanse_theme');
      if (saved === 'dark' || saved === 'light') return saved;
    }
    return 'light';
  });

  const [activeTab, setActiveTab] = useState<ActiveTab>('workspace');
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  const [quota, setQuota] = useState<QuotaSnapshot>(() => createDefaultFreeQuota());
  const isPro = quota.plan === 'pro' && hasVerifiedPaddleSubscription();
  const [jobs, setJobs] = useState<CleanJob[]>([]);
  const [usageLogs, setUsageLogs] = useState<UsageLog[]>([]);
  const [activeJob, setActiveJob] = useState<CleanJob | null>(null);

  const [isProcessing, setIsProcessing] = useState(false);
  const [processingFileName, setProcessingFileName] = useState<string | null>(null);
  const [exportingFormat, setExportingFormat] = useState<string | null>(null);
  const [showDropzone, setShowDropzone] = useState(true);
  const [workspaceView, setWorkspaceView] = useState<'table' | 'charts' | 'split'>('split');

  const [banner, setBanner] = useState<{
    type: 'success' | 'error';
    message: string;
  } | null>(null);

  const [paywall, setPaywall] = useState<PaywallContext>({
    open: false,
    reason: '',
  });

  const [legalModal, setLegalModal] = useState<{
    open: boolean;
    section: LegalDocSection;
  }>({
    open: false,
    section: 'terms',
  });
  const [securityBriefOpen, setSecurityBriefOpen] = useState(false);

  useEffect(() => {
    const root = document.documentElement;
    if (theme === 'dark') {
      root.classList.add('dark');
    } else {
      root.classList.remove('dark');
    }
    localStorage.setItem('docucleanse_theme', theme);
  }, [theme]);

  const fetchAccountState = useCallback(async () => {
    try {
      const [qData, jData] = await Promise.all([fetchQuotaAndLogs(), fetchJobs()]);
      setQuota(enforceVerifiedSubscriptionOnQuota(qData.quota));
      setUsageLogs(qData.usageLogs || []);
      const loadedJobs = jData.jobs || [];
      setJobs(loadedJobs);
    } catch {
      // Keep UI strictly on Free default if initial poll encounters a transient issue
      setQuota((prev) => enforceVerifiedSubscriptionOnQuota(prev));
    }
  }, []);

  useEffect(() => {
    fetchAccountState();
  }, [fetchAccountState]);

  const handleUploadFile = async (file: File) => {
    setBanner(null);
    setIsProcessing(true);
    setProcessingFileName(file.name);
    setActiveTab('workspace');

    try {
      const data = await cleanUploadedFile(file);
      setActiveJob(data.job);
      setShowDropzone(false);
      setQuota(data.quota);
      setJobs((prev) => [data.job, ...prev.filter((j) => j.id !== data.job.id)]);
      setBanner({
        type: 'success',
        message: `Cleaned "${data.job.fileName}" (${data.job.rowCount} rows, ${data.job.cellDiffs.length} cells normalized).`,
      });
      await fetchAccountState();
    } catch (err) {
      if (err instanceof ApiBusinessError && (err.status === 402 || err.upgradeRequired)) {
        if (err.quota) setQuota(err.quota);
        setPaywall({
          open: true,
          reason: err.message,
          code: err.code,
        });
        return;
      }

      setBanner({
        type: 'error',
        message: err instanceof Error ? err.message : 'Document processing failed.',
      });
    } finally {
      setIsProcessing(false);
      setProcessingFileName(null);
    }
  };

  const handleRunSample = async (
    sample: 'expenses' | 'roster' | 'receipt' | 'oversized'
  ) => {
    try {
      const file =
        sample === 'receipt'
          ? await createSampleReceiptImageFile()
          : createSampleCsvFile(sample);
      await handleUploadFile(file);
    } catch (err) {
      setBanner({
        type: 'error',
        message: err instanceof Error ? err.message : 'Failed to prepare sample dataset.',
      });
    }
  };

  const handleExport = async (
    jobId: string,
    format: 'csv' | 'xlsx' | 'pdf' | 'certificate'
  ) => {
    setBanner(null);

    const targetJob =
      (activeJob?.id === jobId ? activeJob : jobs.find((j) => j.id === jobId)) || activeJob;
    if (!targetJob) {
      setBanner({ type: 'error', message: 'No active job selected for export.' });
      return;
    }

    const freeExhausted =
      !isPro &&
      !quota.canExportProFormats &&
      quota.freeCleansUsedThisMonth >= quota.freeCleansLimit;

    if (format === 'csv' && freeExhausted) {
      setPaywall({
        open: true,
        reason:
          'You have reached your Free tier monthly limit. Upgrade to Pro ($40/mo) or grab a $5 Token Pack to continue exporting.',
        code: 'EXPORT_LIMIT_REACHED',
      });
      return;
    }

    setExportingFormat(format);
    try {
      const { blob, fileName } = await downloadExportFile(targetJob, format);

      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);

      setBanner({
        type: 'success',
        message: `Downloaded ${fileName}.`,
      });
      await fetchAccountState();
    } catch (err) {
      if (err instanceof ApiBusinessError && (err.status === 402 || err.upgradeRequired)) {
        if (err.quota) setQuota(err.quota);
        setPaywall({
          open: true,
          reason: err.message,
          code: err.code,
        });
        return;
      }

      setBanner({
        type: 'error',
        message: err instanceof Error ? err.message : 'Export failed.',
      });
    } finally {
      setExportingFormat(null);
    }
  };

  const handleDemoQuotaMode = async (mode: 'reset_free' | 'exhaust_free') => {
    try {
      clearAllProTokensFromStorage();
      const data = await setDemoQuotaMode(mode);
      const normalized = enforceVerifiedSubscriptionOnQuota(data.quota);
      setQuota(normalized);
      setBanner({
        type: 'success',
        message:
          mode === 'exhaust_free'
            ? 'Simulated 3/3 Free monthly cleans exhausted. Try uploading or exporting to test the Paywall Guardrail.'
            : 'Account reset to Free tier (3 of 3 cleans remaining · Max 50 rows/file). All Pro tokens cleared.',
      });
      await fetchAccountState();
    } catch {
      setBanner({ type: 'error', message: 'Could not update demo quota state.' });
    }
  };

  return (
    <div className="flex h-screen overflow-hidden bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-slate-100">
      <Sidebar
        activeTab={activeTab}
        onSelectTab={setActiveTab}
        quota={quota}
        onOpenPaywall={(reason) => setPaywall({ open: true, reason })}
        onDemoQuotaMode={handleDemoQuotaMode}
        mobileOpen={mobileNavOpen}
        onCloseMobile={() => setMobileNavOpen(false)}
      />

      <div className="flex flex-1 flex-col min-w-0 overflow-hidden">
        <TopBar
          activeTab={activeTab}
          activeFileName={activeJob?.fileName}
          quota={quota}
          theme={theme}
          isProcessing={isProcessing}
          onToggleTheme={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))}
          onNewUpload={() => {
            setActiveJob(null);
            setActiveTab('workspace');
            setShowDropzone(true);
            setBanner(null);
          }}
          onUploadFile={handleUploadFile}
          onOpenSecurityBrief={() => setSecurityBriefOpen(true)}
          onOpenMobileNav={() => setMobileNavOpen(true)}
        />

        <main className="flex-1 overflow-y-auto px-4 sm:px-6 lg:px-8 py-6">
          <div className="mx-auto max-w-[1280px] space-y-6">
            {banner && (
              <div
                className={`flex items-center justify-between gap-3 rounded-xl border px-4 py-3 text-xs ${
                  banner.type === 'error'
                    ? 'border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950/40 text-red-800 dark:text-red-200'
                    : 'border-emerald-200 dark:border-emerald-900 bg-emerald-50 dark:bg-emerald-950/40 text-emerald-800 dark:text-emerald-200'
                }`}
              >
                <div className="flex items-center gap-2 min-w-0">
                  {banner.type === 'error' ? (
                    <AlertCircle className="h-4 w-4 shrink-0" />
                  ) : (
                    <CheckCircle2 className="h-4 w-4 shrink-0" />
                  )}
                  <span>{banner.message}</span>
                </div>
                <button
                  type="button"
                  onClick={() => setBanner(null)}
                  className="rounded p-1 hover:bg-black/5 dark:hover:bg-white/10"
                  aria-label="Dismiss notification"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            )}

            {activeTab === 'workspace' && (
              <div className="space-y-6">
                {(!activeJob || showDropzone || isProcessing) && (
                  <UploadDropzone
                    onUploadFile={handleUploadFile}
                    onRunSample={handleRunSample}
                    isProcessing={isProcessing}
                    processingFileName={processingFileName}
                    quota={quota}
                    compact={Boolean(activeJob) && !isProcessing}
                  />
                )}

                {activeJob && !isProcessing && (
                  <>
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div className="space-y-0.5">
                        <h1 className="text-lg font-bold text-slate-900 dark:text-slate-100">
                          {activeJob.fileName}
                        </h1>
                        <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
                          <span className="uppercase font-mono">{activeJob.fileType}</span>
                          <span aria-hidden="true">·</span>
                          <span className="capitalize">
                            {activeJob.documentCategory.replace('_', ' ')}
                          </span>
                          <span aria-hidden="true">·</span>
                          <span className="font-mono tabular-nums">
                            {new Date(activeJob.createdAt).toLocaleString('en-US')}
                          </span>
                        </div>
                      </div>

                      <div className="flex flex-wrap items-center gap-3">
                        <div
                          className="flex items-center gap-1 rounded-lg bg-slate-200/70 dark:bg-slate-800 p-1"
                          role="group"
                          aria-label="Workspace view mode"
                        >
                          {(
                            [
                              { id: 'table', label: 'Table', icon: Table2 },
                              { id: 'charts', label: 'Charts', icon: BarChart3 },
                              { id: 'split', label: 'Split View', icon: Columns2 },
                            ] as const
                          ).map((mode) => {
                            const Icon = mode.icon;
                            const active = workspaceView === mode.id;
                            return (
                              <button
                                key={mode.id}
                                type="button"
                                onClick={() => setWorkspaceView(mode.id)}
                                className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                                  active
                                    ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 shadow-xs'
                                    : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100'
                                }`}
                              >
                                <Icon className="h-3.5 w-3.5 shrink-0" />
                                <span>{mode.label}</span>
                              </button>
                            );
                          })}
                        </div>

                        {!showDropzone && (
                          <button
                            type="button"
                            onClick={() => setShowDropzone(true)}
                            className="rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-1.5 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors whitespace-nowrap shrink-0"
                          >
                            Upload Another File
                          </button>
                        )}
                      </div>
                    </div>

                    <AnomalyCards
                      job={activeJob}
                      onExport={handleExport}
                      exportingFormat={exportingFormat}
                    />

                    {(workspaceView === 'charts' || workspaceView === 'split') && (
                      <DataVisualizer job={activeJob} />
                    )}

                    {(workspaceView === 'table' || workspaceView === 'split') && (
                      <DataComparisonTable
                        job={activeJob}
                        quota={quota}
                        onExport={handleExport}
                        exportingFormat={exportingFormat}
                      />
                    )}
                  </>
                )}
              </div>
            )}

            {activeTab === 'history' && (
              <HistoryView
                jobs={jobs}
                usageLogs={usageLogs}
                onOpenJob={(job) => {
                  setActiveJob(job);
                  setShowDropzone(false);
                  setActiveTab('workspace');
                }}
                onExport={handleExport}
                onGoToUpload={() => {
                  setActiveTab('workspace');
                  setShowDropzone(true);
                }}
              />
            )}

            {activeTab === 'billing' && (
              <BillingWebhooksView
                quota={quota}
                onOpenPaywall={(reason) => setPaywall({ open: true, reason })}
                onQuotaUpdated={(nextQuota, message) => {
                  setQuota(nextQuota);
                  setBanner({ type: 'success', message });
                }}
              />
            )}
            <Footer
              onOpenLegal={(section) => setLegalModal({ open: true, section })}
            />
          </div>
        </main>
      </div>

      <PaywallModal
        context={paywall}
        quota={quota}
        onClose={() => setPaywall({ open: false, reason: '' })}
        onUpgradeComplete={(nextQuota, message) => {
          setQuota(nextQuota);
          setBanner({ type: 'success', message });
        }}
      />

      <LegalModal
        open={legalModal.open}
        activeSection={legalModal.section}
        onSelectSection={(section) => setLegalModal({ open: true, section })}
        onClose={() => setLegalModal((prev) => ({ ...prev, open: false }))}
      />

      <SecurityArchitectureModal
        open={securityBriefOpen}
        activeJob={activeJob}
        onClose={() => setSecurityBriefOpen(false)}
      />
    </div>
  );
}
