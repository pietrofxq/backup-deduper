import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Activity,
  CheckCircle2,
  Filter,
  RefreshCw,
} from 'lucide-react';
import {
  ApiError,
  type Collection,
  type ReviewItem,
} from '../lib/apiClient.js';
import { useApi } from '../lib/apiContext.js';
import { keys } from '../lib/queryKeys.js';
import { Card, CardBody, CardHeader } from '../components/Card.js';
import { Button } from '../components/Button.js';
import { Badge } from '../components/Badge.js';
import { Field, selectClass } from '../components/Field.js';
import { DataTable, type ColumnDef } from '../components/DataTable.js';
import { useTable } from '../hooks/useTable.js';
import { formatBytes, formatRelativeTime } from '../lib/format.js';
import { cn } from '../lib/cn.js';

type StatusFilter = 'open' | 'kept_both' | 'all';

/**
 * Review Queue — name-collision pairs the classifier flagged because two
 * different content hashes share a basename across collections. v1 only
 * supports the "Keep both" decision (the side-quarantine flow lands in
 * Phase 2). Each row shows enough info to spot-check by eye: the basename,
 * paths, sha-prefixes, and sizes.
 */
export function ReviewQueuePage() {
  const api = useApi();
  const qc = useQueryClient();
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('open');
  const [error, setError] = useState<string | null>(null);

  const items = useQuery({
    queryKey: keys.review(statusFilter),
    queryFn: () =>
      api.listReview(statusFilter === 'all' ? undefined : statusFilter),
  });

  const collections = useQuery({
    queryKey: keys.collections(),
    queryFn: () => api.listCollections(),
  });

  const collectionMap = useMemo(() => {
    const m = new Map<number, Collection>();
    (collections.data ?? []).forEach((c) => m.set(c.id, c));
    return m;
  }, [collections.data]);

  const decide = useMutation({
    mutationFn: (id: number) => api.decideReview(id, 'kept_both'),
    onSuccess: () => {
      setError(null);
      qc.invalidateQueries({ queryKey: keys.reviewRoot() });
    },
    onError: (err) => {
      setError(err instanceof ApiError ? err.message : 'Decision failed');
    },
  });

  const columns = useMemo<ColumnDef<ReviewItem>[]>(
    () => [
      {
        id: 'basename',
        header: 'Basename',
        sortable: true,
        accessor: (r) => r.basename,
        cell: (r) => (
          <span className="font-mono text-xs font-medium" title={r.basename}>
            {r.basename}
          </span>
        ),
        width: '12rem',
      },
      {
        id: 'a',
        header: 'A',
        cell: (r) => (
          <SidePath
            collection={collectionMap.get(r.a_collection_id)?.relPath ?? `#${r.a_collection_id}`}
            relPath={r.a_rel_path}
            sha={r.a_sha256_hex}
            size={r.a_size}
          />
        ),
      },
      {
        id: 'b',
        header: 'B',
        cell: (r) => (
          <SidePath
            collection={collectionMap.get(r.b_collection_id)?.relPath ?? `#${r.b_collection_id}`}
            relPath={r.b_rel_path}
            sha={r.b_sha256_hex}
            size={r.b_size}
          />
        ),
      },
      {
        id: 'created_at',
        header: 'Seen',
        sortable: true,
        accessor: (r) => r.created_at,
        cell: (r) => (
          <span className="text-xs text-(--color-text-muted)">
            {formatRelativeTime(r.created_at)}
          </span>
        ),
        width: '7rem',
      },
      {
        id: 'status',
        header: 'Status',
        cell: (r) => <StatusBadge status={r.status} />,
        width: '7rem',
      },
      {
        id: 'actions',
        header: '',
        cell: (r) => (
          r.status === 'open' ? (
            <Button
              size="sm"
              variant="secondary"
              leadingIcon={<CheckCircle2 size={12} />}
              title="Mark as keep-both — both files are kept; no fs side effect."
              onClick={(e) => {
                e.stopPropagation();
                decide.mutate(r.id);
              }}
              disabled={decide.isPending}
            >
              Keep both
            </Button>
          ) : (
            <span className="text-xs text-(--color-text-subtle)">decided</span>
          )
        ),
        width: '9rem',
        className: 'text-right',
      },
    ],
    [collectionMap, decide],
  );

  const table = useTable({
    rows: items.data ?? [],
    columns,
    rowKey: (r) => r.id,
    initialSort: { id: 'created_at', dir: 'desc' },
    initialPageSize: 50,
  });

  return (
    <div className="space-y-6">
      <Header loading={items.isFetching} onRefresh={() => items.refetch()} />

      <KeepBothExplainer />

      {error && (
        <div className="rounded-md border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-900 dark:text-rose-200">
          {error}
        </div>
      )}

      <Card>
        <CardHeader
          title={
            <span className="inline-flex items-center gap-2">
              <Activity size={14} className="text-(--color-text-muted)" />
              Pairs
              <span className="text-(--color-text-subtle)">
                {items.data?.length ?? 0}
              </span>
            </span>
          }
          description="Same basename, different content. Decide whether to keep both."
          action={
            <Field label="" htmlFor="review-status">
              <div className="flex items-center gap-1.5">
                <Filter size={12} className="text-(--color-text-subtle)" />
                <select
                  id="review-status"
                  className={cn(selectClass, 'h-7 text-xs')}
                  value={statusFilter}
                  onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}
                >
                  <option value="open">open</option>
                  <option value="kept_both">kept both</option>
                  <option value="all">all</option>
                </select>
              </div>
            </Field>
          }
        />
        <CardBody className="p-0">
          <DataTable
            columns={columns}
            rows={table.paginated}
            rowKey={(r) => r.id}
            sort={table.sort}
            onSortChange={table.setSort}
            emptyMessage={
              items.isLoading
                ? 'Loading…'
                : statusFilter === 'open'
                  ? 'No open pairs — review queue is clear.'
                  : 'No pairs match this filter.'
            }
          />
          <Pagination
            page={table.page}
            pageCount={table.pageCount}
            pageSize={table.pageSize}
            total={(items.data ?? []).length}
            onPageChange={table.setPage}
            onPageSizeChange={table.setPageSize}
          />
        </CardBody>
      </Card>
    </div>
  );
}

function Header({ loading, onRefresh }: { loading: boolean; onRefresh: () => void }) {
  return (
    <div className="flex items-end justify-between gap-3">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Review queue</h1>
        <p className="mt-1 text-sm text-(--color-text-muted)">
          Filename collisions across collections with different content hashes.
        </p>
      </div>
      <Button
        variant="ghost"
        size="sm"
        leadingIcon={<RefreshCw size={12} className={cn(loading && 'animate-spin')} />}
        onClick={onRefresh}
        disabled={loading}
      >
        Refresh
      </Button>
    </div>
  );
}

function KeepBothExplainer() {
  return (
    <div className="rounded-md border border-(--color-border) bg-(--color-surface-2) px-3 py-2.5 text-xs text-(--color-text-muted)">
      <p>
        v1 ships only the <strong className="font-semibold text-(--color-text)">Keep both</strong>{' '}
        decision: marks the pair as resolved without moving any bytes. Choosing
        a single side to quarantine ships in Phase 2, when the side-quarantine
        flow has been wired through the mover.
      </p>
    </div>
  );
}

function SidePath({
  collection,
  relPath,
  sha,
  size,
}: {
  collection: string;
  relPath: string;
  sha: string;
  size: number;
}) {
  return (
    <div className="space-y-0.5">
      <div className="flex items-center gap-1.5 text-xs">
        <Badge tone="neutral">{collection}</Badge>
        <span className="truncate font-mono text-(--color-text)" title={relPath}>
          {relPath}
        </span>
      </div>
      <div className="flex items-center gap-2 text-[10.5px] text-(--color-text-subtle) tabular-nums">
        <span className="font-mono">{sha.slice(0, 12)}…</span>
        <span>·</span>
        <span>{formatBytes(size)}</span>
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: ReviewItem['status'] }) {
  if (status === 'open') return <Badge tone="warning">open</Badge>;
  if (status === 'kept_both') return <Badge tone="success">kept both</Badge>;
  return <Badge tone="neutral">{status}</Badge>;
}

function Pagination({
  page,
  pageCount,
  pageSize,
  total,
  onPageChange,
  onPageSizeChange,
}: {
  page: number;
  pageCount: number;
  pageSize: number;
  total: number;
  onPageChange: (n: number) => void;
  onPageSizeChange: (n: number) => void;
}) {
  if (total === 0) return null;
  const start = page * pageSize + 1;
  const end = Math.min(total, (page + 1) * pageSize);
  return (
    <div className="flex items-center justify-between gap-3 border-t border-(--color-border) px-4 py-2 text-xs text-(--color-text-muted) tabular-nums">
      <div>
        {start}–{end} of {total}
      </div>
      <div className="flex items-center gap-2">
        <label className="flex items-center gap-1.5">
          <span>per page</span>
          <select
            className="h-7 rounded border border-(--color-border-strong) bg-(--color-surface) px-1.5 text-xs"
            value={pageSize}
            onChange={(e) => onPageSizeChange(Number(e.target.value))}
          >
            {[25, 50, 100].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
        <Button
          size="sm"
          variant="ghost"
          disabled={page === 0}
          onClick={() => onPageChange(Math.max(0, page - 1))}
        >
          Prev
        </Button>
        <span>
          {page + 1} / {pageCount}
        </span>
        <Button
          size="sm"
          variant="ghost"
          disabled={page >= pageCount - 1}
          onClick={() => onPageChange(Math.min(pageCount - 1, page + 1))}
        >
          Next
        </Button>
      </div>
    </div>
  );
}
