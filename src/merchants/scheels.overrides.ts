import type { Landmark, SelectorHint } from './types.js';

// Hand-curated fallback selectors for Scheels. The resolver consults this map
// only when both heuristic hints (Tier 1) and LLM healing (Tier 2) fail —
// typically when the page blocks scraping or the LLM is unavailable.
//
// Populate from heal-and-promote log lines in the Playwright report after
// confirming the selector works on a real run.
export const scheelsOverrides: Partial<Record<Landmark, SelectorHint>> = {
  // addToCart: { kind: 'css', css: '...' },
  // cartLink: { kind: 'css', css: '...' },
  // cartSubtotal: { kind: 'css', css: '...' },
  // cartTotal: { kind: 'css', css: '...' },
  // routeToggle: { kind: 'css', css: '...' },
  // routePrice: { kind: 'css', css: '...' },
};
