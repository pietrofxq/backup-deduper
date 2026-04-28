import path from 'node:path';
import { IS_WINDOWS } from './platform.js';

/**
 * On Windows, prefix an absolute path with `\\?\` to escape MAX_PATH (260) limits.
 * On POSIX, returns the input unchanged.
 *
 * The `\\?\` prefix disables path normalization in Win32 APIs and lifts the limit
 * to ~32k characters. Only meaningful for absolute paths.
 */
export function toLongPath(absPath: string): string {
  if (!IS_WINDOWS) return absPath;
  if (absPath.startsWith('\\\\?\\')) return absPath;
  // UNC paths: \\server\share -> \\?\UNC\server\share
  if (absPath.startsWith('\\\\')) {
    return '\\\\?\\UNC\\' + absPath.slice(2);
  }
  if (path.isAbsolute(absPath)) {
    return '\\\\?\\' + absPath;
  }
  return absPath;
}
