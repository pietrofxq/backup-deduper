import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { cn } from '../lib/cn.js';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';
type Size = 'sm' | 'md' | 'lg';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  /** Optional left-side icon (Lucide component). */
  leadingIcon?: ReactNode;
  loading?: boolean;
}

/**
 * One button to rule them all. Subtle, native-feeling, hover-lift not
 * gradient. The roadmap's M9 spec calls out a "big Scan now button" — this
 * is the primitive it's built from.
 */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = 'secondary',
    size = 'md',
    className,
    leadingIcon,
    loading = false,
    disabled,
    children,
    ...rest
  },
  ref,
) {
  return (
    <button
      ref={ref}
      disabled={disabled || loading}
      className={cn(
        'inline-flex items-center justify-center gap-2 rounded-md font-medium',
        'transition-[background-color,transform,box-shadow] duration-100',
        'focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50',
        size === 'sm' && 'h-7 px-2.5 text-xs',
        size === 'md' && 'h-9 px-3 text-sm',
        size === 'lg' && 'h-11 px-5 text-sm',
        variant === 'primary' && [
          'bg-(--color-accent-600) text-white shadow-sm',
          'hover:bg-(--color-accent-500) active:translate-y-[0.5px]',
          'disabled:hover:bg-(--color-accent-600)',
        ],
        variant === 'secondary' && [
          'border border-(--color-border-strong) bg-(--color-surface-2) text-(--color-text)',
          'hover:bg-(--color-surface-3) active:translate-y-[0.5px]',
        ],
        variant === 'ghost' && [
          'text-(--color-text-muted) hover:bg-(--color-surface-2) hover:text-(--color-text)',
        ],
        variant === 'danger' && [
          'bg-(--color-danger) text-white shadow-sm hover:opacity-90',
        ],
        className,
      )}
      {...rest}
    >
      {loading ? (
        <span
          aria-hidden
          className="size-3.5 animate-spin rounded-full border-2 border-current border-t-transparent"
        />
      ) : (
        leadingIcon && <span className="shrink-0">{leadingIcon}</span>
      )}
      {children}
    </button>
  );
});
