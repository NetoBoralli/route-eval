import type { Page } from '@playwright/test';

export const LANDMARKS = [
  'addToCart',
  'cartLink',
  'cartSubtotal',
  'cartTotal',
  'routeToggle',
  'routePrice',
] as const;

export type Landmark = (typeof LANDMARKS)[number];

export type SelectorHint =
  | { kind: 'role'; role: 'button' | 'link' | 'checkbox' | 'switch'; name?: string | RegExp }
  | { kind: 'testId'; testId: string }
  | { kind: 'text'; text: string | RegExp; tag?: string }
  | { kind: 'css'; css: string }
  // Re-runs the per-landmark label heuristic at resolve time. Used when no
  // stable CSS selector exists (the target has no id/data-testid/unique
  // class) so a synthesized structural path would be brittle. Trades ~10ms
  // per resolve for robustness against DOM reshuffling.
  | { kind: 'labelMatch'; landmark: Landmark };

export type ProductEntry =
  | { type: 'directUrl'; url: string }
  | { type: 'navigate'; run: (page: Page) => Promise<void> };

export type SiteProfile = {
  name: string;
  baseUrl: string;
  // Optional direct URL to the cart page. When set, the flow navigates here
  // instead of clicking the cart link — sidesteps mini-cart slide-out overlays
  // and other click-intercept races. The cartLink landmark is still discovered
  // and asserted to exist.
  cartUrl?: string;
  productEntry: ProductEntry;
  hints: Record<Landmark, SelectorHint[]>;
  popupHints?: SelectorHint[];
  // Crawled selectors are loaded from `<name>.crawled.json` by the registry.
  // Produced by `npm run crawl` — Claude inspects the live DOM and persists
  // a CSS selector per landmark. Not hand-edited.
  crawled?: Partial<Record<Landmark, SelectorHint>>;
  // Manual selectors authored by humans. Final say, trumps everything.
  overrides?: Partial<Record<Landmark, SelectorHint>>;
};
