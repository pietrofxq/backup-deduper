import type { ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useRouterState } from '@tanstack/react-router';
import {
  Activity,
  Archive,
  ClipboardList,
  GaugeCircle,
  Hash,
  HardDrive,
  Settings,
  ShieldAlert,
} from 'lucide-react';
import { useApi } from '../lib/apiContext.js';
import { keys } from '../lib/queryKeys.js';
import { cn } from '../lib/cn.js';
import { Badge } from './Badge.js';

/**
 * Application chrome — sidebar + topbar wrapping the routed page content.
 *
 * Layout mirrors common desktop tools (Linear/Obsidian/Tauri samples):
 *   - Fixed-width sidebar on the left, no logo on its own row
 *   - Compact topbar with target_root, dry-run state, sentinel UUID
 *   - Generous content gutter, max width to keep long lines readable
 */
export function Layout({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-full bg-(--color-surface) text-(--color-text)">
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar />
        <main className="min-w-0 flex-1 overflow-auto">
          <div className="mx-auto w-full max-w-6xl px-8 py-7">{children}</div>
        </main>
      </div>
    </div>
  );
}

interface NavItem {
  to: string;
  label: string;
  icon: ReactNode;
  /** When true, route is not yet implemented — shown muted with a "soon" tag. */
  pending?: boolean;
}

const NAV_ITEMS: NavItem[] = [
  { to: '/', label: 'Dashboard', icon: <GaugeCircle size={16} /> },
  { to: '/settings', label: 'Settings', icon: <Settings size={16} /> },
  { to: '/quarantine', label: 'Quarantine', icon: <Archive size={16} />, pending: true },
  { to: '/audit', label: 'Audit log', icon: <ClipboardList size={16} />, pending: true },
  { to: '/review', label: 'Review queue', icon: <Activity size={16} />, pending: true },
];

function Sidebar() {
  return (
    <aside
      className={cn(
        'no-select flex w-56 flex-col border-r border-(--color-border) bg-(--color-surface-2)',
        'shrink-0',
      )}
    >
      <div className="flex h-14 items-center gap-2.5 border-b border-(--color-border) px-4">
        <div className="grid size-7 place-items-center rounded-md bg-(--color-accent-600) text-white shadow-sm">
          <ShieldAlert size={15} strokeWidth={2.4} />
        </div>
        <div className="leading-tight">
          <div className="text-sm font-semibold tracking-tight">safe-dedupe</div>
          <div className="text-[10.5px] text-(--color-text-subtle)">v0.1 · local</div>
        </div>
      </div>

      <nav className="flex flex-col gap-0.5 p-2">
        {NAV_ITEMS.map((item) => (
          <NavLink key={item.to} item={item} />
        ))}
      </nav>

      <div className="mt-auto border-t border-(--color-border) p-3">
        <SidebarFooter />
      </div>
    </aside>
  );
}

function NavLink({ item }: { item: NavItem }) {
  const path = useRouterState({ select: (s) => s.location.pathname });
  const active = path === item.to;
  if (item.pending) {
    return (
      <div
        className={cn(
          'group flex h-8 items-center gap-2.5 rounded-md px-2.5 text-sm',
          'cursor-not-allowed text-(--color-text-subtle)',
        )}
        title="Lands in M10"
      >
        <span className="opacity-50">{item.icon}</span>
        <span className="flex-1">{item.label}</span>
        <span className="text-[9.5px] font-semibold tracking-wider text-(--color-text-subtle) uppercase">
          soon
        </span>
      </div>
    );
  }
  return (
    <Link
      to={item.to}
      className={cn(
        'group flex h-8 items-center gap-2.5 rounded-md px-2.5 text-sm',
        'transition-colors',
        active
          ? 'bg-(--color-accent-100) font-medium text-(--color-accent-700) dark:bg-(--color-accent-100)/20 dark:text-(--color-accent-300)'
          : 'text-(--color-text-muted) hover:bg-(--color-surface-3) hover:text-(--color-text)',
      )}
    >
      <span
        className={cn(
          active
            ? 'text-(--color-accent-600) dark:text-(--color-accent-300)'
            : 'opacity-80',
        )}
      >
        {item.icon}
      </span>
      <span>{item.label}</span>
    </Link>
  );
}

function SidebarFooter() {
  const api = useApi();
  const health = useQuery({ queryKey: keys.health(), queryFn: () => api.health() });
  return (
    <div className="space-y-1.5 text-[11px] text-(--color-text-subtle)">
      <div className="flex items-center gap-1.5">
        <HardDrive size={12} className="opacity-70" />
        <span
          className="truncate font-mono"
          title={health.data?.targetRoot ?? ''}
        >
          {health.data?.targetRoot ?? '—'}
        </span>
      </div>
      <div className="flex items-center gap-1.5">
        <Hash size={12} className="opacity-70" />
        <span className="truncate font-mono" title={health.data?.uuid ?? ''}>
          {health.data?.uuid?.slice(0, 8) ?? '—'}
        </span>
      </div>
    </div>
  );
}

function TopBar() {
  const api = useApi();
  const config = useQuery({ queryKey: keys.config(), queryFn: () => api.getConfig() });
  const dryRun = config.data?.dry_run ?? true;
  return (
    <header
      className={cn(
        'flex h-14 shrink-0 items-center justify-between border-b border-(--color-border) bg-(--color-surface)',
        'px-6',
      )}
    >
      <div className="flex items-center gap-3 text-sm text-(--color-text-muted)">
        {dryRun ? (
          <Badge tone="warning">dry-run</Badge>
        ) : (
          <Badge tone="success">live</Badge>
        )}
        <span className="text-(--color-text-subtle)">·</span>
        <span>preset</span>
        <span className="font-mono text-xs text-(--color-text)">
          {config.data?.active_preset ?? '…'}
        </span>
      </div>
      <div className="flex items-center gap-2 text-xs text-(--color-text-subtle) tabular-nums">
        retention {config.data?.retention_days ?? '…'}d
      </div>
    </header>
  );
}
