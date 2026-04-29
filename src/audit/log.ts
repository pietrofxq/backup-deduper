import fs from 'node:fs';
import path from 'node:path';
import { sentinelPaths } from '../target/sentinel.js';

export interface AuditEntry {
  ts: string;
  event: string;
  [k: string]: unknown;
}

export function appendAudit(targetRoot: string, event: string, data: Record<string, unknown>): void {
  const { dedupeDir } = sentinelPaths(targetRoot);
  fs.mkdirSync(dedupeDir, { recursive: true });
  const file = path.join(dedupeDir, 'audit.jsonl');
  const entry: AuditEntry = { ts: new Date().toISOString(), event, ...data };
  fs.appendFileSync(file, JSON.stringify(entry) + '\n');
}

export function readAudit(targetRoot: string): AuditEntry[] {
  const { dedupeDir } = sentinelPaths(targetRoot);
  const file = path.join(dedupeDir, 'audit.jsonl');
  try {
    const raw = fs.readFileSync(file, 'utf8');
    return raw
      .split('\n')
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as AuditEntry);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}
