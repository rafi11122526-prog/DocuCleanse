import { useEffect, useState } from 'react';
import { CreditCard, Send, Terminal } from 'lucide-react';
import { dispatchTestWebhook, fetchBillingStatus } from '../services/api';
import type { BillingEvent, QuotaSnapshot } from '../types';

interface BillingWebhooksViewProps {
  quota: QuotaSnapshot | null;
  onOpenPaywall: (reason: string) => void;
  onQuotaUpdated: (quota: QuotaSnapshot, message: string) => void;
}

type PaddleEventKind = 'subscription.activated' | 'transaction.completed' | 'subscription.canceled';

export function BillingWebhooksView({
  quota,
  onOpenPaywall,
  onQuotaUpdated,
}: BillingWebhooksViewProps) {
  const [events, setEvents] = useState<BillingEvent[]>([]);
  const [provider, setProvider] = useState<'paddle' | 'stripe'>('paddle');
  const [paddleEventKind, setPaddleEventKind] =
    useState<PaddleEventKind>('subscription.activated');
  const [stripeTier, setStripeTier] = useState<'pro' | 'token_pack'>('pro');
  const [testingWebhook, setTestingWebhook] = useState(false);
  const [lastWebhookResponse, setLastWebhookResponse] = useState<string | null>(null);

  const loadBillingStatus = async () => {
    try {
      const data = await fetchBillingStatus();
      setEvents(data.events || []);
    } catch {
      // ignore transient error
    }
  };

  useEffect(() => {
    loadBillingStatus();
  }, [quota?.plan, quota?.tokenBalance]);

  const samplePayload =
    provider === 'paddle'
      ? {
          event_id: 'evt_pdl_test_2026',
          event_type: paddleEventKind,
          data: {
            custom_data: {
              userId: quota?.userId || 'usr_demo_freelancer',
              plan:
                paddleEventKind === 'transaction.completed'
                  ? 'token_pack'
                  : paddleEventKind === 'subscription.canceled'
                  ? 'free'
                  : 'pro',
              tokensToAdd: paddleEventKind === 'transaction.completed' ? 15 : 0,
            },
            details: {
              totals: {
                total:
                  paddleEventKind === 'transaction.completed'
                    ? '500'
                    : paddleEventKind === 'subscription.canceled'
                    ? '0'
                    : '2900',
              },
            },
            items: [
              {
                price: {
                  id:
                    paddleEventKind === 'transaction.completed'
                      ? /^pri_[a-z0-9]{20,}$/.test(
                          String(import.meta.env.VITE_PADDLE_TOKEN_PACK_PRICE_ID || '').trim()
                        )
                        ? String(import.meta.env.VITE_PADDLE_TOKEN_PACK_PRICE_ID).trim()
                        : 'pri_01m7s0y3v873p7gxwr0v1ggc6c'
                      : /^pri_[a-z0-9]{20,}$/.test(
                          String(import.meta.env.VITE_PADDLE_PRO_PRICE_ID || '').trim()
                        )
                      ? String(import.meta.env.VITE_PADDLE_PRO_PRICE_ID).trim()
                      : 'pri_01m7r5t4g1487ktfj68gzrs431',
                },
              },
            ],
          },
        }
      : {
          id: 'evt_stripe_test_2026',
          type: 'checkout.session.completed',
          data: {
            object: {
              amount_total: stripeTier === 'pro' ? 2900 : 500,
              metadata: {
                userId: quota?.userId || 'usr_demo_freelancer',
                tier: stripeTier,
                tokensToAdd: stripeTier === 'token_pack' ? 15 : 0,
              },
            },
          },
        };

  const handleDispatchWebhook = async () => {
    setTestingWebhook(true);
    try {
      const data = await dispatchTestWebhook(provider, samplePayload);
      setLastWebhookResponse(JSON.stringify(data, null, 2));
      if (data.quota) {
        const label =
          provider === 'paddle'
            ? paddleEventKind
            : stripeTier === 'pro'
            ? 'Pro ($29/mo)'
            : '15-Token Pack ($5)';
        onQuotaUpdated(data.quota, `Processed ${provider} webhook (${label}).`);
      }
      await loadBillingStatus();
    } catch (err) {
      setLastWebhookResponse(
        JSON.stringify(
          { error: err instanceof Error ? err.message : 'Webhook failed' },
          null,
          2
        )
      );
    } finally {
      setTestingWebhook(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold text-slate-900 dark:text-slate-100">
            Plans, Limits &amp; Payment Webhooks
          </h1>
          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
            Transparent unit economics, quota enforcement, and live Paddle Billing / Stripe webhook handlers.
          </p>
        </div>

        <button
          type="button"
          onClick={() =>
            onOpenPaywall('Select a Pro subscription or Pay-Per-Use Token Pack.')
          }
          className="flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-xs font-semibold text-white hover:bg-blue-700 transition-colors whitespace-nowrap shrink-0 self-start"
        >
          <CreditCard className="h-3.5 w-3.5" />
          <span>Open Checkout Modal</span>
        </button>
      </div>

      {/* Concrete Tier Matrix */}
      <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-x-auto">
        <table className="w-full text-left border-collapse">
          <thead>
            <tr className="border-b border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950/60 text-xs font-semibold text-slate-600 dark:text-slate-300">
              <th className="py-3.5 px-5">Capability</th>
              <th className="py-3.5 px-5">Free Starter (For Solo Evaluation)</th>
              <th className="py-3.5 px-5">Token Pack (For Occasional Closes)</th>
              <th className="py-3.5 px-5 text-blue-600 dark:text-blue-400">
                Pro Tier (For Agencies &amp; Accounting)
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-200 dark:divide-slate-800 text-xs">
            <tr>
              <td className="py-3 px-5 font-medium text-slate-900 dark:text-slate-100">Pricing</td>
              <td className="py-3 px-5 font-mono tabular-nums">$0 / month</td>
              <td className="py-3 px-5 font-mono tabular-nums">$5 one-time (15 cleans)</td>
              <td className="py-3 px-5 font-mono tabular-nums font-semibold">$29 / month</td>
            </tr>
            <tr>
              <td className="py-3 px-5 font-medium text-slate-900 dark:text-slate-100">
                Monthly Clean Quota
              </td>
              <td className="py-3 px-5 font-mono tabular-nums">3 file cleans / month</td>
              <td className="py-3 px-5 font-mono tabular-nums">15 non-expiring tokens</td>
              <td className="py-3 px-5 font-mono tabular-nums">Unlimited cleans</td>
            </tr>
            <tr>
              <td className="py-3 px-5 font-medium text-slate-900 dark:text-slate-100">
                Max Rows Per File
              </td>
              <td className="py-3 px-5 font-mono tabular-nums">50 rows</td>
              <td className="py-3 px-5 font-mono tabular-nums">Unlimited rows</td>
              <td className="py-3 px-5 font-mono tabular-nums">Unlimited rows</td>
            </tr>
            <tr>
              <td className="py-3 px-5 font-medium text-slate-900 dark:text-slate-100">
                Export Formats
              </td>
              <td className="py-3 px-5">Clean CSV</td>
              <td className="py-3 px-5">CSV, Multi-sheet XLSX, Summary PDF</td>
              <td className="py-3 px-5">CSV, Multi-sheet XLSX, Summary PDF</td>
            </tr>
            <tr>
              <td className="py-3 px-5 font-medium text-slate-900 dark:text-slate-100">
                Formula &amp; Schema Audit
              </td>
              <td className="py-3 px-5">Standard normalization</td>
              <td className="py-3 px-5">Full Excel formula &amp; schema audit</td>
              <td className="py-3 px-5">Full Excel formula &amp; schema audit</td>
            </tr>
          </tbody>
        </table>
      </div>

      {/* Webhook Endpoint Tester */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 space-y-4">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <Terminal className="h-4 w-4 text-blue-600 dark:text-blue-400" />
              <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                Live Webhook Simulator
              </h2>
            </div>
            <span className="font-mono text-[11px] text-slate-500 dark:text-slate-400">
              POST /api/billing/webhook/{provider}
            </span>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <div className="flex items-center gap-1 rounded-lg bg-slate-100 dark:bg-slate-800 p-1">
              <button
                type="button"
                onClick={() => setProvider('paddle')}
                className={`rounded-md px-3 py-1 text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                  provider === 'paddle'
                    ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 shadow-xs'
                    : 'text-slate-600 dark:text-slate-400'
                }`}
              >
                Paddle Billing
              </button>
              <button
                type="button"
                onClick={() => setProvider('stripe')}
                className={`rounded-md px-3 py-1 text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                  provider === 'stripe'
                    ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 shadow-xs'
                    : 'text-slate-600 dark:text-slate-400'
                }`}
              >
                Stripe Webhook
              </button>
            </div>

            {provider === 'paddle' ? (
              <div className="flex flex-wrap items-center gap-1 rounded-lg bg-slate-100 dark:bg-slate-800 p-1">
                {(
                  [
                    { id: 'subscription.activated', label: 'subscription.activated' },
                    { id: 'transaction.completed', label: 'transaction.completed (+15)' },
                    { id: 'subscription.canceled', label: 'subscription.canceled' },
                  ] as const
                ).map((evt) => (
                  <button
                    key={evt.id}
                    type="button"
                    onClick={() => setPaddleEventKind(evt.id)}
                    className={`rounded-md px-2.5 py-1 text-[11px] font-mono font-medium transition-colors whitespace-nowrap shrink-0 ${
                      paddleEventKind === evt.id
                        ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 shadow-xs'
                        : 'text-slate-600 dark:text-slate-400'
                    }`}
                  >
                    {evt.label}
                  </button>
                ))}
              </div>
            ) : (
              <div className="flex items-center gap-1 rounded-lg bg-slate-100 dark:bg-slate-800 p-1">
                <button
                  type="button"
                  onClick={() => setStripeTier('pro')}
                  className={`rounded-md px-3 py-1 text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                    stripeTier === 'pro'
                      ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 shadow-xs'
                      : 'text-slate-600 dark:text-slate-400'
                  }`}
                >
                  Grant Pro ($29)
                </button>
                <button
                  type="button"
                  onClick={() => setStripeTier('token_pack')}
                  className={`rounded-md px-3 py-1 text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                    stripeTier === 'token_pack'
                      ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 shadow-xs'
                      : 'text-slate-600 dark:text-slate-400'
                  }`}
                >
                  Grant 15 Tokens ($5)
                </button>
              </div>
            )}
          </div>

          <pre className="rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950 p-3 text-[11px] font-mono text-slate-700 dark:text-slate-300 overflow-x-auto">
            {JSON.stringify(samplePayload, null, 2)}
          </pre>

          <button
            type="button"
            disabled={testingWebhook}
            onClick={handleDispatchWebhook}
            className="flex items-center gap-2 rounded-lg bg-slate-900 dark:bg-blue-600 px-4 py-2 text-xs font-semibold text-white hover:bg-slate-800 dark:hover:bg-blue-700 transition-colors whitespace-nowrap shrink-0 disabled:opacity-60"
          >
            <Send className="h-3.5 w-3.5" />
            <span>{testingWebhook ? 'Dispatching...' : 'Send Test Webhook Event'}</span>
          </button>

          {lastWebhookResponse && (
            <pre className="rounded-lg border border-emerald-200 dark:border-emerald-900 bg-emerald-50/50 dark:bg-emerald-950/30 p-3 text-[11px] font-mono text-emerald-800 dark:text-emerald-300 overflow-x-auto max-h-44">
              {lastWebhookResponse}
            </pre>
          )}
        </div>

        {/* Persisted Billing Events */}
        <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-hidden">
          <div className="border-b border-slate-200 dark:border-slate-800 px-5 py-4">
            <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
              Billing Event Log (SQLite)
            </h2>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950/60 text-[11px] font-semibold text-slate-500 dark:text-slate-400">
                  <th className="py-2.5 px-4">Provider</th>
                  <th className="py-2.5 px-4">Event</th>
                  <th className="py-2.5 px-4">Tier</th>
                  <th className="py-2.5 px-4 text-right">Amount</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200 dark:divide-slate-800 text-xs font-mono tabular-nums">
                {events.length === 0 ? (
                  <tr>
                    <td colSpan={4} className="py-10 text-center font-sans text-slate-500 dark:text-slate-400">
                      No billing events logged yet. Complete a sandbox checkout or send a test webhook.
                    </td>
                  </tr>
                ) : (
                  events.map((evt) => (
                    <tr key={evt.id}>
                      <td className="py-2.5 px-4 text-slate-800 dark:text-slate-200">
                        {evt.provider}
                      </td>
                      <td className="py-2.5 px-4 text-slate-600 dark:text-slate-300">
                        {evt.event_type}
                      </td>
                      <td className="py-2.5 px-4 text-blue-600 dark:text-blue-400">
                        {evt.plan_granted}
                      </td>
                      <td className="py-2.5 px-4 text-right text-slate-900 dark:text-slate-100">
                        ${(evt.amount_cents / 100).toFixed(2)}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}
