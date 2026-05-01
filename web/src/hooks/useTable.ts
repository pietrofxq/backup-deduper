import { useCallback, useMemo, useState } from 'react';
import type { ColumnDef, SortState } from '../components/DataTable.js';

/**
 * useTable — local sort, pagination, and row selection for an in-memory list.
 *
 * Server-side pagination (the audit page hits /api/audit which is paginated
 * on the backend) bypasses `paginated`: pass the already-fetched page in as
 * `rows`, set `pageSize` larger than `rows.length`, and ignore `page`. The
 * sort/selection/CSV concerns still apply.
 */
export interface UseTableOptions<T> {
  rows: T[];
  columns: ColumnDef<T>[];
  rowKey: (row: T) => string | number;
  initialSort?: SortState | null;
  initialPageSize?: number;
}

export interface UseTableResult<T> {
  /** Page-of-sorted-rows ready to feed to <DataTable rows=...>. */
  paginated: T[];
  /** All rows post-sort, pre-pagination — used for CSV export ("export everything"). */
  sorted: T[];
  sort: SortState | null;
  setSort: (s: SortState | null) => void;
  page: number;
  setPage: (n: number) => void;
  pageSize: number;
  setPageSize: (n: number) => void;
  pageCount: number;
  selection: {
    selected: Set<string | number>;
    selectedRows: T[];
    toggle: (id: string | number) => void;
    toggleAll: () => void;
    clear: () => void;
    allSelected: boolean;
    someSelected: boolean;
  };
  /** Trigger a CSV download of `sorted` rows over the visible columns. */
  exportCsv: (filename?: string) => void;
}

export function useTable<T>({
  rows,
  columns,
  rowKey,
  initialSort = null,
  initialPageSize = 50,
}: UseTableOptions<T>): UseTableResult<T> {
  const [sort, setSort] = useState<SortState | null>(initialSort);
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(initialPageSize);
  const [selected, setSelected] = useState<Set<string | number>>(new Set());

  const sorted = useMemo(() => {
    if (!sort) return rows;
    const col = columns.find((c) => c.id === sort.id);
    if (!col?.accessor) return rows;
    const acc = col.accessor;
    const dir = sort.dir === 'asc' ? 1 : -1;
    return rows.slice().sort((a, b) => {
      const av = acc(a);
      const bv = acc(b);
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      if (typeof av === 'number' && typeof bv === 'number') {
        return (av - bv) * dir;
      }
      return String(av).localeCompare(String(bv)) * dir;
    });
  }, [rows, columns, sort]);

  const pageCount = Math.max(1, Math.ceil(sorted.length / pageSize));
  const safePage = Math.min(page, pageCount - 1);
  const paginated = useMemo(
    () => sorted.slice(safePage * pageSize, (safePage + 1) * pageSize),
    [sorted, safePage, pageSize],
  );

  const visibleIds = useMemo(
    () => new Set(paginated.map((r) => rowKey(r))),
    [paginated, rowKey],
  );

  const allSelected =
    paginated.length > 0 && paginated.every((r) => selected.has(rowKey(r)));
  const someSelected = !allSelected && paginated.some((r) => selected.has(rowKey(r)));

  const toggle = useCallback((id: string | number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const toggleAll = useCallback(() => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (allSelected) {
        for (const id of visibleIds) next.delete(id);
      } else {
        for (const id of visibleIds) next.add(id);
      }
      return next;
    });
  }, [allSelected, visibleIds]);

  const clear = useCallback(() => setSelected(new Set()), []);

  const selectedRows = useMemo(
    () => rows.filter((r) => selected.has(rowKey(r))),
    [rows, selected, rowKey],
  );

  const exportCsv = useCallback(
    (filename = 'export.csv') => {
      const header = columns
        .map((c) => csvEscape(stringHeader(c.header)))
        .join(',');
      const body = sorted
        .map((row) =>
          columns
            .map((c) => csvEscape(c.accessor ? toCsvValue(c.accessor(row)) : ''))
            .join(','),
        )
        .join('\n');
      const csv = `${header}\n${body}`;
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    },
    [columns, sorted],
  );

  return {
    paginated,
    sorted,
    sort,
    setSort,
    page: safePage,
    setPage,
    pageSize,
    setPageSize,
    pageCount,
    selection: {
      selected,
      selectedRows,
      toggle,
      toggleAll,
      clear,
      allSelected,
      someSelected,
    },
    exportCsv,
  };
}

function csvEscape(s: string): string {
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function toCsvValue(v: string | number | null): string {
  if (v == null) return '';
  return String(v);
}

function stringHeader(h: unknown): string {
  if (typeof h === 'string') return h;
  if (typeof h === 'number') return String(h);
  return '';
}
