import { useState } from 'react';
import { Check, CreditCard, Loader2, ShieldCheck, X } from 'lucide-react';
import { completeSandboxCheckout, createCheckoutSession } from '../services/api';
import type { PaywallContext, QuotaSnapshot } from '../types';

interface PaywallModalProps {
  context: PaywallContext;
  quota: QuotaSnapshot | null;
  onClose: () => void;
  onUpgradeComplete: (quota: QuotaSnapshot, message: string) => void;
}

export function PaywallModal({
  context,
  quota,
  onClose,
  onUpgradeComplete,
}: PaywallModalProps) {
  const [selectedPlan, setSelectedPlan] = useState<'pro' | 'token_pack'>('pro');
  const [provider, setProvider] = useState<'stripe' | 'lemonsqueezy'>('stripe');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!context.open) return null;

  const handleCheckout = async () => {
    setSubmitting(true);
    setError(null);
    try {
      await createCheckoutSession({ plan: selectedPlan, provider });
      const data = await completeSandboxCheckout({ plan: selectedPlan, provider });

      onUpgradeComplete(
        data.quota,
        data.message || 'Plan upgraded successfully.'
      );
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Payment processing failed.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/70 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="paywall-title"
    >
      <div className="w-full max-w-2xl rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="flex items-start justify-between gap-4 border-b border-slate-200 dark:border-slate-800 px-6 py-5">
          <div className="space-y-1">
            <h2
              id="paywall-title"
              className="text-lg font-bold text-slate-900 dark:text-slate-100"
            >
              Upgrade DocuCleanse to Continue
            </h2>
            <p className="text-xs leading-relaxed text-slate-600 dark:text-slate-300">
              {context.reason}
            </p>
          </div>

          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-800 dark:hover:text-slate-200"
            aria-label="Close upgrade modal"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Plan Options */}
        <div className="p-6 space-y-5">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {/* Pro Monthly */}
            <button
              type="button"
              onClick={() => setSelectedPlan('pro')}
              className={`text-left rounded-xl border p-4 transition-colors ${
                selectedPlan === 'pro'
                  ? 'border-blue-600 bg-blue-50/40 dark:border-blue-500 dark:bg-blue-950/30'
                  : 'border-slate-200 dark:border-slate-800 hover:border-slate-300 dark:hover:border-slate-700'
              }`}
            >
              <div className="flex items-baseline justify-between">
                <span className="text-sm font-bold text-slate-900 dark:text-slate-100">
                  Pro Subscription
                </span>
                <span className="font-mono text-lg font-bold tabular-nums text-slate-900 dark:text-slate-100">
                  $19<span className="text-xs font-normal text-slate-500">/mo</span>
                </span>
              </div>
              <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                For agencies, bookkeepers &amp; scaling operations
              </p>
              <ul className="mt-4 space-y-2 text-xs text-slate-700 dark:text-slate-300">
                <li className="flex items-center gap-2">
                  <Check className="h-3.5 w-3.5 text-blue-600 dark:text-blue-400 shrink-0" />
                  <span>Unlimited file cleans &amp; unlimited rows</span>
                </li>
                <li className="flex items-center gap-2">
                  <Check className="h-3.5 w-3.5 text-blue-600 dark:text-blue-400 shrink-0" />
                  <span>Multi-sheet XLSX &amp; Executive Summary PDF</span>
                </li>
                <li className="flex items-center gap-2">
                  <Check className="h-3.5 w-3.5 text-blue-600 dark:text-blue-400 shrink-0" />
                  <span>Excel formula error &amp; schema audit log</span>
                </li>
              </ul>
            </button>

            {/* Pay-Per-Use Token Pack */}
            <button
              type="button"
              onClick={() => setSelectedPlan('token_pack')}
              className={`text-left rounded-xl border p-4 transition-colors ${
                selectedPlan === 'token_pack'
                  ? 'border-blue-600 bg-blue-50/40 dark:border-blue-500 dark:bg-blue-950/30'
                  : 'border-slate-200 dark:border-slate-800 hover:border-slate-300 dark:hover:border-slate-700'
              }`}
            >
              <div className="flex items-baseline justify-between">
                <span className="text-sm font-bold text-slate-900 dark:text-slate-100">
                  Pay-Per-Use Pack
                </span>
                <span className="font-mono text-lg font-bold tabular-nums text-slate-900 dark:text-slate-100">
                  $5<span className="text-xs font-normal text-slate-500"> once</span>
                </span>
              </div>
              <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                For occasional freelancers &amp; quarterly closes
              </p>
              <ul className="mt-4 space-y-2 text-xs text-slate-700 dark:text-slate-300">
                <li className="flex items-center gap-2">
                  <Check className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400 shrink-0" />
                  <span>15 Pro-grade file clean tokens (no expiry)</span>
                </li>
                <li className="flex items-center gap-2">
                  <Check className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400 shrink-0" />
                  <span>Unlocks XLSX &amp; Executive Summary PDF</span>
                </li>
                <li className="flex items-center gap-2">
                  <Check className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400 shrink-0" />
                  <span>Bypass 50-row Free tier cap</span>
                </li>
              </ul>
            </button>
          </div>

          {/* Payment Gateway Selector */}
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950 px-4 py-3">
            <div className="flex items-center gap-2 text-xs text-slate-600 dark:text-slate-300">
              <ShieldCheck className="h-4 w-4 text-emerald-600 dark:text-emerald-400 shrink-0" />
              <span>Checkout provider (Sandbox webhook connected)</span>
            </div>
            <div className="flex items-center gap-1 rounded-md bg-slate-200/70 dark:bg-slate-800 p-0.5 self-start sm:self-center">
              <button
                type="button"
                onClick={() => setProvider('stripe')}
                className={`rounded px-2.5 py-1 text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                  provider === 'stripe'
                    ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 shadow-xs'
                    : 'text-slate-600 dark:text-slate-400'
                }`}
              >
                Stripe
              </button>
              <button
                type="button"
                onClick={() => setProvider('lemonsqueezy')}
                className={`rounded px-2.5 py-1 text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                  provider === 'lemonsqueezy'
                    ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 shadow-xs'
                    : 'text-slate-600 dark:text-slate-400'
                }`}
              >
                Lemon Squeezy
              </button>
            </div>
          </div>

          {error && (
            <div className="rounded-lg border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950/40 px-4 py-2.5 text-xs text-red-700 dark:text-red-300">
              {error}
            </div>
          )}

          {/* Footer CTA */}
          <div className="flex items-center justify-end gap-3 pt-1">
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg border border-slate-200 dark:border-slate-700 px-4 py-2 text-xs font-medium text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors whitespace-nowrap shrink-0"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={submitting}
              onClick={handleCheckout}
              className="flex items-center gap-2 rounded-lg bg-blue-600 px-5 py-2 text-xs font-semibold text-white hover:bg-blue-700 transition-colors whitespace-nowrap shrink-0 disabled:opacity-60"
            >
              {submitting ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <CreditCard className="h-3.5 w-3.5" />
              )}
              <span>
                {submitting
                  ? 'Completing Checkout...'
                  : selectedPlan === 'pro'
                  ? `Activate Pro ($19/mo) via ${provider === 'stripe' ? 'Stripe' : 'Lemon Squeezy'}`
                  : `Buy 15 Tokens ($5) via ${provider === 'stripe' ? 'Stripe' : 'Lemon Squeezy'}`}
              </span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
