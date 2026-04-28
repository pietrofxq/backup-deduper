import { z } from 'zod';
import type { ServerDeps } from '../index.js';
import type { ZodApp } from '../types.js';
import { listReviewItems, setReviewItemStatus } from '../../db/queries.js';

const ReviewStatus = z.enum(['open', 'kept_both', 'quarantined_a', 'quarantined_b']);

const ListQuery = z.object({
  status: ReviewStatus.optional(),
});

/**
 * v1: only `kept_both` is accepted. The `quarantined_a`/`quarantined_b`
 * statuses exist in the schema for a future revision that wires a single
 * chosen-side quarantine through the mover (with re-hash, two-phase commit,
 * audit row, restore path). Until that wiring is in place we MUST refuse
 * those values — otherwise the API would silently set a status column with
 * no fs side effect, and the user would believe a deletion happened.
 */
const DecisionBody = z.object({
  status: z.literal('kept_both'),
});

const Params = z.object({ id: z.coerce.number().int().positive() });

const Ok = z.object({ ok: z.literal(true) });

export async function registerReviewRoutes(app: ZodApp, deps: ServerDeps): Promise<void> {
  app.get(
    '/review',
    { schema: { querystring: ListQuery } },
    async (req) => listReviewItems(deps.db, req.query.status),
  );

  app.post(
    '/review/:id/decision',
    {
      schema: {
        params: Params,
        body: DecisionBody,
        response: { 200: Ok },
      },
    },
    async (req) => {
      setReviewItemStatus(deps.db, req.params.id, req.body.status);
      return { ok: true as const };
    },
  );
}
