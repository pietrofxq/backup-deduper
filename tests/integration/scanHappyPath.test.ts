import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeTmpDir, rmRf, buildTree } from '../_helpers/tmp.js';
import { boot } from '../../src/main.js';
import { openDb } from '../../src/db/index.js';
import {
  createRun,
  listAllLiveFiles,
  listCollections,
  setRunStatus,
} from '../../src/db/queries.js';
import { scanAll } from '../../src/scanner/index.js';

describe('scan — happy path on small synthetic tree', () => {
  let root: string;
  beforeEach(() => {
    root = makeTmpDir('scan-happy-');
  });
  afterEach(() => rmRf(root));

  it('walks two collections, hashes files, populates DB', async () => {
    buildTree(root, {
      'Backup-A/DCIM/Camera/IMG_001.jpg': 'photo1',
      'Backup-A/DCIM/Camera/IMG_002.jpg': 'photo2',
      'Backup-A/Download/song.mp3': 'audio',
      'Backup-B/DCIM/Camera/IMG_001.jpg': 'photo1',
      'Backup-B/Documents/notes.txt': 'notes',
    });
    await boot({ targetRoot: root, noServe: true });

    const db = openDb(root);
    const runId = createRun(db, 'scan', true, {});
    const summary = await scanAll(db, root, runId);
    setRunStatus(db, runId, 'completed');

    expect(summary.totalFiles).toBe(5);
    expect(summary.totalHashed).toBe(5);

    const cols = listCollections(db);
    expect(cols.map((c) => c.rel_path).sort()).toEqual(['Backup-A', 'Backup-B']);

    const live = listAllLiveFiles(db);
    expect(live).toHaveLength(5);
    for (const f of live) {
      expect(f.sha256_hex).toMatch(/^[0-9a-f]{64}$/);
    }
    db.client.close();
  });
});
