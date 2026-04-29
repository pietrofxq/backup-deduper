import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeTmpDir, rmRf, buildTree } from '../_helpers/tmp.js';
import { boot } from '../../src/main.js';
import { openDb } from '../../src/db/index.js';
import {
  getPrimary,
  listCollections,
  setPrimary,
  UnknownCollectionError,
} from '../../src/db/queries.js';
import { syncCollectionsTable } from '../../src/scanner/index.js';

describe('setPrimary — unknown id is a hard error and does not clear existing primary', () => {
  let root: string;
  beforeEach(() => {
    root = makeTmpDir('setprimary-');
  });
  afterEach(() => rmRf(root));

  it('throws UnknownCollectionError; existing primary is preserved', async () => {
    buildTree(root, { 'Backup-A/x.txt': 'a', 'Backup-B/y.txt': 'b' });
    await boot({ targetRoot: root, noServe: true });
    const db = openDb(root);
    syncCollectionsTable(db, root);

    const a = listCollections(db).find((c) => c.rel_path === 'Backup-A')!;
    setPrimary(db, a.id);
    expect(getPrimary(db)?.id).toBe(a.id);

    // Ask for a nonexistent id. The previous implementation would clear A's
    // primary flag (first UPDATE) and then no-op the second UPDATE, leaving
    // the system with NO primary — silently downgrading sanity guard +
    // cross-collection keeper preference. Now must throw.
    expect(() => setPrimary(db, 999_999)).toThrow(UnknownCollectionError);

    // A is still primary.
    expect(getPrimary(db)?.id).toBe(a.id);
    db.client.close();
  });
});
