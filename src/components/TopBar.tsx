import { useRef } from 'react';
import { ChevronRight, Loader2, Menu, Moon, Plus, ShieldCheck, Sun, Upload } from 'lucide-react';
import type { QuotaSnapshot } from '../types';
import type { ActiveTab } from './Sidebar';

interface TopBarProps {
  activeTab: ActiveTab;
  activeFileName?: string;
  quota: QuotaSnapshot | null;
  theme: 'light' | 'dark';
  isProcessing?: boolean;
  onToggleTheme: () => void;
  onNewUpload: () => void;
  onUploadFile?: (file: File) => void;
  onOpenSecurityBrief: () => void;
  onOpenMobileNav: () => void;
}

export function TopBar({
  activeTab,
  activeFileName,
  theme,
  isProcessing = false,
  onToggleTheme,
  onNewUpload,
  onUploadFile,
  onOpenSecurityBrief,
  onOpenMobileNav,
}: TopBarProps) {
  const quickFileInputRef = useRef<HTMLInputElement | null>(null);

  const sectionName =
    activeTab === 'workspace'
      ? 'Workspace'
      : activeTab === 'history'
      ? 'Audit History'
      : 'Plans & Webhooks';

  const isOnCleanUploadScreen = activeTab === 'workspace' && !activeFileName;

  const handleCleanButtonClick = () => {
    if (isProcessing) return;
    if (isOnCleanUploadScreen && onUploadFile) {
      quickFileInputRef.current?.click();
      return;
    }
    onNewUpload();
  };

  return (
    <header className="shrink-0 border-b border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900">
      <div className="flex h-16 items-center justify-between gap-4 px-4 sm:px-6">
        <div className="flex items-center gap-3 min-w-0">
          <button
            type="button"
            onClick={onOpenMobileNav}
            className="lg:hidden rounded-md p-2 text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800"
            aria-label="Open navigation"
          >
            <Menu className="h-5 w-5" />
          </button>

          <nav aria-label="Breadcrumb" className="flex items-center gap-2 text-sm min-w-0">
            <span className="font-medium text-slate-500 dark:text-slate-400 whitespace-nowrap shrink-0">
              DocuCleanse
            </span>
            <span className="text-slate-400 dark:text-slate-600" aria-hidden="true">
              /
            </span>
            <span className="font-semibold text-slate-900 dark:text-slate-100 whitespace-nowrap shrink-0">
              {sectionName}
            </span>
            {activeTab === 'workspace' && activeFileName && (
              <>
                <span className="hidden sm:inline text-slate-400 dark:text-slate-600" aria-hidden="true">
                  /
                </span>
                <span className="hidden sm:inline truncate max-w-xs font-mono text-xs text-slate-600 dark:text-slate-300">
                  {activeFileName}
                </span>
              </>
            )}
          </nav>
        </div>

        <div className="flex items-center gap-3 shrink-0">
          <span className="hidden sm:inline text-xs font-medium text-slate-600 dark:text-slate-300 whitespace-nowrap">
            Rafi Digital Studio
          </span>

          <button
            type="button"
            onClick={onToggleTheme}
            className="flex h-9 w-9 items-center justify-center rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
            aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
            title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
          >
            {theme === 'dark' ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
          </button>

          <input
            ref={quickFileInputRef}
            type="file"
            accept=".csv,.xlsx,.xls,.pdf,.png,.jpg,.jpeg,.webp"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file && onUploadFile) {
                onUploadFile(file);
              }
              e.target.value = '';
            }}
          />

          <button
            type="button"
            disabled={isProcessing}
            onClick={handleCleanButtonClick}
            className="group relative inline-flex h-9 items-center gap-2 overflow-hidden rounded-lg bg-gradient-to-r from-blue-600 via-blue-600 to-indigo-600 px-4 text-xs font-semibold text-white shadow-sm shadow-blue-600/25 ring-1 ring-inset ring-white/20 transition-all duration-200 hover:-translate-y-0.5 hover:from-blue-500 hover:via-blue-600 hover:to-indigo-500 hover:shadow-md hover:shadow-blue-600/35 active:translate-y-0 active:scale-[0.98] disabled:pointer-events-none disabled:opacity-75 whitespace-nowrap shrink-0 cursor-pointer"
          >
            <span
              aria-hidden="true"
              className="pointer-events-none absolute inset-0 -translate-x-full bg-gradient-to-r from-transparent via-white/25 to-transparent transition-transform duration-700 ease-out group-hover:translate-x-full"
            />
            {isProcessing ? (
              <Loader2 className="relative h-3.5 w-3.5 animate-spin shrink-0" />
            ) : activeFileName ? (
              <Plus className="relative h-3.5 w-3.5 transition-transform duration-200 group-hover:rotate-90 shrink-0" />
            ) : (
              <Upload className="relative h-3.5 w-3.5 transition-transform duration-200 group-hover:-translate-y-0.5 shrink-0" />
            )}
            <span className="relative">
              {isProcessing
                ? 'Cleaning...'
                : activeFileName
                ? 'Clean New File'
                : 'Clean File'}
            </span>
          </button>
        </div>
      </div>

      {/* Interactive Enterprise Compliance & Zero-Retention Security Strip */}
      <div className="border-t border-slate-100 dark:border-slate-800/80 bg-slate-50/80 dark:bg-slate-950/60 px-4 sm:px-6 py-1.5">
        <div className="flex items-center justify-between gap-3">
          <button
            type="button"
            onClick={onOpenSecurityBrief}
            className="group flex items-center gap-2 text-left text-[11px] text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100 transition-colors min-w-0 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 rounded"
            aria-label="Open Security and Architecture Brief"
          >
            <ShieldCheck className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400 shrink-0" />
            <span className="truncate">
              <span className="font-semibold text-slate-700 dark:text-slate-200 group-hover:text-blue-600 dark:group-hover:text-sky-400 transition-colors">
                Enterprise Privacy Shield:
              </span>{' '}
              Ephemeral RAM Processing · Zero Permanent Data Storage · GDPR &amp; Pre-Audit Ready
            </span>
          </button>

          <button
            type="button"
            onClick={onOpenSecurityBrief}
            className="hidden sm:inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[11px] font-medium text-blue-600 dark:text-sky-400 hover:bg-blue-50 dark:hover:bg-sky-950/50 transition-colors whitespace-nowrap shrink-0"
          >
            <span>Security &amp; Architecture Brief</span>
            <ChevronRight className="h-3 w-3 shrink-0" />
          </button>
        </div>
      </div>
    </header>
  );
}
