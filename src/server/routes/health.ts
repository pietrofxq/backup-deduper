import { z } from 'zod';
import type { ServerDeps } from '../index.js';
import type { ZodApp } from '../types.js';
import { getTarget } from '../../db/queries.js';

const HealthResponse = z.object({
  ok: z.boolean(),
  targetRoot: z.string(),
  uuid: z.string().nullable(),
});

export async function registerHealthRoutes(app: ZodApp, deps: ServerDeps): Promise<void> {
  app.get(
    '/health',
    { schema: { response: { 200: HealthResponse } } },
    async () => {
      const t = getTarget(deps.db);
      return {
        ok: true,
        targetRoot: deps.targetRoot,
        uuid: t?.target_id_uuid ?? null,
      };
    },
  );
}
