import type { ReactNode } from 'react';
import { cn } from '../lib/cn.js';

export function Field({
  label,
  hint,
  error,
  htmlFor,
  children,
  className,
}: {
  label: string;
  hint?: ReactNode;
  error?: ReactNode;
  htmlFor?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      <label
        htmlFor={htmlFor}
        className="text-xs font-medium text-(--color-text-muted)"
      >
        {label}
      </label>
      {children}
      {error ? (
        <p className="text-xs text-(--color-danger)">{error}</p>
      ) : hint ? (
        <p className="text-xs text-(--color-text-subtle)">{hint}</p>
      ) : null}
    </div>
  );
}

export const inputClass = cn(
  'h-9 w-full rounded-md border border-(--color-border-strong) bg-(--color-surface)',
  'px-2.5 text-sm text-(--color-text) tabular-nums',
  'placeholder:text-(--color-text-subtle)',
  'transition-colors focus:border-(--color-accent-500) focus:outline-none',
  'disabled:cursor-not-allowed disabled:opacity-50',
);

export const selectClass = cn(
  inputClass,
  'appearance-none bg-no-repeat bg-[right_0.5rem_center] pr-7',
  // tiny chevron via inline SVG; matches both light/dark.
  '[background-image:url("data:image/svg+xml,%3Csvg%20xmlns=%22http://www.w3.org/2000/svg%22%20width=%2210%22%20height=%2210%22%20viewBox=%220%200%2010%2010%22%3E%3Cpath%20stroke=%22currentColor%22%20stroke-width=%221.5%22%20fill=%22none%22%20stroke-linecap=%22round%22%20stroke-linejoin=%22round%22%20d=%22M2%204l3%203%203-3%22/%3E%3C/svg%3E")]',
);
