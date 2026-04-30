import type { ReactNode } from 'react';
import { cn } from '../lib/cn.js';

export interface StatTileProps {
  label: string;
  value: ReactNode;
  /** Optional secondary line (e.g. "12 since last scan"). */
  hint?: ReactNode;
  /** Optional Lucide icon. */
  icon?: ReactNode;
  className?: string;
}

/**
 * A compact metric tile. Used on the Dashboard for at-a-glance reads:
 * collections discovered, files in primary, total bytes, etc.
 *
 * Numbers are rendered tabular so column alignment holds when several tiles
 * sit side-by-side.
 */
export function StatTile({ label, value, hint, icon, className }: StatTileProps) {
  return (
    <div
      className={cn(
        'rounded-lg border border-(--color-border) bg-(--color-surface-2) px-4 py-3',
        'flex flex-col gap-1.5',
        className,
      )}
    >
      <div className="flex items-center justify-between text-xs font-medium tracking-wide text-(--color-text-muted) uppercase">
        <span>{label}</span>
        {icon && <span className="opacity-70">{icon}</span>}
      </div>
      <div className="text-2xl font-semibold tracking-tight tabular-nums">{value}</div>
      {hint && (
        <div className="text-xs text-(--color-text-muted) tabular-nums">{hint}</div>
      )}
    </div>
  );
}
