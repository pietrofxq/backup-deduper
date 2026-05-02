import type { Db } from '../db/index.js';
import { createRun, getRun, setRunStatus } from '../db/queries.js';
import { executeQuarantine, type QuarantineSummary } from '../mover/quarantine.js';
import type { EmptyDir, PlannedAction } from '../classifier/rules.js';
import { loadConfig, saveConfig } from '../config/loader.js';
import { CONFIRMATION_PHRASE } from '../config/schema.js';
import { checkSanityGuard, type SanityGuardResult } from './sanityGuard.js';
import { appendAudit } from '../audit/log.js';
import { parseSqliteDatetime } from '../db/datetime.js';

export class DryRunGateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DryRunGateError';
  }
}

export class SanityGuardError extends Error {
  constructor(
    message: string,
    public readonly guard: SanityGuardResult,
  ) {
    super(message);
    this.name = 'SanityGuardError';
  }
}

export interface QuarantineJobInput {
  db: Db;
  targetRoot: string;
  /** The scan run id whose actions/empty-dirs are to be executed. */
  scanRunId: number;
  actions: PlannedAction[];
  emptyDirs: EmptyDir[];
  /** Pass true to bypass the sanity guard, after explicit user override. */
  ignoreSanityGuard?: boolean;
  /**
   * The sanity-guard result recorded at scan time. Used to detect a
   * stale-plan attack: if the original scan was taken with no primary
   * collection set (`code === 'no_primary_set'`), the cached actions
   * reflect the lex-tiebroken keeper, not the user's deliberate choice.
   * Re-running the guard against current DB state would now pass
   * (a primary has since been set), but the plan itself is tainted —
   * applying it could quarantine files that live under what is now the
   * primary collection. Refuse unless `ignoreSanityGuard` is true.
   *
   * Optional only because the unit tests construct the input directly;
   * production callers (the `/api/quarantine/run` route) MUST pass it.
   */
  scanGuard?: SanityGuardResult;
}

export interface QuarantineJobResult {
  runId: number;
  summary: QuarantineSummary;
  guard: SanityGuardResult;
}

export function runQuarantineJob(input: QuarantineJobInput): QuarantineJobResult {
  const { db, targetRoot, scanRunId, actions, emptyDirs } = input;
  const cfg = loadConfig(db);

  if (cfg.dry_run) {
    throw new DryRunGateError(
      `dry_run is enabled. Type the confirmation phrase ("${CONFIRMATION_PHRASE}") at the disable-dry-run endpoint first.`,
    );
  }

  // Stale-plan refusal: the cached actions came from a scan taken without
  // a primary, so the canonical-keeper picker fell back to lex tiebreak.
  // Even if a primary has been set since, the plan reflects the wrong
  // anchor and must not be applied — re-checking the current DB state
  // would mask this because the recomputed pct guard runs against the
  // *new* primary's footprint. Surface the original (no_primary_set)
  // result so the API client sees a consistent error code.
  if (
    input.scanGuard?.code === 'no_primary_set' &&
    !input.ignoreSanityGuard
  ) {
    throw new SanityGuardError(
      'Scan was taken without a primary collection; the cached action plan reflects' +
        ' a lex-tiebroken keeper rather than a deliberate primary. Re-scan after' +
        ' marking a primary, or pass ignoreSanityGuard=true to apply the stale plan.',
      input.scanGuard,
    );
  }

  const guard = checkSanityGuard(db, actions, {
    filesPctLimit: cfg.sanity_guard_files_pct,
    bytesPctLimit: cfg.sanity_guard_bytes_pct,
    emptyDirCount: emptyDirs.length,
  });
  if (!guard.passed && !input.ignoreSanityGuard) {
    throw new SanityGuardError(
      `Sanity guard refused: ${guard.reason}. Set ignoreSanityGuard=true to override.`,
      guard,
    );
  }

  const scanRun = getRun(db, scanRunId);
  const runStartedAtIso = scanRun?.started_at
    ? parseSqliteDatetime(scanRun.started_at).toISOString()
    : new Date().toISOString();

  const runId = createRun(db, 'quarantine', false, {
    scanRunId,
    actions: actions.length,
    emptyDirs: emptyDirs.length,
    ignoreSanityGuard: !!input.ignoreSanityGuard,
  });

  try {
    const summary = executeQuarantine({ db, targetRoot, runId }, actions, emptyDirs, runStartedAtIso);
    setRunStatus(db, runId, 'completed');
    appendAudit(targetRoot, 'quarantine_complete', { runId, ...summary, guard });
    return { runId, summary, guard };
  } catch (err) {
    setRunStatus(db, runId, 'failed');
    appendAudit(targetRoot, 'quarantine_failed', {
      runId,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

/**
 * Disable dry_run by typing the confirmation phrase. Persisted to config so
 * subsequent quarantine runs proceed without re-confirming.
 */
export function disableDryRun(db: Db, phrase: string, targetRoot: string): void {
  if (phrase !== CONFIRMATION_PHRASE) {
    throw new DryRunGateError(
      `Wrong confirmation phrase. Type exactly: ${CONFIRMATION_PHRASE}`,
    );
  }
  const cfg = loadConfig(db);
  cfg.dry_run = false;
  cfg.dry_run_disabled_at = new Date().toISOString();
  saveConfig(db, cfg);
  appendAudit(targetRoot, 'dry_run_disabled', { at: cfg.dry_run_disabled_at });
}
