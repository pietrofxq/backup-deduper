import { z } from 'zod';

/**
 * Shared zod response schemas. Used by route registrars so the typed
 * Fastify provider both validates outgoing JSON shape and prevents internal
 * DB column names from leaking through `JSON.stringify(row)`.
 *
 * When extending a row type with a new column, add it here too — Fastify's
 * `serializerCompiler` strips fields not declared in the response schema, so
 * forgetting one will silently 0-out the wire shape.
 */

export const ErrorResponse = z.object({ error: z.string() });

// --- run / scan ---

export const RunRow = z.object({
  id: z.number().int(),
  kind: z.enum(['scan', 'quarantine', 'purge', 'restore']),
  status: z.enum(['running', 'completed', 'crashed', 'failed', 'aborted']),
  dry_run: z.number().int(),
  config_json: z.string(),
  started_at: z.string(),
  finished_at: z.string().nullable(),
});

const ReportAction = z.object({
  collectionRelPath: z.string(),
  relPath: z.string(),
  reason: z.string(),
  size: z.number().int(),
  sha256: z.string().nullable(),
});

const ReportSamplePair = z.object({
  basename: z.string(),
  a: z.object({ collection: z.string(), relPath: z.string(), sha256: z.string() }),
  b: z.object({ collection: z.string(), relPath: z.string(), sha256: z.string() }),
});

const SanityGuard = z.object({
  passed: z.boolean(),
  primaryFiles: z.number(),
  primaryBytes: z.number(),
  plannedFiles: z.number(),
  plannedBytes: z.number(),
  filesPct: z.number(),
  bytesPct: z.number(),
  reason: z.string().nullable(),
});

export const DryRunReport = z.object({
  runId: z.number().int(),
  generatedAt: z.string(),
  presetName: z.string(),
  dryRun: z.boolean(),
  collections: z.array(
    z.object({ id: z.number().int(), relPath: z.string(), isPrimary: z.boolean() }),
  ),
  countsByReason: z.record(
    z.string(),
    z.object({ files: z.number(), bytes: z.number() }),
  ),
  totalActions: z.number().int(),
  totalBytes: z.number().int(),
  reviewPairs: z.number().int(),
  emptyDirActions: z.number().int(),
  sanityGuard: SanityGuard,
  scanSummary: z.object({
    totalFiles: z.number(),
    totalHashed: z.number(),
    totalCached: z.number(),
    durationMs: z.number(),
  }),
  actions: z.array(ReportAction),
  reviewSamples: z.array(ReportSamplePair),
});

export const ScanStartResponse = z.object({
  runId: z.number().int(),
  reportPath: z.string(),
  report: DryRunReport,
});

export const ScanDetailResponse = z.object({
  run: RunRow,
  report: DryRunReport.nullable(),
});

export const ScanGateError = z.object({
  error: z.string(),
  kind: z.enum(['dry_run_gate', 'unknown_preset', 'unreadable_subtree']),
  unreadablePaths: z.array(z.string()).optional(),
  collectionRelPath: z.string().optional(),
});

// --- quarantine action ---

export const QuarantineActionRow = z.object({
  id: z.number().int(),
  run_id: z.number().int(),
  collection_id: z.number().int(),
  src_rel_path: z.string(),
  dest_abs_path: z.string(),
  size: z.number().int(),
  sha256_hex: z.string().nullable(),
  reason: z.string(),
  planned_at: z.string(),
  executed_at: z.string().nullable(),
  verified_at: z.string().nullable(),
  restored_at: z.string().nullable(),
  purged_at: z.string().nullable(),
  error: z.string().nullable(),
});

export const QuarantineSummary = z.object({
  attempted: z.number().int(),
  executed: z.number().int(),
  errored: z.number().int(),
  skippedHashMismatch: z.number().int(),
  skippedSourceMissing: z.number().int(),
  emptyDirsRemoved: z.number().int(),
});

export const QuarantineRunResponse = z.object({
  runId: z.number().int(),
  summary: QuarantineSummary,
  guard: SanityGuard,
});

export const QuarantineRunError = z.object({
  error: z.string(),
  kind: z.enum(['dry_run_gate', 'sanity_guard']),
  guard: SanityGuard.optional(),
});

// --- restore ---

export const RestoreOutcome = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('restored'), finalPath: z.string() }),
  z.object({
    kind: z.literal('restored_sidecar'),
    finalPath: z.string(),
    reason: z.string(),
  }),
  z.object({ kind: z.literal('skipped'), reason: z.string() }),
  z.object({ kind: z.literal('errored'), error: z.string() }),
]);

export const BulkRestoreSummary = z.object({
  runId: z.number().int(),
  outcomes: z.array(
    z.object({ actionId: z.number().int(), outcome: RestoreOutcome }),
  ),
});

// --- purge ---

export const PurgeSummary = z.object({
  runId: z.number().int(),
  eligible: z.number().int(),
  purgedFiles: z.number().int(),
  purgedBytes: z.number().int(),
  emptyTrashDirsRemoved: z.number().int(),
  errored: z.number().int(),
  dryRun: z.boolean(),
});

// --- review ---

export const ReviewItemRow = z.object({
  id: z.number().int(),
  run_id: z.number().int(),
  basename: z.string(),
  a_collection_id: z.number().int(),
  a_rel_path: z.string(),
  a_sha256_hex: z.string(),
  a_size: z.number().int(),
  b_collection_id: z.number().int(),
  b_rel_path: z.string(),
  b_sha256_hex: z.string(),
  b_size: z.number().int(),
  status: z.enum(['open', 'kept_both', 'quarantined_a', 'quarantined_b']),
  created_at: z.string(),
});
