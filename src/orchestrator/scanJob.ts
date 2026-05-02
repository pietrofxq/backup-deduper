import fs from 'node:fs';
import path from 'node:path';
import type { Db } from '../db/index.js';
import { sentinelPaths } from '../target/sentinel.js';
import {
  createRun,
  insertReviewItem,
  listAllLiveFiles,
  listCollections,
  setRunStatus,
} from '../db/queries.js';
import { scanAll, type ScanProgressEvent, type ScanSummary } from '../scanner/index.js';
import { classifyAll, type PlannedAction, type ReviewPair, type EmptyDir } from '../classifier/rules.js';
import { loadActivePreset } from '../presets/index.js';
import { loadPresetByName } from '../presets/registry.js';
import { DryRunGateError } from './quarantineJob.js';
import { loadConfig } from '../config/loader.js';
import { checkSanityGuard, type SanityGuardResult } from './sanityGuard.js';
import { appendAudit } from '../audit/log.js';

export interface ScanJobOptions {
  /** Override the dry-run flag (otherwise read from config). */
  dryRun?: boolean;
  /** Override the active preset by name. */
  presetName?: string;
  /** Override sanity-guard. Used when the user explicitly bypasses. */
  ignoreSanityGuard?: boolean;
  /** Optional progress callback. */
  onProgress?: (event: ScanJobProgressEvent) => void;
  /**
   * Optional cancellation signal. The scanner polls between hashed files.
   * On abort the run row is marked `aborted` and ScanAbortedError is thrown.
   */
  signal?: AbortSignal;
  /**
   * Called once the run row exists (so the route can register the run id with
   * the cancel registry before the long-running work begins).
   */
  onRunCreated?: (runId: number) => void;
}

export class ScanAbortedError extends Error {
  constructor(public readonly runId: number) {
    super(`Scan run #${runId} aborted by user`);
    this.name = 'ScanAbortedError';
  }
}

export type ScanJobProgressEvent =
  | { type: 'phase'; phase: 'scan' | 'classify' | 'report' | 'execute' | 'done' }
  | ScanProgressEvent
  | { type: 'classified'; actions: number; reviewPairs: number; emptyDirs: number };

export interface DryRunReport {
  runId: number;
  generatedAt: string;
  presetName: string;
  dryRun: boolean;
  collections: Array<{ id: number; relPath: string; isPrimary: boolean }>;
  countsByReason: Record<string, { files: number; bytes: number }>;
  totalActions: number;
  totalBytes: number;
  reviewPairs: number;
  emptyDirActions: number;
  sanityGuard: SanityGuardResult;
  scanSummary: {
    totalFiles: number;
    totalHashed: number;
    totalCached: number;
    durationMs: number;
  };
  actions: Array<{
    collectionRelPath: string;
    relPath: string;
    reason: string;
    size: number;
    sha256: string | null;
  }>;
  reviewSamples: Array<{
    basename: string;
    a: { collection: string; relPath: string; sha256: string };
    b: { collection: string; relPath: string; sha256: string };
  }>;
}

export interface ScanJobResult {
  runId: number;
  report: DryRunReport;
  actions: PlannedAction[];
  reviewPairs: ReviewPair[];
  emptyDirActions: EmptyDir[];
  sanityGuard: SanityGuardResult;
  reportPath: string;
  /**
   * The primary collection id at the time this scan was classified, or
   * null if no primary was set. The classifier's keeper-picking is
   * shaped by this, so an action plan made under primary A is **not**
   * applicable after the user switches to primary B (the losers were
   * chosen relative to A's path priority and the cross-collection
   * primary-wins rule). `runQuarantineJob` compares this to the
   * current primary and refuses on any mismatch.
   */
  scanPrimaryId: number | null;
}

/**
 * The end-to-end scan flow. Caller (HTTP route or CLI) is responsible for
 * subsequently invoking the mover when dry_run is false. This function only
 * persists planned actions to the report file, never touches user files.
 */
export async function runScanJob(
  db: Db,
  targetRoot: string,
  opts: ScanJobOptions = {},
): Promise<ScanJobResult> {
  const cfg = loadConfig(db);
  // Per-call dry-run can only ever be MORE restrictive than persisted state.
  // Allowing opts.dryRun=false to override cfg.dry_run=true would produce a
  // run/report claiming "live" while runQuarantineJob still refuses (it
  // reads cfg directly), giving callers a misleading report. Force dry-run
  // off only if the persisted gate is also off.
  if (opts.dryRun === false && cfg.dry_run === true) {
    throw new DryRunGateError(
      'Cannot request dryRun=false: the persisted config still has dry_run=true. ' +
        'Disable dry-run via POST /config/disable-dry-run with the confirmation phrase first.',
    );
  }
  const dryRun = opts.dryRun === true ? true : cfg.dry_run;
  const presetName = opts.presetName ?? cfg.active_preset;
  const preset = opts.presetName
    ? loadPresetByName(db, opts.presetName)
    : loadActivePreset(db);

  const runId = createRun(db, 'scan', dryRun, {
    preset: presetName,
    dryRun,
    ignoreSanityGuard: !!opts.ignoreSanityGuard,
  });
  opts.onRunCreated?.(runId);

  const checkAbort = () => {
    if (opts.signal?.aborted) {
      throw new ScanAbortedError(runId);
    }
  };

  try {
    opts.onProgress?.({ type: 'phase', phase: 'scan' });
    checkAbort();
    const scan: ScanSummary = await scanAll(db, targetRoot, runId, {
      onProgress: opts.onProgress,
      signal: opts.signal,
    });

    checkAbort();
    opts.onProgress?.({ type: 'phase', phase: 'classify' });
    const collections = listCollections(db);
    const files = listAllLiveFiles(db);
    // Capture the primary at scan time. The classifier shapes the action
    // plan around this — losers under cross-collection dedup are picked
    // relative to which collection is primary right now. `runQuarantineJob`
    // compares this against current primary at apply time and refuses on
    // any mismatch (the cached plan would otherwise quarantine files
    // inside the user's newly-marked source-of-truth collection).
    const scanPrimaryId = collections.find((c) => c.is_primary === 1)?.id ?? null;

    const emptyDirs: Array<{ collectionId: number; relPath: string }> = [];
    for (const [cid, paths] of scan.emptyDirsByCollection) {
      for (const p of paths) emptyDirs.push({ collectionId: cid, relPath: p });
    }

    checkAbort();
    const cls = classifyAll({ preset, collections, files, emptyDirs });

    opts.onProgress?.({
      type: 'classified',
      actions: cls.actions.length,
      reviewPairs: cls.reviewPairs.length,
      emptyDirs: cls.emptyDirActions.length,
    });

    // Persist review pairs so the UI can act on them later. Long enough on
    // pathological datasets that we sample the abort signal periodically —
    // a user who hit Cancel while we're churning through 50k pairs should
    // see the run terminate within a handful of inserts, not after every
    // pair has landed in the DB.
    let i = 0;
    for (const p of cls.reviewPairs) {
      if ((i++ & 0xff) === 0) checkAbort();
      insertReviewItem(db, {
        runId,
        basename: p.basename,
        aCollectionId: p.a.collection.id,
        aRelPath: p.a.file.rel_path,
        aSha256: p.a.file.sha256_hex ?? '',
        aSize: p.a.file.size,
        bCollectionId: p.b.collection.id,
        bRelPath: p.b.file.rel_path,
        bSha256: p.b.file.sha256_hex ?? '',
        bSize: p.b.file.size,
      });
    }

    checkAbort();
    opts.onProgress?.({ type: 'phase', phase: 'report' });
    const sg = checkSanityGuard(db, cls.actions, {
      filesPctLimit: cfg.sanity_guard_files_pct,
      bytesPctLimit: cfg.sanity_guard_bytes_pct,
      emptyDirCount: cls.emptyDirActions.length,
    });

    const report: DryRunReport = {
      runId,
      generatedAt: new Date().toISOString(),
      presetName,
      dryRun,
      collections: collections.map((c) => ({
        id: c.id,
        relPath: c.rel_path,
        isPrimary: c.is_primary === 1,
      })),
      countsByReason: cls.countsByReason,
      totalActions: cls.actions.length,
      totalBytes: cls.actions.reduce((a, b) => a + b.size, 0),
      reviewPairs: cls.reviewPairs.length,
      emptyDirActions: cls.emptyDirActions.length,
      sanityGuard: sg,
      scanSummary: {
        totalFiles: scan.totalFiles,
        totalHashed: scan.totalHashed,
        totalCached: scan.totalCached,
        durationMs: scan.durationMs,
      },
      actions: cls.actions.map((a) => ({
        collectionRelPath: a.collection.rel_path,
        relPath: a.file.rel_path,
        reason: a.reason,
        size: a.size,
        sha256: a.file.sha256_hex,
      })),
      reviewSamples: cls.reviewPairs.slice(0, 50).map((p) => ({
        basename: p.basename,
        a: {
          collection: p.a.collection.rel_path,
          relPath: p.a.file.rel_path,
          sha256: p.a.file.sha256_hex ?? '',
        },
        b: {
          collection: p.b.collection.rel_path,
          relPath: p.b.file.rel_path,
          sha256: p.b.file.sha256_hex ?? '',
        },
      })),
    };

    checkAbort();
    const reportPath = writeReport(targetRoot, report);
    appendAudit(targetRoot, 'scan_complete', {
      runId,
      dryRun,
      preset: presetName,
      totalActions: cls.actions.length,
      totalBytes: report.totalBytes,
      reviewPairs: cls.reviewPairs.length,
      sanityGuardPassed: sg.passed,
      reportPath,
    });

    // Last gate before flipping the run to 'completed'. A cancel that
    // races the post-classify, post-report path must still land as
    // 'aborted' rather than 'completed'.
    checkAbort();
    setRunStatus(db, runId, 'completed');

    opts.onProgress?.({ type: 'phase', phase: 'done' });
    return {
      runId,
      report,
      actions: cls.actions,
      reviewPairs: cls.reviewPairs,
      emptyDirActions: cls.emptyDirActions,
      sanityGuard: sg,
      reportPath,
      scanPrimaryId,
    };
  } catch (err) {
    // The scanner throws the AbortSignal's `reason` directly when cancelled
    // mid-walk — re-classify any error that lands in our catch with an
    // already-tripped signal as an abort, not a failure. This keeps the
    // run row's terminal status honest (`aborted` vs `failed`) regardless of
    // which loop body caught the signal first.
    if (err instanceof ScanAbortedError || opts.signal?.aborted) {
      setRunStatus(db, runId, 'aborted');
      appendAudit(targetRoot, 'scan_aborted', { runId });
      throw err instanceof ScanAbortedError ? err : new ScanAbortedError(runId);
    }
    setRunStatus(db, runId, 'failed');
    appendAudit(targetRoot, 'scan_failed', {
      runId,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

function writeReport(targetRoot: string, report: DryRunReport): string {
  const { dedupeDir } = sentinelPaths(targetRoot);
  const reportsDir = path.join(dedupeDir, 'reports');
  fs.mkdirSync(reportsDir, { recursive: true });
  const file = path.join(reportsDir, `${report.runId}.json`);
  fs.writeFileSync(file, JSON.stringify(report, null, 2));
  return file;
}

