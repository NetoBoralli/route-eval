import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test';
import type { SiteProfile } from '../merchants/types.js';
import { resolve } from '../healing/resolver.js';
import { sweepPopups } from '../healing/popups.js';
import { gotoProductPage } from '../util/navigation.js';
import { formatCents, parseMoneyCents, withinTolerance } from '../util/money.js';

const SUBTOTAL_POLL_TIMEOUT_MS = 5000;
const SUBTOTAL_TOLERANCE_CENTS = 5;

async function pollSubtotalChange(
  page: Page,
  profile: SiteProfile,
  baseline: string,
): Promise<string> {
  const deadline = Date.now() + SUBTOTAL_POLL_TIMEOUT_MS;
  let last = baseline;
  while (Date.now() < deadline) {
    const loc = await resolve(page, profile, 'cartSubtotal');
    last = (await loc.innerText().catch(() => last)).trim() || last;
    if (last !== baseline) return last;
    await page.waitForTimeout(250);
  }
  return last;
}

async function attachScreenshot(page: Page, info: TestInfo, label: string): Promise<void> {
  const body = await page.screenshot({ fullPage: false });
  await info.attach(label, { body, contentType: 'image/png' });
}

// Toggle a checkbox-shaped input to a target state via a strategy ladder,
// each step verified by reading input.isChecked() after a 1.5s settle.
async function setToggle(
  page: Page,
  profile: SiteProfile,
  toggle: Locator,
  on: boolean,
): Promise<void> {
  await sweepPopups(page, profile);
  const escapeForCss = (s: string): string => s.replace(/[^a-zA-Z0-9_-]/g, (c) => `\\${c}`);
  const verify = async (): Promise<boolean> => {
    await page.waitForTimeout(1500);
    return (await toggle.isChecked().catch(() => null)) === on;
  };

  // Strategy 1: click the <label for="..."> — Route's widget listens here.
  const id = await toggle.getAttribute('id').catch(() => null);
  if (id) {
    const label = page.locator(`label[for="${escapeForCss(id)}"]`);
    if (await label.isVisible({ timeout: 500 }).catch(() => false)) {
      try {
        await label.click({ timeout: 3000 });
        if (await verify()) return;
      } catch {
        // fall through
      }
    }
  }

  // Strategy 2: native check/uncheck on input.
  try {
    if (on) await toggle.check({ timeout: 3000 });
    else await toggle.uncheck({ timeout: 3000 });
    if (await verify()) return;
  } catch {
    // fall through
  }

  // Strategy 3: force-click input.
  try {
    await toggle.click({ force: true, timeout: 3000 });
    if (await verify()) return;
  } catch {
    // fall through
  }

  // Strategy 4: direct DOM mutation + event dispatch.
  await toggle.evaluate((node, desired) => {
    if (!(node instanceof HTMLInputElement)) return;
    if (node.checked !== desired) {
      node.checked = desired;
      node.dispatchEvent(new Event('input', { bubbles: true }));
      node.dispatchEvent(new Event('change', { bubbles: true }));
      node.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    }
  }, on);
  await page.waitForTimeout(1500);
}

export async function runWidgetCheck(
  page: Page,
  profile: SiteProfile,
  info: TestInfo,
): Promise<void> {
  await test.step('open product page', async () => {
    await gotoProductPage(page, profile);
    await sweepPopups(page, profile);
    await attachScreenshot(page, info, '01-product');
  });

  await test.step('add to cart', async () => {
    const btn = await resolve(page, profile, 'addToCart');
    await btn.click();
    await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
    await page.waitForTimeout(2500);
    await sweepPopups(page, profile);
    await attachScreenshot(page, info, '02-after-add');
  });

  await test.step('navigate to cart', async () => {
    if (profile.cartUrl) {
      await page.goto(profile.cartUrl, { waitUntil: 'load' });
      await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
    } else {
      const cartLink = await resolve(page, profile, 'cartLink');
      await cartLink.click();
      await page.waitForLoadState('domcontentloaded');
    }
    await sweepPopups(page, profile);
    await attachScreenshot(page, info, '03-cart');
  });

  // Route's widget on Scheels (and others) doesn't hide its price line on
  // toggle off — the visible widget-level change is the checkbox itself,
  // and the cart subtotal updates after a 1-2s delay. Assert both: checkbox
  // state in each direction, AND cart subtotal moves by the Route price.
  const toggle = await resolve(page, profile, 'routeToggle');
  let routePriceCents = 0;
  let subtotalWithRouteText = '';
  let subtotalWithRouteCents = 0;

  await test.step('toggle Route ON, read price + subtotal baselines', async () => {
    await setToggle(page, profile, toggle, true);
    expect(await toggle.isChecked(), 'Route toggle is not checked after enabling').toBe(true);
    routePriceCents = parseMoneyCents(
      await (await resolve(page, profile, 'routePrice')).innerText(),
    );
    subtotalWithRouteText = (
      await (await resolve(page, profile, 'cartSubtotal')).innerText()
    ).trim();
    subtotalWithRouteCents = parseMoneyCents(subtotalWithRouteText);
    // eslint-disable-next-line no-console
    console.log(
      `[values] routePrice=${formatCents(routePriceCents)} subtotal=${formatCents(subtotalWithRouteCents)}`,
    );
    await attachScreenshot(page, info, '04-widget-on');
  });

  await test.step('toggle Route OFF, subtotal drops by Route price', async () => {
    await setToggle(page, profile, toggle, false);
    expect(await toggle.isChecked(), 'Route toggle is still checked after disabling').toBe(false);
    const offText = await pollSubtotalChange(page, profile, subtotalWithRouteText);
    const offCents = parseMoneyCents(offText);
    const delta = subtotalWithRouteCents - offCents;
    await attachScreenshot(page, info, '05-widget-off');
    expect(
      delta !== 0,
      `Cart subtotal did not change after unchecking Route (${formatCents(subtotalWithRouteCents)} both before and after) — cartSubtotal may point at a static element.`,
    ).toBe(true);
    expect(
      withinTolerance(delta, routePriceCents, SUBTOTAL_TOLERANCE_CENTS),
      `Cart subtotal dropped by ${formatCents(delta)} after unchecking Route, expected drop ${formatCents(routePriceCents)}.`,
    ).toBe(true);
  });

  await test.step('toggle Route ON, subtotal restores', async () => {
    const beforeRestore = (
      await (await resolve(page, profile, 'cartSubtotal')).innerText()
    ).trim();
    await setToggle(page, profile, toggle, true);
    expect(await toggle.isChecked(), 'Route toggle did not return to checked').toBe(true);
    const restoredText = await pollSubtotalChange(page, profile, beforeRestore);
    const restoredCents = parseMoneyCents(restoredText);
    await attachScreenshot(page, info, '06-widget-on-again');
    expect(
      withinTolerance(restoredCents, subtotalWithRouteCents, SUBTOTAL_TOLERANCE_CENTS),
      `Cart subtotal after re-checking Route is ${formatCents(restoredCents)}, expected ${formatCents(subtotalWithRouteCents)}.`,
    ).toBe(true);
  });
}
