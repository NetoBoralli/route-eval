import { test as base, type Browser } from '@playwright/test';
import { stealthChromium } from '../src/util/stealthChromium.js';

// Override the Playwright Test `browser` fixture so the test runs against a
// stealth-patched Chromium. Without this, Cloudflare-fronted merchants serve
// us the bot interstitial instead of the real page.
export const test = base.extend<object, { browser: Browser }>({
  browser: [
    async ({}, use) => {
      const browser = await stealthChromium.launch();
      await use(browser);
      await browser.close();
    },
    { scope: 'worker' },
  ],
});

export { expect } from '@playwright/test';
