import type { Page } from '@playwright/test';
import type { Landmark, SiteProfile } from '../merchants/types.js';
import { resolve } from '../healing/resolver.js';
import { sweepPopups } from '../healing/popups.js';
import { gotoProductPage } from '../util/navigation.js';
import { formatCents, parseMoneyCents, withinTolerance } from '../util/money.js';

const TOLERANCE_CENTS = 2;

export type FlowFailure = {
  step: string;
  message: string;
  // Landmarks whose selector is the most likely cause of this failure, most-likely first.
  suspectLandmarks: Landmark[];
  // What text we actually read from each landmark when the failure occurred —
  // used to seed the next LLM attempt's prompt.
  readValues?: Partial<Record<Landmark, string>>;
};

export type FlowResult = { ok: true } | { ok: false; failure: FlowFailure };

async function readText(page: Page, profile: SiteProfile, landmark: Landmark): Promise<string> {
  const loc = await resolve(page, profile, landmark);
  return (await loc.innerText()).trim();
}

// Plain-function version of the cart/widget validation. Used by both the heal
// CLI (which needs structured failures to drive its retry loop) and the
// Playwright Test spec (which wraps each step in test.step).
export async function runWidgetCheckPlain(
  page: Page,
  profile: SiteProfile,
): Promise<FlowResult> {
  // Step: open product
  try {
    await gotoProductPage(page, profile);
    await sweepPopups(page, profile);
  } catch (err) {
    return {
      ok: false,
      failure: {
        step: 'open product page',
        message: `Navigation failed: ${(err as Error).message}`,
        suspectLandmarks: [],
      },
    };
  }

  // Step: add to cart
  try {
    const btn = await resolve(page, profile, 'addToCart');
    await btn.click();
    await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
    await page.waitForTimeout(2500);
    await sweepPopups(page, profile);
  } catch (err) {
    return {
      ok: false,
      failure: {
        step: 'add to cart',
        message: (err as Error).message,
        suspectLandmarks: ['addToCart'],
      },
    };
  }

  // Step: navigate to cart
  try {
    if (profile.cartUrl) {
      await page.goto(profile.cartUrl, { waitUntil: 'load' });
      await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
    } else {
      const cartLink = await resolve(page, profile, 'cartLink');
      await cartLink.click();
      await page.waitForLoadState('domcontentloaded');
    }
    await sweepPopups(page, profile);
  } catch (err) {
    return {
      ok: false,
      failure: {
        step: 'navigate to cart',
        message: (err as Error).message,
        suspectLandmarks: profile.cartUrl ? [] : ['cartLink'],
      },
    };
  }

  // Step: read prices with Route on
  let routePriceCents: number;
  let totalWithRouteCents: number;
  const readValues: Partial<Record<Landmark, string>> = {};
  try {
    const toggle = await resolve(page, profile, 'routeToggle');
    await toggle.check();
    await page.waitForTimeout(750);
  } catch (err) {
    return {
      ok: false,
      failure: {
        step: 'ensure Route widget ON',
        message: (err as Error).message,
        suspectLandmarks: ['routeToggle'],
      },
    };
  }

  try {
    readValues.routePrice = await readText(page, profile, 'routePrice');
    routePriceCents = parseMoneyCents(readValues.routePrice);
  } catch (err) {
    return {
      ok: false,
      failure: {
        step: 'read Route price',
        message: (err as Error).message,
        suspectLandmarks: ['routePrice'],
        readValues,
      },
    };
  }

  try {
    readValues.cartTotal = await readText(page, profile, 'cartTotal');
    totalWithRouteCents = parseMoneyCents(readValues.cartTotal);
  } catch (err) {
    return {
      ok: false,
      failure: {
        step: 'read cart total',
        message: (err as Error).message,
        suspectLandmarks: ['cartTotal'],
        readValues,
      },
    };
  }

  // Sanity guard: cartTotal must not point at the same DOM element as
  // routePrice (a common LLM mistake — Claude returns nearly-identical
  // selectors scoped under the same parent).
  if (totalWithRouteCents === routePriceCents) {
    return {
      ok: false,
      failure: {
        step: 'sanity check cart total',
        message:
          `cartTotal value ${formatCents(totalWithRouteCents)} is identical to routePrice — ` +
          `the selectors almost certainly point at the same DOM element.`,
        suspectLandmarks: ['cartTotal'],
        readValues,
      },
    };
  }

  // Step: uncheck Route, total should drop by routePrice
  let totalWithoutRouteCents: number;
  try {
    const toggle = await resolve(page, profile, 'routeToggle');
    await toggle.uncheck();
    await page.waitForTimeout(750);
    readValues.cartTotal = await readText(page, profile, 'cartTotal');
    totalWithoutRouteCents = parseMoneyCents(readValues.cartTotal);
  } catch (err) {
    return {
      ok: false,
      failure: {
        step: 'uncheck Route and read total',
        message: (err as Error).message,
        suspectLandmarks: ['routeToggle', 'cartTotal'],
        readValues,
      },
    };
  }

  const delta = totalWithRouteCents - totalWithoutRouteCents;
  if (!withinTolerance(delta, routePriceCents, TOLERANCE_CENTS)) {
    return {
      ok: false,
      failure: {
        step: 'assert total drops by Route amount',
        message:
          `Total dropped by ${formatCents(delta)} after unchecking Route, ` +
          `expected drop of ${formatCents(routePriceCents)} (the Route line price).`,
        // If the total didn't move by the Route amount, the cartTotal selector is the most likely culprit.
        suspectLandmarks: ['cartTotal', 'routePrice'],
        readValues,
      },
    };
  }

  // Step: re-check Route, total should restore
  try {
    const toggle = await resolve(page, profile, 'routeToggle');
    await toggle.check();
    await page.waitForTimeout(750);
    const restoredText = await readText(page, profile, 'cartTotal');
    const restoredCents = parseMoneyCents(restoredText);
    if (!withinTolerance(restoredCents, totalWithRouteCents, TOLERANCE_CENTS)) {
      return {
        ok: false,
        failure: {
          step: 'assert total restored after re-check',
          message:
            `Re-checking Route should restore total to ${formatCents(totalWithRouteCents)}, ` +
            `got ${formatCents(restoredCents)}.`,
          suspectLandmarks: ['cartTotal', 'routeToggle'],
          readValues: { ...readValues, cartTotal: restoredText },
        },
      };
    }
  } catch (err) {
    return {
      ok: false,
      failure: {
        step: 'restore Route',
        message: (err as Error).message,
        suspectLandmarks: ['routeToggle', 'cartTotal'],
        readValues,
      },
    };
  }

  return { ok: true };
}
