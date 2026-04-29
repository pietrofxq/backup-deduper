import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { makeTmpDir, rmRf } from '../_helpers/tmp.js';
import { boot } from '../../src/main.js';

describe('boot — smoke', () => {
  let root: string;
  beforeEach(() => {
    root = makeTmpDir('boot-');
  });
  afterEach(() => rmRf(root));

  it('initializes against an empty tmp dir; creates sentinel + DB', async () => {
    const result = await boot({ targetRoot: root, noServe: true });
    expect(result.targetRoot).toBe(path.resolve(root));
    expect(result.uuid.length).toBe(36);
    expect(fs.existsSync(path.join(root, '.dedupe', 'target-id.txt'))).toBe(true);
    expect(fs.existsSync(path.join(root, '.dedupe', 'state.db'))).toBe(true);
    expect(fs.existsSync(path.join(root, '.dedupe-trash'))).toBe(true);
  });

  it('refuses on a wrong-UUID mismatch', async () => {
    await boot({ targetRoot: root, noServe: true });
    fs.writeFileSync(
      path.join(root, '.dedupe', 'target-id.txt'),
      '00000000-0000-4000-8000-000000000000\n',
    );
    await expect(boot({ targetRoot: root, noServe: true })).rejects.toThrow(/mismatch/i);
  });

  it('refuses on missing sentinel after DB exists', async () => {
    await boot({ targetRoot: root, noServe: true });
    fs.unlinkSync(path.join(root, '.dedupe', 'target-id.txt'));
    await expect(boot({ targetRoot: root, noServe: true })).rejects.toThrow(/sentinel.*missing/i);
  });
});
