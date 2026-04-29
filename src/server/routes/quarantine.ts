import { z } from 'zod';
import type { ServerDeps } from '../index.js';
import type { ZodApp } from '../types.js';
import { listActiveActions, listAllActions } from '../../db/queries.js';
import { bulkRestore } from '../../mover/restore.js';
import { purge } from '../../mover/purge.js';
import { loadConfig } from '../../config/loader.js';

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

export async function registerQuarantineRoutes(
  app: ZodApp,
  deps: ServerDeps,
): Promise<void> {
  app.get(
    '/quarantine',
    { schema: { querystring: ListQuery } },
    async (req) => listActiveActions(deps.db, req.query.runId),
  );

  app.get('/audit', async () => listAllActions(deps.db));

  app.post(
    '/quarantine/restore',
    { schema: { body: RestoreBody } },
    async (req) =>
      bulkRestore({
        db: deps.db,
        targetRoot: deps.targetRoot,
        actionIds: req.body.actionIds,
        allowSidecar: req.body.allowSidecar,
      }),
  );

  app.post(
    '/quarantine/purge',
    { schema: { body: PurgeBody.optional() } },
    async (req) => {
      const cfg = loadConfig(deps.db);
      return purge({
        db: deps.db,
        targetRoot: deps.targetRoot,
        retentionDays: cfg.retention_days,
        dryRun: req.body?.dryRun ?? true,
      });
    },
  );
}
