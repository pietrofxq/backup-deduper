import { z } from 'zod';

export const ConfigSchema = z.object({
  active_preset: z.string().default('Samsung Android phone backup'),
  retention_days: z.number().int().min(1).max(365).default(30),
  dry_run: z.boolean().default(true),
  dry_run_disabled_at: z.string().nullable().default(null),
  sanity_guard_files_pct: z.number().min(0).max(1).default(0.5),
  sanity_guard_bytes_pct: z.number().min(0).max(1).default(0.7),
  sanity_guard_override: z.boolean().default(false),
});

export type Config = z.infer<typeof ConfigSchema>;

export const DEFAULT_CONFIG: Config = ConfigSchema.parse({});

export const CONFIRMATION_PHRASE = 'I have reviewed the dry-run report';
