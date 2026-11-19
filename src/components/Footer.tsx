import type { LegalDocSection } from './LegalModal';

interface FooterProps {
  onOpenLegal: (section: LegalDocSection) => void;
}

export function Footer({ onOpenLegal }: FooterProps) {
  return (
    <footer className="mt-10 border-t border-slate-200 dark:border-slate-800 pt-5 pb-4 text-xs text-slate-500 dark:text-slate-400">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <span>© {new Date().getFullYear()} DocuCleanse. All rights reserved.</span>

        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <button
            type="button"
            onClick={() => onOpenLegal('terms')}
            className="hover:text-slate-900 dark:hover:text-slate-100 hover:underline transition-colors whitespace-nowrap shrink-0"
          >
            Terms of Service
          </button>
          <span className="text-slate-300 dark:text-slate-700" aria-hidden="true">
            ·
          </span>
          <button
            type="button"
            onClick={() => onOpenLegal('privacy')}
            className="hover:text-slate-900 dark:hover:text-slate-100 hover:underline transition-colors whitespace-nowrap shrink-0"
          >
            Privacy Policy
          </button>
          <span className="text-slate-300 dark:text-slate-700" aria-hidden="true">
            ·
          </span>
          <button
            type="button"
            onClick={() => onOpenLegal('refund')}
            className="hover:text-slate-900 dark:hover:text-slate-100 hover:underline transition-colors whitespace-nowrap shrink-0"
          >
            Refund Policy
          </button>
          <span className="text-slate-300 dark:text-slate-700" aria-hidden="true">
            ·
          </span>
          <button
            type="button"
            onClick={() => onOpenLegal('delivery')}
            className="hover:text-slate-900 dark:hover:text-slate-100 hover:underline transition-colors whitespace-nowrap shrink-0"
          >
            Delivery Policy
          </button>
          <span className="text-slate-300 dark:text-slate-700" aria-hidden="true">
            ·
          </span>
          <a
            href="mailto:ru2275353@gmail.com"
            className="hover:text-slate-900 dark:hover:text-slate-100 hover:underline transition-colors whitespace-nowrap shrink-0"
          >
            Contact Support (ru2275353@gmail.com)
          </a>
          <span className="text-slate-300 dark:text-slate-700" aria-hidden="true">
            ·
          </span>
          <a
            href="tel:03180722803"
            className="font-mono tabular-nums hover:text-slate-900 dark:hover:text-slate-100 hover:underline transition-colors whitespace-nowrap shrink-0"
          >
            03180722803
          </a>
        </div>
      </div>
    </footer>
  );
}
