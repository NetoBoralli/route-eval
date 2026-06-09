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

// Toggle a checkbox-shaped input to a target state. Strategy ladder, each
// step verified by reading input.checked afterward:
//
// 1. Click the associated <label for="..."> if it exists. This is what real
//    users click, what Route's widget JS listens on, and it doesn't trip
//    Playwright's interception check since the label IS the top element.
// 2. .check() / .uncheck() on the input directly with a short timeout.
// 3. .click({ force: true }) bypassing interception checks.
// 4. Direct DOM mutation + change/click event dispatch.
async function toggleCheckbox(
  loc: import('@playwright/test').Locator,
  target: boolean,
): Promise<void> {
  const page = loc.page();
  const escapeForCss = (s: string): string =>
    s.replace(/[^a-zA-Z0-9_-]/g, (c) => `\\${c}`);

  const tryStrategy = async (run: () => Promise<void>): Promise<boolean> => {
    try {
      await run();
    } catch {
      return false;
    }
    await page.waitForTimeout(1500);
    const checked = await loc.isChecked().catch(() => null);
    return checked === target;
  };

  // Strategy 1: click the associated <label>.
  const id = await loc.getAttribute('id').catch(() => null);
  if (id) {
    const label = page.locator(`label[for="${escapeForCss(id)}"]`);
    if (await label.isVisible({ timeout: 500 }).catch(() => false)) {
      if (await tryStrategy(() => label.click({ timeout: 3000 }))) return;
    }
  }

  // Strategy 2: native .check/.uncheck on the input.
  if (
    await tryStrategy(async () => {
      if (target) await loc.check({ timeout: 3000 });
      else await loc.uncheck({ timeout: 3000 });
    })
  ) {
    return;
  }

  // Strategy 3: force-click input, bypassing interception checks.
  if (await tryStrategy(() => loc.click({ force: true, timeout: 3000 }))) return;

  // Strategy 4: direct DOM mutation. Dispatch input/change AND a synthetic
  // click event — some widgets only listen to one of these.
  await loc.evaluate((node, desired) => {
    if (!(node instanceof HTMLInputElement)) return;
    if (node.checked !== desired) {
      node.checked = desired;
      node.dispatchEvent(new Event('input', { bubbles: true }));
      node.dispatchEvent(new Event('change', { bubbles: true }));
      node.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    }
  }, target);
  await page.waitForTimeout(1500);
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
