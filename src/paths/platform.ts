import { platform as nodePlatform } from 'node:os';

export type OsPlatform = 'win32' | 'linux' | 'darwin';

export function detectPlatform(): OsPlatform {
  const p = nodePlatform();
  if (p === 'win32' || p === 'linux' || p === 'darwin') return p;
  throw new Error(`Unsupported platform: ${p}`);
}

export const IS_WINDOWS = nodePlatform() === 'win32';
