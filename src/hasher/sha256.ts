import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { toLongPath } from '../paths/winLong.js';

const HIGH_WATER_MARK = 1024 * 1024; // 1 MB

/**
 * Streaming SHA-256 over an absolute path. Used in the worker AND in the
 * mover's "re-verify under fresh hash before quarantine" step (called from
 * the main thread for that, since it's one file at a time).
 */
export function hashFileSync(absPath: string): string {
  const fd = fs.openSync(toLongPath(absPath), 'r');
  try {
    const hash = createHash('sha256');
    const buf = Buffer.alloc(HIGH_WATER_MARK);
    let bytesRead: number;
    while ((bytesRead = fs.readSync(fd, buf, 0, buf.length, null)) > 0) {
      hash.update(buf.subarray(0, bytesRead));
    }
    return hash.digest('hex');
  } finally {
    fs.closeSync(fd);
  }
}

export async function hashFile(absPath: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = fs.createReadStream(toLongPath(absPath), { highWaterMark: HIGH_WATER_MARK });
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', (err) => reject(err));
  });
}
