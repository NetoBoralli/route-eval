import { expect, test, type Page, type TestInfo } from '@playwright/test';
import type { SiteProfile } from '../merchants/types.js';
import { resolve } from '../healing/resolver.js';
import { sweepPopups } from '../healing/popups.js';
import { gotoProductPage } from '../util/navigation.js';
import { formatCents, parseMoneyCents, withinTolerance } from '../util/money.js';

const TOLERANCE_CENTS = 2;

async function attachScreenshot(page: Page, info: TestInfo, label: string): Promise<void> {
  const body = await page.screenshot({ fullPage: false });
  await info.attach(label, { body, contentType: 'image/png' });
}

async function setToggle(page: Page, profile: SiteProfile, on: boolean): Promise<void> {
  const toggle = await resolve(page, profile, 'routeToggle');
  if (on) await toggle.check();
  else await toggle.uncheck();
  // Cart totals on most merchants update via XHR; wait briefly for re-render.
  await page.waitForTimeout(750);
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
    // Optimistic UI: the confirmation often appears before the cart-save XHR
    // finishes. Wait so the next navigation doesn't drop the in-flight save.
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

  let routePriceCentsOn = 0;

  await test.step('toggle Route ON and read price', async () => {
    await setToggle(page, profile, true);
    const routePriceText = await (await resolve(page, profile, 'routePrice')).innerText();
    routePriceCentsOn = parseMoneyCents(routePriceText);
    // eslint-disable-next-line no-console
    console.log(`[values] routePrice=${formatCents(routePriceCentsOn)}`);
    await attachScreenshot(page, info, '04-widget-on');
  });

  await test.step('toggle Route OFF and verify price hides or changes', async () => {
    await setToggle(page, profile, false);
    const loc = await resolve(page, profile, 'routePrice');
    const visible = await loc.isVisible({ timeout: 1500 }).catch(() => false);
    await attachScreenshot(page, info, '05-widget-off');

    if (!visible) return; // hidden → toggle is doing its job
    const text = (await loc.innerText()).trim();
    let cents: number | null;
    try {
      cents = parseMoneyCents(text);
    } catch {
      cents = null; // no dollar amount → effectively "off"
    }
    expect(
      cents !== routePriceCentsOn,
      `Route price element still shows ${formatCents(cents ?? 0)} after unchecking — ` +
        `toggle isn't actually changing widget state.`,
    ).toBe(true);
  });

  await test.step('toggle Route ON and verify price restored', async () => {
    await setToggle(page, profile, true);
    const text = await (await resolve(page, profile, 'routePrice')).innerText();
    const cents = parseMoneyCents(text);
    await attachScreenshot(page, info, '06-widget-on-again');
    expect(
      withinTolerance(cents, routePriceCentsOn, TOLERANCE_CENTS),
      `Re-checking Route should restore price to ${formatCents(routePriceCentsOn)}, got ${formatCents(cents)}.`,
    ).toBe(true);
  });
}
