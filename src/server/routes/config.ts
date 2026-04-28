import { z } from 'zod';
import type { ServerDeps } from '../index.js';
import type { ZodApp } from '../types.js';
import { ConfigSchema } from '../../config/schema.js';
import {
  GATED_CONFIG_KEYS,
  GatedConfigKeyError,
  loadConfig,
  patchConfig,
} from '../../config/loader.js';
import { disableDryRun, DryRunGateError } from '../../orchestrator/quarantineJob.js';

// Build the patch body from the config schema MINUS the gated keys, with
// `.strict()` so any attempt to pass a gated key in the body fails validation
// (HTTP 400) instead of being silently stripped (zod's default "strip" mode).
// patchConfig() also enforces this at runtime as defense-in-depth — see
// GatedConfigKeyError in src/config/loader.ts.
const PatchBody = ConfigSchema.omit(
  Object.fromEntries(GATED_CONFIG_KEYS.map((k) => [k, true])) as Record<
    (typeof GATED_CONFIG_KEYS)[number],
    true
  >,
)
  .partial()
  .strict();

const ConfirmBody = z.object({
  phrase: z.string(),
});

const ErrorResponse = z.object({
  error: z.string(),
});

const DisableOk = z.object({
  ok: z.literal(true),
  config: ConfigSchema,
});

export async function registerConfigRoutes(app: ZodApp, deps: ServerDeps): Promise<void> {
  app.get(
    '/config',
    { schema: { response: { 200: ConfigSchema } } },
    async () => loadConfig(deps.db),
  );

  app.put(
    '/config',
    { schema: { body: PatchBody, response: { 200: ConfigSchema, 400: ErrorResponse } } },
    async (req, reply) => {
      try {
        return patchConfig(deps.db, req.body);
      } catch (err) {
        if (err instanceof GatedConfigKeyError) {
          return reply.code(400).send({ error: err.message });
        }
        throw err;
      }
    },
  );

  app.post(
    '/config/disable-dry-run',
    {
      schema: {
        body: ConfirmBody,
        response: { 200: DisableOk, 400: ErrorResponse },
      },
    },
    async (req, reply) => {
      try {
        disableDryRun(deps.db, req.body.phrase, deps.targetRoot);
        return { ok: true as const, config: loadConfig(deps.db) };
      } catch (err) {
        if (err instanceof DryRunGateError) {
          return reply.code(400).send({ error: err.message });
        }
        throw err;
      }
    },
  );
}
