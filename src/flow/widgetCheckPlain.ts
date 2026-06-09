import type { Page } from '@playwright/test';
import type { Landmark, SiteProfile } from '../merchants/types.js';
import { resolve } from '../healing/resolver.js';
import { sweepPopups } from '../healing/popups.js';
import { gotoProductPage } from '../util/navigation.js';
import { formatCents, parseMoneyCents, withinTolerance } from '../util/money.js';

// Scheels' cart subtotal updates 1-2s after the toggle interaction; poll
// instead of fixed sleep so we don't waste time when the merchant is fast.
const SUBTOTAL_POLL_TIMEOUT_MS = 5000;
const SUBTOTAL_TOLERANCE_CENTS = 5; // line-rounding differences per merchant

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

// Poll readText for `landmark` until its value differs from `baseline`, or
// timeout. Returns the most recent reading either way (caller decides if a
// no-change result is a failure).
async function pollForChange(
  page: Page,
  profile: SiteProfile,
  landmark: Landmark,
  baseline: string,
  timeoutMs: number,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let last = baseline;
  while (Date.now() < deadline) {
    last = await readText(page, profile, landmark).catch(() => last);
    if (last !== baseline) return last;
    await new Promise((r) => setTimeout(r, 250));
  }
  return last;
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

  // Route's widget on Scheels (and probably others) doesn't hide its price
  // when the toggle is off — only the checkbox state changes. So we assert
  // on the checkbox state, not on the price element's visibility/text.
  // The cart subtotal updates after 1-2s but only on a re-render that
  // varies per merchant; we don't depend on it here.

  const readValues: Partial<Record<Landmark, string>> = {};
  let toggleLoc: import('@playwright/test').Locator;

  // Resolve the toggle once, reuse the locator across steps.
  try {
    await sweepPopups(page, profile);
    toggleLoc = await resolve(page, profile, 'routeToggle');
  } catch (err) {
    return {
      ok: false,
      failure: {
        step: 'find Route toggle',
        message: (err as Error).message,
        suspectLandmarks: ['routeToggle'],
      },
    };
  }

  // Step 1: ensure ON. Verify checkbox state, then read routePrice +
  // cartSubtotal baseline.
  await toggleCheckbox(toggleLoc, true);
  if ((await toggleLoc.isChecked().catch(() => null)) !== true) {
    return {
      ok: false,
      failure: {
        step: 'toggle Route ON',
        message: 'After attempting to check the Route toggle, input.checked is still not true.',
        suspectLandmarks: ['routeToggle'],
        readValues,
      },
    };
  }

  let routePriceCents: number;
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

  let subtotalWithRouteCents: number;
  try {
    readValues.cartSubtotal = await readText(page, profile, 'cartSubtotal');
    subtotalWithRouteCents = parseMoneyCents(readValues.cartSubtotal);
  } catch (err) {
    return {
      ok: false,
      failure: {
        step: 'read cart subtotal (Route on)',
        message: (err as Error).message,
        suspectLandmarks: ['cartSubtotal'],
        readValues,
      },
    };
  }

  // Step 2: toggle OFF. Verify checkbox state, then poll cartSubtotal for
  // the delayed update, assert the delta matches routePrice.
  await toggleCheckbox(toggleLoc, false);
  if ((await toggleLoc.isChecked().catch(() => null)) !== false) {
    return {
      ok: false,
      failure: {
        step: 'toggle Route OFF',
        message: 'After attempting to uncheck the Route toggle, input.checked is still not false.',
        suspectLandmarks: ['routeToggle'],
        readValues,
      },
    };
  }

  const subtotalOffText = await pollForChange(
    page,
    profile,
    'cartSubtotal',
    readValues.cartSubtotal ?? '',
    SUBTOTAL_POLL_TIMEOUT_MS,
  );
  readValues.cartSubtotal = subtotalOffText;
  let subtotalOffCents: number;
  try {
    subtotalOffCents = parseMoneyCents(subtotalOffText);
  } catch (err) {
    return {
      ok: false,
      failure: {
        step: 'parse cart subtotal after Route off',
        message: (err as Error).message,
        suspectLandmarks: ['cartSubtotal'],
        readValues,
      },
    };
  }

  const delta = subtotalWithRouteCents - subtotalOffCents;
  if (delta === 0) {
    return {
      ok: false,
      failure: {
        step: 'cart subtotal change after toggle OFF',
        message:
          `Cart subtotal did not change after unchecking Route (${formatCents(subtotalWithRouteCents)} both before and after, after ${SUBTOTAL_POLL_TIMEOUT_MS / 1000}s poll). ` +
          `Either cartSubtotal selector points at a static element (item subtotal vs. running total) ` +
          `or the toggle didn't reach Route's widget despite isChecked() reporting unchecked.`,
        suspectLandmarks: ['cartSubtotal', 'routeToggle'],
        readValues,
      },
    };
  }
  if (!withinTolerance(delta, routePriceCents, SUBTOTAL_TOLERANCE_CENTS)) {
    return {
      ok: false,
      failure: {
        step: 'cart subtotal delta matches Route price',
        message:
          `Cart subtotal dropped by ${formatCents(delta)} after unchecking Route, expected drop ${formatCents(routePriceCents)} (the Route line price).`,
        suspectLandmarks: ['cartSubtotal', 'routePrice'],
        readValues,
      },
    };
  }

  // Step 3: toggle ON. Verify checkbox state, poll for subtotal restore.
  await toggleCheckbox(toggleLoc, true);
  if ((await toggleLoc.isChecked().catch(() => null)) !== true) {
    return {
      ok: false,
      failure: {
        step: 'toggle Route ON (restore)',
        message: 'After re-checking the Route toggle, input.checked is still not true.',
        suspectLandmarks: ['routeToggle'],
        readValues,
      },
    };
  }

  const subtotalRestoredText = await pollForChange(
    page,
    profile,
    'cartSubtotal',
    subtotalOffText,
    SUBTOTAL_POLL_TIMEOUT_MS,
  );
  readValues.cartSubtotal = subtotalRestoredText;
  let subtotalRestoredCents: number;
  try {
    subtotalRestoredCents = parseMoneyCents(subtotalRestoredText);
  } catch (err) {
    return {
      ok: false,
      failure: {
        step: 'parse cart subtotal after Route restored',
        message: (err as Error).message,
        suspectLandmarks: ['cartSubtotal'],
        readValues,
      },
    };
  }

  if (!withinTolerance(subtotalRestoredCents, subtotalWithRouteCents, SUBTOTAL_TOLERANCE_CENTS)) {
    return {
      ok: false,
      failure: {
        step: 'cart subtotal restored after toggle ON',
        message:
          `Cart subtotal after re-checking Route is ${formatCents(subtotalRestoredCents)}, expected ${formatCents(subtotalWithRouteCents)}.`,
        suspectLandmarks: ['cartSubtotal'],
        readValues,
      },
    };
  }

  return { ok: true };
}
