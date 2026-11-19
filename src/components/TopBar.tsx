import { Menu, Moon, Sun, Upload } from 'lucide-react';
import type { QuotaSnapshot } from '../types';
import type { ActiveTab } from './Sidebar';

interface TopBarProps {
  activeTab: ActiveTab;
  activeFileName?: string;
  quota: QuotaSnapshot | null;
  theme: 'light' | 'dark';
  onToggleTheme: () => void;
  onNewUpload: () => void;
  onOpenMobileNav: () => void;
}

export function TopBar({
  activeTab,
  activeFileName,
  theme,
  onToggleTheme,
  onNewUpload,
  onOpenMobileNav,
}: TopBarProps) {
  const sectionName =
    activeTab === 'workspace'
      ? 'Workspace'
      : activeTab === 'history'
      ? 'Audit History'
      : 'Plans & Webhooks';

  return (
    <header className="flex h-16 shrink-0 items-center justify-between gap-4 border-b border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-4 sm:px-6">
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

        <button
          type="button"
          onClick={onNewUpload}
          className="flex items-center gap-2 rounded-lg bg-slate-900 dark:bg-blue-600 px-3.5 py-2 text-xs font-semibold text-white hover:bg-slate-800 dark:hover:bg-blue-700 transition-colors whitespace-nowrap shrink-0"
        >
          <Upload className="h-3.5 w-3.5" />
          <span>Clean File</span>
        </button>
      </div>
    </header>
  );
}
