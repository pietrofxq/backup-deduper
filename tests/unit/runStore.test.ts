import { afterEach, describe, expect, it } from 'vitest';
import {
  _scanResultCacheSize,
  clearScanResults,
  getScanResult,
  rememberScan,
} from '../../src/orchestrator/runStore.js';
import type { ScanJobResult } from '../../src/orchestrator/scanJob.js';

function fakeResult(runId: number): ScanJobResult {
  return {
    runId,
    report: {
      runId,
      generatedAt: 'x',
      presetName: 'p',
      dryRun: true,
      collections: [],
      countsByReason: {},
      totalActions: 0,
      totalBytes: 0,
      reviewPairs: 0,
      emptyDirActions: 0,
      sanityGuard: {
        passed: true,
        primaryFiles: 0,
        primaryBytes: 0,
        plannedFiles: 0,
        plannedBytes: 0,
        filesPct: 0,
        bytesPct: 0,
        reason: null,
      },
      scanSummary: { totalFiles: 0, totalHashed: 0, totalCached: 0, durationMs: 0 },
      actions: [],
      reviewSamples: [],
    },
    actions: [],
    reviewPairs: [],
    emptyDirActions: [],
    sanityGuard: {
      passed: true,
      primaryFiles: 0,
      primaryBytes: 0,
      plannedFiles: 0,
      plannedBytes: 0,
      filesPct: 0,
      bytesPct: 0,
      reason: null,
    },
    reportPath: '/tmp/x',
  };
}

describe('runStore', () => {
  afterEach(() => clearScanResults());

  it('returns null for unknown runId', () => {
    expect(getScanResult(999)).toBeNull();
  });

  it('round-trips a single result', () => {
    rememberScan(fakeResult(1));
    expect(getScanResult(1)?.runId).toBe(1);
  });

  it('evicts the oldest entry when MAX_ENTRIES is exceeded', () => {
    for (let i = 1; i <= 12; i++) {
      rememberScan(fakeResult(i));
    }
    // Bound is 10; first two should be evicted.
    expect(_scanResultCacheSize()).toBe(10);
    expect(getScanResult(1)).toBeNull();
    expect(getScanResult(2)).toBeNull();
    expect(getScanResult(3)?.runId).toBe(3);
    expect(getScanResult(12)?.runId).toBe(12);
  });
});
