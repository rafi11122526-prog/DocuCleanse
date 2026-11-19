import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';
import express from 'express';
import multer from 'multer';
import {
  consumeCleanCreditAndLog,
  getJobById,
  getOrCreateUser,
  getUserJobs,
  getUserQuotaSnapshot,
  getUserUsageLogs,
  logExportAction,
  saveCleanJob,
} from './server/db.ts';
import {
  checkCleanQuota,
  enforceRowLimit,
  requireProExport,
  resolveUserId,
  type GuardedRequest,
} from './server/middleware/monetization.ts';
import { billingRouter } from './server/routes/billing.ts';
import {
  cleanMultimodalDocument,
  cleanTabularDocument,
} from './server/services/cleaner.ts';
import {
  generateCsvBuffer,
  generateSummaryPdfBuffer,
  generateXlsxBuffer,
} from './server/services/exporter.ts';
import { parseUploadedFile } from './server/services/parser.ts';

dotenv.config();

const PORT = Number(process.env.PORT) || 3000;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 200 * 1024 * 1024, // 200MB max upload
  },
});

async function startServer() {
  const app = express();

  // Paddle webhook requires the raw request body for HMAC SHA-256 signature verification
  app.use('/api/billing/webhook/paddle', express.raw({ type: 'application/json', limit: '2mb' }));

  app.use(express.json({ limit: '200mb' }));
  app.use(express.urlencoded({ limit: '200mb', extended: true }));

  // CORS middleware for local dev, Vite proxy, and preview containers
  app.use('/api', (req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', req.header('origin') || '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    res.setHeader(
      'Access-Control-Allow-Headers',
      'Content-Type, Authorization, x-user-id, stripe-signature, paddle-signature'
    );
    res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition, Content-Type');
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
  });

  // Health endpoint with ephemeral RAM lifecycle attestation
  app.get('/api/health', (_req, res) => {
    res.json({
      ok: true,
      service: 'docucleanse-api',
      storageMode: 'ephemeral_ram_memoryStorage',
      rawFileDiskRetention: 'zero',
      timestamp: new Date().toISOString(),
    });
  });

  // Current user quota & usage logs
  app.get('/api/quota', (req, res) => {
    const userId = resolveUserId(req);
    getOrCreateUser(userId);
    const quota = getUserQuotaSnapshot(userId);
    const usageLogs = getUserUsageLogs(userId, 30);
    res.json({ quota, usageLogs });
  });

  // Billing & Webhook routes (Stripe / Lemon Squeezy stubs + sandbox)
  app.use('/api/billing', billingRouter);

  // Core Processing Pipeline guarded by checkCleanQuota middleware
  app.post(
    '/api/clean',
    checkCleanQuota,
    upload.single('file'),
    async (req: GuardedRequest, res) => {
      const uploadedFile = req.file as (Express.Multer.File & { path?: string }) | undefined;
      try {
        const userId = req.docuUserId!;
        const quota = req.quotaSnapshot!;
        const file = uploadedFile;

        if (!file) {
          res.status(400).json({ error: 'No file provided. Upload a CSV, XLSX, PDF, or receipt image.' });
          return;
        }

        const fileHashSha256 = crypto.createHash('sha256').update(file.buffer).digest('hex');
        const parsed = parseUploadedFile(file.buffer, file.originalname, file.mimetype);

        let job;
        if (parsed.kind === 'tabular') {
          // Enforce 50-row Free tier limit BEFORE calling Gemini AI
          const rowCheck = enforceRowLimit(quota, parsed.rows.length);
          if (!rowCheck.allowed) {
            res.status(rowCheck.status).json(rowCheck.payload);
            return;
          }

          job = await cleanTabularDocument({
            userId,
            fileName: file.originalname,
            parsed,
            fileHashSha256,
          });
        } else {
          job = await cleanMultimodalDocument({
            userId,
            fileName: file.originalname,
            parsed,
            fileHashSha256,
          });
        }

        saveCleanJob(job);
        const billing = consumeCleanCreditAndLog({
          userId,
          jobId: job.id,
          fileName: job.fileName,
          fileType: job.fileType,
          rowCount: job.rowCount,
          anomaliesFound: job.anomalies.length,
          cellsNormalized: job.cellDiffs.length,
        });

        res.json({
          job,
          billingSource: billing.billingSource,
          quota: billing.quota,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to process document.';
        const status =
          message.includes('GEMINI_API_KEY') || message.includes('API_KEY')
            ? 503
            : message.includes('empty') || message.includes('Unsupported')
            ? 400
            : 500;
        res.status(status).json({ error: message });
      } finally {
        // Ephemeral RAM Lifecycle Guard: deterministically zeroize raw file bytes from memory
        // and defensively unlink any temp path if a stream fallback were ever configured.
        if (uploadedFile?.buffer && Buffer.isBuffer(uploadedFile.buffer)) {
          uploadedFile.buffer.fill(0);
        }
        if (uploadedFile?.path) {
          try {
            await fs.promises.rm(uploadedFile.path, { force: true });
          } catch {
            // Ignore already-removed temp paths
          }
        }
        if (req.file) {
          req.file.buffer = Buffer.alloc(0);
        }
      }
    }
  );

  // Job history & single job retrieval
  app.get('/api/jobs', (req, res) => {
    const userId = resolveUserId(req);
    getOrCreateUser(userId);
    const jobs = getUserJobs(userId, 25);
    res.json({ jobs });
  });

  app.get('/api/jobs/:jobId', (req, res) => {
    const job = getJobById(req.params.jobId);
    if (!job) {
      res.status(404).json({ error: 'Clean job not found.' });
      return;
    }
    res.json({ job });
  });

  // Formal Pre-Audit Attestation Certificate PDF (always downloadable for compliance verification)
  app.get('/api/export/:jobId/certificate', async (req, res) => {
    try {
      const userId = resolveUserId(req);
      getOrCreateUser(userId);
      const job = getJobById(String(req.params.jobId));
      if (!job) {
        res.status(404).json({ error: 'Clean job not found.' });
        return;
      }

      const baseName = path
        .basename(job.fileName, path.extname(job.fileName))
        .replace(/[^a-zA-Z0-9_-]/g, '_');

      if (job.auditMetadata) {
        res.setHeader('X-DocuCleanse-SHA256', job.auditMetadata.fileHashSha256);
        res.setHeader('X-DocuCleanse-Timestamp-UTC', job.auditMetadata.timestampUtc);
        res.setHeader(
          'X-DocuCleanse-Row-Checksum',
          `${job.auditMetadata.rowsIngested}/${job.auditMetadata.rowsCleaned}:${job.auditMetadata.rowChecksumMatch ? 'VERIFIED' : 'MISMATCH'}`
        );
      }

      const buffer = await generateSummaryPdfBuffer(job);
      logExportAction({
        userId,
        jobId: job.id,
        fileName: job.fileName,
        fileType: job.fileType,
        rowCount: job.rowCount,
        action: 'export_pdf',
      });
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="${baseName}_pre_audit_attestation_certificate.pdf"`
      );
      res.send(buffer);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Attestation certificate export failed.';
      res.status(500).json({ error: message });
    }
  });

  // Export endpoint guarded by requireProExport for XLSX & PDF formats
  app.get('/api/export/:jobId/:format', requireProExport, async (req: GuardedRequest, res) => {
    try {
      const jobId = String(req.params.jobId);
      const format = String(req.params.format).toLowerCase();
      const job = getJobById(jobId);

      if (!job) {
        res.status(404).json({ error: 'Clean job not found.' });
        return;
      }

      const baseName = path.basename(job.fileName, path.extname(job.fileName)).replace(/[^a-zA-Z0-9_-]/g, '_');

      // Attach Institutional Audit Trail & Compliance HTTP Headers to every export
      if (job.auditMetadata) {
        res.setHeader('X-DocuCleanse-SHA256', job.auditMetadata.fileHashSha256);
        res.setHeader('X-DocuCleanse-Timestamp-UTC', job.auditMetadata.timestampUtc);
        res.setHeader(
          'X-DocuCleanse-Row-Checksum',
          `${job.auditMetadata.rowsIngested}/${job.auditMetadata.rowsCleaned}:${job.auditMetadata.rowChecksumMatch ? 'VERIFIED' : 'MISMATCH'}`
        );
        res.setHeader(
          'X-DocuCleanse-Reconciled-Variance',
          `input=${job.auditMetadata.inputSum.toFixed(2)};output=${job.auditMetadata.outputSum.toFixed(2)};delta=${job.auditMetadata.reconciledVariance.toFixed(2)}`
        );
      }

      if (format === 'csv') {
        const buffer = generateCsvBuffer(job);
        logExportAction({
          userId: req.docuUserId!,
          jobId: job.id,
          fileName: job.fileName,
          fileType: job.fileType,
          rowCount: job.rowCount,
          action: 'export_csv',
        });
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${baseName}_cleaned.csv"`);
        res.send(buffer);
        return;
      }

      if (format === 'xlsx') {
        const buffer = await generateXlsxBuffer(job);
        logExportAction({
          userId: req.docuUserId!,
          jobId: job.id,
          fileName: job.fileName,
          fileType: job.fileType,
          rowCount: job.rowCount,
          action: 'export_xlsx',
        });
        res.setHeader(
          'Content-Type',
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
        );
        res.setHeader('Content-Disposition', `attachment; filename="${baseName}_cleaned.xlsx"`);
        res.send(buffer);
        return;
      }

      if (format === 'pdf') {
        const buffer = await generateSummaryPdfBuffer(job);
        logExportAction({
          userId: req.docuUserId!,
          jobId: job.id,
          fileName: job.fileName,
          fileType: job.fileType,
          rowCount: job.rowCount,
          action: 'export_pdf',
        });
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="${baseName}_pre_audit_certificate.pdf"`);
        res.send(buffer);
        return;
      }

      res.status(400).json({ error: 'Unsupported export format. Use csv, xlsx, or pdf.' });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Export failed.';
      res.status(500).json({ error: message });
    }
  });

  // Ensure unmatched /api/* routes always return JSON instead of SPA HTML
  app.all('/api/*', (req, res) => {
    res.status(404).json({
      error: `API route not found: ${req.method} ${req.originalUrl}`,
    });
  });

  // JSON error handler for /api/* (including Multer upload errors)
  app.use(
    '/api',
    (
      err: unknown,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction
    ) => {
      const message = err instanceof Error ? err.message : 'Unexpected server error.';
      const status =
        err instanceof multer.MulterError
          ? 400
          : message.includes('GEMINI_API_KEY')
          ? 503
          : 500;
      res.status(status).json({ error: message });
    }
  );

  // Vite dev middleware vs static production dist
  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`DocuCleanse server listening on http://localhost:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start DocuCleanse server:', err);
  process.exit(1);
});
