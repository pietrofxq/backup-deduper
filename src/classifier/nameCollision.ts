import type { CollectionRow, FileRow } from '../db/queries.js';

export interface NameCollisionCandidate {
  file: FileRow;
  collection: CollectionRow;
}

export interface NameCollisionPair {
  basename: string;
  a: NameCollisionCandidate;
  b: NameCollisionCandidate;
}

/**
 * Emit cross-collection basename pairs whose hashes differ. Same-collection
 * collisions are NOT emitted — those are different files in different folders
 * within one collection, which is normal.
 *
 * Pair emission is O(n^2) per basename group but n is typically tiny — phone
 * backups produce a handful of `IMG_0001.jpg` collisions at most.
 */
export function classifyNameCollisions(
  candidates: NameCollisionCandidate[],
): NameCollisionPair[] {
  const byBasename = new Map<string, NameCollisionCandidate[]>();
  for (const c of candidates) {
    const base = basenameOf(c.file.rel_path);
    const arr = byBasename.get(base);
    if (arr) arr.push(c);
    else byBasename.set(base, [c]);
  }

  const out: NameCollisionPair[] = [];
  for (const [basename, group] of byBasename) {
    if (group.length < 2) continue;
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const a = group[i];
        const b = group[j];
        if (!a || !b) continue;
        if (a.collection.id === b.collection.id) continue;
        if (!a.file.sha256_hex || !b.file.sha256_hex) continue;
        if (a.file.sha256_hex === b.file.sha256_hex) continue;
        out.push({ basename, a, b });
      }
    }
  }
  return out;
}

function basenameOf(relPath: string): string {
  const idx = relPath.lastIndexOf('/');
  return idx === -1 ? relPath : relPath.slice(idx + 1);
}
