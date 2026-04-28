import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { makeTmpDir, rmRf } from '../_helpers/tmp.js';
import { ensureSentinel, isValidUuid, readSentinel, sentinelPaths } from '../../src/target/sentinel.js';
import {
  runTargetGuard,
  TargetGuardError,
  type TargetGuardDeps,
} from '../../src/target/guard.js';

describe('sentinel', () => {
  let root: string;
  beforeEach(() => {
    root = makeTmpDir('sentinel-');
  });
  afterEach(() => rmRf(root));

  it('readSentinel returns null when missing', () => {
    expect(readSentinel(root)).toBeNull();
  });

  it('ensureSentinel creates and persists a UUID', () => {
    const a = ensureSentinel(root);
    expect(isValidUuid(a.uuid)).toBe(true);
    expect(a.created).toBe(true);
    const b = ensureSentinel(root);
    expect(b.uuid).toBe(a.uuid);
    expect(b.created).toBe(false);
  });

  it('writes file at <target_root>/.dedupe/target-id.txt', () => {
    const { uuid } = ensureSentinel(root);
    const onDisk = fs.readFileSync(sentinelPaths(root).sentinelFile, 'utf8').trim();
    expect(onDisk).toBe(uuid);
  });

  it('rejects invalid UUID content in the file', () => {
    fs.mkdirSync(path.join(root, '.dedupe'), { recursive: true });
    fs.writeFileSync(path.join(root, '.dedupe', 'target-id.txt'), 'not-a-uuid');
    expect(() => readSentinel(root)).toThrow();
  });
});

describe('runTargetGuard', () => {
  let root: string;
  beforeEach(() => {
    root = makeTmpDir('guard-');
  });
  afterEach(() => rmRf(root));

  function makeMockDeps() {
    let dbUuid: string | null = null;
    let dbRoot: string | null = null;
    let dbPlatform: string | null = null;
    // The shape MUST match TargetGuardDeps exactly — bindDbUuid takes three
    // args in production. Drift here would let a future API change slip
    // through unnoticed.
    const deps: TargetGuardDeps = {
      getDbUuid: () => dbUuid,
      bindDbUuid: (uuid: string, r: string, osPlatform: string) => {
        dbUuid = uuid;
        dbRoot = r;
        dbPlatform = osPlatform;
      },
      updateTargetRoot: (r: string) => {
        dbRoot = r;
      },
    };
    return Object.assign(deps, {
      _peek: () => ({ dbUuid, dbRoot, dbPlatform }),
    });
  }

  it('initializes both sides on first run', () => {
    const deps = makeMockDeps();
    const result = runTargetGuard(root, 'linux', deps, null);
    expect(result.initialized).toBe(true);
    expect(result.remounted).toBe(false);
    expect(deps._peek().dbUuid).toBe(result.uuid);
    expect(deps._peek().dbRoot).toBe(root);
    expect(readSentinel(root)).toBe(result.uuid);
  });

  it('refuses if DB has UUID but sentinel file is missing', () => {
    const deps = makeMockDeps();
    deps.bindDbUuid('00000000-0000-4000-8000-000000000000', root, 'linux');
    expect(() => runTargetGuard(root, 'linux', deps, root)).toThrow(TargetGuardError);
  });

  it('refuses if sentinel exists but DB has no UUID', () => {
    ensureSentinel(root);
    const deps = makeMockDeps(); // empty DB
    expect(() => runTargetGuard(root, 'linux', deps, null)).toThrow(TargetGuardError);
  });

  it('refuses on UUID mismatch', () => {
    const { uuid } = ensureSentinel(root);
    const deps = makeMockDeps();
    deps.bindDbUuid('11111111-1111-4111-8111-111111111111', root, 'linux');
    expect(uuid).not.toBe('11111111-1111-4111-8111-111111111111');
    expect(() => runTargetGuard(root, 'linux', deps, root)).toThrow(TargetGuardError);
  });

  it('detects remount when previous root differs', () => {
    const { uuid } = ensureSentinel(root);
    const deps = makeMockDeps();
    deps.bindDbUuid(uuid, '/previous/path', 'linux');
    const result = runTargetGuard(root, 'linux', deps, '/previous/path');
    expect(result.remounted).toBe(true);
    expect(deps._peek().dbRoot).toBe(root);
  });

  it('happy path on subsequent boot does not flag remount', () => {
    const { uuid } = ensureSentinel(root);
    const deps = makeMockDeps();
    deps.bindDbUuid(uuid, root, 'linux');
    const result = runTargetGuard(root, 'linux', deps, root);
    expect(result.initialized).toBe(false);
    expect(result.remounted).toBe(false);
  });
});
