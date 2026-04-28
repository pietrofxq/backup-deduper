import { z } from 'zod';
import type { ServerDeps } from '../index.js';
import type { ZodApp } from '../types.js';
import {
  listCollections,
  setPrimary,
  UnknownCollectionError,
} from '../../db/queries.js';
import { syncCollectionsTable } from '../../scanner/index.js';

const Collection = z.object({
  id: z.number().int(),
  relPath: z.string(),
  isPrimary: z.boolean(),
});

const SetPrimaryBody = z.object({
  collectionId: z.number().int().positive(),
});

const Ok = z.object({ ok: z.literal(true) });
const ErrorResponse = z.object({ error: z.string() });

export async function registerCollectionRoutes(
  app: ZodApp,
  deps: ServerDeps,
): Promise<void> {
  app.get(
    '/collections',
    { schema: { response: { 200: z.array(Collection) } } },
    async () => {
      syncCollectionsTable(deps.db, deps.targetRoot);
      return listCollections(deps.db).map((c) => ({
        id: c.id,
        relPath: c.rel_path,
        isPrimary: c.is_primary === 1,
      }));
    },
  );

  app.post(
    '/collections/set-primary',
    {
      schema: {
        body: SetPrimaryBody,
        response: { 200: Ok, 404: ErrorResponse },
      },
    },
    async (req, reply) => {
      try {
        setPrimary(deps.db, req.body.collectionId);
        return { ok: true as const };
      } catch (err) {
        if (err instanceof UnknownCollectionError) {
          return reply.code(404).send({ error: err.message });
        }
        throw err;
      }
    },
  );
}
