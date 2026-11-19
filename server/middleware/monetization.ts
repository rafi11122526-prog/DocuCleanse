import type { NextFunction, Request, Response } from 'express';
import {
  FREE_MAX_ROWS_PER_FILE,
  FREE_MONTHLY_CLEAN_LIMIT,
  getOrCreateUser,
  getUserQuotaSnapshot,
} from '../db.ts';
import type { QuotaSnapshot } from '../types.ts';

export interface GuardedRequest extends Request {
  docuUserId?: string;
  quotaSnapshot?: QuotaSnapshot;
}

export function resolveUserId(req: Request): string {
  const headerUser = req.header('x-user-id');
  const queryUser = typeof req.query.userId === 'string' ? req.query.userId : undefined;
  return (headerUser || queryUser || 'usr_demo_freelancer').trim();
}

/**
 * Monetization Guardrail Middleware:
 * Checks remaining monthly free cleans, token pack balance, and Pro subscription status
 * BEFORE triggering the Gemini AI & file-processing pipeline.
 */
export function checkCleanQuota(req: GuardedRequest, res: Response, next: NextFunction): void {
  const userId = resolveUserId(req);
  getOrCreateUser(userId);
  const quota = getUserQuotaSnapshot(userId);

  req.docuUserId = userId;
  req.quotaSnapshot = quota;

  if (!quota.canProcessNewFile) {
    res.status(402).json({
      error: `Free tier monthly limit reached (${quota.freeCleansUsedThisMonth}/${FREE_MONTHLY_CLEAN_LIMIT} cleans used in ${quota.billingCycleMonth}). Upgrade to Pro or purchase a 15-clean Token Pack to continue.`,
      code: 'MONTHLY_LIMIT_REACHED',
      upgradeRequired: true,
      quota,
    });
    return;
  }

  next();
}

/**
 * Secondary Guardrail invoked right after tabular extraction and BEFORE calling Gemini:
 * Ensures Free-tier uploads stay within the 50-row file cap.
 */
export function enforceRowLimit(
  quota: QuotaSnapshot,
  rowCount: number
): { allowed: true } | { allowed: false; status: number; payload: Record<string, unknown> } {
  // Pro subscribers and Token Pack holders bypass the 50-row Free tier cutoff
  const hasPaidAllowance = quota.plan === 'pro' || quota.tokenBalance > 0;
  if (!hasPaidAllowance && rowCount > FREE_MAX_ROWS_PER_FILE) {
    return {
      allowed: false,
      status: 402,
      payload: {
        error: `This file contains ${rowCount} rows, which exceeds the Free tier cap of ${FREE_MAX_ROWS_PER_FILE} rows per file. Upgrade to Pro ($40/mo) or a $5 Token Pack for unlimited rows.`,
        code: 'ROW_LIMIT_EXCEEDED',
        upgradeRequired: true,
        rowCount,
        quota,
      },
    };
  }
  return { allowed: true };
}

/**
 * Guardrail Middleware for Pro export formats (XLSX with audit sheet, Executive Summary PDF)
 */
export function requireProExport(req: GuardedRequest, res: Response, next: NextFunction): void {
  const userId = resolveUserId(req);
  const quota = getUserQuotaSnapshot(userId);
  req.docuUserId = userId;
  req.quotaSnapshot = quota;

  const format = typeof req.params.format === 'string' ? req.params.format.toLowerCase() : 'csv';

  if ((format === 'xlsx' || format === 'pdf') && !quota.canExportProFormats) {
    res.status(402).json({
      error: `${format.toUpperCase()} export is a Pro & Token Pack feature. Upgrade to unlock clean XLSX workbooks and Executive Summary PDF reports.`,
      code: 'PRO_EXPORT_LOCKED',
      upgradeRequired: true,
      format,
      quota,
    });
    return;
  }

  next();
}
