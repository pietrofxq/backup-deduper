import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fc from 'fast-check';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { makeTmpDir, rmRf } from '../_helpers/tmp.js';
import { boot } from '../../src/main.js';
import { openDb } from '../../src/db/index.js';
import {
  listActiveActions,
  listCollections,
  setPrimary,
} from '../../src/db/queries.js';
import { runScanJob } from '../../src/orchestrator/scanJob.js';
import { disableDryRun, runQuarantineJob } from '../../src/orchestrator/quarantineJob.js';
import { syncCollectionsTable } from '../../src/scanner/index.js';

const NUM_RUNS = Number(process.env.FAST_CHECK_NUM_RUNS ?? 50);

interface SyntheticTree {
  collections: Array<{ name: string; files: Record<string, string> }>;
  primaryIndex: number;
}

const arbitraryTree = fc
  .record({
    collections: fc.array(
      fc.record({
        name: fc.constantFrom('A', 'B', 'C'),
        files: fc.dictionary(
          fc.oneof(
            fc.constantFrom(
              'DCIM/Camera/x.jpg',
              'DCIM/Camera/y.jpg',
              'Download/song.mp3',
              'Documents/note.txt',
              'cache.exo',
              'Android/data/x.bin',
              'Android/media/wa.jpg',
              'Thumbs.db',
              'misc/blob.dat',
            ),
            fc.string({ minLength: 1, maxLength: 8 }).map((s) => `gen/${s.replace(/[^a-zA-Z0-9_-]/g, '_')}.bin`),
          ),
          fc.oneof(
            fc.constantFrom('content-A', 'content-B', 'shared-content', ''),
            fc.string({ minLength: 1, maxLength: 32 }),
          ),
          { minKeys: 0, maxKeys: 6 },
        ),
      }),
      { minLength: 1, maxLength: 3 },
    ),
    primaryIndex: fc.integer({ min: 0, max: 5 }),
  })
  .filter((t) => t.collections.length > 0)
  .map((t) => ({
    ...t,
    primaryIndex: t.primaryIndex % t.collections.length,
  })) as fc.Arbitrary<SyntheticTree>;

describe('safety invariant — every primary byte-content remains reachable', () => {
  let root: string;
  beforeEach(() => {
    root = makeTmpDir('safety-');
  });
  afterEach(() => rmRf(root));

  it('property: scan + classify + quarantine never loses primary content', async () => {
    await fc.assert(
      fc.asyncProperty(arbitraryTree, async (tree) => {
        const baseRoot = makeTmpDir('safety-prop-');
        // Track the DB handle in the outer scope so a `return false` (or any
        // exception) cannot leak it. Leaking on Windows blocks rmRf via
        // EBUSY and can pile up handles across shrinking/replays.
        let db: ReturnType<typeof openDb> | null = null;
        try {
          // Materialize tree on disk.
          // Each collection name may repeat across the array; deduplicate by
          // suffixing index. (fast-check may pick "A" twice.)
          const seen = new Set<string>();
          const realCollections: typeof tree.collections = tree.collections.map((c, i) => {
            let name = c.name;
            if (seen.has(name)) name = `${c.name}_${i}`;
            seen.add(name);
            return { ...c, name };
          });
          for (const c of realCollections) {
            const colRoot = path.join(baseRoot, c.name);
            fs.mkdirSync(colRoot, { recursive: true });
            for (const [rel, content] of Object.entries(c.files)) {
              if (rel.includes('..') || path.isAbsolute(rel)) continue;
              const abs = path.join(colRoot, rel);
              fs.mkdirSync(path.dirname(abs), { recursive: true });
              fs.writeFileSync(abs, content);
            }
          }

          await boot({ targetRoot: baseRoot, noServe: true });
          db = openDb(baseRoot);
          syncCollectionsTable(db, baseRoot);

          // Mark the chosen collection as primary.
          const primaryName = realCollections[tree.primaryIndex]?.name;
          const primary = listCollections(db).find((c) => c.rel_path === primaryName);
          if (primary) setPrimary(db, primary.id);

          // Snapshot every byte-content under the primary BEFORE the run.
          const beforePrimaryHashes = primaryName ? collectHashes(path.join(baseRoot, primaryName)) : new Set<string>();

          const scan = await runScanJob(db, baseRoot, { dryRun: true });
          disableDryRun(db, 'I have reviewed the dry-run report', baseRoot);
          runQuarantineJob({
            db,
            targetRoot: baseRoot,
            scanRunId: scan.runId,
            actions: scan.actions,
            emptyDirs: scan.emptyDirActions,
            ignoreSanityGuard: true, // property test exercises pathological cases
          });

          // After: build the reachability set EXACTLY as the invariant defines it:
          //   "live tree (excluding .dedupe AND .dedupe-trash) OR an active
          //    quarantine_action whose recorded sha256 matches".
          //
          // It is critical to exclude .dedupe-trash from the live walk: a file
          // sitting in trash with no DB row pointing back is the precise
          // failure mode the two-phase commit is meant to detect. If we
          // counted such an orphan as "reachable" because it's still on disk,
          // the test would pass even when the row→file link was lost.
          const liveHashes = collectHashes(baseRoot, [
            path.join(baseRoot, '.dedupe'),
            path.join(baseRoot, '.dedupe-trash'),
          ]);
          const actionHashes = new Set<string>();
          for (const a of listActiveActions(db)) {
            // Only sha-bearing rows count: an action without a recorded hash
            // cannot prove it points at the right bytes.
            if (a.sha256_hex) actionHashes.add(a.sha256_hex);
          }
          const reachable = new Set<string>([...liveHashes, ...actionHashes]);

          for (const h of beforePrimaryHashes) {
            if (!reachable.has(h)) {
              return false;
            }
          }
          return true;
        } finally {
          // Close BEFORE rmRf so Windows can unlink state.db; runs on every
          // exit path (success, failure, exception, fast-check shrinking).
          if (db) {
            try {
              db.client.close();
            } catch {
              /* ignore double-close */
            }
          }
          rmRf(baseRoot);
        }
      }),
      { numRuns: NUM_RUNS, verbose: true },
    );
  }, 300_000);
  // 5-minute budget. Each iteration mkdirs + writes files + boots + scans +
  // quarantines + closes the DB + rmRfs. Windows fs ops are slow and
  // GitHub-Actions runner perf is variable enough that the same test ran
  // for 27s on a windows-latest/Node 20 runner one day and 135s on the
  // next. Numbers stay in the same ballpark on macOS (~1-2s here, ~3-4s
  // on Windows), so this only matters when CI hits a slow runner. The
  // numRuns=500 thorough Linux job catches deeper edges; the per-PR
  // matrix just needs a budget that honest Windows variance can fit
  // inside.
});

/**
 * Regression test for the reachability oracle itself: we deliberately plant
 * an orphan file in .dedupe-trash with NO matching quarantine_action row.
 * The improved oracle (live walk excludes .dedupe-trash; trash reachability
 * is sourced from listActiveActions only) must NOT consider that orphan
 * reachable. If it did, it would mask exactly the failure mode two-phase
 * commit is built to prevent.
 */
describe('safety invariant — oracle correctness', () => {
  it('an orphan file in .dedupe-trash with no matching action row is NOT counted as reachable', async () => {
    const baseRoot = makeTmpDir('safety-oracle-');
    try {
      fs.mkdirSync(path.join(baseRoot, 'A'), { recursive: true });
      fs.writeFileSync(path.join(baseRoot, 'A/x.txt'), 'live');

      await boot({ targetRoot: baseRoot, noServe: true });

      // Plant an orphan in trash. No DB row points back at it.
      const orphanContent = 'orphan-bytes';
      const orphanHash = createHash('sha256').update(orphanContent).digest('hex');
      const orphanDir = path.join(baseRoot, '.dedupe-trash', 'orphan-run');
      fs.mkdirSync(orphanDir, { recursive: true });
      fs.writeFileSync(path.join(orphanDir, 'ghost.bin'), orphanContent);

      // The reachability set built per the corrected oracle.
      const liveHashes = collectHashes(baseRoot, [
        path.join(baseRoot, '.dedupe'),
        path.join(baseRoot, '.dedupe-trash'),
      ]);
      // No action rows exist — the trash side of reachability is empty.
      const reachable = new Set<string>([...liveHashes]);

      // The orphan must NOT be reachable — even though the bytes still exist
      // on disk inside the target tree.
      expect(reachable.has(orphanHash)).toBe(false);
    } finally {
      rmRf(baseRoot);
    }
  });
});

function collectHashes(rootDir: string, exclude: string[] = []): Set<string> {
  const out = new Set<string>();
  if (!fs.existsSync(rootDir)) return out;
  const stack: string[] = [rootDir];
  while (stack.length) {
    const cur = stack.pop()!;
    if (exclude.some((e) => cur === e || cur.startsWith(e + path.sep))) continue;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const abs = path.join(cur, e.name);
      if (e.isDirectory()) stack.push(abs);
      else if (e.isFile()) out.add(hashOf(abs));
    }
  }
  return out;
}

function hashOf(absPath: string): string {
  const buf = fs.readFileSync(absPath);
  return createHash('sha256').update(buf).digest('hex');
}
