import { z } from 'zod';
import type { ServerDeps } from '../index.js';
import type { ZodApp } from '../types.js';
import { PresetSchema } from '../../presets/types.js';
import { listAvailablePresets } from '../../presets/registry.js';

export async function registerPresetRoutes(app: ZodApp, deps: ServerDeps): Promise<void> {
  app.get(
    '/presets',
    { schema: { response: { 200: z.array(PresetSchema) } } },
    async () => listAvailablePresets(deps.db),
  );
}
