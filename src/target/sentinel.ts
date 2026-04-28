import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { IS_WINDOWS } from '../paths/platform.js';

export const DEDUPE_DIR_NAME = '.dedupe';
export const TRASH_DIR_NAME = '.dedupe-trash';
export const SENTINEL_FILE_NAME = 'target-id.txt';

export interface SentinelPaths {
  targetRoot: string;
  dedupeDir: string;
  sentinelFile: string;
  trashDir: string;
}

export function sentinelPaths(targetRoot: string): SentinelPaths {
  const abs = path.resolve(targetRoot);
  const dedupeDir = path.join(abs, DEDUPE_DIR_NAME);
  return {
    targetRoot: abs,
    dedupeDir,
    sentinelFile: path.join(dedupeDir, SENTINEL_FILE_NAME),
    trashDir: path.join(abs, TRASH_DIR_NAME),
  };
}

/**
 * Read the sentinel UUID from disk, returning null if the file does not exist.
 * Throws on read errors that are NOT ENOENT.
 */
export function readSentinel(targetRoot: string): string | null {
  const { sentinelFile } = sentinelPaths(targetRoot);
  try {
    const raw = fs.readFileSync(sentinelFile, 'utf8').trim();
    if (!isValidUuid(raw)) {
      throw new Error(`Sentinel file ${sentinelFile} contains invalid UUID: ${raw}`);
    }
    return raw;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * Create the sentinel UUID file under <target_root>/.dedupe/target-id.txt.
 * Idempotent if a valid UUID is already present (returns the existing one).
 * Hides the .dedupe folder on Windows via attrib +H (best-effort, errors logged).
 */
export function ensureSentinel(targetRoot: string): { uuid: string; created: boolean } {
  const paths = sentinelPaths(targetRoot);
  const existing = readSentinel(paths.targetRoot);
  if (existing) return { uuid: existing, created: false };

  fs.mkdirSync(paths.dedupeDir, { recursive: true });
  const uuid = randomUUID();
  fs.writeFileSync(paths.sentinelFile, uuid + '\n', { encoding: 'utf8', flag: 'wx' });

  if (IS_WINDOWS) {
    try {
      execFileSync('attrib', ['+H', paths.dedupeDir], { stdio: 'ignore' });
    } catch {
      // Best-effort. If attrib isn't available, the dot-prefix still hides on most tools.
    }
  }
  return { uuid, created: true };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function isValidUuid(s: string): boolean {
  return UUID_RE.test(s);
}
