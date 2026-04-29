import path from 'node:path';

/**
 * Convert any OS-native path into a forward-slash relative path for storage in the DB.
 * Strips a leading `./`, refuses absolute paths, refuses paths that escape via `..`.
 */
export function toDbRelPath(rawRel: string): string {
  if (rawRel === '') return '';
  if (path.isAbsolute(rawRel)) {
    throw new Error(`Expected relative path, got absolute: ${rawRel}`);
  }
  const normalized = rawRel.split(path.sep).join('/').replace(/\/+/g, '/');
  const trimmed = normalized.startsWith('./') ? normalized.slice(2) : normalized;
  if (trimmed.split('/').includes('..')) {
    throw new Error(`Relative path escapes its root: ${rawRel}`);
  }
  return trimmed.replace(/\/$/, '');
}

/** Convert a forward-slash DB rel-path back to the OS-native form. */
export function fromDbRelPath(dbRel: string): string {
  if (dbRel === '') return '';
  return dbRel.split('/').join(path.sep);
}

/**
 * Returns true if `child` is contained within `parent` (both absolute, normalized).
 * Used as a sanity guard before any rename to prevent accidental writes outside target_root.
 */
export function isPathWithin(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}
