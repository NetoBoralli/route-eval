import type { Locator, Page } from '@playwright/test';
import { stealthChromium } from '../util/stealthChromium.js';
import { writeFileSync } from 'node:fs';
import type { Landmark, SelectorHint, SiteProfile } from '../merchants/types.js';
import {
  crawledFilePath,
  readCrawledFile,
  type CrawledEntry,
  type CrawledFile,
} from '../merchants/registry.js';
import { buildLocator } from '../healing/resolver.js';
import { sweepPopups } from '../healing/popups.js';
import { healWithLLM } from '../healing/llm.js';
import { healWithLabel } from './labelHeuristics.js';
import { meetsAcceptance } from './acceptance.js';
import { gotoProductPage } from '../util/navigation.js';
import { installPopupBlocker } from '../util/popupBlocker.js';
import { clearFeedback, readFeedback } from '../heal/feedback.js';

export type CrawlOptions = {
  headed?: boolean;
  // When true, ignore any existing crawled.json and re-discover every landmark with the LLM.
  force?: boolean;
};

async function isUsable(loc: Locator, timeoutMs = 1500): Promise<boolean> {
  try {
    const count = await loc.count();
    if (count === 0) return false;
    return await loc.first().isVisible({ timeout: timeoutMs });
  } catch {
    return false;
  }
}

function logStep(profile: SiteProfile, landmark: Landmark, msg: string): void {
  // eslint-disable-next-line no-console
  console.log(`[crawl ${profile.name}.${landmark}] ${msg}`);
}

// Persist the in-progress crawl after each successful landmark resolution. If
// the run crashes mid-flight, the next run picks up the cached landmarks via
// the normal cache short-circuit and only re-runs the LLM for what's missing.
function writeProgress(
  profile: SiteProfile,
  entries: Partial<Record<Landmark, CrawledEntry>>,
): void {
  const payload: CrawledFile = {
    merchant: profile.name,
    crawledAt: new Date().toISOString(),
    entries,
  };
  try {
    writeFileSync(crawledFilePath(profile.name), `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`[crawl ${profile.name}] failed to write progress: ${(err as Error).message}`);
  }
}

// Resolve a single landmark for the crawl:
// - If a previous entry exists AND still resolves on the live DOM, keep it (no API call).
// - Otherwise call Claude, validate, record as fresh LLM discovery.
async function resolveForCrawl(
  page: Page,
  profile: SiteProfile,
  landmark: Landmark,
  previous: CrawledFile | undefined,
  force: boolean,
  out: Partial<Record<Landmark, CrawledEntry>>,
  feedback: Partial<Record<Landmark, string>>,
): Promise<Locator> {
  if (!force) {
    const cached = previous?.entries[landmark];
    if (cached) {
      const loc = buildLocator(page, cached.hint);
      if (await isUsable(loc)) {
        const accept = await meetsAcceptance(loc, landmark);
        if (accept.ok) {
          // Reuse the cached selector — mark source as 'cached' but preserve original discovery time.
          out[landmark] = {
            hint: cached.hint,
            source: 'cached',
            discoveredAt: cached.discoveredAt,
            ...(cached.confidence ? { confidence: cached.confidence } : {}),
          };
          logStep(profile, landmark, `cache hit (${cached.source}, ${cached.discoveredAt})`);
          writeProgress(profile, out);
          return loc.first();
        }
        logStep(
          profile,
          landmark,
          `cache stale (acceptance failed: ${accept.reason}) — re-discovering`,
        );
      } else {
        logStep(profile, landmark, `cache stale — re-discovering with LLM`);
      }
    }
  }

  const result = await healWithLLM(page, landmark, { initialFeedback: feedback[landmark] });
  if (result.ok) {
    const hint: SelectorHint = { kind: 'css', css: result.selector };
    const loc = buildLocator(page, hint);
    if (await isUsable(loc)) {
      const accept = await meetsAcceptance(loc, landmark);
      if (accept.ok) {
        out[landmark] = {
          hint,
          source: 'llm',
          discoveredAt: new Date().toISOString(),
          confidence: result.confidence,
        };
        logStep(profile, landmark, `LLM discovered (${result.confidence}): ${result.selector}`);
        writeProgress(profile, out);
        return loc.first();
      }
      logStep(
        profile,
        landmark,
        `LLM result failed acceptance (${accept.reason}) — escalating to label heuristic`,
      );
    } else {
      logStep(profile, landmark, `LLM result unusable — escalating to label heuristic`);
    }
  } else {
    logStep(profile, landmark, `LLM failed — escalating to label heuristic: ${result.reason}`);
  }

  // Escalation: deterministic label-anchored fallback. Searches the page for
  // the landmark's well-known text label and synthesizes a selector from the
  // matched element's actual DOM attributes.
  const labelResult = await healWithLabel(page, landmark);
  if (labelResult.ok) {
    const accept = await meetsAcceptance(labelResult.loc, landmark);
    if (accept.ok) {
      const hint: SelectorHint = { kind: 'css', css: labelResult.selector };
      out[landmark] = {
        hint,
        source: 'label',
        discoveredAt: new Date().toISOString(),
      };
      logStep(profile, landmark, `label heuristic discovered: ${labelResult.selector}`);
      writeProgress(profile, out);
      return labelResult.loc;
    }
    logStep(
      profile,
      landmark,
      `label heuristic produced unacceptable selector (${accept.reason})`,
    );
  }

  const labelSummary = labelResult.ok
    ? `selector "${labelResult.selector}" found but failed acceptance`
    : labelResult.reason;
  throw new Error(
    `Could not discover "${landmark}" on ${profile.name}. ` +
      `LLM result: ${result.ok ? `selector "${result.selector}" did not meet acceptance` : result.reason}. ` +
      `Label heuristic: ${labelSummary}. ` +
      `Inspect debug/crawl/${landmark}.*.snippet.html and add an entry to ${profile.name}.overrides.ts.`,
  );
}

// Cross-merchant heuristic: if any of these appear on the cart page, the cart
// is empty and we wasted our nav. Throws with actionable guidance.
async function assertCartNotEmpty(page: Page): Promise<void> {
  const emptyIndicators = [
    page.locator('[id*="empty" i][id*="cart" i], [id*="cart" i][id*="empty" i]'),
    page.getByText(/your (shopping )?cart is empty/i),
    page.getByText(/cart is empty/i),
  ];
  for (const ind of emptyIndicators) {
    if (await ind.first().isVisible({ timeout: 500 }).catch(() => false)) {
      throw new Error(
        `Cart page loaded but shows as empty after add-to-cart. Likely causes: ` +
          `(a) the product requires size/variant selection before add-to-cart actually persists; ` +
          `(b) the slide-out is optimistic UI and the cart-save XHR was interrupted by navigation ` +
          `(try bumping the post-add wait); (c) cart state is local-only on this merchant — switch ` +
          `to the slide-out as the canonical cart view.`,
      );
    }
  }
}


export async function crawlMerchant(
  profile: SiteProfile,
  options: CrawlOptions = {},
): Promise<void> {
  const previous = options.force ? undefined : readCrawledFile(profile.name);
  if (previous) {
    // eslint-disable-next-line no-console
    console.log(
      `[crawl ${profile.name}] using cache from ${previous.crawledAt} ` +
        `(${Object.keys(previous.entries).length} entries)`,
    );
  } else {
    // eslint-disable-next-line no-console
    console.log(
      `[crawl ${profile.name}] ${options.force ? 'force mode — ignoring cache' : 'no cache — full LLM discovery'}`,
    );
  }

  // Heal-loop feedback from a previous failed test run, if any. Seeds each
  // affected landmark's LLM prompt so Claude doesn't pick the same wrong
  // selector again.
  const feedbackFile = readFeedback(profile.name);
  const feedback = feedbackFile?.entries ?? {};
  if (feedbackFile) {
    // eslint-disable-next-line no-console
    console.log(
      `[crawl ${profile.name}] applying feedback from attempt ${feedbackFile.attempt} ` +
        `for: ${Object.keys(feedback).join(', ')}`,
    );
  }

  const browser = await stealthChromium.launch({ headless: !options.headed });
  const context = await browser.newContext({
    locale: 'en-US',
    viewport: { width: 1440, height: 900 },
  });
  await installPopupBlocker(context);
  const page = await context.newPage();
  // Start from previous entries so a mid-flight crash doesn't drop perfectly
  // good cached values for landmarks we hadn't gotten to yet. Each successful
  // resolveForCrawl call overwrites with fresh data (source: 'cached' or 'llm'
  // or 'label'). On force mode we start fresh.
  const entries: Partial<Record<Landmark, CrawledEntry>> = options.force
    ? {}
    : { ...(previous?.entries ?? {}) };
  const force = options.force ?? false;

  try {
    // Stage 1: product page.
    await gotoProductPage(page, profile);
    await sweepPopups(page, profile);
    const addToCart = await resolveForCrawl(page, profile, 'addToCart', previous, force, entries, feedback);
    await resolveForCrawl(page, profile, 'cartLink', previous, force, entries, feedback);

    // Stage 2: add to cart so the cart has a real subtotal & the Route widget appears.
    await addToCart.click();
    await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
    // Many sites use optimistic UI: the "Added to cart" slide-out renders before
    // the cart-save XHR finishes. Navigating too eagerly drops the in-flight save
    // and the cart page comes back empty. Belt-and-braces wait.
    await page.waitForTimeout(2500);
    await sweepPopups(page, profile);

    // Stage 3: open the cart. If the profile has a direct cartUrl, navigate
    // there — sidesteps mini-cart overlay click interception. Otherwise click
    // the discovered cartLink.
    if (profile.cartUrl) {
      await page.goto(profile.cartUrl, { waitUntil: 'load' });
      await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
    } else {
      const cartLink = await resolveForCrawl(page, profile, 'cartLink', previous, force, entries, feedback);
      await cartLink.click();
      await page.waitForLoadState('domcontentloaded');
    }
    await sweepPopups(page, profile);
    await assertCartNotEmpty(page);

    // Stage 4: cart page. We deliberately skip cartTotal — many merchants
    // (including Scheels) don't render a grand total on the cart page when
    // tax is calculated at checkout. The toggle test verifies behavior via
    // routePrice element state, no grand total needed.
    await resolveForCrawl(page, profile, 'cartSubtotal', previous, force, entries, feedback);
    await resolveForCrawl(page, profile, 'routeToggle', previous, force, entries, feedback);
    await resolveForCrawl(page, profile, 'routePrice', previous, force, entries, feedback);
  } finally {
    await browser.close();
  }

  // Successful crawl — feedback has been consumed. Clear it so the next
  // standalone `npm run crawl` doesn't keep re-applying stale guidance.
  clearFeedback(profile.name);

  const payload: CrawledFile = {
    merchant: profile.name,
    crawledAt: new Date().toISOString(),
    entries,
  };
  const path = crawledFilePath(profile.name);
  writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');

  const counts = Object.values(entries).reduce(
    (acc, entry) => {
      if (!entry) return acc;
      acc[entry.source] += 1;
      return acc;
    },
    { llm: 0, cached: 0, label: 0 } as Record<CrawledEntry['source'], number>,
  );
  // eslint-disable-next-line no-console
  console.log(
    `[crawl ${profile.name}] wrote ${path} — ${counts.llm} via LLM, ${counts.cached} via cache, ${counts.label} via label heuristic`,
  );
}
