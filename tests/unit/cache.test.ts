import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { makeTmpDir, rmRf, buildTree } from '../_helpers/tmp.js';
import { boot } from '../../src/main.js';
import { openDb } from '../../src/db/index.js';
import {
  createRun,
  getFile,
  listFilesInCollection,
  setRunStatus,
} from '../../src/db/queries.js';
import { scanAll } from '../../src/scanner/index.js';
import { dbPathFor } from '../../src/db/index.js';

describe('scanner cache invalidation', () => {
  let root: string;
  beforeEach(() => {
    root = makeTmpDir('cache-');
  });
  afterEach(() => rmRf(root));

  async function freshScan(targetRoot: string) {
    const db = openDb(targetRoot, { override: { dbPath: dbPathFor(targetRoot) } });
    const runId = createRun(db, 'scan', true, {});
    const result = await scanAll(db, targetRoot, runId);
    setRunStatus(db, runId, 'completed');
    db.client.close();
    return { runId, result };
  }

  it('first scan hashes everything; second scan reuses cache', async () => {
    buildTree(root, {
      'colA/a.txt': 'aaaa',
      'colA/sub/b.txt': 'bbbb',
      'colB/c.txt': 'cccc',
    });
    await boot({ targetRoot: root, noServe: true });

    const first = await freshScan(root);
    expect(first.result.totalHashed).toBe(3);
    expect(first.result.totalCached).toBe(0);

    const second = await freshScan(root);
    expect(second.result.totalHashed).toBe(0);
    expect(second.result.totalCached).toBe(3);
  });

  it('changed mtime triggers re-hash', async () => {
    buildTree(root, { 'colA/a.txt': 'first' });
    await boot({ targetRoot: root, noServe: true });
    await freshScan(root);

    // Modify file content + bump mtime.
    fs.writeFileSync(path.join(root, 'colA', 'a.txt'), 'second-content');
    const future = (Date.now() + 5000) / 1000;
    fs.utimesSync(path.join(root, 'colA', 'a.txt'), future, future);

    const second = await freshScan(root);
    expect(second.result.totalHashed).toBe(1);
    expect(second.result.totalCached).toBe(0);
  });

  it('disappeared file gets its row deleted at end-of-scan', async () => {
    buildTree(root, { 'colA/keep.txt': 'k', 'colA/gone.txt': 'g' });
    await boot({ targetRoot: root, noServe: true });
    await freshScan(root);

    fs.unlinkSync(path.join(root, 'colA', 'gone.txt'));
    const result = await freshScan(root);
    expect(result.result.totalFiles).toBe(1);

    const db = openDb(root);
    expect(getFile(db, 1, 'gone.txt')).toBeNull();
    expect(listFilesInCollection(db, 1).length).toBe(1);
    db.client.close();
  });
});
