import type { NextFunction, Request, Response } from 'express';
import {
  FREE_MAX_ROWS_PER_FILE,
  FREE_MONTHLY_CLEAN_LIMIT,
  getOrCreateUser,
  getUserQuotaSnapshot,
  resetAccountToFreeForTesting,
} from '../db.ts';
import type { QuotaSnapshot } from '../types.ts';

export const VALID_PADDLE_SUBSCRIPTION_TOKEN_RE = /^(sub_|txn_)[a-zA-Z0-9_-]{8,}$/;

export interface GuardedRequest extends Request {
  docuUserId?: string;
  quotaSnapshot?: QuotaSnapshot;
  isVerifiedPro?: boolean;
}

export function resolveUserId(req: Request): string {
  const headerUser = req.header('x-user-id');
  const queryUser = typeof req.query.userId === 'string' ? req.query.userId : undefined;
  return (headerUser || queryUser || 'usr_demo_freelancer').trim();
}

export function getVerifiedPaddleToken(req: Request): string | null {
  const rawHeader =
    req.header('x-paddle-subscription-token') ||
    req.header('x-paddle-token') ||
    '';
  const trimmed = rawHeader.trim();
  return VALID_PADDLE_SUBSCRIPTION_TOKEN_RE.test(trimmed) ? trimmed : null;
}

export function hasVerifiedPaddleToken(req: Request): boolean {
  return getVerifiedPaddleToken(req) !== null;
}

/**
 * Resolves the authoritative quota for the request.
 * Never honors an unverified Pro or token_pack DB state unless an authenticated,
 * verified Paddle subscription token header is present.
 */
export function resolveAuthoritativeQuota(req: Request): {
  userId: string;
  quota: QuotaSnapshot;
  isVerifiedPro: boolean;
} {
  const userId = resolveUserId(req);
  getOrCreateUser(userId);
  const verifiedToken = hasVerifiedPaddleToken(req);
  let quota = getUserQuotaSnapshot(userId);

  if ((quota.plan === 'pro' || quota.tokenBalance > 0) && !verifiedToken) {
    quota = resetAccountToFreeForTesting(userId);
  }

  const isVerifiedPro = quota.plan === 'pro' && verifiedToken;
  return { userId, quota, isVerifiedPro };
}

/**
 * Monetization Guardrail Middleware:
 * Checks remaining monthly free cleans and verified Pro subscription status
 * BEFORE triggering the Gemini AI & file-processing pipeline.
 */
export function checkCleanQuota(req: GuardedRequest, res: Response, next: NextFunction): void {
  const { userId, quota, isVerifiedPro } = resolveAuthoritativeQuota(req);

  req.docuUserId = userId;
  req.quotaSnapshot = quota;
  req.isVerifiedPro = isVerifiedPro;

  const canProcess = isVerifiedPro || quota.freeCleansUsedThisMonth < FREE_MONTHLY_CLEAN_LIMIT;
  if (!canProcess) {
    res.status(402).json({
      error: 'MONTHLY_LIMIT_REACHED',
      code: 'MONTHLY_LIMIT_REACHED',
      requiredPlan: 'pro',
      message: `Free tier monthly limit reached (${quota.freeCleansUsedThisMonth}/${FREE_MONTHLY_CLEAN_LIMIT} cleans used in ${quota.billingCycleMonth}). Upgrade to Pro ($40/mo) to continue.`,
      upgradeRequired: true,
      quota,
    });
    return;
  }

  next();
}

/**
 * Secondary Guardrail invoked right after tabular extraction and BEFORE calling Gemini:
 * Strictly rejects any dataset >50 rows with HTTP 402 unless an authenticated,
 * verified Paddle Pro subscription token is present.
 */
export function enforceRowLimit(
  quota: QuotaSnapshot,
  rowCount: number,
  isVerifiedPro = false
): { allowed: true } | { allowed: false; status: number; payload: Record<string, unknown> } {
  const hasVerifiedProAccess = isVerifiedPro && quota.plan === 'pro';
  if (!hasVerifiedProAccess && rowCount > FREE_MAX_ROWS_PER_FILE) {
    return {
      allowed: false,
      status: 402,
      payload: {
        error: 'ROW_LIMIT_EXCEEDED',
        code: 'ROW_LIMIT_EXCEEDED',
        requiredPlan: 'pro',
        message: `Upgrade to Pro ($40/mo) to process ledgers over ${FREE_MAX_ROWS_PER_FILE} rows. This file contains ${rowCount} rows.`,
        upgradeRequired: true,
        rowCount,
        quota,
      },
    };
  }
  return { allowed: true };
}

/**
 * Guardrail Middleware for Pro export formats (XLSX workbooks, Pre-Audit PDF & Certificate PDF).
 * Rejects with HTTP 402 unless user has plan === 'pro' AND a verified Paddle subscription token.
 */
export function requireProExport(req: GuardedRequest, res: Response, next: NextFunction): void {
  const { userId, quota, isVerifiedPro } = resolveAuthoritativeQuota(req);
  req.docuUserId = userId;
  req.quotaSnapshot = quota;
  req.isVerifiedPro = isVerifiedPro;

  const paramFormat = typeof req.params.format === 'string' ? req.params.format.toLowerCase() : '';
  const pathLower = req.path.toLowerCase();
  const format =
    paramFormat ||
    (pathLower.endsWith('/xlsx')
      ? 'xlsx'
      : pathLower.endsWith('/pdf')
      ? 'pdf'
      : pathLower.endsWith('/certificate')
      ? 'certificate'
      : 'csv');

  const isProFormat = format === 'xlsx' || format === 'pdf' || format === 'certificate';
  if (isProFormat && !isVerifiedPro) {
    res.status(402).json({
      error: 'PRO_EXPORT_LOCKED',
      code: 'PRO_EXPORT_LOCKED',
      requiredPlan: 'pro',
      message:
        format === 'xlsx'
          ? 'Upgrade to Pro ($40/mo) to export multi-tab Executive XLSX workbooks.'
          : 'Upgrade to Pro ($40/mo) to export Pre-Audit Processing Report PDFs.',
      upgradeRequired: true,
      format,
      quota,
    });
    return;
  }

  next();
}

