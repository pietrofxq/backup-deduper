import fs from 'node:fs';
import { toLongPath } from '../paths/winLong.js';

export interface SafeStatResult {
  size: number;
  mtimeMs: number;
  isFile: boolean;
  isDirectory: boolean;
  isSymbolicLink: boolean;
}

/**
 * `fs.lstatSync` wrapper that returns null on ENOENT and rounds mtime to ms.
 * lstat (not stat) — symlinks must not be followed; the walker rejects them
 * explicitly. Throws on unexpected errors.
 */
export function safeStat(absPath: string): SafeStatResult | null {
  try {
    const s = fs.lstatSync(toLongPath(absPath));
    return {
      size: s.size,
      mtimeMs: Math.floor(s.mtimeMs),
      isFile: s.isFile(),
      isDirectory: s.isDirectory(),
      isSymbolicLink: s.isSymbolicLink(),
    };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return null;
    throw err;
  }
}
