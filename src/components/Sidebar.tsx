import {
  CreditCard,
  FileSpreadsheet,
  History,
  RotateCcw,
  ShieldAlert,
  Sparkles,
  X,
} from 'lucide-react';
import type { QuotaSnapshot } from '../types';

export type ActiveTab = 'workspace' | 'history' | 'billing';

interface SidebarProps {
  activeTab: ActiveTab;
  onSelectTab: (tab: ActiveTab) => void;
  quota: QuotaSnapshot | null;
  onOpenPaywall: (reason: string) => void;
  onDemoQuotaMode: (mode: 'reset_free' | 'exhaust_free') => void;
  mobileOpen: boolean;
  onCloseMobile: () => void;
}

export function Sidebar({
  activeTab,
  onSelectTab,
  quota,
  onOpenPaywall,
  onDemoQuotaMode,
  mobileOpen,
  onCloseMobile,
}: SidebarProps) {
  const navItems: Array<{ id: ActiveTab; label: string; icon: typeof FileSpreadsheet }> = [
    { id: 'workspace', label: 'Data Cleaner', icon: FileSpreadsheet },
    { id: 'history', label: 'Audit History', icon: History },
    { id: 'billing', label: 'Plans & Webhooks', icon: CreditCard },
  ];

  const freeUsed = quota?.freeCleansUsedThisMonth ?? 0;
  const freeLimit = quota?.freeCleansLimit ?? 3;
  const progressPct =
    quota?.plan === 'pro'
      ? 100
      : Math.min(100, Math.round((freeUsed / Math.max(1, freeLimit)) * 100));

  const content = (
    <div className="flex h-full flex-col justify-between bg-white dark:bg-slate-900 border-r border-slate-200 dark:border-slate-800 px-4 py-5">
      <div>
        <div className="flex items-center justify-between px-2 pb-6">
          <div className="flex items-center gap-2.5">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-blue-600 text-white font-display font-bold text-sm">
              DC
            </div>
            <span className="font-display text-lg font-bold tracking-tight text-slate-900 dark:text-slate-100 whitespace-nowrap shrink-0">
              DocuCleanse
            </span>
          </div>
          <button
            type="button"
            onClick={onCloseMobile}
            className="lg:hidden rounded-md p-1.5 text-slate-500 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800"
            aria-label="Close navigation"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <nav className="space-y-1" aria-label="Main Navigation">
          {navItems.map((item) => {
            const Icon = item.icon;
            const active = activeTab === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => {
                  onSelectTab(item.id);
                  onCloseMobile();
                }}
                className={`flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors whitespace-nowrap shrink-0 ${
                  active
                    ? 'bg-blue-50 text-blue-700 dark:bg-blue-950/60 dark:text-blue-300'
                    : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900 dark:text-slate-400 dark:hover:bg-slate-800/70 dark:hover:text-slate-100'
                }`}
              >
                <Icon className="h-4 w-4 shrink-0" />
                <span>{item.label}</span>
              </button>
            );
          })}
        </nav>
      </div>

      <div className="space-y-4 border-t border-slate-200 dark:border-slate-800 pt-4">
        <div className="space-y-2.5 px-1">
          <div className="flex items-center justify-between text-xs">
            <span className="font-semibold text-slate-900 dark:text-slate-100">
              {quota?.plan === 'pro'
                ? 'Pro Subscription'
                : quota?.tokenBalance && quota.tokenBalance > 0
                ? 'Token Pack Active'
                : 'Free Tier'}
            </span>
            <span className="font-mono tabular-nums text-slate-500 dark:text-slate-400">
              {quota?.plan === 'pro'
                ? 'Unlimited'
                : quota?.tokenBalance && quota.tokenBalance > 0
                ? `${quota.tokenBalance} tokens`
                : `${freeUsed}/${freeLimit} used`}
            </span>
          </div>

          <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-200 dark:bg-slate-800">
            <div
              className={`h-full transition-all duration-200 ${
                quota?.plan === 'pro'
                  ? 'bg-emerald-600'
                  : freeUsed >= freeLimit && (quota?.tokenBalance ?? 0) === 0
                  ? 'bg-red-600'
                  : 'bg-blue-600'
              }`}
              style={{ width: `${progressPct}%` }}
            />
          </div>

          <p className="text-xs leading-relaxed text-slate-500 dark:text-slate-400">
            {quota?.plan === 'pro'
              ? 'Unlimited rows, XLSX workbooks & PDF reports enabled.'
              : quota?.tokenBalance && quota.tokenBalance > 0
              ? 'Pro exports & unlimited rows enabled via Token Pack.'
              : `Up to ${quota?.freeRowLimit ?? 50} rows/file · CSV export`}
          </p>

          {quota?.plan !== 'pro' && (
            <button
              type="button"
              onClick={() =>
                onOpenPaywall(
                  'Unlock unlimited file cleans, 50+ row spreadsheets, XLSX workbooks, and Executive Summary PDFs.'
                )
              }
              className="mt-1 flex w-full items-center justify-center gap-2 rounded-lg bg-blue-600 px-3 py-2 text-xs font-semibold text-white transition-colors hover:bg-blue-700 whitespace-nowrap shrink-0"
            >
              <Sparkles className="h-3.5 w-3.5" />
              <span>Upgrade to Pro ($40/mo)</span>
            </button>
          )}
        </div>

        <div className="border-t border-slate-200 dark:border-slate-800 pt-3 px-1 space-y-1.5">
          <div className="text-[11px] font-medium text-slate-500 dark:text-slate-400">
            Quota Guardrail Testing
          </div>
          <div className="grid grid-cols-2 gap-1.5">
            <button
              type="button"
              onClick={() => onDemoQuotaMode('exhaust_free')}
              className="flex items-center justify-center gap-1 rounded-md border border-slate-200 dark:border-slate-700 px-2 py-1.5 text-[11px] font-medium text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors whitespace-nowrap shrink-0"
              title="Simulate 3/3 free cleans exhausted"
            >
              <ShieldAlert className="h-3 w-3 text-amber-600 dark:text-amber-400" />
              <span>Hit Limit</span>
            </button>
            <button
              type="button"
              onClick={() => onDemoQuotaMode('reset_free')}
              className="flex items-center justify-center gap-1 rounded-md border border-slate-200 dark:border-slate-700 px-2 py-1.5 text-[11px] font-medium text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors whitespace-nowrap shrink-0"
              title="Reset account to fresh Free tier (0/3 used)"
            >
              <RotateCcw className="h-3 w-3 text-slate-500" />
              <span>Reset Free</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );

  return (
    <>
      <aside className="hidden lg:block w-64 shrink-0">{content}</aside>

      {mobileOpen && (
        <div className="fixed inset-0 z-50 flex lg:hidden">
          <div
            className="fixed inset-0 bg-slate-950/60"
            onClick={onCloseMobile}
            aria-hidden="true"
          />
          <div className="relative z-10 w-64 max-w-[80vw] h-full">{content}</div>
        </div>
      )}
    </>
  );
}
