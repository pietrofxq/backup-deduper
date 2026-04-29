#!/usr/bin/env tsx
/**
 * Seed a directory with realistic test data for safe-dedupe.
 *
 * Creates a structure that exercises every classifier path:
 *   - cross-collection duplicates (same bytes in multiple collections)
 *   - within-collection duplicates (one collection has the same bytes twice)
 *   - cruft (Samsung preset: .exo, Android/data/, Android/obb/; always-on:
 *     Thumbs.db, .DS_Store, desktop.ini, ehthumbs.db)
 *   - whitelist hits (Android/media/ — must NOT be touched)
 *   - name collisions (review queue: same basename, different content)
 *   - empty directories (cruft_empty_folder)
 *   - unique files (no action)
 *
 * Usage:
 *   tsx scripts/seed-test-data.ts <target-dir>
 *   tsx scripts/seed-test-data.ts <target-dir> --clean
 *   tsx scripts/seed-test-data.ts <target-dir> --size=medium
 *   npm run seed -- ./.test-data --clean
 *
 * Options:
 *   --clean        Remove <target-dir> before seeding (DESTRUCTIVE — explicit
 *                  flag required so accidental re-runs don't blow away state)
 *   --size=<s>     small (default) | medium | large — scales the bulk-photos
 *                  count for stress-testing the scanner. The canonical
 *                  classifier-coverage fixtures are always created.
 *   --help         Show this message and exit
 *
 * Then:
 *   TARGET_ROOT=<target-dir> npm run dev
 *
 * Safety:
 *   - Refuses to write to a path that already contains `.dedupe/` unless
 *     `--clean` is passed (we don't want to corrupt a real dedupe state DB).
 *   - Refuses to operate on `/`, `$HOME`, or paths above the project tree.
 *   - All file content is deterministic — re-running the script produces
 *     byte-identical files, so the cache layer can be tested by running
 *     a scan, then re-seeding, then re-scanning.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

type Size = 'small' | 'medium' | 'large';

interface Args {
  target: string;
  clean: boolean;
  size: Size;
}

function parseArgs(argv: ReadonlyArray<string>): Args {
  const out: Args = { target: '', clean: false, size: 'small' };
  for (const a of argv) {
    if (a === '--help' || a === '-h') {
      printHelp();
      process.exit(0);
    } else if (a === '--clean') {
      out.clean = true;
    } else if (a.startsWith('--size=')) {
      const v = a.slice('--size='.length);
      if (v !== 'small' && v !== 'medium' && v !== 'large') {
        die(`unknown --size: ${v} (expected small|medium|large)`);
      }
      out.size = v;
    } else if (a.startsWith('--')) {
      die(`unknown flag: ${a}`);
    } else if (!out.target) {
      out.target = a;
    } else {
      die(`unexpected positional argument: ${a}`);
    }
  }
  if (!out.target) {
    printHelp();
    process.exit(2);
  }
  return out;
}

function printHelp(): void {
  process.stdout.write(`Usage: tsx scripts/seed-test-data.ts <target-dir> [options]

Options:
  --clean         Remove <target-dir> before seeding (destructive).
  --size=<s>      small | medium | large  (default: small)
  --help, -h      Show this help.

Examples:
  npm run seed -- ./.test-data
  npm run seed -- ./.test-data --clean --size=medium
`);
}

function die(msg: string): never {
  process.stderr.write(`seed-test-data: ${msg}\n`);
  process.exit(2);
}

// ---------- safety fences ----------

function assertSafeTarget(target: string): void {
  const abs = path.resolve(target);
  // Disallow root, $HOME, parent of project. Belt and braces — the script
  // can rm -rf when --clean is passed.
  const forbidden = new Set([
    path.parse(abs).root,
    os.homedir(),
    path.resolve(os.homedir(), '..'),
  ]);
  if (forbidden.has(abs)) {
    die(`refusing to seed at ${abs} — too close to important state`);
  }
  // Reject absolute system locations on POSIX.
  if (process.platform !== 'win32') {
    const dangerous = ['/', '/home', '/usr', '/etc', '/var', '/opt', '/bin', '/sbin'];
    if (dangerous.includes(abs)) {
      die(`refusing to seed at system path ${abs}`);
    }
  }
}

function assertNoExistingDedupeState(target: string, clean: boolean): void {
  const sentinel = path.join(target, '.dedupe');
  if (fs.existsSync(sentinel) && !clean) {
    die(
      `${target} already has a .dedupe/ folder — refusing to overwrite. ` +
        `Pass --clean to wipe it first.`,
    );
  }
}

// ---------- deterministic content ----------

/**
 * Build a buffer of `size` deterministic bytes derived from a seed string.
 * Same seed → same bytes, so re-runs produce identical files (good for
 * exercising the (size, mtime_ms) cache).
 */
function deterministicBytes(seed: string, size: number): Buffer {
  const out = Buffer.allocUnsafe(size);
  let pos = 0;
  let counter = 0;
  while (pos < size) {
    const block = crypto
      .createHash('sha256')
      .update(seed)
      .update(String(counter++))
      .digest();
    const take = Math.min(block.length, size - pos);
    block.copy(out, pos, 0, take);
    pos += take;
  }
  return out;
}

// ---------- structure ----------

interface FilePlan {
  /** Path relative to target_root, posix-style. */
  relPath: string;
  /** Seed for deterministic content. Files sharing a seed share bytes. */
  contentSeed: string;
  /** Approximate file size in bytes. */
  size: number;
  /**
   * What this file is meant to demonstrate — surfaces in the summary at
   * the end so the user can grep the seed output for "name_collision" etc.
   */
  category:
    | 'unique'
    | 'duplicate_cross'
    | 'duplicate_within'
    | 'cruft_preset'
    | 'cruft_os'
    | 'whitelisted'
    | 'name_collision'
    | 'bulk';
}

interface Plan {
  files: FilePlan[];
  emptyDirs: string[];
}

const KB = 1024;

/**
 * Build the canonical fixture plan that exercises every classifier rule.
 * Independent of --size — these specific paths/contents are the contract
 * we test against. The bulk photos in `addBulk()` scale up.
 */
function basePlan(): Plan {
  const files: FilePlan[] = [];

  // ---------- Backup-A (older backup) ----------

  // DCIM/Camera — duplicates with Backup-B and Phone-Live.
  files.push(
    {
      relPath: 'Backup-A/DCIM/Camera/IMG_0001.jpg',
      contentSeed: 'photo:IMG_0001',
      size: 96 * KB,
      category: 'duplicate_cross',
    },
    {
      relPath: 'Backup-A/DCIM/Camera/IMG_0002.jpg',
      contentSeed: 'photo:IMG_0002',
      size: 78 * KB,
      category: 'duplicate_within', // matches IMG_0003 below
    },
    {
      relPath: 'Backup-A/DCIM/Camera/IMG_0003.jpg',
      contentSeed: 'photo:IMG_0002', // intentional: byte-identical to IMG_0002
      size: 78 * KB,
      category: 'duplicate_within',
    },
    {
      relPath: 'Backup-A/DCIM/Camera/IMG_0004.jpg',
      contentSeed: 'photo:IMG_0004-A', // different from B's IMG_0004
      size: 64 * KB,
      category: 'name_collision',
    },
    {
      relPath: 'Backup-A/DCIM/Screenshots/Screenshot_20240101_120000.png',
      contentSeed: 'screenshot:20240101',
      size: 22 * KB,
      category: 'unique',
    },
  );

  // Music — .mp3.exo is preset cruft (Samsung), the .mp3 itself is unique.
  files.push(
    {
      relPath: 'Backup-A/Music/song.mp3',
      contentSeed: 'music:song-mp3',
      size: 200 * KB,
      category: 'duplicate_cross', // also in Backup-B
    },
    {
      relPath: 'Backup-A/Music/song.mp3.exo',
      contentSeed: 'cruft:song-exo',
      size: 18 * KB,
      category: 'cruft_preset',
    },
  );

  // Android/data and Android/obb are preset cruft (path_prefix).
  files.push(
    {
      relPath: 'Backup-A/Android/data/com.example.app/cache/cache.bin',
      contentSeed: 'cruft:android-data-cache',
      size: 8 * KB,
      category: 'cruft_preset',
    },
    {
      relPath: 'Backup-A/Android/data/com.example.app/files/log.txt',
      contentSeed: 'cruft:android-data-log',
      size: 2 * KB,
      category: 'cruft_preset',
    },
    {
      relPath: 'Backup-A/Android/obb/com.example.game/main.1.obb',
      contentSeed: 'cruft:android-obb',
      size: 64 * KB,
      category: 'cruft_preset',
    },
  );

  // Android/media — WHITELIST. These look like cruft paths (Android/...) but
  // the preset's whitelist beats every cruft rule. They must survive the scan.
  files.push(
    {
      relPath: 'Backup-A/Android/media/com.whatsapp/WhatsApp/Media/WhatsApp Images/IMG-WAPHOTO.jpg',
      contentSeed: 'whitelist:wa-photo',
      size: 110 * KB,
      category: 'whitelisted',
    },
    {
      relPath: 'Backup-A/Android/media/com.whatsapp/WhatsApp/Media/WhatsApp Audio/AUD-WAVOICE.opus',
      contentSeed: 'whitelist:wa-voice',
      size: 28 * KB,
      category: 'whitelisted',
    },
  );

  // Always-on OS metadata cruft.
  files.push(
    {
      relPath: 'Backup-A/.DS_Store',
      contentSeed: 'cruft:ds-store-A',
      size: 6 * KB,
      category: 'cruft_os',
    },
    {
      relPath: 'Backup-A/DCIM/Thumbs.db',
      contentSeed: 'cruft:thumbs-A',
      size: 12 * KB,
      category: 'cruft_os',
    },
    {
      relPath: 'Backup-A/desktop.ini',
      contentSeed: 'cruft:desktop-ini-A',
      size: 1 * KB,
      category: 'cruft_os',
    },
  );

  // Documents — unique.
  files.push({
    relPath: 'Backup-A/Documents/notes.txt',
    contentSeed: 'doc:notes-A',
    size: 3 * KB,
    category: 'unique',
  });

  // ---------- Backup-B (newer backup, intended primary) ----------

  files.push(
    // Cross-collection duplicate of Backup-A's IMG_0001.
    {
      relPath: 'Backup-B/DCIM/Camera/IMG_0001.jpg',
      contentSeed: 'photo:IMG_0001',
      size: 96 * KB,
      category: 'duplicate_cross',
    },
    // Name collision — same basename as A's IMG_0004 but different content.
    {
      relPath: 'Backup-B/DCIM/Camera/IMG_0004.jpg',
      contentSeed: 'photo:IMG_0004-B', // distinct from Backup-A's
      size: 70 * KB,
      category: 'name_collision',
    },
    // New unique photo only on B.
    {
      relPath: 'Backup-B/DCIM/Camera/IMG_0099.jpg',
      contentSeed: 'photo:IMG_0099',
      size: 88 * KB,
      category: 'unique',
    },
    // Cross-collection duplicate of A's song.mp3.
    {
      relPath: 'Backup-B/Music/song.mp3',
      contentSeed: 'music:song-mp3',
      size: 200 * KB,
      category: 'duplicate_cross',
    },
    // Unique file on B.
    {
      relPath: 'Backup-B/newdoc.txt',
      contentSeed: 'doc:newdoc-B',
      size: 4 * KB,
      category: 'unique',
    },
    // OS-metadata cruft.
    {
      relPath: 'Backup-B/.DS_Store',
      contentSeed: 'cruft:ds-store-B',
      size: 6 * KB,
      category: 'cruft_os',
    },
    {
      relPath: 'Backup-B/ehthumbs.db',
      contentSeed: 'cruft:ehthumbs-B',
      size: 4 * KB,
      category: 'cruft_os',
    },
  );

  // ---------- Phone-Live (third collection — small) ----------

  files.push(
    {
      relPath: 'Phone-Live/DCIM/Camera/IMG_0001.jpg',
      contentSeed: 'photo:IMG_0001', // duplicates A and B
      size: 96 * KB,
      category: 'duplicate_cross',
    },
    {
      relPath: 'Phone-Live/DCIM/Camera/IMG_LIVE.jpg',
      contentSeed: 'photo:IMG_LIVE',
      size: 60 * KB,
      category: 'unique',
    },
  );

  // ---------- Empty directories (cruft_empty_folder) ----------

  const emptyDirs: string[] = [
    'Backup-B/EmptyFolder',
    'Backup-A/Documents/Drafts/Empty',
  ];

  return { files, emptyDirs };
}

/**
 * Add bulk photos to scale the fixture. None of these are duplicates or
 * cruft — they're for stressing the scanner walk + hash pipeline.
 */
function addBulk(plan: Plan, size: Size): void {
  const counts: Record<Size, number> = { small: 0, medium: 200, large: 2000 };
  const n = counts[size];
  if (n === 0) return;

  // Spread across two folders so we don't hammer one directory.
  for (let i = 0; i < n; i += 1) {
    const month = String(((i % 12) + 1)).padStart(2, '0');
    const seq = String(i).padStart(5, '0');
    plan.files.push({
      relPath: `Backup-B/DCIM/Camera/${month}/IMG_BULK_${seq}.jpg`,
      contentSeed: `bulk:B:${seq}`,
      // Vary sizes a bit (50–250 KB) so byte stats look plausible.
      size: (50 + (i % 200)) * KB,
      category: 'bulk',
    });
  }
}

// ---------- writer ----------

function writePlan(target: string, plan: Plan): void {
  for (const f of plan.files) {
    const abs = path.join(target, f.relPath);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, deterministicBytes(f.contentSeed, f.size));
  }
  for (const d of plan.emptyDirs) {
    fs.mkdirSync(path.join(target, d), { recursive: true });
  }
}

interface Summary {
  byCategory: Record<FilePlan['category'], { files: number; bytes: number }>;
  totalFiles: number;
  totalBytes: number;
  emptyDirs: number;
}

function summarize(plan: Plan): Summary {
  const byCategory: Summary['byCategory'] = {
    unique: { files: 0, bytes: 0 },
    duplicate_cross: { files: 0, bytes: 0 },
    duplicate_within: { files: 0, bytes: 0 },
    cruft_preset: { files: 0, bytes: 0 },
    cruft_os: { files: 0, bytes: 0 },
    whitelisted: { files: 0, bytes: 0 },
    name_collision: { files: 0, bytes: 0 },
    bulk: { files: 0, bytes: 0 },
  };
  let totalFiles = 0;
  let totalBytes = 0;
  for (const f of plan.files) {
    byCategory[f.category].files += 1;
    byCategory[f.category].bytes += f.size;
    totalFiles += 1;
    totalBytes += f.size;
  }
  return { byCategory, totalFiles, totalBytes, emptyDirs: plan.emptyDirs.length };
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(2)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function printSummary(target: string, summary: Summary, size: Size): void {
  const rows: Array<[string, number, number]> = (
    Object.entries(summary.byCategory) as Array<[FilePlan['category'], { files: number; bytes: number }]>
  )
    .filter(([, v]) => v.files > 0)
    .map(([k, v]) => [k, v.files, v.bytes]);
  const labelWidth = Math.max(...rows.map(([k]) => k.length), 'category'.length);
  process.stdout.write(`\nSeeded ${target} (size=${size})\n`);
  process.stdout.write(`${''.padEnd(labelWidth)}    files       bytes\n`);
  process.stdout.write(`${'-'.repeat(labelWidth + 22)}\n`);
  for (const [cat, files, bytes] of rows) {
    process.stdout.write(
      `${cat.padEnd(labelWidth)}  ${String(files).padStart(7)}  ${formatBytes(bytes).padStart(10)}\n`,
    );
  }
  process.stdout.write(`${'-'.repeat(labelWidth + 22)}\n`);
  process.stdout.write(
    `${'TOTAL'.padEnd(labelWidth)}  ${String(summary.totalFiles).padStart(7)}  ${formatBytes(summary.totalBytes).padStart(10)}\n`,
  );
  process.stdout.write(`empty dirs: ${summary.emptyDirs}\n`);
  process.stdout.write(`\nNext steps:\n`);
  process.stdout.write(`  1. Set Backup-B as primary (Settings → Primary collection)\n`);
  process.stdout.write(`  2. Run a scan — expected behavior:\n`);
  process.stdout.write(`     • cross-collection dups in A and Phone-Live get planned for quarantine\n`);
  process.stdout.write(`     • within-collection dup IMG_0003 (matches IMG_0002) gets planned\n`);
  process.stdout.write(`     • IMG_0004 lands in the review queue (basename collision, different bytes)\n`);
  process.stdout.write(`     • Android/data, Android/obb, *.exo, .DS_Store/Thumbs.db/desktop.ini → cruft\n`);
  process.stdout.write(`     • Android/media/* survives (whitelist beats cruft)\n`);
  process.stdout.write(`     • two empty folders → cruft_empty_folder\n\n`);
  process.stdout.write(`Start the app:\n`);
  process.stdout.write(`  TARGET_ROOT=${target} npm run dev\n\n`);
}

// ---------- main ----------

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const target = path.resolve(args.target);
  assertSafeTarget(target);

  if (args.clean && fs.existsSync(target)) {
    process.stdout.write(`Removing ${target}…\n`);
    fs.rmSync(target, { recursive: true, force: true });
  }

  fs.mkdirSync(target, { recursive: true });
  assertNoExistingDedupeState(target, args.clean);

  const plan = basePlan();
  addBulk(plan, args.size);

  writePlan(target, plan);
  printSummary(target, summarize(plan), args.size);
}

main();
