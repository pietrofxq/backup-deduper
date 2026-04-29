import path from 'node:path';
import type { CruftRule, Preset, WhitelistRule } from '../presets/types.js';

/**
 * The canonical set of basenames that are considered OS-metadata cruft on every
 * preset (always-on, regardless of which preset is active).
 */
export const ALWAYS_ON_OS_METADATA = new Set([
  'Thumbs.db',
  'desktop.ini',
  '.DS_Store',
  'ehthumbs.db',
]);

export type CruftClassification =
  | { kind: 'whitelisted' }
  | { kind: 'os_metadata' }
  | { kind: 'preset_match'; ruleId: string }
  | { kind: 'none' };

/**
 * Decide whether a single file is cruft.
 *
 * IMPORTANT: whitelist always wins. Even if a file's path matches a cruft
 * rule, a whitelist hit returns `{kind:'whitelisted'}`. The Samsung preset
 * relies on this so `Android/media/` (WhatsApp media) is never swept.
 *
 * `relPath` is in DB form (forward slashes, no leading slash).
 */
export function classifyCruft(relPath: string, preset: Preset): CruftClassification {
  // 1. whitelist
  for (const w of preset.whitelist) {
    if (whitelistMatches(relPath, w)) return { kind: 'whitelisted' };
  }
  // 2. always-on OS metadata
  const base = basenameOf(relPath);
  if (ALWAYS_ON_OS_METADATA.has(base)) return { kind: 'os_metadata' };
  // 3. preset rules in order
  for (const r of preset.cruft_rules) {
    if (cruftMatches(relPath, r)) return { kind: 'preset_match', ruleId: r.id };
  }
  return { kind: 'none' };
}

function basenameOf(relPath: string): string {
  // relPath is forward-slash normalized — last segment is the basename.
  const idx = relPath.lastIndexOf('/');
  return idx === -1 ? relPath : relPath.slice(idx + 1);
}

function cruftMatches(relPath: string, rule: CruftRule): boolean {
  switch (rule.kind) {
    case 'basename':
      return basenameOf(relPath) === rule.pattern;
    case 'extension': {
      const ext = path.posix.extname(relPath).toLowerCase();
      return ext === rule.pattern.toLowerCase();
    }
    case 'path_prefix':
      return relPath.startsWith(rule.pattern);
    case 'glob':
      return globMatch(relPath, rule.pattern);
  }
}

function whitelistMatches(relPath: string, rule: WhitelistRule): boolean {
  switch (rule.kind) {
    case 'basename':
      return basenameOf(relPath) === rule.pattern;
    case 'extension': {
      const ext = path.posix.extname(relPath).toLowerCase();
      return ext === rule.pattern.toLowerCase();
    }
    case 'path_prefix':
      return relPath.startsWith(rule.pattern);
    case 'glob':
      return globMatch(relPath, rule.pattern);
  }
}

/**
 * Single-segment glob matcher for `*` and `?`. Does NOT support `**`. We use
 * forward slashes and match against the full rel-path. Anchored at both ends.
 */
function globMatch(input: string, pattern: string): boolean {
  // Convert glob to regex: escape regex specials except * and ?, then
  // map * → [^/]* and ? → [^/].
  let re = '^';
  for (const ch of pattern) {
    if (ch === '*') re += '[^/]*';
    else if (ch === '?') re += '[^/]';
    else if (/[.+^${}()|[\]\\]/.test(ch)) re += '\\' + ch;
    else re += ch;
  }
  re += '$';
  return new RegExp(re).test(input);
}

export function reasonStringFor(c: CruftClassification): string | null {
  if (c.kind === 'os_metadata') return 'cruft_os_metadata';
  if (c.kind === 'preset_match') return `cruft_preset_${c.ruleId}`;
  return null;
}
