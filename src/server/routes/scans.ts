import { z } from 'zod';
import type { ServerDeps } from '../index.js';
import type { ZodApp } from '../types.js';
import { runScanJob } from '../../orchestrator/scanJob.js';
import { getScanResult, rememberScan } from '../../orchestrator/runStore.js';
import { getRun, listRuns } from '../../db/queries.js';
import {
  DryRunGateError,
  runQuarantineJob,
  SanityGuardError,
} from '../../orchestrator/quarantineJob.js';
import { UnreadableSubtreeError } from '../../scanner/index.js';
import { UnknownPresetError } from '../../presets/registry.js';

const StartScanBody = z.object({
  presetName: z.string().optional(),
  dryRun: z.boolean().optional(),
});

const RunQuarantineBody = z.object({
  scanRunId: z.number().int().positive(),
  ignoreSanityGuard: z.boolean().optional(),
});

const Params = z.object({ id: z.coerce.number().int().positive() });

const ErrorResponse = z.object({ error: z.string() });

export async function registerScanRoutes(app: ZodApp, deps: ServerDeps): Promise<void> {
  app.get('/scans', async () => listRuns(deps.db, 50));

  app.get(
    '/scans/:id',
    { schema: { params: Params } },
    async (req, reply) => {
      const run = getRun(deps.db, req.params.id);
      if (!run) {
        return reply.code(404).send({ error: 'scan_run_not_found' });
      }
      const cached = getScanResult(req.params.id);
      return { run, report: cached?.report ?? null };
    },
  );

  app.post(
    '/scans',
    { schema: { body: StartScanBody.optional() } },
    async (req, reply) => {
      try {
        const result = await runScanJob(deps.db, deps.targetRoot, req.body ?? {});
        rememberScan(result);
        return {
          runId: result.runId,
          reportPath: result.reportPath,
          report: result.report,
        };
      } catch (err) {
        if (err instanceof DryRunGateError) {
          return reply.code(400).send({ error: err.message, kind: 'dry_run_gate' });
        }
        if (err instanceof UnreadableSubtreeError) {
          return reply.code(409).send({
            error: err.message,
            kind: 'unreadable_subtree',
            unreadablePaths: err.unreadablePaths,
            collectionRelPath: err.collectionRelPath,
          });
        }
        if (err instanceof UnknownPresetError) {
          return reply.code(404).send({ error: err.message, kind: 'unknown_preset' });
        }
        throw err;
      }
    },
  );

  app.post(
    '/quarantine/run',
    { schema: { body: RunQuarantineBody } },
    async (req, reply) => {
      const cached = getScanResult(req.body.scanRunId);
      if (!cached) {
        return reply
          .code(404)
          .send({
            error:
              'scan result not found in cache; re-run /scans first (server restarts clear the cache)',
          });
      }
      try {
        return runQuarantineJob({
          db: deps.db,
          targetRoot: deps.targetRoot,
          scanRunId: req.body.scanRunId,
          actions: cached.actions,
          emptyDirs: cached.emptyDirActions,
          ignoreSanityGuard: req.body.ignoreSanityGuard ?? false,
        });
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
}
