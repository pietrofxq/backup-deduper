import { clsx, type ClassValue } from 'clsx';

/**
 * Class-name composer — `clsx` re-export with the conventional name. Tailwind
 * conflicts are resolved by ordering (later classes win); we don't use
 * tailwind-merge here to keep the bundle tight.
 */
export function cn(...inputs: ClassValue[]): string {
  return clsx(inputs);
}
