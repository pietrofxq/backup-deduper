import { describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AuditLogPage } from '../AuditLog.js';
import { buildMockApi, renderWithProviders } from '../../test-utils.js';
import type {
  AuditPageResponse,
  Collection,
  QuarantineAction,
} from '../../lib/apiClient.js';

const collections: Collection[] = [
  { id: 1, relPath: 'Backup-A', isPrimary: true },
];

const baseRow = {
  run_id: 5,
  collection_id: 1,
  size: 1024,
  sha256_hex: null,
  planned_at: '2025-01-01 12:00:00',
  executed_at: '2025-01-01 12:00:01',
  verified_at: '2025-01-01 12:00:02',
  restored_at: null,
  purged_at: null,
  error: null,
  dest_abs_path: '/tmp/x',
} as const;

const items: QuarantineAction[] = [
  {
    ...baseRow,
    id: 1,
    src_rel_path: 'a.jpg',
    reason: 'duplicate_cross_collection',
  },
  {
    ...baseRow,
    id: 2,
    src_rel_path: 'b.jpg',
    reason: 'cruft_thumbnail',
  },
];

function buildPage(overrides: Partial<AuditPageResponse> = {}): AuditPageResponse {
  return {
    items,
    total: items.length,
    limit: 100,
    offset: 0,
    reasons: ['cruft_thumbnail', 'duplicate_cross_collection'],
    ...overrides,
  };
}

describe('AuditLogPage', () => {
  it('renders the table with paginated rows from listAudit', async () => {
    const api = buildMockApi({
      listAudit: vi.fn().mockResolvedValue(buildPage()),
      listCollections: vi.fn().mockResolvedValue(collections),
    });

    renderWithProviders(<AuditLogPage />, { api });

    expect(
      await screen.findByRole('heading', { name: /audit log/i }),
    ).toBeInTheDocument();
    expect(await screen.findByText('a.jpg')).toBeInTheDocument();
    expect(await screen.findByText('b.jpg')).toBeInTheDocument();
  });

  it('reason filter triggers a re-fetch with the chosen reason', async () => {
    const listAudit = vi.fn().mockResolvedValue(buildPage());
    const api = buildMockApi({
      listAudit,
      listCollections: vi.fn().mockResolvedValue(collections),
    });

    renderWithProviders(<AuditLogPage />, { api });

    await screen.findByText('a.jpg');
    const reasonSelect = screen.getByLabelText(/reason/i);
    await userEvent.selectOptions(reasonSelect, 'cruft_thumbnail');

    await waitFor(() => {
      const lastCall = listAudit.mock.calls[listAudit.mock.calls.length - 1];
      expect(lastCall?.[0]).toMatchObject({ reason: 'cruft_thumbnail' });
    });
  });

  it('runId filter sends a numeric runId in the query', async () => {
    const listAudit = vi.fn().mockResolvedValue(buildPage());
    const api = buildMockApi({
      listAudit,
      listCollections: vi.fn().mockResolvedValue(collections),
    });

    renderWithProviders(<AuditLogPage />, { api });

    await screen.findByText('a.jpg');
    const runIdInput = screen.getByLabelText(/run id/i);
    await userEvent.type(runIdInput, '7');

    await waitFor(() => {
      const lastCall = listAudit.mock.calls[listAudit.mock.calls.length - 1];
      expect(lastCall?.[0]).toMatchObject({ runId: 7 });
    });
  });

  it('clear button resets all filters back to empty', async () => {
    const listAudit = vi.fn().mockResolvedValue(buildPage());
    const api = buildMockApi({
      listAudit,
      listCollections: vi.fn().mockResolvedValue(collections),
    });

    renderWithProviders(<AuditLogPage />, { api });

    await screen.findByText('a.jpg');
    const reasonSelect = screen.getByLabelText(/reason/i);
    await userEvent.selectOptions(reasonSelect, 'cruft_thumbnail');

    const clearBtn = await screen.findByRole('button', { name: /clear/i });
    await userEvent.click(clearBtn);

    await waitFor(() => {
      const lastCall = listAudit.mock.calls[listAudit.mock.calls.length - 1];
      expect(lastCall?.[0]).toEqual({ limit: 100, offset: 0 });
    });
  });

  it('paginates: clicking Next advances the offset', async () => {
    const listAudit = vi
      .fn()
      .mockResolvedValueOnce(buildPage({ total: 250 }))
      .mockResolvedValue(buildPage({ total: 250, offset: 100 }));
    const api = buildMockApi({
      listAudit,
      listCollections: vi.fn().mockResolvedValue(collections),
    });

    renderWithProviders(<AuditLogPage />, { api });

    await screen.findByText('a.jpg');
    const next = await screen.findByRole('button', { name: /next/i });
    await userEvent.click(next);

    await waitFor(() => {
      const lastCall = listAudit.mock.calls[listAudit.mock.calls.length - 1];
      expect(lastCall?.[0]).toMatchObject({ offset: 100 });
    });
  });
});
