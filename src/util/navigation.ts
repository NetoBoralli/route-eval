import type { Page } from '@playwright/test';
import type { SiteProfile } from '../merchants/types.js';

// Open a merchant's product page and wait until the SPA has actually hydrated.
// Used by BOTH the crawl and the test so they have identical navigation
// semantics — a difference here (e.g. waitUntil: 'domcontentloaded' in one
// place) means the test races the page render and reads a selector before
// the element exists.
export async function gotoProductPage(page: Page, profile: SiteProfile): Promise<void> {
  if (profile.productEntry.type === 'directUrl') {
    await page.goto(profile.productEntry.url, { waitUntil: 'load' });
  } else {
    await page.goto(profile.baseUrl, { waitUntil: 'load' });
    await profile.productEntry.run(page);
  }
  await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
  await page
    .waitForFunction(() => (document.body?.innerText.trim().length ?? 0) > 200, {
      timeout: 10_000,
    })
    .catch(() => {});
}
