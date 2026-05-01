import { z } from 'zod';
import type { ServerDeps } from '../index.js';
import type { ZodApp } from '../types.js';
import { runScanJob, ScanAbortedError } from '../../orchestrator/scanJob.js';
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
      const events = deps.events;
      const controller = new AbortController();
      let registeredRunId: number | null = null;

      try {
        const result = await runScanJob(deps.db, deps.targetRoot, {
          ...(req.body ?? {}),
          signal: controller.signal,
          onRunCreated: (runId) => {
            // Register cancel handle as soon as the run row exists, before
            // the long-running scan loop starts. The orchestrator catches
            // signal aborts at every phase boundary and inside the hashing
            // loop, so a cancel issued any time after this point takes
            // effect within one file's worth of work.
            registeredRunId = runId;
            events?.registerCancellable(runId, controller);
            events?.publish('phase', runId, { phase: 'started' });
          },
          onProgress: (event) => {
            if (!events || registeredRunId === null) return;
            // Map orchestrator-level events to bus event types. The shape
            // is preserved so downstream clients can parse without a switch.
            switch (event.type) {
              case 'phase':
                events.publish('phase', registeredRunId, { phase: event.phase });
                break;
              case 'discovered':
                events.publish('discovered', registeredRunId, event);
                break;
              case 'hashed':
                events.publish('hashed', registeredRunId, event);
                break;
              case 'collection_done':
                events.publish('collection_done', registeredRunId, event);
                break;
              case 'classified':
                events.publish('classified', registeredRunId, event);
                break;
            }
          },
        });
        rememberScan(result);
        events?.publish('done', result.runId, {
          totalActions: result.report.totalActions,
          totalBytes: result.report.totalBytes,
          reviewPairs: result.report.reviewPairs,
          sanityGuardPassed: result.sanityGuard.passed,
          reportPath: result.reportPath,
        });
        return {
          runId: result.runId,
          reportPath: result.reportPath,
          report: result.report,
        };
      } catch (err) {
        if (err instanceof ScanAbortedError) {
          events?.publish('aborted', err.runId, { reason: 'cancelled by user' });
          return reply.code(409).send({
            error: err.message,
            kind: 'aborted',
          });
        }
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
        if (registeredRunId !== null) {
          events?.publish('failed', registeredRunId, {
            error: err instanceof Error ? err.message : String(err),
          });
        }
        throw err;
      } finally {
        if (registeredRunId !== null) events?.unregisterCancellable(registeredRunId);
      }
    },
  );

  app.post(
    '/scans/:id/cancel',
    {
      schema: {
        params: Params,
        response: {
          200: z.object({ ok: z.literal(true), runId: z.number().int() }),
          404: ErrorResponse,
        },
      },
    },
    async (req, reply) => {
      const events = deps.events;
      if (!events) {
        return reply.code(404).send({ error: 'event bus not configured' });
      }
      const ok = events.cancel(req.params.id);
      if (!ok) {
        return reply
          .code(404)
          .send({ error: `no in-flight scan with runId=${req.params.id}` });
      }
      return { ok: true as const, runId: req.params.id };
    },
  );
}

// Re-export so callers building the report shape can keep their imports stable.
export { DryRunReport };
