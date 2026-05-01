import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { ServerDeps } from '../index.js';
import type { ZodApp } from '../types.js';
import { registerHealthRoutes } from './health.js';
import { registerConfigRoutes } from './config.js';
import { registerCollectionRoutes } from './collections.js';
import { registerPresetRoutes } from './presets.js';
import { registerScanRoutes } from './scans.js';
import { registerReviewRoutes } from './review.js';
import { registerQuarantineRoutes } from './quarantine.js';
import { registerEventRoutes } from './events.js';
import { registerStaticUi } from '../static.js';

/**
 * Register every API route under the `/api` prefix and the static UI at `/`.
 *
 * The SPA owns `/` (Vite/React bundle); the server owns `/api`. Tests target
 * the same `/api/*` URLs the browser will hit, so contract coverage and the
 * production wire shape stay in lockstep.
 */
export async function registerRoutes(app: ZodApp, deps: ServerDeps): Promise<void> {
  await app.register(
    async (sub) => {
      const typed = sub.withTypeProvider<ZodTypeProvider>();
      await registerHealthRoutes(typed, deps);
      await registerConfigRoutes(typed, deps);
      await registerCollectionRoutes(typed, deps);
      await registerPresetRoutes(typed, deps);
      await registerScanRoutes(typed, deps);
      await registerReviewRoutes(typed, deps);
      await registerQuarantineRoutes(typed, deps);
      await registerEventRoutes(typed, deps);
    },
    { prefix: '/api' },
  );
  await registerStaticUi(app);
}
