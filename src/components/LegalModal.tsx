import { X } from 'lucide-react';

export type LegalDocSection = 'terms' | 'privacy' | 'refund' | 'delivery' | 'contact';

interface LegalModalProps {
  open: boolean;
  activeSection: LegalDocSection;
  onSelectSection: (section: LegalDocSection) => void;
  onClose: () => void;
}

export function LegalModal({
  open,
  activeSection,
  onSelectSection,
  onClose,
}: LegalModalProps) {
  if (!open) return null;

  const tabs: Array<{ id: LegalDocSection; label: string }> = [
    { id: 'terms', label: 'Terms of Service' },
    { id: 'privacy', label: 'Privacy Policy' },
    { id: 'refund', label: 'Refund Policy' },
    { id: 'delivery', label: 'Delivery Policy' },
    { id: 'contact', label: 'Contact / Support' },
  ];

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/70 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="legal-modal-title"
    >
      <div className="flex max-h-[85vh] w-full max-w-2xl flex-col rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between gap-4 border-b border-slate-200 dark:border-slate-800 px-6 py-4">
          <div>
            <h2
              id="legal-modal-title"
              className="text-base font-bold text-slate-900 dark:text-slate-100"
            >
              DocuCleanse Legal &amp; Compliance
            </h2>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Effective November 2026 · Support: ru2275353@gmail.com · 03180722803
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-800 dark:hover:text-slate-200"
            aria-label="Close legal modal"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Section Tabs */}
        <div className="border-b border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950/60 px-6 py-2.5 overflow-x-auto">
          <div className="flex items-center gap-1.5">
            {tabs.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => onSelectSection(t.id)}
                className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                  activeSection === t.id
                    ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 border border-slate-200 dark:border-slate-700 shadow-xs'
                    : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100'
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-4 text-xs leading-relaxed text-slate-600 dark:text-slate-300">
          {activeSection === 'terms' && (
            <>
              <h3 className="text-sm font-bold text-slate-900 dark:text-slate-100">
                1. Terms of Service &amp; Digital SaaS Delivery
              </h3>
              <p>
                DocuCleanse provides cloud-based automated spreadsheet, receipt, and ledger
                normalization software delivered strictly as a digital Software-as-a-Service (SaaS)
                platform. By creating an account or initiating a subscription or token pack purchase,
                you agree to these terms on behalf of yourself or your organization.
              </p>
              <h4 className="font-semibold text-slate-900 dark:text-slate-100">
                2. Customer Data Responsibility &amp; Confidentiality
              </h4>
              <p>
                You retain full ownership of all uploaded CSV, Excel, PDF, and receipt documents. You
                are solely responsible for ensuring you possess the legal right and authorization to
                upload and process any financial, vendor, or client roster records submitted to
                DocuCleanse, and for reviewing flagged formula errors before filing tax or accounting
                submissions.
              </p>
              <h4 className="font-semibold text-slate-900 dark:text-slate-100">
                3. Service Availability &amp; 99.9% Uptime Target
              </h4>
              <p>
                We engineer DocuCleanse to maintain a 99.9% monthly uptime availability target for
                core document cleaning and export endpoints, excluding scheduled maintenance windows
                or upstream AI infrastructure disruptions. Pro accounts receive priority processing
                and direct support via{' '}
                <a
                  href="mailto:ru2275353@gmail.com"
                  className="text-blue-600 dark:text-blue-400 underline"
                >
                  ru2275353@gmail.com
                </a>{' '}
                or{' '}
                <a
                  href="tel:03180722803"
                  className="text-blue-600 dark:text-blue-400 underline font-mono tabular-nums"
                >
                  03180722803
                </a>
                .
              </p>
            </>
          )}

          {activeSection === 'privacy' && (
            <>
              <h3 className="text-sm font-bold text-slate-900 dark:text-slate-100">
                1. Privacy Policy &amp; Strict Non-Retention of Source Files
              </h3>
              <p>
                DocuCleanse processes uploaded documents in transient memory buffers during parsing
                and normalization. Raw uploaded files (`.csv`, `.xlsx`, `.pdf`, and receipt images)
                are never written to permanent third-party storage buckets and are discarded
                immediately upon completion of the cleaning pipeline.
              </p>
              <h4 className="font-semibold text-slate-900 dark:text-slate-100">
                2. Local Workspace History &amp; Metadata
              </h4>
              <p>
                Normalized job previews and usage counters are stored in your isolated application
                database solely so you can inspect diffs, view audit logs, and re-export cleaned
                reports. We do not sell, rent, or use your financial documents to train foundation
                models.
              </p>
              <h4 className="font-semibold text-slate-900 dark:text-slate-100">
                3. Payment Data &amp; Merchant of Record (Paddle)
              </h4>
              <p>
                Our order process is conducted by our online reseller Paddle.com. Paddle.com is the
                Merchant of Record for all orders processed through Paddle Billing. Paddle handles
                credit card entry, VAT/sales tax calculation, invoicing, and PCI-DSS compliance.
                DocuCleanse never stores raw card numbers or CVV credentials on its servers.
              </p>
            </>
          )}

          {activeSection === 'refund' && (
            <>
              <h3 className="text-sm font-bold text-slate-900 dark:text-slate-100">
                14-Day Money-Back Guarantee
              </h3>
              <p>
                We stand behind the accuracy of DocuCleanse&apos;s automated schema mapping,
                currency/date normalization, and formula error detection. If you purchase a Pro
                monthly subscription ($40/mo) or Pay-Per-Use Token Pack ($5) and automated file
                cleaning or formatting fails to match product specifications, you are eligible for a
                full refund within 14 calendar days of the original transaction.
              </p>
              <h4 className="font-semibold text-slate-900 dark:text-slate-100">
                Refund Requests
              </h4>
              <p>
                Subscriptions can be canceled at any time prior to the next billing renewal date to
                prevent future charges. To request a 14-day refund, include your Paddle/Stripe
                order receipt ID and a brief description of the formatting issue. Approved refunds
                are issued back to your original payment method within 3–5 business days.
              </p>
              <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950/60 p-3.5 space-y-1">
                <p>
                  <span className="font-semibold text-slate-900 dark:text-slate-100">
                    Support Email:{' '}
                  </span>
                  <a
                    href="mailto:ru2275353@gmail.com"
                    className="text-blue-600 dark:text-blue-400 underline"
                  >
                    ru2275353@gmail.com
                  </a>
                </p>
                <p>
                  <span className="font-semibold text-slate-900 dark:text-slate-100">
                    Support Phone:{' '}
                  </span>
                  <a
                    href="tel:03180722803"
                    className="text-blue-600 dark:text-blue-400 underline font-mono tabular-nums"
                  >
                    03180722803
                  </a>
                </p>
                <p>
                  <span className="font-semibold text-slate-900 dark:text-slate-100">
                    Operating Hours:{' '}
                  </span>
                  Monday to Friday (response within 24 hours)
                </p>
              </div>
            </>
          )}

          {activeSection === 'delivery' && (
            <>
              <h3 className="text-sm font-bold text-slate-900 dark:text-slate-100">
                Digital Delivery Policy
              </h3>
              <p>
                DocuCleanse is a 100% digital web application. No physical goods or shipped media
                are sold.
              </p>
              <h4 className="font-semibold text-slate-900 dark:text-slate-100">
                Instantaneous Provisioning
              </h4>
              <p>
                Upon completed payment webhook verification from Paddle (`subscription.activated` or
                `transaction.completed`) or Stripe, your account entitlements—including unlimited
                monthly file cleans, unlimited spreadsheet rows, multi-sheet XLSX export, and
                Executive Summary PDF generation—are unlocked instantaneously in your active
                session.
              </p>
            </>
          )}

          {activeSection === 'contact' && (
            <>
              <h3 className="text-sm font-bold text-slate-900 dark:text-slate-100">
                Contact / Support
              </h3>
              <p>
                For billing inquiries, Paddle checkout assistance, schema mapping questions, or
                14-day refund requests, reach our support desk directly using the details below:
              </p>
              <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950/60 p-4 space-y-2">
                <p>
                  <span className="font-semibold text-slate-900 dark:text-slate-100">
                    Support Email:{' '}
                  </span>
                  <a
                    href="mailto:ru2275353@gmail.com"
                    className="text-blue-600 dark:text-blue-400 underline"
                  >
                    ru2275353@gmail.com
                  </a>
                </p>
                <p>
                  <span className="font-semibold text-slate-900 dark:text-slate-100">
                    Support Phone:{' '}
                  </span>
                  <a
                    href="tel:03180722803"
                    className="text-blue-600 dark:text-blue-400 underline font-mono tabular-nums"
                  >
                    03180722803
                  </a>
                </p>
                <p>
                  <span className="font-semibold text-slate-900 dark:text-slate-100">
                    Operating Hours:{' '}
                  </span>
                  Monday to Friday (response within 24 hours)
                </p>
              </div>
            </>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end border-t border-slate-200 dark:border-slate-800 px-6 py-3.5">
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
  );
}
