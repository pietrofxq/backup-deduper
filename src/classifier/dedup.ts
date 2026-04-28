import type { FileRow, CollectionRow } from '../db/queries.js';
import type { Preset } from '../presets/types.js';

export interface DedupCandidate {
  file: FileRow;
  collection: CollectionRow;
}

export interface DedupVerdict {
  /** The chosen keeper for this hash group. */
  keeper: DedupCandidate;
  /** Files to quarantine + reason. */
  losers: Array<{ candidate: DedupCandidate; reason: 'duplicate_within_collection' | 'duplicate_cross_collection' }>;
}

/**
 * Group files by sha256, then for each group:
 *   1. Within each collection, pick the canonical via path priority. Non-keepers
 *      → duplicate_within_collection.
 *   2. Across collections, primary's representative wins. Others → duplicate_cross_collection.
 *      If primary has no representative, lex-first collection wins (deterministic).
 */
export function classifyDedup(
  candidates: DedupCandidate[],
  preset: Preset,
): DedupVerdict[] {
  const byHash = new Map<string, DedupCandidate[]>();
  for (const c of candidates) {
    const h = c.file.sha256_hex;
    if (!h) continue; // unhashed files are not deduped
    const arr = byHash.get(h);
    if (arr) arr.push(c);
    else byHash.set(h, [c]);
  }

  const verdicts: DedupVerdict[] = [];
  for (const group of byHash.values()) {
    if (group.length < 2) continue;

    // Step 1: within-collection canonical pick.
    const byCollection = new Map<number, DedupCandidate[]>();
    for (const c of group) {
      const arr = byCollection.get(c.collection.id);
      if (arr) arr.push(c);
      else byCollection.set(c.collection.id, [c]);
    }
    const losersInternal: Array<{
      candidate: DedupCandidate;
      reason: 'duplicate_within_collection';
    }> = [];
    const collectionKeepers: DedupCandidate[] = [];
    for (const [, cands] of byCollection) {
      const sorted = [...cands].sort((a, b) => comparePathPriority(a.file.rel_path, b.file.rel_path, preset));
      const keeper = sorted[0];
      if (!keeper) continue;
      collectionKeepers.push(keeper);
      for (let i = 1; i < sorted.length; i++) {
        const c = sorted[i];
        if (c) losersInternal.push({ candidate: c, reason: 'duplicate_within_collection' });
      }
    }

    if (collectionKeepers.length === 1) {
      const only = collectionKeepers[0];
      if (only) verdicts.push({ keeper: only, losers: losersInternal });
      continue;
    }

    // Step 2: cross-collection primary-wins, then lex tiebreak.
    const primary = collectionKeepers.find((k) => k.collection.is_primary === 1);
    let chosen: DedupCandidate | undefined = primary;
    if (!chosen) {
      chosen = [...collectionKeepers].sort((a, b) =>
        a.collection.rel_path.localeCompare(b.collection.rel_path),
      )[0];
    }
    if (!chosen) continue;

    const crossLosers: Array<{
      candidate: DedupCandidate;
      reason: 'duplicate_cross_collection';
    }> = collectionKeepers
      .filter((k) => k !== chosen)
      .map((k) => ({ candidate: k, reason: 'duplicate_cross_collection' }));

    verdicts.push({ keeper: chosen, losers: [...losersInternal, ...crossLosers] });
  }

  return verdicts;
}

/**
 * Compare two rel-paths using the preset's path_priority list.
 *
 * A rel-path matches a priority entry iff it begins with that entry. The lower
 * the matched index, the higher the priority. Files matching nothing rank last
 * and are then broken by lex order so the result is deterministic.
 */
export function comparePathPriority(a: string, b: string, preset: Preset): number {
  const ra = priorityRank(a, preset.path_priority);
  const rb = priorityRank(b, preset.path_priority);
  if (ra !== rb) return ra - rb;
  return a.localeCompare(b);
}

function priorityRank(relPath: string, priority: ReadonlyArray<string>): number {
  for (let i = 0; i < priority.length; i++) {
    const p = priority[i];
    if (p === undefined) continue;
    if (relPath.startsWith(p)) return i;
  }
  return priority.length; // unmatched → last bucket
}
