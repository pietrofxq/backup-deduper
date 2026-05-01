import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ClipboardList, Download, Filter, RefreshCw, X } from 'lucide-react';
import {
  type AuditQuery,
  type Collection,
  type QuarantineAction,
} from '../lib/apiClient.js';
import { useApi } from '../lib/apiContext.js';
import { keys } from '../lib/queryKeys.js';
import { Card, CardBody, CardHeader } from '../components/Card.js';
import { Button } from '../components/Button.js';
import { Badge } from '../components/Badge.js';
import { Field, inputClass, selectClass } from '../components/Field.js';
import { DataTable, type ColumnDef, type SortState } from '../components/DataTable.js';
import { formatBytes, formatRelativeTime } from '../lib/format.js';
import { csvEscape, downloadCsv } from '../lib/csv.js';
import { cn } from '../lib/cn.js';

const PAGE_SIZE = 100;

interface FilterState {
  runId: string;
  reason: string;
  after: string;
  before: string;
}

const EMPTY_FILTERS: FilterState = { runId: '', reason: '', after: '', before: '' };

/**
 * Audit log — read-only paginated view of every quarantine action ever
 * planned, including those later restored or purged. Backed by GET /api/audit
 * which paginates server-side; the page uses server-side filters (runId,
 * reason, date range) and client-side sort across the visible page.
 */
export function AuditLogPage() {
  const api = useApi();
  const [filters, setFilters] = useState<FilterState>(EMPTY_FILTERS);
  const [page, setPage] = useState(0);
  const [sort, setSort] = useState<SortState | null>(null);

  const queryParams: AuditQuery = useMemo(() => {
    const p: AuditQuery = { limit: PAGE_SIZE, offset: page * PAGE_SIZE };
    const n = Number(filters.runId);
    if (filters.runId.trim() !== '' && Number.isInteger(n) && n > 0) p.runId = n;
    if (filters.reason !== '') p.reason = filters.reason;
    if (filters.after !== '') p.after = filters.after;
    if (filters.before !== '') p.before = filters.before;
    return p;
  }, [filters, page]);

  const audit = useQuery({
    queryKey: [...keys.audit(), queryParams] as const,
    queryFn: () => api.listAudit(queryParams),
    placeholderData: (prev) => prev,
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

  const reasonOptions = audit.data?.reasons ?? [];
  const total = audit.data?.total ?? 0;
  const items = audit.data?.items ?? [];

  const columns = useMemo<ColumnDef<QuarantineAction>[]>(
    () => [
      {
        id: 'id',
        header: '#',
        sortable: true,
        accessor: (r) => r.id,
        cell: (r) => <span className="text-(--color-text-subtle)">#{r.id}</span>,
        width: '4.5rem',
      },
      {
        id: 'run_id',
        header: 'Run',
        sortable: true,
        accessor: (r) => r.run_id,
        cell: (r) => <span className="font-mono text-xs">#{r.run_id}</span>,
        width: '4rem',
      },
      {
        id: 'collection_id',
        header: 'Collection',
        sortable: true,
        accessor: (r) =>
          collectionMap.get(r.collection_id)?.relPath ?? `#${r.collection_id}`,
        cell: (r) => (
          <span className="font-mono text-xs">
            {collectionMap.get(r.collection_id)?.relPath ?? `#${r.collection_id}`}
          </span>
        ),
        width: '12rem',
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
        id: 'state',
        header: 'State',
        cell: (r) => <StateBadge row={r} />,
        width: '7rem',
      },
    ],
    [collectionMap],
  );

  const sortedItems = useMemo(() => {
    if (!sort) return items;
    const col = columns.find((c) => c.id === sort.id);
    if (!col?.accessor) return items;
    const acc = col.accessor;
    const dir = sort.dir === 'asc' ? 1 : -1;
    return items.slice().sort((a, b) => {
      const av = acc(a);
      const bv = acc(b);
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * dir;
      return String(av).localeCompare(String(bv)) * dir;
    });
  }, [items, sort, columns]);

  const filtersDirty = filters !== EMPTY_FILTERS && (
    filters.runId !== '' ||
    filters.reason !== '' ||
    filters.after !== '' ||
    filters.before !== ''
  );

  function exportCsv() {
    // The audit CSV intentionally exports more columns than the visible
    // table (executed/restored/purged timestamps + error) so it can serve
    // as a real audit artifact, not just a screen dump. That's why we
    // don't reuse `useTable.exportCsv` here. csvEscape is shared though,
    // so formula-injection mitigation lives in one place.
    const headers = [
      'id',
      'run_id',
      'collection',
      'src_rel_path',
      'reason',
      'size',
      'planned_at',
      'executed_at',
      'restored_at',
      'purged_at',
      'error',
    ];
    const lines = [headers.join(',')];
    for (const r of sortedItems) {
      const cols = [
        r.id,
        r.run_id,
        collectionMap.get(r.collection_id)?.relPath ?? `#${r.collection_id}`,
        r.src_rel_path,
        r.reason,
        r.size,
        r.planned_at,
        r.executed_at ?? '',
        r.restored_at ?? '',
        r.purged_at ?? '',
        r.error ?? '',
      ].map((v) => csvEscape(String(v)));
      lines.push(cols.join(','));
    }
    downloadCsv('audit.csv', lines.join('\n'));
  }

  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="space-y-6">
      <Header
        loading={audit.isFetching}
        onRefresh={() => audit.refetch()}
      />

      <Card>
        <CardHeader
          title={
            <span className="inline-flex items-center gap-2">
              <Filter size={13} className="text-(--color-text-muted)" />
              Filters
            </span>
          }
          action={
            filtersDirty ? (
              <Button
                size="sm"
                variant="ghost"
                leadingIcon={<X size={11} />}
                onClick={() => {
                  setFilters(EMPTY_FILTERS);
                  setPage(0);
                }}
              >
                Clear
              </Button>
            ) : undefined
          }
        />
        <CardBody className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="Run id" htmlFor="audit-runid">
            <input
              id="audit-runid"
              type="number"
              inputMode="numeric"
              min={1}
              className={inputClass}
              placeholder="any"
              value={filters.runId}
              onChange={(e) => {
                setFilters({ ...filters, runId: e.target.value });
                setPage(0);
              }}
            />
          </Field>
          <Field label="Reason" htmlFor="audit-reason">
            <select
              id="audit-reason"
              className={selectClass}
              value={filters.reason}
              onChange={(e) => {
                setFilters({ ...filters, reason: e.target.value });
                setPage(0);
              }}
            >
              <option value="">all reasons</option>
              {reasonOptions.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
          </Field>
          <Field label="From (planned ≥)" htmlFor="audit-after">
            <input
              id="audit-after"
              type="date"
              className={inputClass}
              value={filters.after}
              onChange={(e) => {
                setFilters({ ...filters, after: e.target.value });
                setPage(0);
              }}
            />
          </Field>
          <Field label="To (planned ≤)" htmlFor="audit-before">
            <input
              id="audit-before"
              type="date"
              className={inputClass}
              value={filters.before}
              onChange={(e) => {
                setFilters({ ...filters, before: e.target.value });
                setPage(0);
              }}
            />
          </Field>
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title={
            <span className="inline-flex items-center gap-2">
              <ClipboardList size={14} className="text-(--color-text-muted)" />
              All actions
              <span className="text-(--color-text-subtle)">{total}</span>
            </span>
          }
          description="Every action ever planned, including restored and purged. Read-only."
          action={
            <Button
              size="sm"
              variant="ghost"
              leadingIcon={<Download size={12} />}
              onClick={exportCsv}
              disabled={sortedItems.length === 0}
            >
              Export CSV
            </Button>
          }
        />
        <CardBody className="p-0">
          <DataTable
            columns={columns}
            rows={sortedItems}
            rowKey={(r) => r.id}
            sort={sort}
            onSortChange={setSort}
            emptyMessage={
              audit.isLoading
                ? 'Loading…'
                : filtersDirty
                  ? 'No actions match the filters.'
                  : 'No actions yet.'
            }
          />
          <Pagination
            page={page}
            pageCount={pageCount}
            pageSize={PAGE_SIZE}
            total={total}
            onPageChange={setPage}
          />
        </CardBody>
      </Card>
    </div>
  );
}

function StateBadge({ row }: { row: QuarantineAction }) {
  if (row.purged_at) return <Badge tone="neutral">purged</Badge>;
  if (row.restored_at) return <Badge tone="accent">restored</Badge>;
  if (row.error) return <Badge tone="danger">errored</Badge>;
  if (row.executed_at) return <Badge tone="warning">quarantined</Badge>;
  return <Badge tone="neutral">planned</Badge>;
}

function Header({ loading, onRefresh }: { loading: boolean; onRefresh: () => void }) {
  return (
    <div className="flex items-end justify-between gap-3">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Audit log</h1>
        <p className="mt-1 text-sm text-(--color-text-muted)">
          Historical view of every action — quarantined, restored, purged, or
          errored. Filter and export for offline review.
        </p>
      </div>
      <Button
        variant="ghost"
        size="sm"
        leadingIcon={
          <RefreshCw size={12} className={cn(loading && 'animate-spin')} />
        }
        onClick={onRefresh}
        disabled={loading}
      >
        Refresh
      </Button>
    </div>
  );
}

function Pagination({
  page,
  pageCount,
  pageSize,
  total,
  onPageChange,
}: {
  page: number;
  pageCount: number;
  pageSize: number;
  total: number;
  onPageChange: (n: number) => void;
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
