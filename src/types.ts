export type UserPlan = 'free' | 'pro' | 'token_pack';

export type DocumentCategory =
  | 'transactions'
  | 'receipt'
  | 'client_roster'
  | 'invoice'
  | 'general_table';

export type AnomalySeverity = 'critical' | 'warning' | 'fixed';

export interface CellDiff {
  rowIndex: number;
  column: string;
  rawHeader: string;
  rawValue: string;
  cleanedValue: string;
  changeType:
    | 'currency'
    | 'date'
    | 'phone'
    | 'formula_error'
    | 'whitespace'
    | 'schema'
    | 'duplicate'
    | 'missing';
}

export interface AnomalyItem {
  id: string;
  severity: AnomalySeverity;
  category: string;
  location: string;
  rawValue: string;
  suggestedOrFixedValue: string;
  explanation: string;
}

export interface SchemaMapping {
  rawHeader: string;
  normalizedHeader: string;
  detectedType: 'date' | 'currency' | 'phone' | 'email' | 'text' | 'number' | 'status';
  reason: string;
}

export interface CleanJob {
  id: string;
  userId: string;
  fileName: string;
  fileType: string;
  documentCategory: DocumentCategory;
  rawHeaders: string[];
  rawRows: Record<string, string>[];
  cleanedHeaders: string[];
  cleanedRows: Record<string, string>[];
  cellDiffs: CellDiff[];
  anomalies: AnomalyItem[];
  schemaMappings: SchemaMapping[];
  executiveSummary: string;
  rowCount: number;
  processingMs: number;
  createdAt: string;
}

export interface QuotaSnapshot {
  userId: string;
  email: string;
  name: string;
  plan: UserPlan;
  freeCleansUsedThisMonth: number;
  freeCleansLimit: number;
  freeRowLimit: number;
  tokenBalance: number;
  remainingCleans: number | 'unlimited';
  canProcessNewFile: boolean;
  canExportProFormats: boolean;
  billingCycleMonth: string;
}

export interface UsageLog {
  id: string;
  userId: string;
  jobId: string | null;
  fileName: string;
  fileType: string;
  rowCount: number;
  anomaliesFound: number;
  cellsNormalized: number;
  action: 'clean' | 'export_csv' | 'export_xlsx' | 'export_pdf';
  billingSource: 'free_monthly' | 'token_pack' | 'pro_unlimited';
  createdAt: string;
}

export interface BillingEvent {
  id: string;
  provider: string;
  event_type: string;
  plan_granted: string;
  amount_cents: number;
  created_at: string;
}

export interface PaywallContext {
  open: boolean;
  reason: string;
  code?: string;
}
