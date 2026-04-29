import { describe, expect, it } from 'vitest';
import { parseSqliteDatetime } from '../../src/db/datetime.js';

describe('parseSqliteDatetime', () => {
  it('parses default datetime("now") format as UTC', () => {
    const d = parseSqliteDatetime('2026-01-15 12:34:56');
    expect(d.toISOString()).toBe('2026-01-15T12:34:56.000Z');
  });

  it('parses sub-second variant', () => {
    const d = parseSqliteDatetime('2026-01-15 12:34:56.789');
    expect(d.toISOString()).toBe('2026-01-15T12:34:56.789Z');
  });

  it('passes through ISO without Z (appending Z)', () => {
    const d = parseSqliteDatetime('2026-01-15T12:34:56');
    expect(d.toISOString()).toBe('2026-01-15T12:34:56.000Z');
  });

  it('passes through ISO with Z', () => {
    const d = parseSqliteDatetime('2026-01-15T12:34:56.789Z');
    expect(d.toISOString()).toBe('2026-01-15T12:34:56.789Z');
  });

  it('throws on unrecognized shape', () => {
    expect(() => parseSqliteDatetime('not-a-date')).toThrow(/unrecognized shape/);
    expect(() => parseSqliteDatetime('2026/01/15')).toThrow(/unrecognized shape/);
    expect(() => parseSqliteDatetime('')).toThrow(/unrecognized shape/);
  });

  it('throws on shapes that match the regex but parse to NaN', () => {
    // Out-of-range pieces would normally make Date NaN; covered by the parser.
    expect(() => parseSqliteDatetime('2026-13-15 12:34:56')).toThrow();
  });
});
