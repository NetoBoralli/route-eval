import type { Landmark, SelectorHint } from '../merchants/types.js';

export type CachedSource = 'override' | 'crawled' | 'heuristic';

export type CachedSelector = {
  landmark: Landmark;
  source: CachedSource;
  hint: SelectorHint;
};

// Per-run cache. Each Playwright worker gets its own module instance, so this
// is naturally scoped to the test run.
const cache = new Map<string, CachedSelector>();

function key(merchant: string, landmark: Landmark): string {
  return `${merchant}::${landmark}`;
}

export function get(merchant: string, landmark: Landmark): CachedSelector | undefined {
  return cache.get(key(merchant, landmark));
}

export function set(merchant: string, entry: CachedSelector): void {
  cache.set(key(merchant, entry.landmark), entry);
}

export function clear(): void {
  cache.clear();
}
