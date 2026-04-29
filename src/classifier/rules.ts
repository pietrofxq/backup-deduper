import path from 'node:path';
import type { CollectionRow, FileRow } from '../db/queries.js';
import type { Preset } from '../presets/types.js';
import { classifyCruft, reasonStringFor } from './cruft.js';
import { classifyDedup } from './dedup.js';
import { classifyNameCollisions } from './nameCollision.js';

/**
 * A planned action emitted by the classifier — one row per file that should
 * end up in quarantine.
 */
export interface PlannedAction {
  collection: CollectionRow;
  file: FileRow;
  reason: string;
  /** Bytes that will be quarantined (for sanity-guard math). */
  size: number;
}

export interface ReviewPair {
  basename: string;
  a: { collection: CollectionRow; file: FileRow };
  b: { collection: CollectionRow; file: FileRow };
}

export interface EmptyDir {
  collection: CollectionRow;
  relPath: string;
}

export interface ClassifyInput {
  preset: Preset;
  collections: CollectionRow[];
  files: FileRow[];
  emptyDirs: Array<{ collectionId: number; relPath: string }>;
}

export interface ClassifyOutput {
  actions: PlannedAction[];
  reviewPairs: ReviewPair[];
  emptyDirActions: EmptyDir[];
  /** Counts grouped by reason, for the dry-run report. */
  countsByReason: Record<string, { files: number; bytes: number }>;
}

/**
 * Top-level precedence:
 *
 *   1. CRUFT (path-pattern match; STOP on match per file)
 *      - whitelist checked FIRST against rules
 *      - always-on: empty folders, OS metadata
 *      - preset rules in declared order
 *   2. DUPLICATE (group-by sha256; STOP for the entire group)
 *      - within-collection canonical via path priority
 *      - cross-collection primary-wins
 *   3. NAME COLLISION (basename group, cross-collection, hashes differ)
 *      → REVIEW only; never auto-acts
 *   4. KEEP (default)
 *
 * Cruft beats duplicate so the audit reason is the most informative one (a
 * `.exo` file that's also a duplicate is logged as `cruft_preset_exo`).
 */
export function classifyAll(input: ClassifyInput): ClassifyOutput {
  const collectionById = new Map(input.collections.map((c) => [c.id, c]));

  const cruftHits = new Set<string>(); // key: collectionId|relPath
  const actions: PlannedAction[] = [];
  const countsByReason: Record<string, { files: number; bytes: number }> = {};

  function bumpCount(reason: string, bytes: number): void {
    const prev = countsByReason[reason];
    if (prev) {
      prev.files += 1;
      prev.bytes += bytes;
    } else {
      countsByReason[reason] = { files: 1, bytes };
    }
  }

  function key(c: CollectionRow, f: FileRow): string {
    return `${c.id}|${f.rel_path}`;
  }

  // 1. cruft pass
  for (const f of input.files) {
    const c = collectionById.get(f.collection_id);
    if (!c) continue;
    const verdict = classifyCruft(f.rel_path, input.preset);
    if (verdict.kind === 'whitelisted' || verdict.kind === 'none') continue;
    const reason = reasonStringFor(verdict);
    if (!reason) continue;
    actions.push({ collection: c, file: f, reason, size: f.size });
    bumpCount(reason, f.size);
    cruftHits.add(key(c, f));
  }

  // empty-folder cruft is independent of `file` rows.
  const emptyDirActions: EmptyDir[] = input.emptyDirs
    .map((d) => {
      const c = collectionById.get(d.collectionId);
      if (!c) return null;
      bumpCount('cruft_empty_folder', 0);
      return { collection: c, relPath: d.relPath } satisfies EmptyDir;
    })
    .filter((x): x is EmptyDir => x !== null);

  // 2. dedup pass — exclude files already classified as cruft.
  const dedupCandidates = input.files
    .filter((f) => !cruftHits.has(`${f.collection_id}|${f.rel_path}`))
    .map((f) => ({ file: f, collection: collectionById.get(f.collection_id) }))
    .filter((x): x is { file: FileRow; collection: CollectionRow } => !!x.collection);

  const verdicts = classifyDedup(dedupCandidates, input.preset);
  const dedupHits = new Set<string>();
  for (const v of verdicts) {
    for (const loser of v.losers) {
      const c = loser.candidate.collection;
      const f = loser.candidate.file;
      const reason = loser.reason;
      actions.push({ collection: c, file: f, reason, size: f.size });
      bumpCount(reason, f.size);
      dedupHits.add(key(c, f));
    }
  }

  // 3. name-collision review pairs — exclude any already-targeted file.
  const remaining = dedupCandidates.filter(
    (x) => !dedupHits.has(`${x.collection.id}|${x.file.rel_path}`),
  );
  const pairs = classifyNameCollisions(remaining);
  const reviewPairs: ReviewPair[] = pairs.map((p) => ({
    basename: p.basename,
    a: { collection: p.a.collection, file: p.a.file },
    b: { collection: p.b.collection, file: p.b.file },
  }));

  return { actions, reviewPairs, emptyDirActions, countsByReason };
}

export function basenameOf(relPath: string): string {
  return path.posix.basename(relPath);
}
