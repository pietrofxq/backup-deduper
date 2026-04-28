import type { ServerDeps } from '../index.js';
import type { ZodApp } from '../types.js';
import { registerHealthRoutes } from './health.js';
import { registerConfigRoutes } from './config.js';
import { registerCollectionRoutes } from './collections.js';
import { registerPresetRoutes } from './presets.js';
import { registerScanRoutes } from './scans.js';
import { registerReviewRoutes } from './review.js';
import { registerQuarantineRoutes } from './quarantine.js';
import { registerStaticUi } from '../static.js';

export async function registerRoutes(app: ZodApp, deps: ServerDeps): Promise<void> {
  await registerHealthRoutes(app, deps);
  await registerConfigRoutes(app, deps);
  await registerCollectionRoutes(app, deps);
  await registerPresetRoutes(app, deps);
  await registerScanRoutes(app, deps);
  await registerReviewRoutes(app, deps);
  await registerQuarantineRoutes(app, deps);
  await registerStaticUi(app);
}
