import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export function makeTmpDir(prefix = 'safe-dedupe-'): string {
  const dir = path.join(os.tmpdir(), prefix + randomUUID().slice(0, 8));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function rmRf(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

/** Build a tree from a {relPath: contents} object. Creates parent dirs. */
export function buildTree(root: string, files: Record<string, string | Buffer>): void {
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
}
