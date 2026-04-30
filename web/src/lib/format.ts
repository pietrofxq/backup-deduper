/**
 * Formatters — small, locale-stable helpers used across pages.
 */

const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'] as const;

/** Humanize a byte count. 0 → "0 B"; 1.5 GB → "1.50 GB". */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const decimals = value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(decimals)} ${BYTE_UNITS[unit]}`;
}

/** Humanize a number with thousands separators. */
export function formatCount(n: number): string {
  if (!Number.isFinite(n)) return '—';
  return n.toLocaleString('en-US');
}

/**
 * Format a SQLite/ISO timestamp as a relative or absolute string.
 *   recent (< 60s)  → "just now"
 *   < 1h            → "12m ago"
 *   < 24h           → "3h ago"
 *   < 7d            → "2d ago"
 *   else            → "Mar 12, 14:23"
 */
export function formatRelativeTime(input: string | null | undefined, now = Date.now()): string {
  if (!input) return '—';
  // SQLite returns "YYYY-MM-DD HH:MM:SS" (no T, no Z). Normalize for Date().
  const iso = input.includes('T') ? input : input.replace(' ', 'T') + 'Z';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return input;
  const delta = now - t;
  const sec = Math.round(delta / 1000);
  if (sec < 60) return 'just now';
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  if (day < 7) return `${day}d ago`;
  return new Date(t).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** Format a percentage between 0 and 1 as e.g. "37%". */
export function formatPercent(p: number): string {
  if (!Number.isFinite(p)) return '—';
  return `${Math.round(p * 100)}%`;
}

/** Format a duration in ms as "1.2s" / "340ms" / "2m 15s". */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms)) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const min = Math.floor(ms / 60_000);
  const sec = Math.round((ms % 60_000) / 1000);
  return `${min}m ${sec}s`;
}
