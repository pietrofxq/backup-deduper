import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export function makeTmpDir(prefix = 'safe-dedupe-'): string {
  const dir = path.join(os.tmpdir(), prefix + randomUUID().slice(0, 8));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Remove a directory tree.
 *
 * On Windows, an EBUSY/EPERM/ENOTEMPTY can occur in a small window after
 * better-sqlite3 closes a connection: the kernel may briefly hold the
 * `state.db` / `state.db-wal` file before the unlink can succeed. Retry a
 * handful of times with short backoffs so a clean test that closed all DB
 * handles before this call still wins the race. POSIX returns immediately
 * on the first try.
 */
export function rmRf(dir: string): void {
  const isWindows = process.platform === 'win32';
  const maxAttempts = isWindows ? 10 : 1;
  const backoffMs = 50;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      const transient = code === 'EBUSY' || code === 'EPERM' || code === 'ENOTEMPTY';
      if (!transient || attempt === maxAttempts - 1) {
        if (isWindows) {
          // Last-resort: leak the dir rather than fail the suite. Windows test
          // runners clean %TEMP% between runs anyway.
          // eslint-disable-next-line no-console
          console.warn(`rmRf: giving up on ${dir} (${code}) after ${maxAttempts} attempts`);
          return;
        }
        throw err;
      }
      sleepSync(backoffMs * (attempt + 1));
    }
  }
}

/**
 * Sync sleep without burning CPU. Atomics.wait blocks the calling thread on
 * a SharedArrayBuffer for up to `ms` milliseconds. Used by rmRf's Windows
 * retry loop to wait for the kernel to release a freshly-closed file
 * handle.
 */
function sleepSync(ms: number): void {
  const buf = new SharedArrayBuffer(4);
  const view = new Int32Array(buf);
  Atomics.wait(view, 0, 0, ms);
}

/** Build a tree from a {relPath: contents} object. Creates parent dirs. */
export function buildTree(root: string, files: Record<string, string | Buffer>): void {
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
}
