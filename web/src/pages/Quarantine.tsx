import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  Archive,
  Download,
  RefreshCw,
  Trash2,
  Undo2,
} from 'lucide-react';
import {
  ApiError,
  type Collection,
  type PurgeSummary as PurgeSummaryT,
  type QuarantineAction,
  type RestoreOutcome,
} from '../lib/apiClient.js';
import { useApi } from '../lib/apiContext.js';
import { keys } from '../lib/queryKeys.js';
import { Card, CardBody, CardHeader } from '../components/Card.js';
import { Button } from '../components/Button.js';
import { Badge } from '../components/Badge.js';
import { DataTable, type ColumnDef } from '../components/DataTable.js';
import { useTable } from '../hooks/useTable.js';
import { formatBytes, formatRelativeTime } from '../lib/format.js';

/**
 * Quarantine — every action with `executed_at IS NOT NULL` and not yet
 * restored or purged. The user can restore individual rows (or selected
 * rows in bulk) and run a purge; purge is shown as a dry-run preview first
 * and requires a second click to actually delete. Outcomes from the most
 * recent restore/purge surface in a banner above the table.
 */
export function QuarantinePage() {
  const api = useApi();
  const qc = useQueryClient();

  const [restoreSummary, setRestoreSummary] = useState<RestoreSummaryView | null>(null);
  const [purgePreview, setPurgePreview] = useState<PurgeSummaryT | null>(null);
  const [purgeResult, setPurgeResult] = useState<PurgeSummaryT | null>(null);
  const [error, setError] = useState<string | null>(null);

  const quarantine = useQuery({
    queryKey: keys.quarantine(),
    queryFn: () => api.listQuarantine(),
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

  const columns = useMemo<ColumnDef<QuarantineAction>[]>(
    () => [
      {
        id: 'collection',
        header: 'Collection',
        sortable: true,
        accessor: (r) => collectionMap.get(r.collection_id)?.relPath ?? `#${r.collection_id}`,
        cell: (r) => (
          <span className="font-mono text-xs">
            {collectionMap.get(r.collection_id)?.relPath ?? `#${r.collection_id}`}
          </span>
        ),
        width: '14rem',
      },
      {
        id: 'src_rel_path',
        header: 'Path',
        sortable: true,
        accessor: (r) => r.src_rel_path,
        cell: (r) => (
          <span className="block truncate font-mono text-xs" title={r.src_rel_path}>
            {r.src_rel_path}
          </span>
        ),
      },
      {
        id: 'reason',
        header: 'Reason',
        sortable: true,
        accessor: (r) => r.reason,
        cell: (r) => (
          <span className="font-mono text-[11px] text-(--color-text-muted)">
            {r.reason}
          </span>
        ),
        width: '11rem',
      },
      {
        id: 'size',
        header: 'Size',
        sortable: true,
        accessor: (r) => r.size,
        cell: (r) => formatBytes(r.size),
        className: 'text-right',
        width: '6.5rem',
      },
      {
        id: 'planned_at',
        header: 'Planned',
        sortable: true,
        accessor: (r) => r.planned_at,
        cell: (r) => (
          <span className="text-xs text-(--color-text-muted)">
            {formatRelativeTime(r.planned_at)}
          </span>
        ),
        width: '7rem',
      },
      {
        id: 'executed_at',
        header: 'Executed',
        sortable: true,
        accessor: (r) => r.executed_at,
        cell: (r) => (
          <span className="text-xs text-(--color-text-muted)">
            {formatRelativeTime(r.executed_at)}
          </span>
        ),
        width: '7rem',
      },
      {
        id: 'actions',
        header: '',
        cell: (r) => (
          <Button
            size="sm"
            variant="ghost"
            leadingIcon={<Undo2 size={12} />}
            onClick={(e) => {
              e.stopPropagation();
              runRestore.mutate({ ids: [r.id] });
            }}
            disabled={runRestore.isPending}
          >
            Restore
          </Button>
        ),
        width: '8rem',
        className: 'text-right',
      },
    ],
    [collectionMap],
  );

  const table = useTable({
    rows: quarantine.data ?? [],
    columns,
    rowKey: (r) => r.id,
    initialSort: { id: 'executed_at', dir: 'desc' },
    initialPageSize: 50,
  });

  const runRestore = useMutation({
    mutationFn: (args: { ids: number[]; allowSidecar?: boolean }) =>
      api.restoreQuarantine(args.ids, args.allowSidecar),
    onSuccess: (summary) => {
      setError(null);
      const counts = countOutcomes(summary.outcomes);
      setRestoreSummary({ counts, total: summary.outcomes.length });
      table.selection.clear();
      qc.invalidateQueries({ queryKey: keys.quarantine() });
      qc.invalidateQueries({ queryKey: keys.audit() });
    },
    onError: (err) => {
      setError(err instanceof ApiError ? err.message : 'Restore failed');
    },
  });

  const runPurgeDry = useMutation({
    mutationFn: () => api.purgeQuarantine(true),
    onSuccess: (summary) => {
      setError(null);
      setPurgeResult(null);
      setPurgePreview(summary);
    },
    onError: (err) => {
      setError(err instanceof ApiError ? err.message : 'Purge preview failed');
    },
  });

  const runPurgeReal = useMutation({
    mutationFn: () => api.purgeQuarantine(false),
    onSuccess: (summary) => {
      setError(null);
      setPurgePreview(null);
      setPurgeResult(summary);
      qc.invalidateQueries({ queryKey: keys.quarantine() });
      qc.invalidateQueries({ queryKey: keys.audit() });
    },
    onError: (err) => {
      setError(err instanceof ApiError ? err.message : 'Purge failed');
    },
  });

  const selectedIds = useMemo(
    () => table.selection.selectedRows.map((r) => r.id),
    [table.selection.selectedRows],
  );
  const selectedBytes = table.selection.selectedRows.reduce((acc, r) => acc + r.size, 0);

  return (
    <div className="space-y-6">
      <Header
        loading={quarantine.isFetching}
        onRefresh={() => qc.invalidateQueries({ queryKey: keys.quarantine() })}
      />

      <Banners
        error={error}
        restoreSummary={restoreSummary}
        purgePreview={purgePreview}
        purgeResult={purgeResult}
        onConfirmPurge={() => runPurgeReal.mutate()}
        onCancelPurge={() => setPurgePreview(null)}
        purgingReal={runPurgeReal.isPending}
      />

      <Card>
        <CardHeader
          title={
            <span className="inline-flex items-center gap-2">
              <Archive size={14} className="text-(--color-text-muted)" />
              Quarantined files
              <span className="text-(--color-text-subtle)">
                {quarantine.data?.length ?? 0}
              </span>
            </span>
          }
          description="Files moved to .dedupe-trash/, awaiting restore or purge."
          action={
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                variant="ghost"
                leadingIcon={<Download size={12} />}
                onClick={() => table.exportCsv('quarantine.csv')}
                disabled={(quarantine.data?.length ?? 0) === 0}
              >
                Export CSV
              </Button>
              <Button
                size="sm"
                variant="secondary"
                leadingIcon={<Undo2 size={12} />}
                onClick={() => runRestore.mutate({ ids: selectedIds })}
                disabled={selectedIds.length === 0 || runRestore.isPending}
                loading={runRestore.isPending && selectedIds.length > 1}
              >
                Restore selected ({selectedIds.length})
              </Button>
              <Button
                size="sm"
                variant="danger"
                leadingIcon={<Trash2 size={12} />}
                onClick={() => runPurgeDry.mutate()}
                loading={runPurgeDry.isPending}
                disabled={(quarantine.data?.length ?? 0) === 0}
              >
                Purge eligible
              </Button>
            </div>
          }
        />
        <CardBody className="p-0">
          {selectedIds.length > 0 && (
            <div className="flex items-center justify-between gap-3 border-b border-(--color-border) bg-(--color-accent-100)/40 px-4 py-2 text-xs dark:bg-(--color-accent-100)/10">
              <span className="text-(--color-text)">
                <strong className="font-semibold">{selectedIds.length}</strong> selected
                · {formatBytes(selectedBytes)}
              </span>
              <button
                type="button"
                className="text-(--color-text-muted) hover:text-(--color-text)"
                onClick={() => table.selection.clear()}
              >
                Clear selection
              </button>
            </div>
          )}
          <DataTable
            columns={columns}
            rows={table.paginated}
            rowKey={(r) => r.id}
            sort={table.sort}
            onSortChange={table.setSort}
            selection={{
              selected: table.selection.selected,
              onToggle: table.selection.toggle,
              onToggleAll: table.selection.toggleAll,
              allSelected: table.selection.allSelected,
              someSelected: table.selection.someSelected,
            }}
            emptyMessage={
              quarantine.isLoading ? 'Loading…' : 'Nothing in quarantine.'
            }
          />
          <Pagination
            page={table.page}
            pageCount={table.pageCount}
            pageSize={table.pageSize}
            total={(quarantine.data ?? []).length}
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
        <h1 className="text-xl font-semibold tracking-tight">Quarantine</h1>
        <p className="mt-1 text-sm text-(--color-text-muted)">
          Files moved to <span className="font-mono">.dedupe-trash/</span>. Restore
          to bring back; purge after retention to free space.
        </p>
      </div>
      <Button
        variant="ghost"
        size="sm"
        leadingIcon={<RefreshCw size={12} className={loading ? 'animate-spin' : ''} />}
        onClick={onRefresh}
        disabled={loading}
      >
        Refresh
      </Button>
    </div>
  );
}

interface RestoreSummaryView {
  counts: Record<RestoreOutcome['kind'], number>;
  total: number;
}

function countOutcomes(
  outcomes: ReadonlyArray<{ outcome: RestoreOutcome }>,
): Record<RestoreOutcome['kind'], number> {
  const acc: Record<RestoreOutcome['kind'], number> = {
    restored: 0,
    restored_sidecar: 0,
    skipped: 0,
    errored: 0,
  };
  for (const o of outcomes) acc[o.outcome.kind] += 1;
  return acc;
}

function Banners({
  error,
  restoreSummary,
  purgePreview,
  purgeResult,
  onConfirmPurge,
  onCancelPurge,
  purgingReal,
}: {
  error: string | null;
  restoreSummary: RestoreSummaryView | null;
  purgePreview: PurgeSummaryT | null;
  purgeResult: PurgeSummaryT | null;
  onConfirmPurge: () => void;
  onCancelPurge: () => void;
  purgingReal: boolean;
}) {
  return (
    <div className="space-y-2">
      {error && (
        <div className="rounded-md border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-900 dark:text-rose-200">
          {error}
        </div>
      )}
      {restoreSummary && (
        <div className="flex flex-wrap items-center gap-2 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-900 dark:text-emerald-200">
          <strong className="font-semibold">
            Restore complete — {restoreSummary.total} action
            {restoreSummary.total === 1 ? '' : 's'}
          </strong>
          <Badge tone="success">{restoreSummary.counts.restored} restored</Badge>
          {restoreSummary.counts.restored_sidecar > 0 && (
            <Badge tone="warning">
              {restoreSummary.counts.restored_sidecar} sidecar
            </Badge>
          )}
          {restoreSummary.counts.skipped > 0 && (
            <Badge tone="neutral">{restoreSummary.counts.skipped} skipped</Badge>
          )}
          {restoreSummary.counts.errored > 0 && (
            <Badge tone="danger">{restoreSummary.counts.errored} errored</Badge>
          )}
        </div>
      )}
      {purgePreview && (
        <div className="space-y-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-3 text-xs text-amber-900 dark:text-amber-200">
          <div className="flex items-start gap-2.5">
            <AlertTriangle size={14} className="mt-0.5 shrink-0" />
            <div className="space-y-1">
              <p className="font-semibold">Purge preview (dry-run)</p>
              <p>
                <strong>{purgePreview.eligible}</strong> action
                {purgePreview.eligible === 1 ? '' : 's'} eligible — would delete{' '}
                <strong>{purgePreview.purgedFiles}</strong> file
                {purgePreview.purgedFiles === 1 ? '' : 's'} freeing{' '}
                <strong>{formatBytes(purgePreview.purgedBytes)}</strong>.
              </p>
              {purgePreview.errored > 0 && (
                <p>
                  <strong>{purgePreview.errored}</strong> would error.
                </p>
              )}
            </div>
          </div>
          <div className="flex justify-end gap-2 pt-1">
            <Button size="sm" variant="ghost" onClick={onCancelPurge} disabled={purgingReal}>
              Cancel
            </Button>
            <Button
              size="sm"
              variant="danger"
              onClick={onConfirmPurge}
              loading={purgingReal}
              disabled={purgePreview.eligible === 0}
            >
              Confirm purge
            </Button>
          </div>
        </div>
      )}
      {purgeResult && (
        <div className="rounded-md border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-900 dark:text-emerald-200">
          <strong className="font-semibold">Purge complete.</strong> Removed{' '}
          {purgeResult.purgedFiles} file{purgeResult.purgedFiles === 1 ? '' : 's'},
          freed {formatBytes(purgeResult.purgedBytes)}.
        </div>
      )}
    </div>
  );
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
        Showing {start}–{end} of {total}
      </div>
      <div className="flex items-center gap-2">
        <label className="flex items-center gap-1.5">
          <span>per page</span>
          <select
            className="h-7 rounded border border-(--color-border-strong) bg-(--color-surface) px-1.5 text-xs"
            value={pageSize}
            onChange={(e) => onPageSizeChange(Number(e.target.value))}
          >
            {[25, 50, 100, 200].map((n) => (
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
