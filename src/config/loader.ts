import { ConfigSchema, type Config, DEFAULT_CONFIG } from './schema.js';
import {
  deleteConfigValue,
  getConfigValue,
  setConfigValue,
} from '../db/queries.js';
import type { Db } from '../db/index.js';

const KEY = 'main';

/**
 * Fields that must NOT be flipped through the generic patch path. Any change
 * to these has its own gated entrypoint (see disableDryRun in
 * orchestrator/quarantineJob.ts).
 *
 * If we let a PUT /config patch include these, a stray request — or a UI bug —
 * could disable dry-run / unlock the sanity guard with no confirmation phrase,
 * defeating the type-to-confirm safety story documented in README §"Safety
 * model" and PLAN.md "First-run safety."
 */
export const GATED_CONFIG_KEYS = [
  'dry_run',
  'dry_run_disabled_at',
  'sanity_guard_override',
] as const satisfies ReadonlyArray<keyof Config>;

export class GatedConfigKeyError extends Error {
  constructor(public readonly keys: ReadonlyArray<string>) {
    super(
      `Cannot patch gated config keys via PUT /config: ${keys.join(', ')}. ` +
        `Use the dedicated gated endpoint (e.g. POST /config/disable-dry-run).`,
    );
    this.name = 'GatedConfigKeyError';
  }
}

export function loadConfig(db: Db): Config {
  const raw = getConfigValue(db, KEY);
  if (!raw) return { ...DEFAULT_CONFIG };
  try {
    const parsed = JSON.parse(raw);
    return ConfigSchema.parse({ ...DEFAULT_CONFIG, ...parsed });
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export function saveConfig(db: Db, cfg: Config): void {
  const validated = ConfigSchema.parse(cfg);
  setConfigValue(db, KEY, JSON.stringify(validated));
}

/**
 * Patch the persisted config. REJECTS any of the gated keys — those have
 * dedicated, confirmation-gated endpoints. Callers that need to bypass the
 * gate (e.g. the disable-dry-run flow) call `saveConfig` directly.
 */
export function patchConfig(db: Db, patch: Partial<Config>): Config {
  const offending = (Object.keys(patch) as Array<keyof Config>).filter((k) =>
    (GATED_CONFIG_KEYS as ReadonlyArray<string>).includes(k as string),
  );
  if (offending.length > 0) {
    throw new GatedConfigKeyError(offending as string[]);
  }
  const current = loadConfig(db);
  const next = ConfigSchema.parse({ ...current, ...patch });
  setConfigValue(db, KEY, JSON.stringify(next));
  return next;
}

export function resetConfig(db: Db): void {
  deleteConfigValue(db, KEY);
}
