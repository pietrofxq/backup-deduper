import {
  and,
  desc,
  eq,
  gte,
  isNotNull,
  isNull,
  lt,
  lte,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import type { Db } from './index.js';
import * as s from './schema.js';

// ---------- target ----------

export interface TargetRow {
  id: number;
  target_id_uuid: string;
  target_root_abs: string;
  os_platform: 'win32' | 'linux' | 'darwin';
  bound_at: string;
}

export function getTarget(db: Db): TargetRow | null {
  const row = db.q.select().from(s.target).where(eq(s.target.id, 1)).get();
  if (!row) return null;
  return rowTarget(row);
}

export function setTarget(
  db: Db,
  uuid: string,
  targetRootAbs: string,
  osPlatform: string,
): void {
  db.q
    .insert(s.target)
    .values({
      id: 1,
      targetIdUuid: uuid,
      targetRootAbs,
      osPlatform,
    })
    .onConflictDoUpdate({
      target: s.target.id,
      set: {
        targetIdUuid: uuid,
        targetRootAbs,
        osPlatform,
      },
    })
    .run();
}

export function updateTargetRoot(db: Db, targetRootAbs: string): void {
  db.q.update(s.target).set({ targetRootAbs }).where(eq(s.target.id, 1)).run();
}

function rowTarget(r: typeof s.target.$inferSelect): TargetRow {
  return {
    id: r.id,
    target_id_uuid: r.targetIdUuid,
    target_root_abs: r.targetRootAbs,
    os_platform: r.osPlatform as TargetRow['os_platform'],
    bound_at: r.boundAt,
  };
}

// ---------- collection ----------

export interface CollectionRow {
  id: number;
  rel_path: string;
  is_primary: number;
  created_at: string;
}

function rowCollection(r: typeof s.collection.$inferSelect): CollectionRow {
  return { id: r.id, rel_path: r.relPath, is_primary: r.isPrimary, created_at: r.createdAt };
}

export function listCollections(db: Db): CollectionRow[] {
  const rows = db.q.select().from(s.collection).orderBy(s.collection.relPath).all();
  return rows.map(rowCollection);
}

export function upsertCollection(db: Db, relPath: string): CollectionRow {
  db.q
    .insert(s.collection)
    .values({ relPath })
    .onConflictDoNothing({ target: s.collection.relPath })
    .run();
  const row = db.q
    .select()
    .from(s.collection)
    .where(eq(s.collection.relPath, relPath))
    .get();
  if (!row) throw new Error(`upsertCollection: missing row for ${relPath}`);
  return rowCollection(row);
}

export class UnknownCollectionError extends Error {
  constructor(public readonly collectionId: number) {
    super(`No collection with id=${collectionId}`);
    this.name = 'UnknownCollectionError';
  }
}

/**
 * Mark a collection as primary. The transaction must be all-or-nothing:
 * if `collectionId` doesn't exist, we MUST NOT have already cleared the
 * existing primary — otherwise a stale id leaves the system with no
 * primary at all, which silently disables the cross-collection keeper
 * preference and the sanity-guard's "% of primary" math.
 */
export function setPrimary(db: Db, collectionId: number): void {
  db.q.transaction((tx) => {
    const exists = tx
      .select({ id: s.collection.id })
      .from(s.collection)
      .where(eq(s.collection.id, collectionId))
      .get();
    if (!exists) {
      throw new UnknownCollectionError(collectionId);
    }
    tx.update(s.collection).set({ isPrimary: 0 }).where(eq(s.collection.isPrimary, 1)).run();
    tx.update(s.collection).set({ isPrimary: 1 }).where(eq(s.collection.id, collectionId)).run();
  });
}

export function getPrimary(db: Db): CollectionRow | null {
  const row = db.q
    .select()
    .from(s.collection)
    .where(eq(s.collection.isPrimary, 1))
    .get();
  return row ? rowCollection(row) : null;
}

// ---------- file ----------

export interface FileRow {
  id: number;
  collection_id: number;
  rel_path: string;
  size: number;
  mtime_ms: number;
  sha256_hex: string | null;
  last_seen_run: number | null;
}

function rowFile(r: typeof s.file.$inferSelect): FileRow {
  return {
    id: r.id,
    collection_id: r.collectionId,
    rel_path: r.relPath,
    size: r.size,
    mtime_ms: r.mtimeMs,
    sha256_hex: r.sha256Hex,
    last_seen_run: r.lastSeenRun,
  };
}

export function getFile(
  db: Db,
  collectionId: number,
  relPath: string,
): FileRow | null {
  const row = db.q
    .select()
    .from(s.file)
    .where(and(eq(s.file.collectionId, collectionId), eq(s.file.relPath, relPath)))
    .get();
  return row ? rowFile(row) : null;
}

export function upsertFile(
  db: Db,
  collectionId: number,
  relPath: string,
  size: number,
  mtimeMs: number,
  sha256: string | null,
  runId: number,
): void {
  db.q
    .insert(s.file)
    .values({
      collectionId,
      relPath,
      size,
      mtimeMs,
      sha256Hex: sha256,
      lastSeenRun: runId,
    })
    .onConflictDoUpdate({
      target: [s.file.collectionId, s.file.relPath],
      set: {
        size,
        mtimeMs,
        sha256Hex: sha256,
        lastSeenRun: runId,
      },
    })
    .run();
}

export function setFileHash(
  db: Db,
  collectionId: number,
  relPath: string,
  sha256: string,
): void {
  db.q
    .update(s.file)
    .set({ sha256Hex: sha256 })
    .where(and(eq(s.file.collectionId, collectionId), eq(s.file.relPath, relPath)))
    .run();
}

export function deleteStaleFiles(db: Db, runId: number): number {
  const info = db.q
    .delete(s.file)
    .where(or(isNull(s.file.lastSeenRun), lt(s.file.lastSeenRun, runId)))
    .run();
  return info.changes;
}

export function listFilesInCollection(db: Db, collectionId: number): FileRow[] {
  return db.q
    .select()
    .from(s.file)
    .where(eq(s.file.collectionId, collectionId))
    .all()
    .map(rowFile);
}

export function listAllLiveFiles(db: Db): FileRow[] {
  return db.q.select().from(s.file).all().map(rowFile);
}

export function deleteFileRow(db: Db, collectionId: number, relPath: string): void {
  db.q
    .delete(s.file)
    .where(and(eq(s.file.collectionId, collectionId), eq(s.file.relPath, relPath)))
    .run();
}

// ---------- run ----------

export type RunKind = 'scan' | 'quarantine' | 'purge' | 'restore';
export type RunStatus = 'running' | 'completed' | 'crashed' | 'failed' | 'aborted';

export interface RunRow {
  id: number;
  kind: RunKind;
  status: RunStatus;
  dry_run: number;
  config_json: string;
  started_at: string;
  finished_at: string | null;
}

function rowRun(r: typeof s.run.$inferSelect): RunRow {
  return {
    id: r.id,
    kind: r.kind as RunKind,
    status: r.status as RunStatus,
    dry_run: r.dryRun,
    config_json: r.configJson,
    started_at: r.startedAt,
    finished_at: r.finishedAt,
  };
}

export function createRun(
  db: Db,
  kind: RunKind,
  dryRun: boolean,
  config: unknown,
): number {
  const result = db.q
    .insert(s.run)
    .values({
      kind,
      status: 'running',
      dryRun: dryRun ? 1 : 0,
      configJson: JSON.stringify(config),
    })
    .returning({ id: s.run.id })
    .get();
  if (!result) throw new Error('createRun: no row returned');
  return result.id;
}

export function setRunStatus(db: Db, runId: number, status: RunStatus): void {
  db.q
    .update(s.run)
    .set({ status, finishedAt: sql`datetime('now')` })
    .where(eq(s.run.id, runId))
    .run();
}

export function getRun(db: Db, runId: number): RunRow | null {
  const r = db.q.select().from(s.run).where(eq(s.run.id, runId)).get();
  return r ? rowRun(r) : null;
}

export function listRuns(db: Db, limit = 50): RunRow[] {
  return db.q.select().from(s.run).orderBy(desc(s.run.id)).limit(limit).all().map(rowRun);
}

export function findRunningRuns(db: Db): RunRow[] {
  return db.q.select().from(s.run).where(eq(s.run.status, 'running')).all().map(rowRun);
}

// ---------- quarantine_action ----------

export type QuarantineReason =
  | 'duplicate_cross_collection'
  | 'duplicate_within_collection'
  | 'cruft_empty_folder'
  | 'cruft_os_metadata'
  | `cruft_preset_${string}`;

export interface QuarantineActionRow {
  id: number;
  run_id: number;
  collection_id: number;
  src_rel_path: string;
  dest_abs_path: string;
  size: number;
  sha256_hex: string | null;
  reason: string;
  planned_at: string;
  executed_at: string | null;
  verified_at: string | null;
  restored_at: string | null;
  purged_at: string | null;
  error: string | null;
}

function rowAction(r: typeof s.quarantineAction.$inferSelect): QuarantineActionRow {
  return {
    id: r.id,
    run_id: r.runId,
    collection_id: r.collectionId,
    src_rel_path: r.srcRelPath,
    dest_abs_path: r.destAbsPath,
    size: r.size,
    sha256_hex: r.sha256Hex,
    reason: r.reason,
    planned_at: r.plannedAt,
    executed_at: r.executedAt,
    verified_at: r.verifiedAt,
    restored_at: r.restoredAt,
    purged_at: r.purgedAt,
    error: r.error,
  };
}

export function insertPlannedAction(
  db: Db,
  args: {
    runId: number;
    collectionId: number;
    srcRelPath: string;
    destAbsPath: string;
    size: number;
    sha256: string | null;
    reason: string;
  },
): number {
  const result = db.q
    .insert(s.quarantineAction)
    .values({
      runId: args.runId,
      collectionId: args.collectionId,
      srcRelPath: args.srcRelPath,
      destAbsPath: args.destAbsPath,
      size: args.size,
      sha256Hex: args.sha256,
      reason: args.reason,
    })
    .returning({ id: s.quarantineAction.id })
    .get();
  if (!result) throw new Error('insertPlannedAction: no row returned');
  return result.id;
}

export function markActionExecuted(db: Db, actionId: number): void {
  db.q
    .update(s.quarantineAction)
    .set({
      executedAt: sql`datetime('now')`,
      verifiedAt: sql`datetime('now')`,
    })
    .where(eq(s.quarantineAction.id, actionId))
    .run();
}

export function markActionError(db: Db, actionId: number, error: string): void {
  db.q
    .update(s.quarantineAction)
    .set({ error })
    .where(eq(s.quarantineAction.id, actionId))
    .run();
}

export function getPendingActions(db: Db): QuarantineActionRow[] {
  return db.q
    .select()
    .from(s.quarantineAction)
    .where(and(isNull(s.quarantineAction.executedAt), isNull(s.quarantineAction.error)))
    .orderBy(s.quarantineAction.id)
    .all()
    .map(rowAction);
}

export function getAction(db: Db, id: number): QuarantineActionRow | null {
  const r = db.q
    .select()
    .from(s.quarantineAction)
    .where(eq(s.quarantineAction.id, id))
    .get();
  return r ? rowAction(r) : null;
}

export function listActiveActions(db: Db, runId?: number): QuarantineActionRow[] {
  const baseFilter = and(
    isNotNull(s.quarantineAction.executedAt),
    isNull(s.quarantineAction.restoredAt),
    isNull(s.quarantineAction.purgedAt),
  );
  if (runId !== undefined) {
    return db.q
      .select()
      .from(s.quarantineAction)
      .where(and(eq(s.quarantineAction.runId, runId), baseFilter))
      .orderBy(s.quarantineAction.id)
      .all()
      .map(rowAction);
  }
  return db.q
    .select()
    .from(s.quarantineAction)
    .where(baseFilter)
    .orderBy(desc(s.quarantineAction.id))
    .all()
    .map(rowAction);
}

export function listAllActions(db: Db, runId?: number): QuarantineActionRow[] {
  if (runId !== undefined) {
    return db.q
      .select()
      .from(s.quarantineAction)
      .where(eq(s.quarantineAction.runId, runId))
      .orderBy(s.quarantineAction.id)
      .all()
      .map(rowAction);
  }
  return db.q
    .select()
    .from(s.quarantineAction)
    .orderBy(desc(s.quarantineAction.id))
    .limit(1000)
    .all()
    .map(rowAction);
}

export interface AuditFilters {
  runId?: number;
  reason?: string;
  /** Inclusive lower bound on planned_at (SQLite datetime string, e.g. "2025-01-01"). */
  after?: string;
  /** Inclusive upper bound on planned_at. */
  before?: string;
}

export interface AuditPage {
  items: QuarantineActionRow[];
  total: number;
  limit: number;
  offset: number;
}

function buildAuditWhere(filters: AuditFilters): SQL | undefined {
  const parts: SQL[] = [];
  if (filters.runId !== undefined) {
    parts.push(eq(s.quarantineAction.runId, filters.runId));
  }
  if (filters.reason !== undefined && filters.reason !== '') {
    parts.push(eq(s.quarantineAction.reason, filters.reason));
  }
  if (filters.after !== undefined && filters.after !== '') {
    parts.push(gte(s.quarantineAction.plannedAt, filters.after));
  }
  if (filters.before !== undefined && filters.before !== '') {
    parts.push(lte(s.quarantineAction.plannedAt, filters.before));
  }
  if (parts.length === 0) return undefined;
  if (parts.length === 1) return parts[0];
  return and(...parts);
}

export function listAuditPage(
  db: Db,
  filters: AuditFilters = {},
  limit = 100,
  offset = 0,
): AuditPage {
  const where = buildAuditWhere(filters);
  const totalRow = where
    ? db.q
        .select({ n: sql<number>`count(*)` })
        .from(s.quarantineAction)
        .where(where)
        .get()
    : db.q
        .select({ n: sql<number>`count(*)` })
        .from(s.quarantineAction)
        .get();
  const total = totalRow?.n ?? 0;

  const rows = where
    ? db.q
        .select()
        .from(s.quarantineAction)
        .where(where)
        .orderBy(desc(s.quarantineAction.id))
        .limit(limit)
        .offset(offset)
        .all()
    : db.q
        .select()
        .from(s.quarantineAction)
        .orderBy(desc(s.quarantineAction.id))
        .limit(limit)
        .offset(offset)
        .all();
  return { items: rows.map(rowAction), total, limit, offset };
}

/** Distinct `reason` values present in the audit table — used to populate the UI filter dropdown. */
export function listAuditReasons(db: Db): string[] {
  return db.q
    .selectDistinct({ reason: s.quarantineAction.reason })
    .from(s.quarantineAction)
    .orderBy(s.quarantineAction.reason)
    .all()
    .map((r) => r.reason);
}

export function markActionRestored(db: Db, actionId: number): void {
  db.q
    .update(s.quarantineAction)
    .set({ restoredAt: sql`datetime('now')` })
    .where(eq(s.quarantineAction.id, actionId))
    .run();
}

export function markActionPurged(db: Db, actionId: number): void {
  db.q
    .update(s.quarantineAction)
    .set({ purgedAt: sql`datetime('now')` })
    .where(eq(s.quarantineAction.id, actionId))
    .run();
}

// ---------- review_item ----------

export interface ReviewItemRow {
  id: number;
  run_id: number;
  basename: string;
  a_collection_id: number;
  a_rel_path: string;
  a_sha256_hex: string;
  a_size: number;
  b_collection_id: number;
  b_rel_path: string;
  b_sha256_hex: string;
  b_size: number;
  status: 'open' | 'kept_both' | 'quarantined_a' | 'quarantined_b';
  created_at: string;
}

function rowReviewItem(r: typeof s.reviewItem.$inferSelect): ReviewItemRow {
  return {
    id: r.id,
    run_id: r.runId,
    basename: r.basename,
    a_collection_id: r.aCollectionId,
    a_rel_path: r.aRelPath,
    a_sha256_hex: r.aSha256Hex,
    a_size: r.aSize,
    b_collection_id: r.bCollectionId,
    b_rel_path: r.bRelPath,
    b_sha256_hex: r.bSha256Hex,
    b_size: r.bSize,
    status: r.status as ReviewItemRow['status'],
    created_at: r.createdAt,
  };
}

export function insertReviewItem(
  db: Db,
  args: {
    runId: number;
    basename: string;
    aCollectionId: number;
    aRelPath: string;
    aSha256: string;
    aSize: number;
    bCollectionId: number;
    bRelPath: string;
    bSha256: string;
    bSize: number;
  },
): number {
  const result = db.q
    .insert(s.reviewItem)
    .values({
      runId: args.runId,
      basename: args.basename,
      aCollectionId: args.aCollectionId,
      aRelPath: args.aRelPath,
      aSha256Hex: args.aSha256,
      aSize: args.aSize,
      bCollectionId: args.bCollectionId,
      bRelPath: args.bRelPath,
      bSha256Hex: args.bSha256,
      bSize: args.bSize,
    })
    .returning({ id: s.reviewItem.id })
    .get();
  if (!result) throw new Error('insertReviewItem: no row returned');
  return result.id;
}

export function listReviewItems(db: Db, status?: ReviewItemRow['status']): ReviewItemRow[] {
  if (status) {
    return db.q
      .select()
      .from(s.reviewItem)
      .where(eq(s.reviewItem.status, status))
      .orderBy(desc(s.reviewItem.id))
      .all()
      .map(rowReviewItem);
  }
  return db.q
    .select()
    .from(s.reviewItem)
    .orderBy(desc(s.reviewItem.id))
    .all()
    .map(rowReviewItem);
}

export function setReviewItemStatus(
  db: Db,
  id: number,
  status: ReviewItemRow['status'],
): boolean {
  const result = db.q.update(s.reviewItem).set({ status }).where(eq(s.reviewItem.id, id)).run();
  return result.changes > 0;
}

// ---------- config ----------

export function getConfigValue(db: Db, key: string): string | null {
  const r = db.q.select().from(s.config).where(eq(s.config.key, key)).get();
  return r?.value ?? null;
}

export function setConfigValue(db: Db, key: string, value: string): void {
  db.q
    .insert(s.config)
    .values({ key, value })
    .onConflictDoUpdate({
      target: s.config.key,
      set: { value, updatedAt: sql`datetime('now')` },
    })
    .run();
}

export function deleteConfigValue(db: Db, key: string): void {
  db.q.delete(s.config).where(eq(s.config.key, key)).run();
}

// ---------- preset ----------

export interface PresetRow {
  id: number;
  name: string;
  cruft_rules_json: string;
  whitelist_json: string;
  path_priority_json: string;
  is_builtin: number;
  created_at: string;
}

function rowPreset(r: typeof s.preset.$inferSelect): PresetRow {
  return {
    id: r.id,
    name: r.name,
    cruft_rules_json: r.cruftRulesJson,
    whitelist_json: r.whitelistJson,
    path_priority_json: r.pathPriorityJson,
    is_builtin: r.isBuiltin,
    created_at: r.createdAt,
  };
}

export function listPresets(db: Db): PresetRow[] {
  return db.q.select().from(s.preset).orderBy(s.preset.id).all().map(rowPreset);
}

export function getPresetByName(db: Db, name: string): PresetRow | null {
  const r = db.q.select().from(s.preset).where(eq(s.preset.name, name)).get();
  return r ? rowPreset(r) : null;
}

export function upsertPreset(
  db: Db,
  args: {
    name: string;
    cruftRulesJson: string;
    whitelistJson: string;
    pathPriorityJson: string;
    isBuiltin: boolean;
  },
): void {
  db.q
    .insert(s.preset)
    .values({
      name: args.name,
      cruftRulesJson: args.cruftRulesJson,
      whitelistJson: args.whitelistJson,
      pathPriorityJson: args.pathPriorityJson,
      isBuiltin: args.isBuiltin ? 1 : 0,
    })
    .onConflictDoUpdate({
      target: s.preset.name,
      set: {
        cruftRulesJson: args.cruftRulesJson,
        whitelistJson: args.whitelistJson,
        pathPriorityJson: args.pathPriorityJson,
        isBuiltin: args.isBuiltin ? 1 : 0,
      },
    })
    .run();
}
