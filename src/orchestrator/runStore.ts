import type { ScanJobResult } from './scanJob.js';

/**
 * In-memory cache of recent scan results. The mover/quarantine route uses
 * this to look up the planned actions for a given scanRunId.
 *
 * Bounded to MAX_ENTRIES so a long-running server can't grow unboundedly:
 * each entry potentially holds a large `actions` list. We evict the oldest
 * entry by insertion order (JS Map preserves insertion order).
 *
 * Persistence model: cache entries do NOT survive a restart. A scan +
 * quarantine flow that crosses a server restart re-scans first.
 */
const MAX_ENTRIES = 10;
const cache = new Map<number, ScanJobResult>();

export function rememberScan(result: ScanJobResult): void {
  cache.set(result.runId, result);
  while (cache.size > MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

export function getScanResult(runId: number): ScanJobResult | null {
  return cache.get(runId) ?? null;
}

export function clearScanResults(): void {
  cache.clear();
}

/** Test-only — exposes the cache size so tests can assert eviction. */
export function _scanResultCacheSize(): number {
  return cache.size;
}
