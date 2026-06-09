import { test as base, type Browser, type BrowserContext } from '@playwright/test';
import { stealthChromium } from '../src/util/stealthChromium.js';
import { installPopupBlocker } from '../src/util/popupBlocker.js';

// Override the Playwright Test `browser` fixture so the test runs against a
// stealth-patched Chromium. Without this, Cloudflare-fronted merchants serve
// us the bot interstitial instead of the real page.
export const test = base.extend<{ context: BrowserContext }, { browser: Browser }>({
  browser: [
    async ({}, use) => {
      const browser = await stealthChromium.launch();
      await use(browser);
      await browser.close();
    },
    { scope: 'worker' },
  ],
  context: async ({ browser }, use) => {
    const context = await browser.newContext();
    await installPopupBlocker(context);
    await use(context);
    await context.close();
  },
});

export { expect } from '@playwright/test';
