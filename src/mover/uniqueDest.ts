import fs from 'node:fs';
import path from 'node:path';

/**
 * If `absPath` is already free, return it. Otherwise append " (1)", " (2)", …
 * before the extension and return the first free slot.
 *
 * IMPORTANT: callers should still treat this as advisory and re-check after a
 * potentially racy interval.
 */
export function uniqueDest(absPath: string): string {
  if (!exists(absPath)) return absPath;
  const dir = path.dirname(absPath);
  const ext = path.extname(absPath);
  const base = path.basename(absPath, ext);
  for (let i = 1; i < 10_000; i++) {
    const candidate = path.join(dir, `${base} (${i})${ext}`);
    if (!exists(candidate)) return candidate;
  }
  throw new Error(`uniqueDest: could not find a free slot for ${absPath}`);
}

function exists(p: string): boolean {
  try {
    fs.lstatSync(p);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
}
