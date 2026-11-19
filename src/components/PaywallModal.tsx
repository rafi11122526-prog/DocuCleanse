import { useCallback, useEffect, useRef, useState } from 'react';
import { initializePaddle, type Paddle } from '@paddle/paddle-js';
import { Check, CreditCard, Loader2, Lock, ShieldCheck, X } from 'lucide-react';
import {
  completeSandboxCheckout,
  createCheckoutSession,
  DEMO_USER_ID,
} from '../services/api';
import type { PaywallContext, QuotaSnapshot } from '../types';

interface PaywallModalProps {
  context: PaywallContext;
  quota: QuotaSnapshot | null;
  onClose: () => void;
  onUpgradeComplete: (quota: QuotaSnapshot, message: string) => void;
}

const ACTIVE_PADDLE_PRO_PRICE_ID = 'pri_01m7r5t4g1487ktfj68gzrs431';
const ACTIVE_PADDLE_TOKEN_PACK_PRICE_ID = 'pri_01m7s0y3v873p7gxwr0v1ggc6c';

function resolveValidPaddlePriceId(value: string | undefined, fallback: string): string {
  const trimmed = value?.trim();
  // Real Paddle Billing price IDs follow ULID format: pri_ + 26 lowercase alphanumeric chars
  if (trimmed && /^pri_[a-z0-9]{20,}$/.test(trimmed)) {
    return trimmed;
  }
  return fallback;
}

const PADDLE_CLIENT_TOKEN = (
  (import.meta.env.VITE_PADDLE_CLIENT_TOKEN as string | undefined) || ''
).trim();

const PADDLE_PRO_PRICE_ID = resolveValidPaddlePriceId(
  import.meta.env.VITE_PADDLE_PRO_PRICE_ID as string | undefined,
  ACTIVE_PADDLE_PRO_PRICE_ID
);
const PADDLE_TOKEN_PACK_PRICE_ID = resolveValidPaddlePriceId(
  import.meta.env.VITE_PADDLE_TOKEN_PACK_PRICE_ID as string | undefined,
  ACTIVE_PADDLE_TOKEN_PACK_PRICE_ID
);

function isConfiguredPaddleToken(token: string): boolean {
  if (!token || /placeholder|your_client_token/i.test(token)) return false;
  // Paddle Billing client-side tokens begin with "test_" (sandbox) or "live_" (production)
  return /^(test|live)_[a-zA-Z0-9]{10,}$/.test(token);
}

// Default to 'sandbox' unless production is explicitly configured with a live_ client token
const PADDLE_ENV: 'sandbox' | 'production' =
  import.meta.env.VITE_PADDLE_ENV === 'production' && PADDLE_CLIENT_TOKEN.startsWith('live_')
    ? 'production'
    : 'sandbox';

export function PaywallModal({
  context,
  quota,
  onClose,
  onUpgradeComplete,
}: PaywallModalProps) {
  const hasValidPaddleToken = isConfiguredPaddleToken(PADDLE_CLIENT_TOKEN);
  const [selectedPlan, setSelectedPlan] = useState<'pro' | 'token_pack'>('pro');
  const [paddle, setPaddle] = useState<Paddle | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selectedPlanRef = useRef<'pro' | 'token_pack'>(selectedPlan);
  selectedPlanRef.current = selectedPlan;
  const paddleRef = useRef<Paddle | null>(paddle);
  paddleRef.current = paddle;

  const completeCheckoutSync = useCallback(
    async (plan: 'pro' | 'token_pack') => {
      const data = await completeSandboxCheckout({ plan, provider: 'paddle' });
      onUpgradeComplete(data.quota, data.message || 'Plan upgraded successfully.');
      onClose();
    },
    [onUpgradeComplete, onClose]
  );

  const ensurePaddleInstance = useCallback(async (): Promise<Paddle | null> => {
    if (paddleRef.current) return paddleRef.current;
    if (!hasValidPaddleToken) return null;

    try {
      const instance = await initializePaddle({
        environment: PADDLE_ENV,
        token: PADDLE_CLIENT_TOKEN,
        eventCallback: (event) => {
          const eventName = String(event.name || '');

          if (eventName === 'checkout.completed') {
            const eventData = event.data as
              | { custom_data?: { plan?: 'pro' | 'token_pack' } }
              | undefined;
            const completedPlan =
              eventData?.custom_data?.plan || selectedPlanRef.current;

            void completeCheckoutSync(completedPlan).catch((err) => {
              console.error('[Paddle Post-Checkout Sync Error]', err);
            });
            return;
          }

          const rawEvent = event as unknown as Record<string, unknown>;
          const nestedError = rawEvent.error;

          if (
            eventName === 'checkout.error' ||
            eventName === 'checkout.failed' ||
            eventName === 'checkout.payment.error' ||
            eventName.includes('error') ||
            Boolean(nestedError) ||
            Boolean(event.code)
          ) {
            const activePriceId =
              selectedPlanRef.current === 'pro'
                ? PADDLE_PRO_PRICE_ID
                : PADDLE_TOKEN_PACK_PRICE_ID;

            console.error('[Paddle Checkout Error]', {
              eventName,
              environment: PADDLE_ENV,
              priceId: activePriceId,
              error: nestedError,
              detail: event.detail,
              code: event.code,
              payload: event,
            });

            try {
              paddleRef.current?.Checkout.close();
            } catch {
              // Ignore close errors if overlay already closed
            }

            const detail =
              (typeof event.detail === 'string' && event.detail) ||
              (nestedError && typeof nestedError === 'object' && 'detail' in nestedError
                ? String((nestedError as { detail?: unknown }).detail || '')
                : '') ||
              'Checkout could not be initialized. Please try again in a moment.';

            setError(detail);
            setSubmitting(false);
          }
        },
      });

      if (instance) {
        paddleRef.current = instance;
        setPaddle(instance);
        return instance;
      }
      return null;
    } catch (err) {
      console.error('[Paddle Initialize Error]', {
        environment: PADDLE_ENV,
        hasToken: hasValidPaddleToken,
        error: err,
      });
      return null;
    }
  }, [hasValidPaddleToken, completeCheckoutSync]);

  useEffect(() => {
    if (!context.open || paddle || !hasValidPaddleToken) {
      return;
    }
    void ensurePaddleInstance();
  }, [context.open, paddle, hasValidPaddleToken, ensurePaddleInstance]);

  if (!context.open) return null;

  const handleCheckout = async () => {
    setSubmitting(true);
    setError(null);
    try {
      const userId = quota?.userId || DEMO_USER_ID;
      const priceId =
        selectedPlan === 'pro' ? PADDLE_PRO_PRICE_ID : PADDLE_TOKEN_PACK_PRICE_ID;

      const session = await createCheckoutSession({
        plan: selectedPlan,
        provider: 'paddle',
      });

      if (session.paddleFallbackReason) {
        console.error('[Paddle Server Checkout Error]', {
          environment: PADDLE_ENV,
          priceId,
          reason: session.paddleFallbackReason,
        });
      }

      if (hasValidPaddleToken) {
        const paddleInstance = await ensurePaddleInstance();
        if (paddleInstance) {
          const theme = document.documentElement.classList.contains('dark') ? 'dark' : 'light';
          try {
            if (session.transactionId) {
              paddleInstance.Checkout.open({
                transactionId: session.transactionId,
                settings: { displayMode: 'overlay', theme },
              });
            } else {
              paddleInstance.Checkout.open({
                items: [{ priceId, quantity: 1 }],
                customData: {
                  userId,
                  plan: selectedPlan,
                },
                settings: { displayMode: 'overlay', theme },
              });
            }
            setSubmitting(false);
            return;
          } catch (openErr) {
            console.error('[Paddle Checkout.open Error]', {
              environment: PADDLE_ENV,
              priceId,
              error: openErr,
            });
            setError('Unable to open the checkout overlay. Please try again.');
            setSubmitting(false);
            return;
          }
        }
      }

      // Graceful fallback when client token is not configured in the current environment
      await completeCheckoutSync(selectedPlan);
    } catch (err) {
      console.error('[Paddle Checkout Flow Error]', err);
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
        {/* Streamlined Production Header */}
        <div className="flex items-start justify-between gap-4 border-b border-slate-200 dark:border-slate-800 px-6 py-5">
          <div className="flex items-start gap-3.5 min-w-0">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-blue-200 dark:border-blue-900/70 bg-blue-50 dark:bg-blue-950/50 text-blue-600 dark:text-blue-400">
              <Lock className="h-5 w-5" />
            </div>
            <div className="space-y-1 min-w-0">
              <h2
                id="paywall-title"
                className="text-lg font-bold tracking-tight text-slate-900 dark:text-slate-100"
              >
                DocuCleanse Pro — Unlock Unlimited Exports
              </h2>
              {context.reason && (
                <p className="text-xs leading-relaxed text-slate-600 dark:text-slate-300">
                  {context.reason}
                </p>
              )}
            </div>
          </div>

          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-800 dark:hover:text-slate-200 shrink-0"
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
                  $29<span className="text-xs font-normal text-slate-500">/mo</span>
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

          {error && (
            <div className="rounded-lg border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950/40 px-4 py-2.5 text-xs text-red-700 dark:text-red-300">
              {error}
            </div>
          )}

          {/* Footer Security Assurance & Primary Paddle Checkout Action */}
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-t border-slate-200 dark:border-slate-800 pt-4">
            <div className="flex items-center gap-2 text-[11px] text-slate-500 dark:text-slate-400">
              <ShieldCheck className="h-4 w-4 text-emerald-600 dark:text-emerald-400 shrink-0" />
              <span>Secured by Paddle · Instant access · 14-day money-back guarantee</span>
            </div>

            <div className="flex items-center justify-end gap-3">
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
                    ? 'Opening Checkout...'
                    : selectedPlan === 'pro'
                    ? 'Upgrade to Pro ($29/mo)'
                    : 'Buy 15 Tokens ($5)'}
                </span>
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
