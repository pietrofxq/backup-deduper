import { describe, expect, it } from 'vitest';
import { classifyCruft } from '../../src/classifier/cruft.js';
import { comparePathPriority } from '../../src/classifier/dedup.js';
import { classifyAll, type PlannedAction, type ReviewPair } from '../../src/classifier/rules.js';
import { SAMSUNG_ANDROID } from '../../src/presets/samsung-android.js';
import { MINIMAL } from '../../src/presets/minimal.js';
import type { CollectionRow, FileRow } from '../../src/db/queries.js';

const COL_A: CollectionRow = { id: 1, rel_path: 'Backup-A', is_primary: 0, created_at: 'x' };
const COL_B: CollectionRow = { id: 2, rel_path: 'Backup-B', is_primary: 1, created_at: 'x' };
const COL_C: CollectionRow = { id: 3, rel_path: 'Backup-C', is_primary: 0, created_at: 'x' };

function f(
  collection_id: number,
  rel_path: string,
  sha256: string | null,
  size = 100,
): FileRow {
  return {
    id: rel_path.length + collection_id,
    collection_id,
    rel_path,
    size,
    mtime_ms: 0,
    sha256_hex: sha256,
    last_seen_run: 1,
  };
}

describe('classifyCruft (Samsung preset)', () => {
  it('classifies *.exo as preset cruft', () => {
    // .exo rule is listed first in the preset, so it matches before android_data prefix.
    expect(classifyCruft('Android/data/cache.exo', SAMSUNG_ANDROID)).toEqual({
      kind: 'preset_match',
      ruleId: 'exo',
    });
    expect(classifyCruft('DCIM/Camera/cache.exo', SAMSUNG_ANDROID)).toEqual({
      kind: 'preset_match',
      ruleId: 'exo',
    });
  });
  it('classifies Android/data/ as preset cruft', () => {
    expect(classifyCruft('Android/data/foo/bar.txt', SAMSUNG_ANDROID)).toEqual({
      kind: 'preset_match',
      ruleId: 'android_data',
    });
  });
  it('classifies Android/obb/ as preset cruft', () => {
    expect(classifyCruft('Android/obb/com.foo/something.obb', SAMSUNG_ANDROID)).toEqual({
      kind: 'preset_match',
      ruleId: 'android_obb',
    });
  });
  it('whitelist beats every cruft rule for Android/media/', () => {
    expect(classifyCruft('Android/media/com.whatsapp/img.jpg', SAMSUNG_ANDROID)).toEqual({
      kind: 'whitelisted',
    });
  });
  it('classifies always-on OS metadata regardless of preset', () => {
    expect(classifyCruft('DCIM/Thumbs.db', SAMSUNG_ANDROID)).toEqual({ kind: 'os_metadata' });
    expect(classifyCruft('DCIM/.DS_Store', SAMSUNG_ANDROID)).toEqual({ kind: 'os_metadata' });
    expect(classifyCruft('foo/desktop.ini', MINIMAL)).toEqual({ kind: 'os_metadata' });
  });
  it('classifies normal photos as none', () => {
    expect(classifyCruft('DCIM/Camera/IMG_001.jpg', SAMSUNG_ANDROID)).toEqual({ kind: 'none' });
  });
});

describe('comparePathPriority (Samsung preset)', () => {
  it('Camera beats Download', () => {
    expect(
      comparePathPriority('DCIM/Camera/x.jpg', 'Download/x.jpg', SAMSUNG_ANDROID),
    ).toBeLessThan(0);
  });
  it('Camera beats DCIM/Snapchat', () => {
    expect(
      comparePathPriority('DCIM/Camera/x.jpg', 'DCIM/Snapchat/x.jpg', SAMSUNG_ANDROID),
    ).toBeLessThan(0);
  });
  it('falls back to lex when neither matches', () => {
    expect(comparePathPriority('Other/a.jpg', 'Other/b.jpg', SAMSUNG_ANDROID)).toBeLessThan(0);
  });
});

describe('classifyAll', () => {
  it('cruft beats duplicate (most informative reason)', () => {
    const files = [
      f(1, 'Android/data/x.bin', 'h1', 10),
      f(2, 'Backups/x.bin', 'h1', 10),
    ];
    const out = classifyAll({
      preset: SAMSUNG_ANDROID,
      collections: [COL_A, COL_B],
      files,
      emptyDirs: [],
    });
    const reasons = out.actions.map((a) => `${a.collection.rel_path}|${a.reason}`);
    expect(reasons).toContain('Backup-A|cruft_preset_android_data');
    expect(reasons).not.toContain('Backup-A|duplicate_cross_collection');
  });

  it('cross-collection dedup keeps primary copy', () => {
    const files = [
      f(1, 'DCIM/Camera/IMG_1.jpg', 'h1'),
      f(2, 'DCIM/Camera/IMG_1.jpg', 'h1'),
    ];
    const out = classifyAll({
      preset: SAMSUNG_ANDROID,
      collections: [COL_A, COL_B],
      files,
      emptyDirs: [],
    });
    expect(out.actions).toHaveLength(1);
    const a = out.actions[0] as PlannedAction;
    expect(a.collection.rel_path).toBe('Backup-A'); // non-primary
    expect(a.reason).toBe('duplicate_cross_collection');
  });

  it('within-collection dedup uses path priority', () => {
    const files = [
      f(2, 'Download/x.jpg', 'h1'),
      f(2, 'DCIM/Camera/x.jpg', 'h1'),
    ];
    const out = classifyAll({
      preset: SAMSUNG_ANDROID,
      collections: [COL_B],
      files,
      emptyDirs: [],
    });
    expect(out.actions).toHaveLength(1);
    const a = out.actions[0] as PlannedAction;
    expect(a.file.rel_path).toBe('Download/x.jpg');
    expect(a.reason).toBe('duplicate_within_collection');
  });

  it('lex tiebreak when no primary present', () => {
    const noPrimaryB: CollectionRow = { ...COL_B, is_primary: 0 };
    const files = [
      f(1, 'DCIM/Camera/x.jpg', 'h1'),
      f(2, 'DCIM/Camera/x.jpg', 'h1'),
    ];
    const out = classifyAll({
      preset: SAMSUNG_ANDROID,
      collections: [COL_A, noPrimaryB],
      files,
      emptyDirs: [],
    });
    expect(out.actions).toHaveLength(1);
    const a = out.actions[0] as PlannedAction;
    expect(a.collection.rel_path).toBe('Backup-B');
  });

  it('emits review pair for cross-collection name collision (different bytes)', () => {
    const files = [
      f(1, 'DCIM/Camera/IMG.jpg', 'h1'),
      f(2, 'DCIM/Camera/IMG.jpg', 'h2'),
    ];
    const out = classifyAll({
      preset: SAMSUNG_ANDROID,
      collections: [COL_A, COL_B],
      files,
      emptyDirs: [],
    });
    expect(out.actions).toHaveLength(0);
    expect(out.reviewPairs).toHaveLength(1);
    const p = out.reviewPairs[0] as ReviewPair;
    expect(p.basename).toBe('IMG.jpg');
  });

  it('does NOT emit review pair when same basename + same bytes (it is a normal duplicate)', () => {
    const files = [
      f(1, 'DCIM/Camera/IMG.jpg', 'h1'),
      f(2, 'DCIM/Camera/IMG.jpg', 'h1'),
    ];
    const out = classifyAll({
      preset: SAMSUNG_ANDROID,
      collections: [COL_A, COL_B],
      files,
      emptyDirs: [],
    });
    expect(out.reviewPairs).toHaveLength(0);
    expect(out.actions).toHaveLength(1);
    expect(out.actions[0]?.reason).toBe('duplicate_cross_collection');
  });

  it('does NOT emit review pair for within-collection basename collision', () => {
    const files = [
      f(1, 'DCIM/Camera/IMG.jpg', 'h1'),
      f(1, 'Other/IMG.jpg', 'h2'),
    ];
    const out = classifyAll({
      preset: SAMSUNG_ANDROID,
      collections: [COL_A],
      files,
      emptyDirs: [],
    });
    expect(out.reviewPairs).toHaveLength(0);
  });

  it('Android/media/ survives as a duplicate of Android/data/', () => {
    const files = [
      f(1, 'Android/data/photo.jpg', 'h1'),
      f(1, 'Android/media/photo.jpg', 'h1'),
    ];
    const out = classifyAll({
      preset: SAMSUNG_ANDROID,
      collections: [COL_A],
      files,
      emptyDirs: [],
    });
    // Android/data path is cruft → quarantined under cruft reason.
    // Android/media is whitelisted → never touched. So no within-collection dedup happens.
    const reasons = out.actions.map((a) => `${a.file.rel_path}|${a.reason}`);
    expect(reasons).toEqual(['Android/data/photo.jpg|cruft_preset_android_data']);
  });

  it('counts by reason', () => {
    const files = [
      f(1, 'a.exo', null, 5),
      f(1, 'b.exo', null, 7),
      f(1, 'c.jpg', 'h1', 100),
      f(2, 'c.jpg', 'h1', 100),
    ];
    const out = classifyAll({
      preset: SAMSUNG_ANDROID,
      collections: [COL_A, COL_B],
      files,
      emptyDirs: [],
    });
    expect(out.countsByReason['cruft_preset_exo']).toEqual({ files: 2, bytes: 12 });
    expect(out.countsByReason['duplicate_cross_collection']).toEqual({ files: 1, bytes: 100 });
  });

  it('three-collection dedup keeps primary, others lose', () => {
    const files = [
      f(1, 'DCIM/Camera/x.jpg', 'h1'),
      f(2, 'DCIM/Camera/x.jpg', 'h1'),
      f(3, 'DCIM/Camera/x.jpg', 'h1'),
    ];
    const out = classifyAll({
      preset: SAMSUNG_ANDROID,
      collections: [COL_A, COL_B, COL_C],
      files,
      emptyDirs: [],
    });
    const reasons = out.actions.map((a) => `${a.collection.rel_path}|${a.reason}`);
    expect(reasons.sort()).toEqual([
      'Backup-A|duplicate_cross_collection',
      'Backup-C|duplicate_cross_collection',
    ]);
  });
});
