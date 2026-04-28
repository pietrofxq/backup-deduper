import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { detectPlatform } from './paths/platform.js';
import { sentinelPaths } from './target/sentinel.js';
import { runTargetGuard } from './target/guard.js';
import { migrate, openDb } from './db/index.js';
import { getTarget, setTarget, updateTargetRoot } from './db/queries.js';
import { seedBuiltinPresets } from './presets/index.js';
import { loadConfig } from './config/loader.js';
import { reconcilePending } from './mover/reconcile.js';
import { startServer } from './server/index.js';
import { appendAudit } from './audit/log.js';

export interface BootResult {
  targetRoot: string;
  uuid: string;
  port: number;
}

export interface BootOptions {
  targetRoot: string;
  port?: number;
  /** When true, server is not started (useful for tests / CLI commands). */
  noServe?: boolean;
}

export async function boot(opts: BootOptions): Promise<BootResult> {
  const targetRoot = path.resolve(opts.targetRoot);
  if (!fs.existsSync(targetRoot)) {
    throw new Error(`target_root does not exist: ${targetRoot}`);
  }
  const stat = fs.statSync(targetRoot);
  if (!stat.isDirectory()) {
    throw new Error(`target_root is not a directory: ${targetRoot}`);
  }

  const osPlatform = detectPlatform();
  const { dedupeDir, trashDir } = sentinelPaths(targetRoot);
  fs.mkdirSync(dedupeDir, { recursive: true });
  fs.mkdirSync(trashDir, { recursive: true });

  const db = openDb(targetRoot);
  migrate(db);
  seedBuiltinPresets(db);

  const dbTarget = getTarget(db);
  const guardResult = runTargetGuard(
    targetRoot,
    osPlatform,
    {
      getDbUuid: () => dbTarget?.target_id_uuid ?? null,
      bindDbUuid: (uuid, root, plat) => setTarget(db, uuid, root, plat),
      updateTargetRoot: (root) => updateTargetRoot(db, root),
    },
    dbTarget?.target_root_abs ?? null,
  );

  appendAudit(targetRoot, 'boot', {
    uuid: guardResult.uuid,
    initialized: guardResult.initialized,
    remounted: guardResult.remounted,
    targetRoot,
    osPlatform,
  });

  // Reconcile any actions left in mid-flight from a previous crash.
  reconcilePending(db, targetRoot);

  // Touch loaded config to materialize defaults.
  loadConfig(db);

  if (opts.noServe) {
    // Important: in noServe mode the caller (typically a test) does not get
    // the DB handle, so close it here. Holding it open leaks an fd and on
    // Windows blocks subsequent test runs from removing the .dedupe folder.
    db.client.close();
    return { targetRoot, uuid: guardResult.uuid, port: 0 };
  }
  const port = opts.port ?? Number(process.env.PORT ?? 7777);
  const server = await startServer({ db, targetRoot, port });
  return { targetRoot, uuid: guardResult.uuid, port: server.port };
}

// CLI entrypoint
const isMain = (() => {
  if (typeof process.argv[1] !== 'string') return false;
  // Compare resolved real paths to detect direct invocation reliably.
  // Use fileURLToPath, not URL.pathname — on Windows the latter returns
  // `/C:/...` (with leading slash and URL-encoding), which makes
  // realpathSync throw or return a non-comparable string.
  try {
    const argvPath = fs.realpathSync(process.argv[1]);
    const here = fs.realpathSync(fileURLToPath(import.meta.url));
    return argvPath === here;
  } catch {
    return false;
  }
})();

if (isMain) {
  const targetRoot = process.env.TARGET_ROOT ?? process.argv[2];
  if (!targetRoot) {
    console.error('Usage: TARGET_ROOT=<path> npm start  (or: node dist/main.js <path>)');
    process.exit(2);
  }
  boot({ targetRoot }).catch((err) => {
    console.error(`Fatal: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
