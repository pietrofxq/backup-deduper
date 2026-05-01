import { describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ReviewQueuePage } from '../ReviewQueue.js';
import { buildMockApi, renderWithProviders } from '../../test-utils.js';
import type { Collection, ReviewItem } from '../../lib/apiClient.js';

const collections: Collection[] = [
  { id: 1, relPath: 'Backup-A', isPrimary: true },
  { id: 2, relPath: 'Backup-B', isPrimary: false },
];

const items: ReviewItem[] = [
  {
    id: 1,
    run_id: 5,
    basename: 'IMG_001.jpg',
    a_collection_id: 1,
    a_rel_path: 'photos/IMG_001.jpg',
    a_sha256_hex: 'abcdef0123456789',
    a_size: 1000,
    b_collection_id: 2,
    b_rel_path: 'pictures/IMG_001.jpg',
    b_sha256_hex: 'fedcba9876543210',
    b_size: 1100,
    status: 'open',
    created_at: '2025-01-01 12:00:00',
  },
  {
    id: 2,
    run_id: 5,
    basename: 'note.txt',
    a_collection_id: 1,
    a_rel_path: 'docs/note.txt',
    a_sha256_hex: '1111111111111111',
    a_size: 100,
    b_collection_id: 2,
    b_rel_path: 'misc/note.txt',
    b_sha256_hex: '2222222222222222',
    b_size: 110,
    status: 'kept_both',
    created_at: '2025-01-02 12:00:00',
  },
];

describe('ReviewQueuePage', () => {
  it('renders only open pairs by default and exposes paths/hashes', async () => {
    const listReview = vi
      .fn()
      .mockImplementation((status?: string) =>
        Promise.resolve(
          status === 'open' ? items.filter((i) => i.status === 'open') : items,
        ),
      );
    const api = buildMockApi({
      listReview,
      listCollections: vi.fn().mockResolvedValue(collections),
    });

    renderWithProviders(<ReviewQueuePage />, { api });

    expect(
      await screen.findByRole('heading', { name: /review queue/i }),
    ).toBeInTheDocument();
    await waitFor(() => expect(listReview).toHaveBeenCalledWith('open'));

    expect(await screen.findByText('IMG_001.jpg')).toBeInTheDocument();
    expect(screen.getByText('photos/IMG_001.jpg')).toBeInTheDocument();
    expect(screen.getByText('pictures/IMG_001.jpg')).toBeInTheDocument();
  });

  it('Keep both calls decideReview with kept_both', async () => {
    const decideReview = vi.fn().mockResolvedValue({ ok: true });
    const api = buildMockApi({
      listReview: vi.fn().mockResolvedValue(items.filter((i) => i.status === 'open')),
      listCollections: vi.fn().mockResolvedValue(collections),
      decideReview,
    });

    renderWithProviders(<ReviewQueuePage />, { api });

    const keepBoth = await screen.findByRole('button', { name: /keep both/i });
    await userEvent.click(keepBoth);

    await waitFor(() =>
      expect(decideReview).toHaveBeenCalledWith(1, 'kept_both'),
    );
  });

  it('changing the status filter re-fetches with the new status', async () => {
    const listReview = vi.fn().mockResolvedValue(items);
    const api = buildMockApi({
      listReview,
      listCollections: vi.fn().mockResolvedValue(collections),
    });

    renderWithProviders(<ReviewQueuePage />, { api });

    await screen.findByText('IMG_001.jpg');

    // Status filter is the first <select> on the page (id="review-status").
    // The pagination per-page select only appears once total > pageSize.
    const select = document.getElementById('review-status') as HTMLSelectElement;
    expect(select).not.toBeNull();
    await userEvent.selectOptions(select, 'kept_both');
    await waitFor(() => expect(listReview).toHaveBeenCalledWith('kept_both'));

    await userEvent.selectOptions(select, 'all');
    await waitFor(() => {
      const last = listReview.mock.calls[listReview.mock.calls.length - 1];
      expect(last?.[0]).toBeUndefined();
    });
  });
});
