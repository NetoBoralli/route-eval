import type { Locator } from '@playwright/test';
import type { Landmark } from '../merchants/types.js';

export type AcceptanceResult = { ok: true } | { ok: false; reason: string };

// Per-landmark "is this the right kind of element" check. Runs AFTER a
// candidate selector has passed visibility — catches the common LLM failure
// mode where a returned selector resolves to *some* visible element that
// isn't even the right *shape* (e.g. the CHECKOUT button matched as if it
// were the cart total).
//
// When the acceptance check rejects an LLM result during the crawl, the
// resolver falls through to the deterministic label heuristic instead of
// recording a known-bad selector to disk.
export async function meetsAcceptance(
  loc: Locator,
  landmark: Landmark,
): Promise<AcceptanceResult> {
  try {
    switch (landmark) {
      case 'cartSubtotal':
      case 'cartTotal':
      case 'routePrice': {
        const text = (await loc.first().innerText({ timeout: 1500 })).trim();
        if (!/\$\s*\d/.test(text)) {
          return {
            ok: false,
            reason: `text ${JSON.stringify(text.slice(0, 60))} contains no $-amount`,
          };
        }
        // A price element shouldn't be a wrapping container. 200 chars is
        // generous for "Route Protection · $2.49" etc., but catches body-text
        // matches like "Skip to main content\nGifts Dad Will Love..."
        if (text.length > 200) {
          return {
            ok: false,
            reason: `text is ${text.length} chars — selector matches a wrapper, not the price element`,
          };
        }
        return { ok: true };
      }
      case 'routeToggle': {
        const isToggle = await loc.first().evaluate((el) => {
          if (!(el instanceof Element)) return false;
          const tag = el.tagName.toLowerCase();
          const type = el.getAttribute('type');
          const role = el.getAttribute('role');
          return (
            (tag === 'input' && (type === 'checkbox' || type === 'radio')) ||
            role === 'checkbox' ||
            role === 'switch'
          );
        });
        return isToggle
          ? { ok: true }
          : { ok: false, reason: 'element is not a checkbox/switch/radio input' };
      }
      case 'addToCart':
      case 'cartLink': {
        const isClickable = await loc.first().evaluate((el) => {
          if (!(el instanceof Element)) return false;
          const tag = el.tagName.toLowerCase();
          const role = el.getAttribute('role');
          return tag === 'button' || tag === 'a' || role === 'button' || role === 'link';
        });
        return isClickable
          ? { ok: true }
          : { ok: false, reason: 'element is not a button/link' };
      }
    }
  } catch (err) {
    return { ok: false, reason: `acceptance check threw: ${(err as Error).message}` };
  }
}
