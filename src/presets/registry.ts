import type { Db } from '../db/index.js';
import { getPresetByName, listPresets, upsertPreset } from '../db/queries.js';
import { loadConfig } from '../config/loader.js';
import { MINIMAL } from './minimal.js';
import { SAMSUNG_ANDROID } from './samsung-android.js';
import { type Preset, PresetSchema } from './types.js';

export type { Preset } from './types.js';

const BUILTINS: ReadonlyArray<Preset> = [SAMSUNG_ANDROID, MINIMAL];

export function builtinPresets(): ReadonlyArray<Preset> {
  return BUILTINS;
}

export function seedBuiltinPresets(db: Db): void {
  for (const p of BUILTINS) {
    const validated = PresetSchema.parse(p);
    upsertPreset(db, {
      name: validated.name,
      cruftRulesJson: JSON.stringify(validated.cruft_rules),
      whitelistJson: JSON.stringify(validated.whitelist),
      pathPriorityJson: JSON.stringify(validated.path_priority),
      isBuiltin: true,
    });
  }
}

export function loadActivePreset(db: Db): Preset {
  const cfg = loadConfig(db);
  return loadPresetByName(db, cfg.active_preset);
}

export function loadPresetByName(db: Db, name: string): Preset {
  const row = getPresetByName(db, name);
  if (!row) {
    // Fall back to first builtin if the configured preset is unknown.
    return SAMSUNG_ANDROID;
  }
  return PresetSchema.parse({
    name: row.name,
    description: '',
    cruft_rules: JSON.parse(row.cruft_rules_json),
    whitelist: JSON.parse(row.whitelist_json),
    path_priority: JSON.parse(row.path_priority_json),
  });
}

export function listAvailablePresets(db: Db): Preset[] {
  return listPresets(db).map((row) =>
    PresetSchema.parse({
      name: row.name,
      description: '',
      cruft_rules: JSON.parse(row.cruft_rules_json),
      whitelist: JSON.parse(row.whitelist_json),
      path_priority: JSON.parse(row.path_priority_json),
    }),
  );
}
