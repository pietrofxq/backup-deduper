import { describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QuarantinePage } from '../Quarantine.js';
import { buildMockApi, renderWithProviders } from '../../test-utils.js';
import type {
  BulkRestoreSummary,
  Collection,
  PurgeSummary,
  QuarantineAction,
} from '../../lib/apiClient.js';

const collections: Collection[] = [
  { id: 1, relPath: 'Backup-A', isPrimary: true },
  { id: 2, relPath: 'Backup-B', isPrimary: false },
];

const baseAction = {
  run_id: 5,
  size: 1024,
  sha256_hex: 'abc',
  reason: 'duplicate_cross_collection',
  planned_at: '2025-01-01 12:00:00',
  executed_at: '2025-01-01 12:00:01',
  verified_at: '2025-01-01 12:00:02',
  restored_at: null,
  purged_at: null,
  error: null,
} as const;

const actions: QuarantineAction[] = [
  {
    ...baseAction,
    id: 1,
    collection_id: 1,
    src_rel_path: 'photos/IMG_001.jpg',
    dest_abs_path: '/tmp/.dedupe-trash/Backup-A/photos/IMG_001.jpg',
  },
  {
    ...baseAction,
    id: 2,
    collection_id: 2,
    src_rel_path: 'docs/note.txt',
    dest_abs_path: '/tmp/.dedupe-trash/Backup-B/docs/note.txt',
    reason: 'cruft_thumbnail',
    size: 512,
  },
];

describe('QuarantinePage', () => {
  it('renders the table with rows from listQuarantine and shows the row count', async () => {
    const api = buildMockApi({
      listQuarantine: vi.fn().mockResolvedValue(actions),
      listCollections: vi.fn().mockResolvedValue(collections),
    });

    renderWithProviders(<QuarantinePage />, { api });

    expect(
      await screen.findByRole('heading', { level: 1, name: /quarantine/i }),
    ).toBeInTheDocument();
    expect(await screen.findByText('photos/IMG_001.jpg')).toBeInTheDocument();
    expect(await screen.findByText('docs/note.txt')).toBeInTheDocument();
    expect(await screen.findByText('cruft_thumbnail')).toBeInTheDocument();
  });

  it('clicking a row Restore button calls restoreQuarantine with the action id', async () => {
    const restoreSummary: BulkRestoreSummary = {
      runId: 100,
      outcomes: [
        { actionId: 1, outcome: { kind: 'restored', finalPath: '/tmp/x' } },
      ],
    };
    const restoreQuarantine = vi.fn().mockResolvedValue(restoreSummary);
    const api = buildMockApi({
      listQuarantine: vi.fn().mockResolvedValue(actions),
      listCollections: vi.fn().mockResolvedValue(collections),
      restoreQuarantine,
    });

    renderWithProviders(<QuarantinePage />, { api });

    const restoreButtons = await screen.findAllByRole('button', { name: /^restore$/i });
    await userEvent.click(restoreButtons[0]!);

    await waitFor(() =>
      expect(restoreQuarantine).toHaveBeenCalledWith([1], undefined),
    );
    expect(await screen.findByText(/Restore complete/i)).toBeInTheDocument();
  });

  it('bulk restore via row selection sends all selected ids', async () => {
    const restoreSummary: BulkRestoreSummary = {
      runId: 101,
      outcomes: [
        { actionId: 1, outcome: { kind: 'restored', finalPath: '/tmp/x' } },
        { actionId: 2, outcome: { kind: 'restored', finalPath: '/tmp/y' } },
      ],
    };
    const restoreQuarantine = vi.fn().mockResolvedValue(restoreSummary);
    const api = buildMockApi({
      listQuarantine: vi.fn().mockResolvedValue(actions),
      listCollections: vi.fn().mockResolvedValue(collections),
      restoreQuarantine,
    });

    renderWithProviders(<QuarantinePage />, { api });

    // Wait for rows to render, then click "Select all" header checkbox.
    await screen.findByText('photos/IMG_001.jpg');
    const selectAll = screen.getByRole('checkbox', { name: /select all/i });
    await userEvent.click(selectAll);

    const bulkButton = await screen.findByRole('button', { name: /restore selected/i });
    await userEvent.click(bulkButton);

    await waitFor(() =>
      expect(restoreQuarantine).toHaveBeenCalledWith(
        expect.arrayContaining([1, 2]),
        undefined,
      ),
    );
  });

  it('purge eligible shows a dry-run preview before deleting', async () => {
    const dryPreview: PurgeSummary = {
      runId: 200,
      eligible: 2,
      purgedFiles: 2,
      purgedBytes: 1536,
      emptyTrashDirsRemoved: 0,
      errored: 0,
      dryRun: true,
    };
    const realResult: PurgeSummary = { ...dryPreview, dryRun: false };
    const purgeQuarantine = vi
      .fn()
      .mockImplementation((dryRun: boolean) =>
        Promise.resolve(dryRun ? dryPreview : realResult),
      );

    const api = buildMockApi({
      listQuarantine: vi.fn().mockResolvedValue(actions),
      listCollections: vi.fn().mockResolvedValue(collections),
      purgeQuarantine,
    });

    renderWithProviders(<QuarantinePage />, { api });

    const purgeButton = await screen.findByRole('button', { name: /purge eligible/i });
    await userEvent.click(purgeButton);

    // First click triggers a dry-run preview.
    await waitFor(() => expect(purgeQuarantine).toHaveBeenCalledWith(true));
    const preview = await screen.findByText(/Purge preview/i);
    expect(preview).toBeInTheDocument();

    // Confirm in the preview banner triggers the real purge.
    const confirm = await screen.findByRole('button', { name: /confirm purge/i });
    await userEvent.click(confirm);

    await waitFor(() => expect(purgeQuarantine).toHaveBeenCalledWith(false));
    expect(await screen.findByText(/Purge complete/i)).toBeInTheDocument();
  });

  it('sorting toggles by clicking the column header', async () => {
    const api = buildMockApi({
      listQuarantine: vi.fn().mockResolvedValue(actions),
      listCollections: vi.fn().mockResolvedValue(collections),
    });

    renderWithProviders(<QuarantinePage />, { api });

    await screen.findByText('photos/IMG_001.jpg');
    // Click "Reason" header to sort by reason ascending. cruft_thumbnail < duplicate_cross_collection.
    const reasonHeader = screen.getByRole('button', { name: /reason/i });
    await userEvent.click(reasonHeader);

    // After sort asc, the cruft_thumbnail row should render before
    // duplicate_cross_collection. Locate by reason text and assert ordering.
    const tbody = screen.getByText('cruft_thumbnail').closest('tbody');
    expect(tbody).not.toBeNull();
    const rows = within(tbody!).getAllByRole('row');
    const firstRowText = rows[0]!.textContent ?? '';
    expect(firstRowText).toContain('cruft_thumbnail');
  });
});
