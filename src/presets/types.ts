import { z } from 'zod';

/**
 * A cruft rule is a path-pattern check. Patterns use forward slashes (DB form).
 * `kind` differentiates how the pattern is interpreted:
 *   - 'basename'      : exact match against the file's basename
 *   - 'extension'     : exact match against the (lowercased) extension, including the dot, e.g. '.exo'
 *   - 'path_prefix'   : the rel-path begins with the pattern (e.g. 'Android/data/')
 *   - 'glob'          : a simple glob ('*', '?'); no '**' nesting; matched against the full rel-path
 *
 * `id` is a stable identifier used to construct the audit-log reason `cruft_preset_<id>`.
 */
export const CruftRuleSchema = z.object({
  id: z.string().min(1).regex(/^[a-z0-9_]+$/, 'id must be [a-z0-9_]+'),
  kind: z.enum(['basename', 'extension', 'path_prefix', 'glob']),
  pattern: z.string().min(1),
  description: z.string().default(''),
});

export type CruftRule = z.infer<typeof CruftRuleSchema>;

/**
 * Whitelist patterns are checked BEFORE every cruft rule for any given file.
 * Same `kind` semantics as cruft rules.
 */
export const WhitelistRuleSchema = z.object({
  kind: z.enum(['basename', 'extension', 'path_prefix', 'glob']),
  pattern: z.string().min(1),
  description: z.string().default(''),
});

export type WhitelistRule = z.infer<typeof WhitelistRuleSchema>;

/**
 * Path priority: an ordered list of rel-path prefixes. The lower the index, the
 * higher the priority. A file whose rel_path begins with priority[0] outranks
 * one that begins with priority[1], etc. Files matching no entry rank last.
 *
 * Used as the within-collection canonical-keeper picker for duplicate groups.
 */
export const PresetSchema = z.object({
  name: z.string().min(1),
  description: z.string().default(''),
  cruft_rules: z.array(CruftRuleSchema).default([]),
  whitelist: z.array(WhitelistRuleSchema).default([]),
  path_priority: z.array(z.string()).default([]),
});

export type Preset = z.infer<typeof PresetSchema>;
