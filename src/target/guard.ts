import { ensureSentinel, readSentinel } from './sentinel.js';

export class TargetGuardError extends Error {
  constructor(
    message: string,
    public readonly kind:
      | 'sentinel_missing'
      | 'db_uuid_missing'
      | 'uuid_mismatch'
      | 'target_root_missing',
  ) {
    super(message);
    this.name = 'TargetGuardError';
  }
}

export interface TargetGuardDeps {
  /** Returns the bound UUID stored in the DB, or null if none yet. */
  getDbUuid(): string | null;
  /** Persist a freshly-generated UUID and the absolute target_root. */
  bindDbUuid(uuid: string, targetRootAbs: string, osPlatform: string): void;
  /** Update the last-seen target_root_abs in the DB; UUID stays the same. */
  updateTargetRoot(targetRootAbs: string): void;
}

export interface TargetGuardResult {
  uuid: string;
  /** True if the DB / sentinel was just initialized on this start. */
  initialized: boolean;
  /** True if the target_root_abs has changed from the previously-recorded one. */
  remounted: boolean;
}

/**
 * The startup gate. Either:
 *   - Both DB and sentinel are absent → initialize both (first run).
 *   - Both present and matching → OK; update target_root_abs if it has changed.
 *   - Anything else → refuse with a TargetGuardError.
 *
 * `previousTargetRoot` is the last-seen absolute path the DB has recorded.
 */
export function runTargetGuard(
  targetRootAbs: string,
  osPlatform: string,
  deps: TargetGuardDeps,
  previousTargetRoot: string | null,
): TargetGuardResult {
  const sentinelUuid = readSentinel(targetRootAbs);
  const dbUuid = deps.getDbUuid();

  if (sentinelUuid === null && dbUuid === null) {
    const { uuid } = ensureSentinel(targetRootAbs);
    deps.bindDbUuid(uuid, targetRootAbs, osPlatform);
    return { uuid, initialized: true, remounted: false };
  }

  if (sentinelUuid === null) {
    throw new TargetGuardError(
      `DB is bound to UUID ${dbUuid} but sentinel file is missing at <target_root>/.dedupe/target-id.txt. ` +
        `Refusing to run — the target may have been replaced or the .dedupe folder deleted.`,
      'sentinel_missing',
    );
  }

  if (dbUuid === null) {
    throw new TargetGuardError(
      `Sentinel UUID ${sentinelUuid} exists on disk but DB has no bound UUID. ` +
        `This shouldn't happen; refusing to run — the DB may be from a different target.`,
      'db_uuid_missing',
    );
  }

  if (sentinelUuid !== dbUuid) {
    throw new TargetGuardError(
      `Target identity mismatch. Sentinel UUID = ${sentinelUuid} (from <target_root>/.dedupe/target-id.txt), ` +
        `DB UUID = ${dbUuid}. Refusing to run.`,
      'uuid_mismatch',
    );
  }

  const remounted = previousTargetRoot !== null && previousTargetRoot !== targetRootAbs;
  if (remounted || previousTargetRoot === null) {
    deps.updateTargetRoot(targetRootAbs);
  }
  return { uuid: dbUuid, initialized: false, remounted };
}
