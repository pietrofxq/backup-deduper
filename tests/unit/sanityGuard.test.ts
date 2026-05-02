import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { boot } from '../../src/main.js';
import { openDb, type Db } from '../../src/db/index.js';
import {
  listCollections,
  setPrimary,
  type CollectionRow,
  type FileRow,
} from '../../src/db/queries.js';
import { syncCollectionsTable } from '../../src/scanner/index.js';
import { checkSanityGuard } from '../../src/orchestrator/sanityGuard.js';
import type { PlannedAction } from '../../src/classifier/rules.js';
import { makeTmpDir, rmRf, buildTree } from '../_helpers/tmp.js';

describe('checkSanityGuard — fail-closed without primary (M15 / SG-1)', () => {
  let root: string;
  let db: Db;

  beforeEach(async () => {
    root = makeTmpDir('sg-');
    buildTree(root, {
      'Backup-A/x.txt': 'a',
      'Backup-B/y.txt': 'b',
    });
    await boot({ targetRoot: root, noServe: true });
    db = openDb(root);
    syncCollectionsTable(db, root);
  });

  afterEach(() => {
    db.client.close();
    rmRf(root);
  });

  function makeAction(coll: CollectionRow, size = 100): PlannedAction {
    const file: FileRow = {
      id: 1,
      collection_id: coll.id,
      rel_path: 'fake.txt',
      size,
      mtime_ms: 0,
      sha256_hex: 'a'.repeat(64),
      last_seen_run: 1,
    };
    return { collection: coll, file, reason: 'duplicate_within_collection', size };
  }

  it('passes vacuously when there are no actions and no primary', () => {
    const result = checkSanityGuard(db, [], { filesPctLimit: 0.5, bytesPctLimit: 0.7 });
    expect(result.passed).toBe(true);
    expect(result.code).toBeNull();
    expect(result.reason).toBeNull();
  });

  it('fails closed when there are actions and no primary is set', () => {
    const a = listCollections(db)[0]!;
    const result = checkSanityGuard(db, [makeAction(a, 100)], {
      filesPctLimit: 0.5,
      bytesPctLimit: 0.7,
    });
    expect(result.passed).toBe(false);
    expect(result.code).toBe('no_primary_set');
    expect(result.reason).toMatch(/no primary collection set/i);
    expect(result.plannedFiles).toBe(1);
    expect(result.plannedBytes).toBe(100);
  });

  it('does NOT fail closed once a primary is selected', () => {
    const cols = listCollections(db);
    const primary = cols.find((c) => c.rel_path === 'Backup-A')!;
    const other = cols.find((c) => c.rel_path === 'Backup-B')!;
    setPrimary(db, primary.id);
    // Action targets a non-primary, so primaryActions=[] and the pct
    // calculation produces zero — passes.
    const result = checkSanityGuard(db, [makeAction(other)], {
      filesPctLimit: 0.5,
      bytesPctLimit: 0.7,
    });
    expect(result.passed).toBe(true);
    expect(result.code).toBeNull();
  });

  it('fails closed with no primary when only empty-dir removals are planned', () => {
    // Regression for Copilot review on PR #6: a no-primary run that emits
    // zero file actions but ≥1 empty-dir removal would otherwise be
    // treated as vacuous, even though the mover still mutates the live
    // tree via rmdirSync. The sanity guard must count empty-dir actions
    // toward the "anything would fire" check.
    const result = checkSanityGuard(db, [], {
      filesPctLimit: 0.5,
      bytesPctLimit: 0.7,
      emptyDirCount: 2,
    });
    expect(result.passed).toBe(false);
    expect(result.code).toBe('no_primary_set');
    expect(result.reason).toMatch(/no primary collection set/i);
  });

  it('passes vacuously with no primary and no emptyDirs and no actions', () => {
    const result = checkSanityGuard(db, [], {
      filesPctLimit: 0.5,
      bytesPctLimit: 0.7,
      emptyDirCount: 0,
    });
    expect(result.passed).toBe(true);
    expect(result.code).toBeNull();
  });
});
