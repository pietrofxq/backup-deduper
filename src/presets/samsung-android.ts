import type { Preset } from './types.js';

/**
 * Samsung Android phone backup preset.
 *
 * IMPORTANT: `Android/media/` is explicitly whitelisted because it holds
 * WhatsApp media. The whitelist is checked before every cruft rule.
 */
export const SAMSUNG_ANDROID: Preset = {
  name: 'Samsung Android phone backup',
  description:
    'Smart Switch / Samsung backup output. Sweeps .exo cache, Android/data/, Android/obb/, ' +
    'while preserving Android/media/ (WhatsApp media lives there).',
  cruft_rules: [
    {
      id: 'exo',
      kind: 'extension',
      pattern: '.exo',
      description: 'ExoPlayer download cache',
    },
    {
      id: 'android_data',
      kind: 'path_prefix',
      pattern: 'Android/data/',
      description: 'App-private data folder; rebuilt on restore',
    },
    {
      id: 'android_obb',
      kind: 'path_prefix',
      pattern: 'Android/obb/',
      description: 'Game expansion files; re-downloaded by Play',
    },
  ],
  whitelist: [
    {
      kind: 'path_prefix',
      pattern: 'Android/media/',
      description: 'Holds WhatsApp media — never cruft.',
    },
  ],
  path_priority: [
    'DCIM/Camera/',
    'DCIM/Screenshots/',
    'DCIM/Restored/',
    'DCIM/Shared/',
    'DCIM/Snapchat/',
  ],
};
