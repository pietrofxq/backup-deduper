/**
 * Parse a timestamp produced by SQLite's `datetime('now')`, which returns
 * `YYYY-MM-DD HH:MM:SS` (UTC) — NOT RFC 3339. Naively appending `Z` and
 * passing to the JS Date constructor "happens to work" on Node + V8 but is
 * not portable across environments and silently drops sub-second precision
 * if we ever switch to `strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`.
 *
 * We accept either form here:
 *   - `YYYY-MM-DD HH:MM:SS`           (current SQLite default)
 *   - `YYYY-MM-DD HH:MM:SS.SSS`       (sub-second variant)
 *   - `YYYY-MM-DDTHH:MM:SS[.SSS]Z`    (already ISO)
 *
 * Returns a Date in UTC. Throws on shapes we don't recognize so callers
 * fail loudly rather than silently producing NaN dates.
 */
export function parseSqliteDatetime(s: string): Date {
  const trimmed = s.trim();
  // Already ISO? Date can parse it directly.
  if (/T/.test(trimmed)) {
    const d = new Date(trimmed.endsWith('Z') ? trimmed : trimmed + 'Z');
    if (Number.isNaN(d.getTime())) {
      throw new Error(`parseSqliteDatetime: unparsable ISO string ${JSON.stringify(s)}`);
    }
    return d;
  }
  // Space-separated: `YYYY-MM-DD HH:MM:SS[.SSS]`
  const m = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}(?:\.\d+)?)$/.exec(trimmed);
  if (!m) {
    throw new Error(`parseSqliteDatetime: unrecognized shape ${JSON.stringify(s)}`);
  }
  const iso = `${m[1]}T${m[2]}Z`;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) {
    throw new Error(`parseSqliteDatetime: unparsable normalized ISO ${iso}`);
  }
  return d;
}
