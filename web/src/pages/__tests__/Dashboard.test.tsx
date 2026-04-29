import { describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DashboardPage } from '../Dashboard.js';
import { buildMockApi, renderWithProviders } from '../../test-utils.js';
import type {
  Collection,
  Config,
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
});
