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
  const dryRun = opts.dryRun ?? cfg.dry_run;
  const presetName = opts.presetName ?? cfg.active_preset;
  const preset = opts.presetName
    ? loadPresetByName(db, opts.presetName)
    : loadActivePreset(db);

  const runId = createRun(db, 'scan', dryRun, {
    preset: presetName,
    dryRun,
    ignoreSanityGuard: !!opts.ignoreSanityGuard,
  });

  try {
    opts.onProgress?.({ type: 'phase', phase: 'scan' });
    const scan: ScanSummary = await scanAll(db, targetRoot, runId, {
      onProgress: opts.onProgress,
    });

    opts.onProgress?.({ type: 'phase', phase: 'classify' });
    const collections = listCollections(db);
    const files = listAllLiveFiles(db);

    const emptyDirs: Array<{ collectionId: number; relPath: string }> = [];
    for (const [cid, paths] of scan.emptyDirsByCollection) {
      for (const p of paths) emptyDirs.push({ collectionId: cid, relPath: p });
    }

    const cls = classifyAll({ preset, collections, files, emptyDirs });

    opts.onProgress?.({
      type: 'classified',
      actions: cls.actions.length,
      reviewPairs: cls.reviewPairs.length,
      emptyDirs: cls.emptyDirActions.length,
    });

    // Persist review pairs so the UI can act on them later.
    for (const p of cls.reviewPairs) {
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

    opts.onProgress?.({ type: 'phase', phase: 'report' });
    const sg = checkSanityGuard(db, cls.actions, {
      filesPctLimit: cfg.sanity_guard_files_pct,
      bytesPctLimit: cfg.sanity_guard_bytes_pct,
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
    };
  } catch (err) {
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

