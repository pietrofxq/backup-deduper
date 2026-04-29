import type { Preset } from './types.js';

/**
 * Minimal preset — no preset-specific cruft rules.
 *
 * The classifier still applies always-on cruft rules (empty folders, OS
 * metadata files like Thumbs.db / desktop.ini / .DS_Store). This preset only
 * controls preset-driven extensions: it adds none.
 */
export const MINIMAL: Preset = {
  name: 'None (conservative defaults only)',
  description: 'No preset-specific cruft rules — only always-on rules apply.',
  cruft_rules: [],
  whitelist: [],
  path_priority: [],
};
