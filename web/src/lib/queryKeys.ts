/**
 * Centralised TanStack Query keys. Co-located with apiClient so mutations
 * in M9+ can `invalidateQueries({ queryKey: keys.config() })` without
 * stringly-typed key drift.
 */
export const keys = {
  health: () => ['health'] as const,
  config: () => ['config'] as const,
  collections: () => ['collections'] as const,
  presets: () => ['presets'] as const,
  scans: () => ['scans'] as const,
  scan: (id: number) => ['scans', id] as const,
  review: (status?: string) => ['review', status ?? 'all'] as const,
  /**
   * Root for invalidating every review-status variant at once. `keys.review()`
   * returns `['review', 'all']` and only invalidates that single variant; this
   * key matches every `['review', ...]` cache entry.
   */
  reviewRoot: () => ['review'] as const,
  quarantine: (runId?: number) => ['quarantine', runId ?? 'all'] as const,
  audit: () => ['audit'] as const,
};
