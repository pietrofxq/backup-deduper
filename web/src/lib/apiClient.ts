/**
 * Typed wrappers for the Fastify `/api/*` surface.
 *
 * The response shapes are duplicated from `src/server/schemas.ts` rather
 * than imported. Reasons:
 *   - Importing the server's zod schemas pulls server-only deps (drizzle,
 *     better-sqlite3 transitively via `db/queries.ts` etc.) into the web
 *     bundle. Worse, it couples the SPA tsconfig to the server tsconfig.
 *   - The contract test (`tests/contract/api.test.ts`) is the single source
 *     of truth that the server's wire shape matches what the SPA expects.
 *     A drift in either side will fail that test before the UI ships.
 *   - When the server adds a field, the SPA simply doesn't see it (extra
 *     fields are stripped client-side via the explicit type cast in
 *     `request()` rather than by zod). When the server *removes* a field,
 *     the SPA breaks at compile time — exactly what we want.
 *
 * If this duplication grows painful, the right fix is to publish a shared
 * `@safe-dedupe/api-types` package, NOT to cross the boundary directly.
 */

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: unknown,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export interface ApiClientOptions {
  /** Base URL — `''` for same-origin (production), full URL in tests. */
  baseUrl?: string;
  /** Custom fetch (for tests). Defaults to `globalThis.fetch`. */
  fetch?: typeof fetch;
}

export function createApiClient(opts: ApiClientOptions = {}) {
  const baseUrl = opts.baseUrl ?? '';
  const f = opts.fetch ?? globalThis.fetch.bind(globalThis);

  async function request<T>(
    method: string,
    path: string,
    body?: unknown,
    query?: Record<string, string | number | boolean | undefined>,
  ): Promise<T> {
    const search = query
      ? '?' +
        Object.entries(query)
          .filter(([, v]) => v !== undefined)
          .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
          .join('&')
      : '';
    const url = `${baseUrl}/api${path}${search}`;
    const res = await f(url, {
      method,
      headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let parsed: unknown = null;
    if (text.length > 0) {
      try {
        parsed = JSON.parse(text);
      } catch {
        // Non-JSON 4xx/5xx body: surface raw text in the error.
        parsed = text;
      }
    }
    if (!res.ok) {
      const detail =
        parsed && typeof parsed === 'object' && 'error' in parsed
          ? String((parsed as { error: unknown }).error)
          : `HTTP ${res.status}`;
      throw new ApiError(res.status, parsed, `${method} /api${path} failed: ${detail}`);
    }
    return parsed as T;
  }

  return {
    health: () => request<HealthResponse>('GET', '/health'),

    getConfig: () => request<Config>('GET', '/config'),
    putConfig: (patch: Partial<Omit<Config, 'dry_run' | 'dry_run_disabled_at'>>) =>
      request<Config>('PUT', '/config', patch),
    disableDryRun: (phrase: string) =>
      request<DisableDryRunResponse>('POST', '/config/disable-dry-run', { phrase }),

    listCollections: () => request<Collection[]>('GET', '/collections'),
    setPrimary: (collectionId: number) =>
      request<{ ok: true }>('POST', '/collections/set-primary', { collectionId }),

    listPresets: () => request<Preset[]>('GET', '/presets'),

    listScans: () => request<RunRow[]>('GET', '/scans'),
    getScan: (id: number) => request<ScanDetail>('GET', `/scans/${id}`),
    startScan: (body?: { presetName?: string; dryRun?: boolean }) =>
      request<ScanStartResponse>('POST', '/scans', body ?? {}),

    listReview: (status?: ReviewItem['status']) =>
      request<ReviewItem[]>('GET', '/review', undefined, { status }),
    decideReview: (id: number, status: 'kept_both') =>
      request<{ ok: true }>('POST', `/review/${id}/decision`, { status }),

    listQuarantine: (runId?: number) =>
      request<QuarantineAction[]>('GET', '/quarantine', undefined, { runId }),
    listAudit: () => request<QuarantineAction[]>('GET', '/audit'),
    runQuarantine: (scanRunId: number, ignoreSanityGuard?: boolean) =>
      request<QuarantineRunResponse>('POST', '/quarantine/run', {
        scanRunId,
        ignoreSanityGuard,
      }),
    restoreQuarantine: (actionIds: number[], allowSidecar = false) =>
      request<BulkRestoreSummary>('POST', '/quarantine/restore', {
        actionIds,
        allowSidecar,
      }),
    purgeQuarantine: (dryRun = true) =>
      request<PurgeSummary>('POST', '/quarantine/purge', { dryRun }),
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;

// ---------- response shapes (duplicated from src/server/schemas.ts) ----------

export interface HealthResponse {
  ok: boolean;
  targetRoot: string;
  uuid: string | null;
}

export interface Config {
  active_preset: string;
  retention_days: number;
  dry_run: boolean;
  dry_run_disabled_at: string | null;
  sanity_guard_files_pct: number;
  sanity_guard_bytes_pct: number;
}

export interface DisableDryRunResponse {
  ok: true;
  config: Config;
}

export interface Collection {
  id: number;
  relPath: string;
  isPrimary: boolean;
}

export interface Preset {
  name: string;
  description: string;
  cruft_rules: Array<{
    id: string;
    kind: 'basename' | 'extension' | 'path_prefix' | 'glob';
    pattern: string;
    description: string;
  }>;
  whitelist: Array<{
    kind: 'basename' | 'extension' | 'path_prefix' | 'glob';
    pattern: string;
    description: string;
  }>;
  path_priority: string[];
}

export interface RunRow {
  id: number;
  kind: 'scan' | 'quarantine' | 'purge' | 'restore';
  status: 'running' | 'completed' | 'crashed' | 'failed' | 'aborted';
  dry_run: number;
  config_json: string;
  started_at: string;
  finished_at: string | null;
}

export interface SanityGuard {
  passed: boolean;
  primaryFiles: number;
  primaryBytes: number;
  plannedFiles: number;
  plannedBytes: number;
  filesPct: number;
  bytesPct: number;
  reason: string | null;
}

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
  sanityGuard: SanityGuard;
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

export interface ScanStartResponse {
  runId: number;
  reportPath: string;
  report: DryRunReport;
}

export interface ScanDetail {
  run: RunRow;
  report: DryRunReport | null;
}

export interface QuarantineAction {
  id: number;
  run_id: number;
  collection_id: number;
  src_rel_path: string;
  dest_abs_path: string;
  size: number;
  sha256_hex: string | null;
  reason: string;
  planned_at: string;
  executed_at: string | null;
  verified_at: string | null;
  restored_at: string | null;
  purged_at: string | null;
  error: string | null;
}

export interface QuarantineRunResponse {
  runId: number;
  summary: {
    attempted: number;
    executed: number;
    errored: number;
    skippedHashMismatch: number;
    skippedSourceMissing: number;
    emptyDirsRemoved: number;
  };
  guard: SanityGuard;
}

export type RestoreOutcome =
  | { kind: 'restored'; finalPath: string }
  | { kind: 'restored_sidecar'; finalPath: string; reason: string }
  | { kind: 'skipped'; reason: string }
  | { kind: 'errored'; error: string };

export interface BulkRestoreSummary {
  runId: number;
  outcomes: Array<{ actionId: number; outcome: RestoreOutcome }>;
}

export interface PurgeSummary {
  runId: number;
  eligible: number;
  purgedFiles: number;
  purgedBytes: number;
  emptyTrashDirsRemoved: number;
  errored: number;
  dryRun: boolean;
}

export interface ReviewItem {
  id: number;
  run_id: number;
  basename: string;
  a_collection_id: number;
  a_rel_path: string;
  a_sha256_hex: string;
  a_size: number;
  b_collection_id: number;
  b_rel_path: string;
  b_sha256_hex: string;
  b_size: number;
  status: 'open' | 'kept_both' | 'quarantined_a' | 'quarantined_b';
  created_at: string;
}
