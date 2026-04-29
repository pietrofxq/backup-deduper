import type { ReactNode } from 'react';
import { cn } from '../lib/cn.js';

type Tone = 'neutral' | 'accent' | 'warning' | 'success' | 'danger';

export function Badge({
  tone = 'neutral',
  children,
  className,
}: {
  tone?: Tone;
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10.5px] font-semibold uppercase tracking-wider tabular-nums',
        tone === 'neutral' && 'bg-(--color-surface-3) text-(--color-text-muted)',
        tone === 'accent' &&
          'bg-(--color-accent-100) text-(--color-accent-700) dark:bg-(--color-accent-100)/30 dark:text-(--color-accent-300)',
        tone === 'warning' &&
          'bg-amber-100 text-amber-900 dark:bg-amber-500/20 dark:text-amber-300',
        tone === 'success' &&
          'bg-emerald-100 text-emerald-900 dark:bg-emerald-500/20 dark:text-emerald-300',
        tone === 'danger' &&
          'bg-rose-100 text-rose-900 dark:bg-rose-500/20 dark:text-rose-300',
        className,
      )}
    >
      {children}
    </span>
  );
}
