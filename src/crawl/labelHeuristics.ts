import type { Locator, Page } from '@playwright/test';
import type { Landmark } from '../merchants/types.js';

// Inspect a uniquely-matched element and produce a stable standard-CSS selector
// for it, preferring stable attributes over class chains. Returns null if no
// usable selector can be derived.
async function synthesizeStableSelector(loc: Locator): Promise<string | null> {
  return loc
    .first()
    .evaluate((node: Element) => {
      if (!(node instanceof Element)) return null;
      const cssEscape = (s: string): string =>
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (window as unknown as { CSS?: { escape?: (s: string) => string } }).CSS?.escape
          ? // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (window as any).CSS.escape(s)
          : s.replace(/[^a-zA-Z0-9_-]/g, (c: string) => `\\${c}`);
      if (node.id) return `#${cssEscape(node.id)}`;
      for (const attr of ['data-testid', 'data-qa', 'data-cy', 'data-test', 'aria-label', 'name']) {
        const v = node.getAttribute(attr);
        if (v) return `[${attr}="${v.replace(/"/g, '\\"')}"]`;
      }
      // Last resort: build a short tag-and-position path.
      const path: string[] = [];
      let cur: Element | null = node;
      while (cur && cur.tagName !== 'BODY' && path.length < 5) {
        let part = cur.tagName.toLowerCase();
        const parent: Element | null = cur.parentElement;
        if (parent) {
          const sameTag = Array.from(parent.children).filter((c) => c.tagName === cur!.tagName);
          if (sameTag.length > 1) {
            const idx = sameTag.indexOf(cur) + 1;
            part += `:nth-of-type(${idx})`;
          }
        }
        path.unshift(part);
        cur = parent;
      }
      return path.length > 0 ? path.join(' > ') : null;
    })
    .catch(() => null);
}

async function isUsable(loc: Locator): Promise<boolean> {
  try {
    const count = await loc.count();
    if (count === 0) return false;
    return await loc.first().isVisible({ timeout: 1000 });
  } catch {
    return false;
  }
}

// Landmark-specific deterministic finders. Each searches the live page for the
// element using text labels we know are nearly universal across e-commerce
// (Subtotal, Total, Route/Package Protection). Returns the located element.
const finders: Partial<Record<Landmark, (page: Page) => Promise<Locator | null>>> = {
  cartSubtotal: async (page) => {
    const label = page.getByText(/^subtotal$/i).first();
    if (!(await label.isVisible({ timeout: 1500 }).catch(() => false))) return null;
    // Walk up two levels to find the row, then locate the $-amount sibling.
    const row = label.locator('xpath=ancestor::*[2]');
    const price = row.getByText(/\$\s?\d+(\.\d{2})?/).first();
    return (await price.isVisible({ timeout: 500 }).catch(() => false)) ? price : null;
  },
  cartTotal: async (page) => {
    // Match "Total" or "Order Total" but NOT "Subtotal".
    const label = page
      .getByText(/^(order\s+|grand\s+)?total$/i)
      .filter({ hasNotText: /subtotal/i })
      .first();
    if (!(await label.isVisible({ timeout: 1500 }).catch(() => false))) return null;
    const row = label.locator('xpath=ancestor::*[2]');
    const price = row.getByText(/\$\s?\d+(\.\d{2})?/).first();
    return (await price.isVisible({ timeout: 500 }).catch(() => false)) ? price : null;
  },
  routeToggle: async (page) => {
    const label = page
      .getByText(/route|package protection|shipping protection/i)
      .first();
    if (!(await label.isVisible({ timeout: 1500 }).catch(() => false))) return null;
    // Walk up the tree looking for the nearest checkbox/switch.
    const section = label.locator('xpath=ancestor::*[3]');
    const candidates = section.locator(
      'input[type="checkbox"], input[type="radio"], [role="checkbox"], [role="switch"]',
    );
    return (await candidates.count().catch(() => 0)) > 0 ? candidates.first() : null;
  },
  routePrice: async (page) => {
    const label = page
      .getByText(/route|package protection|shipping protection/i)
      .first();
    if (!(await label.isVisible({ timeout: 1500 }).catch(() => false))) return null;
    const section = label.locator('xpath=ancestor::*[3]');
    const price = section.getByText(/\$\s?\d+(\.\d{2})?/).first();
    return (await price.isVisible({ timeout: 500 }).catch(() => false)) ? price : null;
  },
};

export type LabelHealResult =
  | { ok: true; loc: Locator; selector: string }
  | { ok: false; reason: string };

// Attempt to locate a landmark via deterministic label-anchored heuristics, then
// synthesize a stable CSS selector by reading the matched element's actual id,
// data-testid, or aria-label. Returns ok+selector only if the synthesized
// selector resolves back to a usable element (defensive round-trip).
export async function healWithLabel(page: Page, landmark: Landmark): Promise<LabelHealResult> {
  const finder = finders[landmark];
  if (!finder) return { ok: false, reason: `no label heuristic for landmark "${landmark}"` };

  const found = await finder(page);
  if (!found) return { ok: false, reason: 'label text not found on page' };
  if (!(await isUsable(found))) return { ok: false, reason: 'found element not usable (not visible)' };

  const selector = await synthesizeStableSelector(found);
  if (!selector) return { ok: false, reason: 'no stable selector could be derived from element' };

  const verify = page.locator(selector);
  if (!(await isUsable(verify))) {
    return { ok: false, reason: `synthesized selector "${selector}" did not round-trip` };
  }

  return { ok: true, loc: verify.first(), selector };
}
