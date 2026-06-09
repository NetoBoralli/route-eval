import type { Locator, Page } from '@playwright/test';
import type { Landmark, SelectorHint, SiteProfile } from '../merchants/types.js';
import * as cache from './cache.js';

export function buildLocator(page: Page, hint: SelectorHint): Locator {
  switch (hint.kind) {
    case 'role':
      return hint.name
        ? page.getByRole(hint.role, { name: hint.name })
        : page.getByRole(hint.role);
    case 'testId':
      return page.getByTestId(hint.testId);
    case 'text':
      return hint.tag
        ? page.locator(hint.tag).filter({ hasText: hint.text })
        : page.getByText(hint.text);
    case 'css':
      return page.locator(hint.css);
  }
}

export function describeHint(hint: SelectorHint): string {
  switch (hint.kind) {
    case 'role':
      return `role=${hint.role}${hint.name ? ` name=${hint.name}` : ''}`;
    case 'testId':
      return `testId=${hint.testId}`;
    case 'text':
      return `text=${hint.text}${hint.tag ? ` (in <${hint.tag}>)` : ''}`;
    case 'css':
      return `css=${hint.css}`;
  }
}

export async function locatorIsUsable(loc: Locator, timeoutMs = 3000): Promise<boolean> {
  try {
    const count = await loc.count();
    if (count === 0) return false;
    const first = loc.first();
    if (await first.isVisible({ timeout: timeoutMs })) return true;
    // Lazy-rendered sections sometimes need a scroll to become visible.
    await first.scrollIntoViewIfNeeded({ timeout: 1000 }).catch(() => {});
    return await first.isVisible({ timeout: 500 });
  } catch {
    return false;
  }
}

// Returns a verbose breakdown for diagnostics: how many matched, whether any
// were visible. Used by the LLM healer to give the model a precise failure
// reason on retry.
export async function describeLocator(loc: Locator): Promise<{ count: number; visible: boolean }> {
  try {
    const count = await loc.count();
    if (count === 0) return { count: 0, visible: false };
    const visible = await loc.first().isVisible({ timeout: 1500 });
    return { count, visible };
  } catch {
    return { count: 0, visible: false };
  }
}

export async function resolve(
  page: Page,
  profile: SiteProfile,
  landmark: Landmark,
): Promise<Locator> {
  const cached = cache.get(profile.name, landmark);
  if (cached) return buildLocator(page, cached.hint).first();

  // Tier 1: manual override. Human knows best — final say.
  const override = profile.overrides?.[landmark];
  if (override) {
    const loc = buildLocator(page, override);
    if (await locatorIsUsable(loc)) {
      // eslint-disable-next-line no-console
      console.log(`[resolve] ${profile.name}.${landmark} via override`);
      cache.set(profile.name, { landmark, source: 'override', hint: override });
      return loc.first();
    }
    // eslint-disable-next-line no-console
    console.log(
      `[resolve] ${profile.name}.${landmark} override present but unusable: ${describeHint(override)}`,
    );
  }

  // Tier 2: crawled selector (produced by `npm run crawl`).
  const crawled = profile.crawled?.[landmark];
  if (crawled) {
    const loc = buildLocator(page, crawled);
    if (await locatorIsUsable(loc)) {
      // eslint-disable-next-line no-console
      console.log(`[resolve] ${profile.name}.${landmark} via crawled`);
      cache.set(profile.name, { landmark, source: 'crawled', hint: crawled });
      return loc.first();
    }
    // eslint-disable-next-line no-console
    console.log(
      `[resolve] ${profile.name}.${landmark} crawled hint stale: ${describeHint(crawled)} — re-run \`npm run crawl:${profile.name}\``,
    );
  }

  // Tier 3: heuristic hints from the profile.
  for (const hint of profile.hints[landmark]) {
    const loc = buildLocator(page, hint);
    if (await locatorIsUsable(loc)) {
      cache.set(profile.name, { landmark, source: 'heuristic', hint });
      return loc.first();
    }
  }

  throw new Error(
    `Could not resolve landmark "${landmark}" for merchant "${profile.name}". ` +
      `All sources (override, crawled, heuristics) failed. ` +
      `Re-run \`npm run crawl:${profile.name}\` to let Claude rediscover the DOM, ` +
      `or add a manual entry to \`${profile.name}.overrides.ts\`.`,
  );
}
