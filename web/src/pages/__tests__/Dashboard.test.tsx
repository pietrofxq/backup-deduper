import { describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DashboardPage } from '../Dashboard.js';
import { buildMockApi, renderWithProviders } from '../../test-utils.js';
import type {
  Collection,
  Config,
  DryRunReport,
  HealthResponse,
  RunRow,
  ScanDetail,
  ScanStartResponse,
} from '../../lib/apiClient.js';

const baseHealth: HealthResponse = {
  ok: true,
  targetRoot: '/tmp/example',
  uuid: 'abc12345-de67-89f0-1234-56789abcdef0',
};

const baseConfig: Config = {
  active_preset: 'Samsung Android phone backup',
  retention_days: 30,
  dry_run: true,
  dry_run_disabled_at: null,
  sanity_guard_files_pct: 0.5,
  sanity_guard_bytes_pct: 0.7,
};

const collections: Collection[] = [
  { id: 1, relPath: 'Backup-A', isPrimary: false },
  { id: 2, relPath: 'Backup-B', isPrimary: true },
];

describe('DashboardPage', () => {
  it('renders the page title and dry-run banner when dry_run is on', async () => {
    const api = buildMockApi({
      health: vi.fn().mockResolvedValue(baseHealth),
      getConfig: vi.fn().mockResolvedValue(baseConfig),
      listCollections: vi.fn().mockResolvedValue(collections),
      listScans: vi.fn().mockResolvedValue([]),
    });

    renderWithProviders(<DashboardPage />, { api });

    expect(
      await screen.findByRole('heading', { name: /dashboard/i }),
    ).toBeInTheDocument();
    expect(await screen.findByText(/Dry-run is enabled/i)).toBeInTheDocument();
  });

  it('shows live banner when dry_run is off', async () => {
    const api = buildMockApi({
      health: vi.fn().mockResolvedValue(baseHealth),
      getConfig: vi.fn().mockResolvedValue({
        ...baseConfig,
        dry_run: false,
        dry_run_disabled_at: '2025-01-01T00:00:00Z',
      }),
      listCollections: vi.fn().mockResolvedValue(collections),
      listScans: vi.fn().mockResolvedValue([]),
    });

    renderWithProviders(<DashboardPage />, { api });

    expect(await screen.findByText(/Live mode/i)).toBeInTheDocument();
  });

  it('lists collections and marks the primary', async () => {
    const api = buildMockApi({
      health: vi.fn().mockResolvedValue(baseHealth),
      getConfig: vi.fn().mockResolvedValue(baseConfig),
      listCollections: vi.fn().mockResolvedValue(collections),
      listScans: vi.fn().mockResolvedValue([]),
    });

    renderWithProviders(<DashboardPage />, { api });

    // Backup-A only appears in the Collections list. Backup-B appears twice
    // (Collections list + ScanPanel "Primary collection" hint), so we just
    // check it shows up at all.
    expect(await screen.findByText('Backup-A')).toBeInTheDocument();
    const backupBs = await screen.findAllByText('Backup-B');
    expect(backupBs.length).toBeGreaterThanOrEqual(1);
    const primaryMarks = await screen.findAllByText(/primary/i);
    expect(primaryMarks.length).toBeGreaterThanOrEqual(1);
  });

  it('clicking Scan now calls startScan and displays the resulting summary', async () => {
    const report: ScanStartResponse['report'] = {
      runId: 7,
      generatedAt: new Date().toISOString(),
      presetName: 'Samsung Android phone backup',
      dryRun: true,
      collections: collections.map((c) => ({
        id: c.id,
        relPath: c.relPath,
        isPrimary: c.isPrimary,
      })),
      countsByReason: {
        duplicate_cross_collection: { files: 3, bytes: 300 },
      },
      totalActions: 3,
      totalBytes: 300,
      reviewPairs: 0,
      emptyDirActions: 0,
      sanityGuard: {
        passed: true,
        primaryFiles: 50,
        primaryBytes: 5000,
        plannedFiles: 3,
        plannedBytes: 300,
        filesPct: 0.06,
        bytesPct: 0.06,
        reason: null,
        code: null,
      },
      scanSummary: {
        totalFiles: 50,
        totalHashed: 5,
        totalCached: 45,
        durationMs: 200,
      },
      actions: [],
      reviewSamples: [],
    };

    const startScan = vi.fn().mockResolvedValue({
      runId: 7,
      reportPath: '/tmp/example/.dedupe/reports/7.json',
      report,
    } satisfies ScanStartResponse);

    const newRun: RunRow = {
      id: 7,
      kind: 'scan',
      status: 'completed',
      dry_run: 1,
      config_json: '{}',
      started_at: '2025-01-01 12:00:00',
      finished_at: '2025-01-01 12:00:01',
    };

    const listScans = vi
      .fn<() => Promise<RunRow[]>>()
      .mockResolvedValueOnce([])
      .mockResolvedValue([newRun]);

    const api = buildMockApi({
      health: vi.fn().mockResolvedValue(baseHealth),
      getConfig: vi.fn().mockResolvedValue(baseConfig),
      listCollections: vi.fn().mockResolvedValue(collections),
      listScans,
      startScan,
      // After scans invalidates, lastScanId becomes 7 and getScan(7) is
      // the source of truth for the rendered summary. Return the same
      // report we sent through startScan so the panel resolves to the
      // success state we're asserting on.
      getScan: vi.fn().mockResolvedValue({
        run: newRun,
        report,
      } satisfies ScanDetail),
    });

    renderWithProviders(<DashboardPage />, { api });

    const button = await screen.findByRole('button', { name: /scan now/i });
    await userEvent.click(button);

    await waitFor(() => expect(startScan).toHaveBeenCalledTimes(1));

    // The summary panel re-renders with the report from setQueryData and
    // then the cached/refetched getScan response.
    expect(await screen.findByText('sanity ok')).toBeInTheDocument();
    expect(
      await screen.findByText(/duplicate_cross_collection/i),
    ).toBeInTheDocument();
    // The recent-runs panel shows the new run id; it appears in the
    // summary header AND the run history row, so we just check ≥1.
    const ids = await screen.findAllByText('#7');
    expect(ids.length).toBeGreaterThanOrEqual(1);
  });

  it('disables Scan now when no primary collection is set', async () => {
    const api = buildMockApi({
      health: vi.fn().mockResolvedValue(baseHealth),
      getConfig: vi.fn().mockResolvedValue(baseConfig),
      listCollections: vi.fn().mockResolvedValue(
        collections.map((c) => ({ ...c, isPrimary: false })),
      ),
      listScans: vi.fn().mockResolvedValue([]),
    });

    renderWithProviders(<DashboardPage />, { api });

    const button = await screen.findByRole('button', { name: /scan now/i });
    await waitFor(() => expect(button).toBeDisabled());
    expect(screen.getByText(/none — set one first/i)).toBeInTheDocument();
  });

  it('shows the no-primary banner when none is selected (M15)', async () => {
    const api = buildMockApi({
      health: vi.fn().mockResolvedValue(baseHealth),
      getConfig: vi.fn().mockResolvedValue(baseConfig),
      listCollections: vi.fn().mockResolvedValue(
        collections.map((c) => ({ ...c, isPrimary: false })),
      ),
      listScans: vi.fn().mockResolvedValue([]),
    });

    renderWithProviders(<DashboardPage />, { api });

    expect(
      await screen.findByText(/no primary collection set — quarantine disabled/i),
    ).toBeInTheDocument();
  });

  it('renders the no-primary banner as a screen-reader-announced alert (M15 round-4 a11y)', async () => {
    // The banner is a safety-critical state change; screen readers MUST be
    // told. role="alert" + aria-live ensure announcement when the element
    // appears after the async collections query resolves.
    const api = buildMockApi({
      health: vi.fn().mockResolvedValue(baseHealth),
      getConfig: vi.fn().mockResolvedValue(baseConfig),
      listCollections: vi.fn().mockResolvedValue(
        collections.map((c) => ({ ...c, isPrimary: false })),
      ),
      listScans: vi.fn().mockResolvedValue([]),
    });

    renderWithProviders(<DashboardPage />, { api });

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/no primary collection set/i);
    expect(alert).toHaveAttribute('aria-live', 'assertive');
  });

  it('hides the no-primary banner once a primary is selected', async () => {
    const api = buildMockApi({
      health: vi.fn().mockResolvedValue(baseHealth),
      getConfig: vi.fn().mockResolvedValue(baseConfig),
      listCollections: vi.fn().mockResolvedValue(collections),
      listScans: vi.fn().mockResolvedValue([]),
    });

    renderWithProviders(<DashboardPage />, { api });

    // Wait for the dry-run banner to render so collections finished loading.
    await screen.findByText(/Dry-run is enabled/i);
    expect(
      screen.queryByText(/no primary collection set — quarantine disabled/i),
    ).toBeNull();
  });

  it('LastScanSummary shows the no-primary header and hides the percentage line when code=no_primary_set (M15)', async () => {
    const run: RunRow = {
      id: 11,
      kind: 'scan',
      status: 'completed',
      dry_run: 1,
      config_json: '{}',
      started_at: '2025-01-01 12:00:00',
      finished_at: '2025-01-01 12:00:01',
    };
    const report: DryRunReport = {
      runId: 11,
      generatedAt: new Date().toISOString(),
      presetName: 'Samsung Android phone backup',
      dryRun: true,
      collections: collections.map((c) => ({ ...c, isPrimary: false })),
      countsByReason: { duplicate_cross_collection: { files: 1, bytes: 100 } },
      totalActions: 1,
      totalBytes: 100,
      reviewPairs: 0,
      emptyDirActions: 0,
      sanityGuard: {
        passed: false,
        primaryFiles: 0,
        primaryBytes: 0,
        plannedFiles: 1,
        plannedBytes: 100,
        filesPct: 0,
        bytesPct: 0,
        reason: 'no primary collection set; mark one as primary before running quarantine',
        code: 'no_primary_set',
      },
      scanSummary: { totalFiles: 2, totalHashed: 2, totalCached: 0, durationMs: 50 },
      actions: [],
      reviewSamples: [],
    };

    const api = buildMockApi({
      health: vi.fn().mockResolvedValue(baseHealth),
      getConfig: vi.fn().mockResolvedValue(baseConfig),
      listCollections: vi.fn().mockResolvedValue(
        collections.map((c) => ({ ...c, isPrimary: false })),
      ),
      listScans: vi.fn().mockResolvedValue([run]),
      getScan: vi.fn().mockResolvedValue({ run, report } satisfies ScanDetail),
    });

    renderWithProviders(<DashboardPage />, { api });

    expect(
      await screen.findByText(/Quarantine refused — no primary set/i),
    ).toBeInTheDocument();
    // The percentage line is irrelevant when code=no_primary_set (primary
    // counts are zero) — must be suppressed so the user isn't told
    // "files 0% · bytes 0%".
    expect(screen.queryByText(/files 0% · bytes 0%/i)).toBeNull();
  });

  it('LastScanSummary shows the percentage line when code=pct_exceeded (M15 regression guard)', async () => {
    const run: RunRow = {
      id: 12,
      kind: 'scan',
      status: 'completed',
      dry_run: 1,
      config_json: '{}',
      started_at: '2025-01-01 12:00:00',
      finished_at: '2025-01-01 12:00:01',
    };
    const report: DryRunReport = {
      runId: 12,
      generatedAt: new Date().toISOString(),
      presetName: 'Samsung Android phone backup',
      dryRun: true,
      collections: collections.map((c) => ({
        id: c.id,
        relPath: c.relPath,
        isPrimary: c.isPrimary,
      })),
      countsByReason: { duplicate_within_collection: { files: 4, bytes: 400 } },
      totalActions: 4,
      totalBytes: 400,
      reviewPairs: 0,
      emptyDirActions: 0,
      sanityGuard: {
        passed: false,
        primaryFiles: 5,
        primaryBytes: 500,
        plannedFiles: 4,
        plannedBytes: 400,
        filesPct: 0.8,
        bytesPct: 0.8,
        reason: 'files 80.0% > 50% and bytes 80.0% > 70%',
        code: 'pct_exceeded',
      },
      scanSummary: { totalFiles: 5, totalHashed: 5, totalCached: 0, durationMs: 100 },
      actions: [],
      reviewSamples: [],
    };

    const api = buildMockApi({
      health: vi.fn().mockResolvedValue(baseHealth),
      getConfig: vi.fn().mockResolvedValue(baseConfig),
      listCollections: vi.fn().mockResolvedValue(collections),
      listScans: vi.fn().mockResolvedValue([run]),
      getScan: vi.fn().mockResolvedValue({ run, report } satisfies ScanDetail),
    });

    renderWithProviders(<DashboardPage />, { api });

    expect(await screen.findByText(/Sanity guard tripped/i)).toBeInTheDocument();
    expect(screen.getByText(/files 80% · bytes 80%/i)).toBeInTheDocument();
    // No-primary header must NOT show in the pct branch.
    expect(screen.queryByText(/Quarantine refused — no primary set/i)).toBeNull();
  });
});
