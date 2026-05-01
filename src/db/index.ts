import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { sentinelPaths } from '../target/sentinel.js';
import * as schema from './schema.js';

/**
 * Public DB type. Wraps the better-sqlite3 client and the typed Drizzle
 * builder side-by-side.
 *
 * Use `db.q` for everything by default — every query in `src/db/queries.ts`
 * goes through it and gets type-checked column names plus typed result rows.
 *
 * `db.client` is the lower-level escape hatch. Reach for it only when:
 *   - running raw `client.exec(...)` for migrations,
 *   - calling `client.pragma(...)`,
 *   - or hand-rolling a prepared statement that Drizzle can't express.
 *
 * Both fields share the same underlying SQLite connection — there is no
 * second handle and no separate transaction context, so `db.client.transaction`
 * and `db.q.transaction` are the same SQLite session.
 */
export interface Db {
  client: Database.Database;
  q: BetterSQLite3Database<typeof schema>;
}

export interface OpenDbOptions {
  /** Set to true in tests to keep the DB file out of `<target_root>/.dedupe/`. */
  override?: { dbPath: string };
}

export function dbPathFor(targetRoot: string): string {
  return path.join(sentinelPaths(targetRoot).dedupeDir, 'state.db');
}

export function openDb(targetRoot: string, opts: OpenDbOptions = {}): Db {
  const dbPath = opts.override?.dbPath ?? dbPathFor(targetRoot);
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const client = new Database(dbPath);
  client.pragma('journal_mode = WAL');
  client.pragma('foreign_keys = ON');
  // synchronous=FULL adds an extra fsync per commit so a kernel panic /
  // power loss in the middle of a transaction can't corrupt the WAL.
  // The throughput cost is negligible for our workload (a few hundred
  // commits per scan, no bulk-insert hot paths) and the safety dividend
  // is essential for a tool that mediates destructive moves.
  client.pragma('synchronous = FULL');
  const q = drizzle(client, { schema });
  return { client, q };
}

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Locate the `migrations/` folder, whether running from `dist/` or `src/`. */
function migrationsDir(): string {
  const candidate = path.join(HERE, 'migrations');
  if (fs.existsSync(candidate)) return candidate;
  const fallback = path.resolve(HERE, '../../src/db/migrations');
  if (fs.existsSync(fallback)) return fallback;
  throw new Error(`Cannot locate db/migrations directory (tried: ${candidate}, ${fallback})`);
}

export interface MigrateResult {
  applied: number[];
}

/**
 * Apply migrations in numeric order, recording the applied versions in our
 * own `schema_version` table.
 *
 * Rationale (vs. drizzle-kit migrate at runtime): we keep the runner
 * deliberately tiny and our own — one fewer thing to debug under crash
 * recovery, and our `schema_version` table is observable from the same
 * client without spinning up Drizzle's runtime.
 */
export function migrate(db: Db): MigrateResult {
  db.client.exec(`CREATE TABLE IF NOT EXISTS schema_version (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);

  const dir = migrationsDir();
  const files = fs
    .readdirSync(dir)
    .filter((f) => /^\d+_.+\.sql$/.test(f))
    .sort();

  const applied: number[] = [];
  for (const file of files) {
    const m = file.match(/^(\d+)_/);
    if (!m || m[1] === undefined) continue;
    const version = Number(m[1]);
    const row = db.client
      .prepare('SELECT version FROM schema_version WHERE version = ?')
      .get(version) as { version: number } | undefined;
    if (row) continue;

    const sqlText = fs.readFileSync(path.join(dir, file), 'utf8');
    const tx = db.client.transaction(() => {
      // Drizzle splits multi-statement migrations with `--> statement-breakpoint`.
      // better-sqlite3's exec() handles `;`-separated statements fine; the marker
      // is on its own comment line so exec() ignores it.
      db.client.exec(sqlText);
      db.client.prepare('INSERT INTO schema_version (version) VALUES (?)').run(version);
    });
    tx();
    applied.push(version);
  }

  return { applied };
}
