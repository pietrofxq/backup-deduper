import type { HTMLAttributes, ReactNode } from 'react';
import { cn } from '../lib/cn.js';

export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode;
}

export function Card({ className, children, ...rest }: CardProps) {
  return (
    <div
      className={cn(
        'rounded-lg border border-(--color-border) bg-(--color-surface-2)',
        // Hairline shadow — gives the panel just enough lift to feel raised
        // without crossing into web-app territory.
        'shadow-[0_1px_0_0_color-mix(in_oklab,var(--color-border)_60%,transparent)]',
        className,
      )}
      {...rest}
    >
      {children}
    </div>
  );
}

export function CardHeader({
  title,
  action,
  description,
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'flex items-start justify-between gap-3 border-b border-(--color-border) px-4 py-3',
        className,
      )}
    >
      <div>
        <h3 className="text-sm font-semibold tracking-tight">{title}</h3>
        {description && (
          <p className="mt-0.5 text-xs text-(--color-text-muted)">{description}</p>
        )}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}

export function CardBody({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  return <div className={cn('p-4', className)}>{children}</div>;
}
