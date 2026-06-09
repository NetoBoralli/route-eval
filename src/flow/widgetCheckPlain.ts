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

// Returns the visible text of the routePrice element, or `null` if the element
// is not in the DOM / not visible. Used to detect the "Route toggled off"
// state, where the price element typically disappears or zeroes out.
async function readRoutePriceState(page: Page, profile: SiteProfile): Promise<string | null> {
  try {
    const loc = await resolve(page, profile, 'routePrice');
    if (!(await loc.isVisible({ timeout: 1500 }).catch(() => false))) return null;
    return (await loc.innerText()).trim();
  } catch {
    return null;
  }
}

function safeParseCents(text: string): number | null {
  try {
    return parseMoneyCents(text);
  } catch {
    return null;
  }
}

// Toggle a checkbox-shaped input to a target state. Falls through three
// strategies because Route's widget puts a label *over* the input (standard
// HTML pattern: clicking the label toggles the input) and Playwright's
// strict actionability check rejects that as "label intercepts pointer
// events". Sticky merchant headers create the same false-positive.
//
// 1. Normal .check()/.uncheck() — preserves Playwright's state-aware logic.
// 2. .click({ force: true }) — bypasses interception checks, lets the
//    label-as-overlay click through to the linked input.
// 3. Direct DOM mutation + change event dispatch — last resort if even the
//    forced click can't reach the element.
async function toggleCheckbox(
  loc: import('@playwright/test').Locator,
  target: boolean,
): Promise<void> {
  // Try Playwright's smart .check/.uncheck first with a short timeout. If the
  // page's overlay layout blocks it, we'll bail and try force.
  try {
    if (target) await loc.check({ timeout: 3000 });
    else await loc.uncheck({ timeout: 3000 });
  } catch {
    try {
      // Force-click bypasses actionability checks. HTML still routes the click
      // through any overlaying <label for="...">.
      await loc.click({ force: true, timeout: 3000 });
    } catch {
      // Last resort: flip the input state directly and dispatch the change
      // event so any React/JS listener picks it up.
      await loc.evaluate((node, desired) => {
        if (!(node instanceof HTMLInputElement)) return;
        if (node.checked !== desired) {
          node.checked = desired;
          node.dispatchEvent(new Event('input', { bubbles: true }));
          node.dispatchEvent(new Event('change', { bubbles: true }));
        }
      }, target);
    }
  }
  // Cart totals on most merchants update via XHR; wait briefly for re-render.
  await loc.page().waitForTimeout(750);
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

  // Step: read Route price with toggle on
  let routePriceCentsOn: number;
  const readValues: Partial<Record<Landmark, string>> = {};
  try {
    await sweepPopups(page, profile);
    const toggle = await resolve(page, profile, 'routeToggle');
    await toggleCheckbox(toggle, true);
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
    routePriceCentsOn = parseMoneyCents(readValues.routePrice);
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

  // Step: uncheck Route. The Route price element should either disappear
  // (not visible) or stop showing a $-amount.
  try {
    await sweepPopups(page, profile);
    const toggle = await resolve(page, profile, 'routeToggle');
    await toggleCheckbox(toggle, false);
  } catch (err) {
    return {
      ok: false,
      failure: {
        step: 'uncheck Route',
        message: (err as Error).message,
        suspectLandmarks: ['routeToggle'],
        readValues,
      },
    };
  }

  const priceOffText = await readRoutePriceState(page, profile);
  readValues.routePrice = priceOffText ?? '<hidden>';
  const offCents = priceOffText !== null ? safeParseCents(priceOffText) : null;
  if (offCents !== null && offCents === routePriceCentsOn) {
    return {
      ok: false,
      failure: {
        step: 'assert Route price hides/changes when toggled off',
        message:
          `Route price element still shows the same value (${formatCents(offCents)}) ` +
          `after unchecking the toggle. Either the toggle isn't actually changing the widget state, ` +
          `or the routeToggle selector points at the wrong element.`,
        suspectLandmarks: ['routeToggle', 'routePrice'],
        readValues,
      },
    };
  }

  // Step: re-check Route, price should come back to the original value.
  try {
    await sweepPopups(page, profile);
    const toggle = await resolve(page, profile, 'routeToggle');
    await toggleCheckbox(toggle, true);
    const restored = await readText(page, profile, 'routePrice');
    readValues.routePrice = restored;
    const restoredCents = parseMoneyCents(restored);
    if (!withinTolerance(restoredCents, routePriceCentsOn, TOLERANCE_CENTS)) {
      return {
        ok: false,
        failure: {
          step: 'assert Route price restored after re-check',
          message:
            `Re-checking Route should restore the price to ${formatCents(routePriceCentsOn)}, ` +
            `got ${formatCents(restoredCents)}.`,
          suspectLandmarks: ['routePrice', 'routeToggle'],
          readValues,
        },
      };
    }
  } catch (err) {
    return {
      ok: false,
      failure: {
        step: 'restore Route',
        message: (err as Error).message,
        suspectLandmarks: ['routeToggle', 'routePrice'],
        readValues,
      },
    };
  }

  return { ok: true };
}
