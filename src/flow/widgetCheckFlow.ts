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

  let routePriceCents = 0;
  let totalWithRouteCents = 0;

  await test.step('ensure Route widget is ON and read prices', async () => {
    await setToggle(page, profile, true);

    const routePriceText = await (await resolve(page, profile, 'routePrice')).innerText();
    routePriceCents = parseMoneyCents(routePriceText);

    const totalText = await (await resolve(page, profile, 'cartTotal')).innerText();
    totalWithRouteCents = parseMoneyCents(totalText);

    expect(
      totalWithRouteCents !== routePriceCents,
      `cartTotal value ${formatCents(totalWithRouteCents)} is identical to routePrice — ` +
        `the selectors almost certainly point at the same DOM element.`,
    ).toBe(true);

    // eslint-disable-next-line no-console
    console.log(
      `[values] routePrice=${formatCents(routePriceCents)} ` +
        `total=${formatCents(totalWithRouteCents)}`,
    );

    await attachScreenshot(page, info, '04-widget-on');
  });

  await test.step('toggle Route OFF and verify total drops by Route price', async () => {
    await setToggle(page, profile, false);
    const totalText = await (await resolve(page, profile, 'cartTotal')).innerText();
    const totalWithoutRouteCents = parseMoneyCents(totalText);
    const delta = totalWithRouteCents - totalWithoutRouteCents;
    await attachScreenshot(page, info, '05-widget-off');

    expect(
      withinTolerance(delta, routePriceCents, TOLERANCE_CENTS),
      `Total dropped by ${formatCents(delta)} after unchecking Route, expected drop of ` +
        `${formatCents(routePriceCents)} (the Route line price).`,
    ).toBe(true);
  });

  await test.step('toggle Route ON again and verify total returns', async () => {
    await setToggle(page, profile, true);
    const totalText = await (await resolve(page, profile, 'cartTotal')).innerText();
    const totalAgainCents = parseMoneyCents(totalText);
    await attachScreenshot(page, info, '06-widget-on-again');

    expect(
      withinTolerance(totalAgainCents, totalWithRouteCents, TOLERANCE_CENTS),
      `Re-checking Route should restore total to ${formatCents(totalWithRouteCents)}, ` +
        `got ${formatCents(totalAgainCents)}.`,
    ).toBe(true);
  });
}
