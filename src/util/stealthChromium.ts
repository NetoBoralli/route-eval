import { chromium } from 'playwright-extra';
import stealth from 'puppeteer-extra-plugin-stealth';

// Apply stealth patches once at module load. playwright-extra wraps Playwright's
// chromium so navigator.webdriver, plugin/codec lists, languages, etc. look
// like a real desktop browser instead of a vanilla automated Chromium. Needed
// to get past Cloudflare bot challenges on merchant sites like scheels.com.
let applied = false;
function ensure(): typeof chromium {
  if (!applied) {
    chromium.use(stealth());
    applied = true;
  }
  return chromium;
}

export const stealthChromium = ensure();
