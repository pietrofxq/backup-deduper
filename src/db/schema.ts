import { sql } from 'drizzle-orm';
import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
  check,
} from 'drizzle-orm/sqlite-core';

/**
 * The schema is the same shape as the original 001_initial.sql migration.
 * Drizzle generates the migration SQL from this file via `drizzle-kit generate`.
 *
 * NOTE: `schema_version` is NOT included here on purpose — it's our migration
 * runner's internal bookkeeping table, created in `migrate()` outside Drizzle's
 * model. Including it here would cause the generated migration to conflict
 * with the runner's own CREATE.
 */

export const target = sqliteTable(
  'target',
  {
    id: integer('id').primaryKey(),
    targetIdUuid: text('target_id_uuid').notNull(),
    targetRootAbs: text('target_root_abs').notNull(),
    osPlatform: text('os_platform').notNull(),
    boundAt: text('bound_at').notNull().default(sql`(datetime('now'))`),
  },
  (t) => [
    check('target_id_singleton', sql`${t.id} = 1`),
    check('target_os_platform', sql`${t.osPlatform} IN ('win32','linux','darwin')`),
  ],
);

export const preset = sqliteTable('preset', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull().unique(),
  cruftRulesJson: text('cruft_rules_json').notNull(),
  whitelistJson: text('whitelist_json').notNull(),
  pathPriorityJson: text('path_priority_json').notNull(),
  isBuiltin: integer('is_builtin').notNull().default(0),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
});

export const collection = sqliteTable(
  'collection',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    relPath: text('rel_path').notNull().unique(),
    isPrimary: integer('is_primary').notNull().default(0),
    createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
  },
  (t) => [
    // Partial unique index: at most one row may have is_primary = 1.
    uniqueIndex('idx_collection_one_primary')
      .on(t.isPrimary)
      .where(sql`${t.isPrimary} = 1`),
  ],
);

export const file = sqliteTable(
  'file',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    collectionId: integer('collection_id')
      .notNull()
      .references(() => collection.id, { onDelete: 'cascade' }),
    relPath: text('rel_path').notNull(),
    size: integer('size').notNull(),
    mtimeMs: integer('mtime_ms').notNull(),
    sha256Hex: text('sha256_hex'),
    lastSeenRun: integer('last_seen_run'),
  },
  (t) => [
    uniqueIndex('idx_file_collection_relpath').on(t.collectionId, t.relPath),
    index('idx_file_sha256').on(t.sha256Hex).where(sql`${t.sha256Hex} IS NOT NULL`),
    index('idx_file_collection').on(t.collectionId),
    // Indexes the full rel_path, not the basename. The basename-grouping
    // pass in classifier/nameCollision.ts is in-memory, so this index just
    // accelerates path-prefix lookups during scanning.
    index('idx_file_relpath').on(t.relPath),
  ],
);

export const run = sqliteTable(
  'run',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    kind: text('kind').notNull(),
    status: text('status').notNull(),
    dryRun: integer('dry_run').notNull().default(1),
    configJson: text('config_json').notNull(),
    startedAt: text('started_at').notNull().default(sql`(datetime('now'))`),
    finishedAt: text('finished_at'),
  },
  (t) => [
    check('run_kind', sql`${t.kind} IN ('scan','quarantine','purge','restore')`),
    check(
      'run_status',
      sql`${t.status} IN ('running','completed','crashed','failed','aborted')`,
    ),
    index('idx_run_status').on(t.status),
  ],
);

export const quarantineAction = sqliteTable(
  'quarantine_action',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    runId: integer('run_id')
      .notNull()
      .references(() => run.id, { onDelete: 'restrict' }),
    collectionId: integer('collection_id')
      .notNull()
      .references(() => collection.id, { onDelete: 'restrict' }),
    srcRelPath: text('src_rel_path').notNull(),
    destAbsPath: text('dest_abs_path').notNull(),
    size: integer('size').notNull(),
    sha256Hex: text('sha256_hex'),
    reason: text('reason').notNull(),
    plannedAt: text('planned_at').notNull().default(sql`(datetime('now'))`),
    executedAt: text('executed_at'),
    verifiedAt: text('verified_at'),
    restoredAt: text('restored_at'),
    purgedAt: text('purged_at'),
    error: text('error'),
  },
  (t) => [
    index('idx_qa_run').on(t.runId),
    index('idx_qa_pending')
      .on(t.executedAt, t.error)
      .where(sql`${t.executedAt} IS NULL AND ${t.error} IS NULL`),
    index('idx_qa_active').on(t.executedAt, t.restoredAt, t.purgedAt),
  ],
);

export const reviewItem = sqliteTable(
  'review_item',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    runId: integer('run_id')
      .notNull()
      .references(() => run.id, { onDelete: 'cascade' }),
    basename: text('basename').notNull(),
    aCollectionId: integer('a_collection_id')
      .notNull()
      .references(() => collection.id, { onDelete: 'cascade' }),
    aRelPath: text('a_rel_path').notNull(),
    aSha256Hex: text('a_sha256_hex').notNull(),
    aSize: integer('a_size').notNull(),
    bCollectionId: integer('b_collection_id')
      .notNull()
      .references(() => collection.id, { onDelete: 'cascade' }),
    bRelPath: text('b_rel_path').notNull(),
    bSha256Hex: text('b_sha256_hex').notNull(),
    bSize: integer('b_size').notNull(),
    status: text('status').notNull().default('open'),
    createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
  },
  (t) => [
    check(
      'review_item_status',
      sql`${t.status} IN ('open','kept_both','quarantined_a','quarantined_b')`,
    ),
    index('idx_review_status').on(t.status),
  ],
);

export const config = sqliteTable('config', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: text('updated_at').notNull().default(sql`(datetime('now'))`),
});

export type Schema = {
  target: typeof target;
  preset: typeof preset;
  collection: typeof collection;
  file: typeof file;
  run: typeof run;
  quarantineAction: typeof quarantineAction;
  reviewItem: typeof reviewItem;
  config: typeof config;
};
