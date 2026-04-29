import { describe, expect, it } from 'vitest';
import { PresetSchema } from '../../src/presets/types.js';
import { SAMSUNG_ANDROID } from '../../src/presets/samsung-android.js';
import { MINIMAL } from '../../src/presets/minimal.js';

describe('presets — round-trip through zod schema', () => {
  it('Samsung preset is valid', () => {
    expect(() => PresetSchema.parse(SAMSUNG_ANDROID)).not.toThrow();
  });
  it('Minimal preset is valid', () => {
    expect(() => PresetSchema.parse(MINIMAL)).not.toThrow();
  });
  it('Samsung whitelist contains Android/media/', () => {
    expect(SAMSUNG_ANDROID.whitelist.some((w) => w.pattern === 'Android/media/')).toBe(true);
  });
  it('Samsung path priority puts DCIM/Camera first', () => {
    expect(SAMSUNG_ANDROID.path_priority[0]).toBe('DCIM/Camera/');
  });
  it('rule ids are id-form (lowercase + underscore)', () => {
    for (const r of SAMSUNG_ANDROID.cruft_rules) {
      expect(r.id).toMatch(/^[a-z0-9_]+$/);
    }
  });
});
