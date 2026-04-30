import { z } from 'zod';
import type { ServerDeps } from '../index.js';
import type { ZodApp } from '../types.js';
import { runScanJob } from '../../orchestrator/scanJob.js';
import { getScanResult, rememberScan } from '../../orchestrator/runStore.js';
import { getRun, listRuns } from '../../db/queries.js';
import { DryRunGateError } from '../../orchestrator/quarantineJob.js';
import { UnreadableSubtreeError } from '../../scanner/index.js';
import { UnknownPresetError } from '../../presets/registry.js';
import {
  DryRunReport,
  ErrorResponse,
  RunRow,
  ScanDetailResponse,
  ScanGateError,
  ScanStartResponse,
} from '../schemas.js';

const StartScanBody = z.object({
  presetName: z.string().optional(),
  dryRun: z.boolean().optional(),
});

const Params = z.object({ id: z.coerce.number().int().positive() });

export async function registerScanRoutes(app: ZodApp, deps: ServerDeps): Promise<void> {
  app.get(
    '/scans',
    { schema: { response: { 200: z.array(RunRow) } } },
    async () => listRuns(deps.db, 50),
  );

  app.get(
    '/scans/:id',
    {
      schema: {
        params: Params,
        response: { 200: ScanDetailResponse, 404: ErrorResponse },
      },
    },
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
    {
      schema: {
        body: StartScanBody.optional(),
        response: {
          200: ScanStartResponse,
          400: ScanGateError,
          404: ScanGateError,
          409: ScanGateError,
        },
      },
    },
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
            // Spread to a fresh mutable array so the response schema's
            // `array(string)` doesn't reject ReadonlyArray.
            unreadablePaths: [...err.unreadablePaths],
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
}

// Re-export so callers building the report shape can keep their imports stable.
export { DryRunReport };
