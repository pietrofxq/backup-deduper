import type { ReactNode } from 'react';
import { ArrowDown, ArrowUp, ChevronsUpDown } from 'lucide-react';
import { cn } from '../lib/cn.js';

export interface ColumnDef<T> {
  /** Stable id used for sort state and CSV export. */
  id: string;
  header: ReactNode;
  /** Render the cell. */
  cell: (row: T) => ReactNode;
  /** Plain-text accessor for CSV export and sort comparisons. */
  accessor?: (row: T) => string | number | null;
  sortable?: boolean;
  className?: string;
  width?: string;
}

export interface SortState {
  id: string;
  dir: 'asc' | 'desc';
}

export interface DataTableProps<T> {
  columns: ColumnDef<T>[];
  rows: T[];
  /** Stable row identity for selection + key. */
  rowKey: (row: T) => string | number;
  sort?: SortState | null;
  onSortChange?: (s: SortState | null) => void;
  /** When provided, a leading checkbox column is rendered. */
  selection?: {
    selected: ReadonlySet<string | number>;
    onToggle: (id: string | number) => void;
    onToggleAll: () => void;
    allSelected: boolean;
    someSelected: boolean;
  };
  emptyMessage?: ReactNode;
  /** Optional click handler per row. */
  onRowClick?: (row: T) => void;
}

/**
 * Compact, monospace-leaning table primitive. Hand-rolled rather than pulling
 * in @tanstack/react-table — the M10 pages need sort + selection + CSV export
 * and that's it.
 */
export function DataTable<T>({
  columns,
  rows,
  rowKey,
  sort,
  onSortChange,
  selection,
  emptyMessage,
  onRowClick,
}: DataTableProps<T>) {
  const headerCellClass =
    'sticky top-0 z-10 border-b border-(--color-border) bg-(--color-surface-2) px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wider text-(--color-text-muted)';

  function toggleSort(id: string) {
    if (!onSortChange) return;
    if (!sort || sort.id !== id) {
      onSortChange({ id, dir: 'asc' });
      return;
    }
    if (sort.dir === 'asc') {
      onSortChange({ id, dir: 'desc' });
      return;
    }
    onSortChange(null);
  }

  return (
    <div className="overflow-auto">
      <table className="w-full border-collapse text-sm tabular-nums">
        <thead>
          <tr>
            {selection && (
              <th className={cn(headerCellClass, 'w-9 px-2')}>
                <input
                  type="checkbox"
                  aria-label="Select all"
                  checked={selection.allSelected}
                  ref={(el) => {
                    if (el) el.indeterminate = !selection.allSelected && selection.someSelected;
                  }}
                  onChange={selection.onToggleAll}
                  className="size-3.5 cursor-pointer accent-(--color-accent-500)"
                />
              </th>
            )}
            {columns.map((c) => {
              const sortable = c.sortable && onSortChange;
              const active = sort?.id === c.id;
              return (
                <th
                  key={c.id}
                  className={cn(headerCellClass, c.className)}
                  style={c.width ? { width: c.width } : undefined}
                >
                  {sortable ? (
                    <button
                      type="button"
                      onClick={() => toggleSort(c.id)}
                      className={cn(
                        'inline-flex items-center gap-1 hover:text-(--color-text)',
                        active && 'text-(--color-text)',
                      )}
                    >
                      <span>{c.header}</span>
                      {active ? (
                        sort?.dir === 'asc' ? (
                          <ArrowUp size={11} />
                        ) : (
                          <ArrowDown size={11} />
                        )
                      ) : (
                        <ChevronsUpDown size={11} className="opacity-40" />
                      )}
                    </button>
                  ) : (
                    c.header
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td
                colSpan={columns.length + (selection ? 1 : 0)}
                className="px-3 py-6 text-center text-sm text-(--color-text-muted)"
              >
                {emptyMessage ?? 'Nothing to show.'}
              </td>
            </tr>
          ) : (
            rows.map((row) => {
              const id = rowKey(row);
              const isSelected = selection?.selected.has(id) ?? false;
              return (
                <tr
                  key={id}
                  className={cn(
                    'border-b border-(--color-border) transition-colors',
                    isSelected
                      ? 'bg-(--color-accent-100)/40 dark:bg-(--color-accent-100)/10'
                      : 'hover:bg-(--color-surface-2)',
                    onRowClick && 'cursor-pointer',
                  )}
                  onClick={onRowClick ? () => onRowClick(row) : undefined}
                >
                  {selection && (
                    <td className="px-2 py-1.5 align-middle">
                      <input
                        type="checkbox"
                        aria-label={`Select row ${id}`}
                        checked={isSelected}
                        onClick={(e) => e.stopPropagation()}
                        onChange={() => selection.onToggle(id)}
                        className="size-3.5 cursor-pointer accent-(--color-accent-500)"
                      />
                    </td>
                  )}
                  {columns.map((c) => (
                    <td
                      key={c.id}
                      className={cn(
                        'px-3 py-1.5 align-middle text-(--color-text)',
                        c.className,
                      )}
                    >
                      {c.cell(row)}
                    </td>
                  ))}
                </tr>
              );
            })
          )}
        </tbody>
      </table>
    </div>
  );
}
