import { describe, expect, it } from 'vitest';
import { fromDbRelPath, isPathWithin, toDbRelPath } from '../../src/paths/relpath.js';
import { toLongPath } from '../../src/paths/winLong.js';
import path from 'node:path';

describe('toDbRelPath', () => {
  it('converts native sep to forward slash', () => {
    expect(toDbRelPath(['a', 'b', 'c.jpg'].join(path.sep))).toBe('a/b/c.jpg');
  });
  it('strips leading ./', () => {
    expect(toDbRelPath('./a/b')).toBe('a/b');
  });
  it('refuses absolute paths', () => {
    const abs = path.resolve('/x/y');
    expect(() => toDbRelPath(abs)).toThrow();
  });
  it('refuses .. escape', () => {
    expect(() => toDbRelPath('a/../b')).toThrow();
    expect(() => toDbRelPath('../b')).toThrow();
  });
  it('strips trailing slash and collapses double slashes', () => {
    expect(toDbRelPath('a//b/')).toBe('a/b');
  });
});

describe('fromDbRelPath', () => {
  it('round-trips through native sep', () => {
    const orig = ['a', 'b', 'c.jpg'].join(path.sep);
    expect(fromDbRelPath(toDbRelPath(orig))).toBe(orig);
  });
});

describe('isPathWithin', () => {
  it('returns true for child', () => {
    const parent = path.resolve('/var/foo');
    const child = path.resolve('/var/foo/bar/baz');
    expect(isPathWithin(parent, child)).toBe(true);
  });
  it('returns false for sibling', () => {
    const parent = path.resolve('/var/foo');
    const sibling = path.resolve('/var/foox');
    expect(isPathWithin(parent, sibling)).toBe(false);
  });
  it('returns false for self', () => {
    const parent = path.resolve('/var/foo');
    expect(isPathWithin(parent, parent)).toBe(false);
  });
});

describe('toLongPath', () => {
  if (process.platform === 'win32') {
    it('prefixes drive-letter absolute paths with \\\\?\\', () => {
      expect(toLongPath('C:\\foo\\bar')).toBe('\\\\?\\C:\\foo\\bar');
    });
    it('is idempotent', () => {
      expect(toLongPath('\\\\?\\C:\\foo')).toBe('\\\\?\\C:\\foo');
    });
    it('handles UNC paths', () => {
      expect(toLongPath('\\\\srv\\share\\f')).toBe('\\\\?\\UNC\\srv\\share\\f');
    });
    it('passes through relative paths', () => {
      expect(toLongPath('relative\\foo')).toBe('relative\\foo');
    });
  } else {
    it('is a no-op on POSIX', () => {
      expect(toLongPath('/var/foo')).toBe('/var/foo');
      expect(toLongPath('relative/foo')).toBe('relative/foo');
    });
  }
});
