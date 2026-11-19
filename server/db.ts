import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';
import type {
  CleanJobRecord,
  QuotaSnapshot,
  UsageLogRecord,
  UserPlan,
  UserRecord,
} from '../server/types.ts';

export const FREE_MONTHLY_CLEAN_LIMIT = 3;
export const FREE_MAX_ROWS_PER_FILE = 50;

const dataDir = path.resolve(process.cwd(), 'data');
fs.mkdirSync(dataDir, { recursive: true });

const dbPath = path.join(dataDir, 'docucleanse.db');
export const db = new Database(dbPath);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    plan TEXT NOT NULL DEFAULT 'free' CHECK (plan IN ('free', 'pro', 'token_pack')),
    token_balance INTEGER NOT NULL DEFAULT 0,
    stripe_customer_id TEXT,
    lemonsqueezy_customer_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS usage_logs (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    job_id TEXT,
    file_name TEXT NOT NULL,
    file_type TEXT NOT NULL,
    row_count INTEGER NOT NULL DEFAULT 0,
    anomalies_found INTEGER NOT NULL DEFAULT 0,
    cells_normalized INTEGER NOT NULL DEFAULT 0,
    action TEXT NOT NULL CHECK (action IN ('clean', 'export_csv', 'export_xlsx', 'export_pdf')),
    billing_source TEXT NOT NULL CHECK (billing_source IN ('free_monthly', 'token_pack', 'pro_unlimited')),
    created_at TEXT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_usage_logs_user_month
    ON usage_logs (user_id, action, created_at);

  CREATE TABLE IF NOT EXISTS clean_jobs (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    file_name TEXT NOT NULL,
    file_type TEXT NOT NULL,
    document_category TEXT NOT NULL,
    raw_headers_json TEXT NOT NULL,
    raw_rows_json TEXT NOT NULL,
    cleaned_headers_json TEXT NOT NULL,
    cleaned_rows_json TEXT NOT NULL,
    cell_diffs_json TEXT NOT NULL,
    anomalies_json TEXT NOT NULL,
    schema_mappings_json TEXT NOT NULL,
    executive_summary TEXT NOT NULL,
    row_count INTEGER NOT NULL,
    processing_ms INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_clean_jobs_user_created
    ON clean_jobs (user_id, created_at DESC);

  CREATE TABLE IF NOT EXISTS billing_events (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    provider TEXT NOT NULL,
    event_type TEXT NOT NULL,
    plan_granted TEXT NOT NULL,
    amount_cents INTEGER NOT NULL,
    payload_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
`);

// Safe schema migration for existing SQLite databases: add audit_metadata_json if absent
const cleanJobColumns = db
  .prepare(`PRAGMA table_info(clean_jobs)`)
  .all() as Array<{ name: string }>;
if (!cleanJobColumns.some((c) => c.name === 'audit_metadata_json')) {
  db.exec(`ALTER TABLE clean_jobs ADD COLUMN audit_metadata_json TEXT`);
}

interface UserRow {
  id: string;
  email: string;
  name: string;
  plan: UserPlan;
  token_balance: number;
  stripe_customer_id: string | null;
  lemonsqueezy_customer_id: string | null;
  created_at: string;
  updated_at: string;
}

function mapUserRow(row: UserRow): UserRecord {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    plan: row.plan,
    tokenBalance: row.token_balance,
    stripeCustomerId: row.stripe_customer_id,
    lemonsqueezyCustomerId: row.lemonsqueezy_customer_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function getOrCreateUser(userId = 'usr_demo_freelancer'): UserRecord {
  const existing = db
    .prepare('SELECT * FROM users WHERE id = ?')
    .get(userId) as UserRow | undefined;

  if (existing) {
    return mapUserRow(existing);
  }

  const now = new Date().toISOString();
  const safeId = userId.trim() || 'usr_demo_freelancer';
  const defaultEmail =
    safeId === 'usr_demo_freelancer'
      ? 'ru2275353@gmail.com'
      : `${safeId.replace(/[^a-zA-Z0-9_.-]/g, '_')}@docucleanse.local`;

  db.prepare(
    `INSERT INTO users (id, email, name, plan, token_balance, created_at, updated_at)
     VALUES (?, ?, ?, 'free', 0, ?, ?)`
  ).run(safeId, defaultEmail, 'Rafi Digital Studio', now, now);

  const created = db
    .prepare('SELECT * FROM users WHERE id = ?')
    .get(safeId) as UserRow;
  return mapUserRow(created);
}

export function getCurrentBillingMonth(): string {
  return new Date().toISOString().slice(0, 7);
}

export function getMonthlyFreeCleanCount(userId: string): number {
  const monthPrefix = `${getCurrentBillingMonth()}%`;
  const row = db
    .prepare(
      `SELECT COUNT(*) as total
       FROM usage_logs
       WHERE user_id = ?
         AND action = 'clean'
         AND billing_source = 'free_monthly'
         AND created_at LIKE ?`
    )
    .get(userId, monthPrefix) as { total: number };

  return row?.total ?? 0;
}

export function getUserQuotaSnapshot(userId: string): QuotaSnapshot {
  const user = getOrCreateUser(userId);
  const freeUsed = getMonthlyFreeCleanCount(user.id);
  const freeRemaining = Math.max(0, FREE_MONTHLY_CLEAN_LIMIT - freeUsed);

  let remainingCleans: number | 'unlimited' = freeRemaining;
  if (user.plan === 'pro') {
    remainingCleans = 'unlimited';
  } else if (user.tokenBalance > 0) {
    remainingCleans = freeRemaining + user.tokenBalance;
  }

  const canProcessNewFile =
    user.plan === 'pro' || user.tokenBalance > 0 || freeUsed < FREE_MONTHLY_CLEAN_LIMIT;

  const canExportProFormats = user.plan === 'pro' || user.tokenBalance > 0;

  return {
    userId: user.id,
    email: user.email,
    name: user.name,
    plan: user.plan,
    freeCleansUsedThisMonth: freeUsed,
    freeCleansLimit: FREE_MONTHLY_CLEAN_LIMIT,
    freeRowLimit: FREE_MAX_ROWS_PER_FILE,
    tokenBalance: user.tokenBalance,
    remainingCleans,
    canProcessNewFile,
    canExportProFormats,
    billingCycleMonth: getCurrentBillingMonth(),
  };
}

export function consumeCleanCreditAndLog(params: {
  userId: string;
  jobId: string;
  fileName: string;
  fileType: string;
  rowCount: number;
  anomaliesFound: number;
  cellsNormalized: number;
}): { billingSource: 'free_monthly' | 'token_pack' | 'pro_unlimited'; quota: QuotaSnapshot } {
  const tx = db.transaction(() => {
    const user = getOrCreateUser(params.userId);
    const now = new Date().toISOString();
    let billingSource: 'free_monthly' | 'token_pack' | 'pro_unlimited' = 'free_monthly';

    if (user.plan === 'pro') {
      billingSource = 'pro_unlimited';
    } else if (user.tokenBalance > 0) {
      billingSource = 'token_pack';
      db.prepare(
        `UPDATE users SET token_balance = MAX(0, token_balance - 1), updated_at = ? WHERE id = ?`
      ).run(now, user.id);
    } else {
      billingSource = 'free_monthly';
    }

    db.prepare(
      `INSERT INTO usage_logs (
        id, user_id, job_id, file_name, file_type, row_count,
        anomalies_found, cells_normalized, action, billing_source, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'clean', ?, ?)`
    ).run(
      `log_${crypto.randomUUID()}`,
      user.id,
      params.jobId,
      params.fileName,
      params.fileType,
      params.rowCount,
      params.anomaliesFound,
      params.cellsNormalized,
      billingSource,
      now
    );

    return billingSource;
  });

  const billingSource = tx();
  return { billingSource, quota: getUserQuotaSnapshot(params.userId) };
}

export function logExportAction(params: {
  userId: string;
  jobId: string;
  fileName: string;
  fileType: string;
  rowCount: number;
  action: 'export_csv' | 'export_xlsx' | 'export_pdf';
}): void {
  const user = getOrCreateUser(params.userId);
  const billingSource =
    user.plan === 'pro'
      ? 'pro_unlimited'
      : user.tokenBalance > 0
      ? 'token_pack'
      : 'free_monthly';

  db.prepare(
    `INSERT INTO usage_logs (
      id, user_id, job_id, file_name, file_type, row_count,
      anomalies_found, cells_normalized, action, billing_source, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?)`
  ).run(
    `log_${crypto.randomUUID()}`,
    user.id,
    params.jobId,
    params.fileName,
    params.fileType,
    params.rowCount,
    params.action,
    billingSource,
    new Date().toISOString()
  );
}

export function saveCleanJob(job: CleanJobRecord): void {
  db.prepare(
    `INSERT INTO clean_jobs (
      id, user_id, file_name, file_type, document_category,
      raw_headers_json, raw_rows_json, cleaned_headers_json, cleaned_rows_json,
      cell_diffs_json, anomalies_json, schema_mappings_json, executive_summary,
      row_count, processing_ms, created_at, audit_metadata_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    job.id,
    job.userId,
    job.fileName,
    job.fileType,
    job.documentCategory,
    JSON.stringify(job.rawHeaders),
    JSON.stringify(job.rawRows),
    JSON.stringify(job.cleanedHeaders),
    JSON.stringify(job.cleanedRows),
    JSON.stringify(job.cellDiffs),
    JSON.stringify(job.anomalies),
    JSON.stringify(job.schemaMappings),
    job.executiveSummary,
    job.rowCount,
    job.processingMs,
    job.createdAt,
    job.auditMetadata ? JSON.stringify(job.auditMetadata) : null
  );
}

interface CleanJobRow {
  id: string;
  user_id: string;
  file_name: string;
  file_type: string;
  document_category: CleanJobRecord['documentCategory'];
  raw_headers_json: string;
  raw_rows_json: string;
  cleaned_headers_json: string;
  cleaned_rows_json: string;
  cell_diffs_json: string;
  anomalies_json: string;
  schema_mappings_json: string;
  executive_summary: string;
  row_count: number;
  processing_ms: number;
  created_at: string;
  audit_metadata_json?: string | null;
}

function mapCleanJobRow(row: CleanJobRow): CleanJobRecord {
  return {
    id: row.id,
    userId: row.user_id,
    fileName: row.file_name,
    fileType: row.file_type,
    documentCategory: row.document_category,
    rawHeaders: JSON.parse(row.raw_headers_json),
    rawRows: JSON.parse(row.raw_rows_json),
    cleanedHeaders: JSON.parse(row.cleaned_headers_json),
    cleanedRows: JSON.parse(row.cleaned_rows_json),
    cellDiffs: JSON.parse(row.cell_diffs_json),
    anomalies: JSON.parse(row.anomalies_json),
    schemaMappings: JSON.parse(row.schema_mappings_json),
    executiveSummary: row.executive_summary,
    rowCount: row.row_count,
    processingMs: row.processing_ms,
    createdAt: row.created_at,
    auditMetadata: row.audit_metadata_json ? JSON.parse(row.audit_metadata_json) : undefined,
  };
}

export function getJobById(jobId: string): CleanJobRecord | null {
  const row = db
    .prepare('SELECT * FROM clean_jobs WHERE id = ?')
    .get(jobId) as CleanJobRow | undefined;

  return row ? mapCleanJobRow(row) : null;
}

export function getUserJobs(userId: string, limit = 25): CleanJobRecord[] {
  const rows = db
    .prepare('SELECT * FROM clean_jobs WHERE user_id = ? ORDER BY created_at DESC LIMIT ?')
    .all(userId, limit) as CleanJobRow[];

  return rows.map(mapCleanJobRow);
}

export function getUserUsageLogs(userId: string, limit = 50): UsageLogRecord[] {
  const rows = db
    .prepare('SELECT * FROM usage_logs WHERE user_id = ? ORDER BY created_at DESC LIMIT ?')
    .all(userId, limit) as Array<{
    id: string;
    user_id: string;
    job_id: string | null;
    file_name: string;
    file_type: string;
    row_count: number;
    anomalies_found: number;
    cells_normalized: number;
    action: UsageLogRecord['action'];
    billing_source: UsageLogRecord['billingSource'];
    created_at: string;
  }>;

  return rows.map((r) => ({
    id: r.id,
    userId: r.user_id,
    jobId: r.job_id,
    fileName: r.file_name,
    fileType: r.file_type,
    rowCount: r.row_count,
    anomaliesFound: r.anomalies_found,
    cellsNormalized: r.cells_normalized,
    action: r.action,
    billingSource: r.billing_source,
    createdAt: r.created_at,
  }));
}

export function applyBillingUpgrade(params: {
  userId: string;
  provider: 'stripe' | 'paddle' | 'sandbox';
  eventType: string;
  tier: 'pro' | 'token_pack';
  tokensToAdd?: number;
  amountCents: number;
  payload: unknown;
}): QuotaSnapshot {
  const tx = db.transaction(() => {
    const user = getOrCreateUser(params.userId);
    const now = new Date().toISOString();

    if (params.tier === 'pro') {
      db.prepare(
        `UPDATE users SET plan = 'pro', updated_at = ? WHERE id = ?`
      ).run(now, user.id);
    } else {
      const addTokens = params.tokensToAdd ?? 15;
      const nextPlan: UserPlan = user.plan === 'pro' ? 'pro' : 'token_pack';
      db.prepare(
        `UPDATE users SET plan = ?, token_balance = token_balance + ?, updated_at = ? WHERE id = ?`
      ).run(nextPlan, addTokens, now, user.id);
    }

    db.prepare(
      `INSERT INTO billing_events (id, user_id, provider, event_type, plan_granted, amount_cents, payload_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      `evt_${crypto.randomUUID()}`,
      user.id,
      params.provider,
      params.eventType,
      params.tier,
      params.amountCents,
      JSON.stringify(params.payload),
      now
    );
  });

  tx();
  return getUserQuotaSnapshot(params.userId);
}

export function applySubscriptionCanceled(params: {
  userId: string;
  provider: 'stripe' | 'paddle';
  eventType: string;
  payload: unknown;
}): QuotaSnapshot {
  const tx = db.transaction(() => {
    const user = getOrCreateUser(params.userId);
    const now = new Date().toISOString();

    db.prepare(
      `UPDATE users SET plan = 'free', updated_at = ? WHERE id = ?`
    ).run(now, user.id);

    db.prepare(
      `INSERT INTO billing_events (id, user_id, provider, event_type, plan_granted, amount_cents, payload_json, created_at)
       VALUES (?, ?, ?, ?, 'free', 0, ?, ?)`
    ).run(
      `evt_${crypto.randomUUID()}`,
      user.id,
      params.provider,
      params.eventType,
      JSON.stringify(params.payload),
      now
    );
  });

  tx();
  return getUserQuotaSnapshot(params.userId);
}

export function recordBillingAuditEvent(params: {
  userId: string;
  provider: 'stripe' | 'paddle' | 'sandbox';
  eventType: string;
  planGranted: string;
  amountCents: number;
  payload: unknown;
}): void {
  const user = getOrCreateUser(params.userId);
  db.prepare(
    `INSERT INTO billing_events (id, user_id, provider, event_type, plan_granted, amount_cents, payload_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    `evt_${crypto.randomUUID()}`,
    user.id,
    params.provider,
    params.eventType,
    params.planGranted,
    params.amountCents,
    JSON.stringify(params.payload),
    new Date().toISOString()
  );
}

export function resetAccountToFreeForTesting(userId: string): QuotaSnapshot {
  const tx = db.transaction(() => {
    getOrCreateUser(userId);
    const now = new Date().toISOString();
    db.prepare(
      `UPDATE users
       SET plan = 'free',
           token_balance = 0,
           stripe_customer_id = NULL,
           lemonsqueezy_customer_id = NULL,
           updated_at = ?
       WHERE id = ?`
    ).run(now, userId);
    db.prepare(`DELETE FROM usage_logs WHERE user_id = ?`).run(userId);
  });
  tx();
  return getUserQuotaSnapshot(userId);
}

export function exhaustFreeQuotaForTesting(userId: string): QuotaSnapshot {
  const tx = db.transaction(() => {
    getOrCreateUser(userId);
    const now = new Date().toISOString();
    db.prepare(
      `UPDATE users SET plan = 'free', token_balance = 0, updated_at = ? WHERE id = ?`
    ).run(now, userId);

    const used = getMonthlyFreeCleanCount(userId);
    const needed = Math.max(0, FREE_MONTHLY_CLEAN_LIMIT - used);
    for (let i = 0; i < needed; i++) {
      db.prepare(
        `INSERT INTO usage_logs (
          id, user_id, job_id, file_name, file_type, row_count,
          anomalies_found, cells_normalized, action, billing_source, created_at
        ) VALUES (?, ?, NULL, ?, 'csv', 12, 0, 0, 'clean', 'free_monthly', ?)`
      ).run(`log_${crypto.randomUUID()}`, userId, `simulated_batch_${i + 1}.csv`, now);
    }
  });
  tx();
  return getUserQuotaSnapshot(userId);
}
