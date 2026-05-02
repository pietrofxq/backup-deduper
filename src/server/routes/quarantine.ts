import { z } from 'zod';
import type { ServerDeps } from '../index.js';
import type { ZodApp } from '../types.js';
import {
  listActiveActions,
  listAuditPage,
  listAuditReasons,
} from '../../db/queries.js';
import { bulkRestore } from '../../mover/restore.js';
import { purge } from '../../mover/purge.js';
import { loadConfig } from '../../config/loader.js';
import { getScanResult } from '../../orchestrator/runStore.js';
import { withMutationLock } from '../../orchestrator/mutex.js';
import {
  DryRunGateError,
  runQuarantineJob,
  SanityGuardError,
} from '../../orchestrator/quarantineJob.js';
import {
  AuditPageResponse,
  BulkRestoreSummary,
  ErrorResponse,
  PurgeSummary,
  QuarantineActionRow,
  QuarantineRunError,
  QuarantineRunResponse,
} from '../schemas.js';

const ListQuery = z.object({
  runId: z.coerce.number().int().positive().optional(),
});

const RestoreBody = z.object({
  actionIds: z.array(z.number().int().positive()).min(1),
  allowSidecar: z.boolean().default(false),
});

const PurgeBody = z.object({
  dryRun: z.boolean().default(true),
});

const RunQuarantineBody = z.object({
  scanRunId: z.number().int().positive(),
  ignoreSanityGuard: z.boolean().optional(),
});

export async function registerQuarantineRoutes(
  app: ZodApp,
  deps: ServerDeps,
): Promise<void> {
  app.get(
    '/quarantine',
    {
      schema: {
        querystring: ListQuery,
        response: { 200: z.array(QuarantineActionRow) },
      },
    },
    async (req) => listActiveActions(deps.db, req.query.runId),
  );

  const AuditQuery = z.object({
    runId: z.coerce.number().int().positive().optional(),
    reason: z.string().min(1).optional(),
    after: z.string().min(1).optional(),
    before: z.string().min(1).optional(),
    limit: z.coerce.number().int().min(1).max(500).default(100),
    offset: z.coerce.number().int().nonnegative().default(0),
  });

  app.get(
    '/audit',
    {
      schema: {
        querystring: AuditQuery,
        response: { 200: AuditPageResponse },
      },
    },
    async (req) => {
      const page = listAuditPage(
        deps.db,
        {
          runId: req.query.runId,
          reason: req.query.reason,
          after: req.query.after,
          before: req.query.before,
        },
        req.query.limit,
        req.query.offset,
      );
      return { ...page, reasons: listAuditReasons(deps.db) };
    },
  );

  app.post(
    '/quarantine/run',
    {
      schema: {
        body: RunQuarantineBody,
        response: {
          200: QuarantineRunResponse,
          400: QuarantineRunError,
          404: ErrorResponse,
        },
      },
    },
    async (req, reply) => {
      const cached = getScanResult(req.body.scanRunId);
      if (!cached) {
        return reply.code(404).send({
          error:
            'scan result not found in cache; re-run /api/scans first (server restarts clear the cache)',
        });
      }
      try {
        return await withMutationLock(() =>
          runQuarantineJob({
            db: deps.db,
            targetRoot: deps.targetRoot,
            scanRunId: req.body.scanRunId,
            actions: cached.actions,
            emptyDirs: cached.emptyDirActions,
            ignoreSanityGuard: req.body.ignoreSanityGuard ?? false,
            // The cached scan's guard carries the canonical "no primary at
            // scan time" flag. Pass it so runQuarantineJob can refuse a
            // stale plan even if the user has since set a primary (the
            // plan itself reflects the old lex-tiebroken keeper).
            scanGuard: cached.sanityGuard,
          }),
        );
      } catch (err) {
        if (err instanceof DryRunGateError) {
          return reply.code(400).send({ error: err.message, kind: 'dry_run_gate' });
        }
        if (err instanceof SanityGuardError) {
          return reply
            .code(400)
            .send({ error: err.message, kind: 'sanity_guard', guard: err.guard });
        }
        throw err;
      }
    },
  );

  app.post(
    '/quarantine/restore',
    {
      schema: {
        body: RestoreBody,
        response: { 200: BulkRestoreSummary },
      },
    },
    async (req) =>
      withMutationLock(() =>
        bulkRestore({
          db: deps.db,
          targetRoot: deps.targetRoot,
          actionIds: req.body.actionIds,
          allowSidecar: req.body.allowSidecar,
        }),
      ),
  );

  app.post(
    '/quarantine/purge',
    {
      schema: {
        body: PurgeBody.optional(),
        response: { 200: PurgeSummary },
      },
    },
    async (req) => {
      const cfg = loadConfig(deps.db);
      return withMutationLock(() =>
        purge({
          db: deps.db,
          targetRoot: deps.targetRoot,
          retentionDays: cfg.retention_days,
          dryRun: req.body?.dryRun ?? true,
        }),
      );
    },
  );
}
