import type { Locator, Page } from '@playwright/test';
import type { Landmark } from '../merchants/types.js';

type SynthesizeResult =
  | { ok: true; selector: string; via: 'id' | 'attribute' | 'class' | 'path' }
  | { ok: false; reason: string };

// Inspect a uniquely-matched element and produce a stable standard-CSS selector
// for it, preferring stable attributes, then unique classes, then a structural
// tag-position path. Never returns null silently — any failure carries a
// human-readable reason that surfaces in the crawl log.
async function synthesizeStableSelector(loc: Locator): Promise<SynthesizeResult> {
  try {
    // The evaluated body deliberately avoids named function/const declarations.
    // tsx/esbuild wraps named declarations with __name() for stack-trace
    // fidelity, and that helper doesn't exist in the page's browser context
    // (ReferenceError: __name is not defined). Everything inline.
    const raw = await loc.first().evaluate((node: Element) => {
      const out: { selector?: string; via?: string; reason?: string } = {};
      if (!(node instanceof Element)) {
        out.reason = `matched node is not an Element (got ${typeof node})`;
        return out;
      }
      if (node.id) {
        out.selector = `#${node.id.replace(/[^a-zA-Z0-9_-]/g, (c) => `\\${c}`)}`;
        out.via = 'id';
        return out;
      }
      const ATTRS = ['data-testid', 'data-qa', 'data-cy', 'data-test', 'aria-label', 'name'];
      for (let i = 0; i < ATTRS.length; i++) {
        const attr = ATTRS[i]!;
        const v = node.getAttribute(attr);
        if (v) {
          out.selector = `[${attr}="${v.replace(/"/g, '\\"')}"]`;
          out.via = 'attribute';
          return out;
        }
      }
      // Try unique class names — any individual class globally unique on the
      // page wins.
      const classes = Array.from(node.classList);
      for (let i = 0; i < classes.length; i++) {
        const cls = classes[i]!;
        if (!cls || /^[0-9]/.test(cls)) continue;
        const escaped = cls.replace(/[^a-zA-Z0-9_-]/g, (c) => `\\${c}`);
        const matches = document.querySelectorAll(`.${escaped}`);
        if (matches.length === 1 && matches[0] === node) {
          out.selector = `.${escaped}`;
          out.via = 'class';
          return out;
        }
      }
      // Structural tag+position path, up to 8 hops or until BODY.
      const path: string[] = [];
      let cur: Element | null = node;
      while (cur && cur.tagName !== 'BODY' && path.length < 8) {
        let part = cur.tagName.toLowerCase();
        const parent: Element | null = cur.parentElement;
        if (parent) {
          let idx = 1;
          let sib: Element | null = cur.previousElementSibling;
          while (sib) {
            if (sib.tagName === cur.tagName) idx++;
            sib = sib.previousElementSibling;
          }
          let total = 0;
          for (let ci = 0; ci < parent.children.length; ci++) {
            if (parent.children[ci]!.tagName === cur.tagName) total++;
          }
          if (total > 1) part += `:nth-of-type(${idx})`;
        }
        path.unshift(part);
        cur = parent;
      }
      if (path.length === 0) {
        out.reason = `node has no parent chain (tag=${node.tagName})`;
        return out;
      }
      out.selector = path.join(' > ');
      out.via = 'path';
      return out;
    });

    if (raw.selector && raw.via) {
      return {
        ok: true,
        selector: raw.selector,
        via: raw.via as 'id' | 'attribute' | 'class' | 'path',
      };
    }
    return { ok: false, reason: raw.reason ?? 'synthesizer returned no selector' };
  } catch (err) {
    return { ok: false, reason: `evaluate threw: ${(err as Error).message}` };
  }
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
    // Find the SMALLEST visible element whose text contains both "Subtotal"
    // AND a $-amount. Walking up ancestors from a "Subtotal" label captures
    // sibling rows (Route's $2.49 line often appears BEFORE the Subtotal row
    // in DOM order, contaminating any first-$-in-ancestor match). Scanning for
    // smallest text-match scopes naturally to the cart-summary row.
    //
    // The found element gets tagged with a temporary marker attribute so we
    // can build a Locator from it; the synthesizer then derives a stable
    // selector from the element's REAL attributes (id, data-testid, unique
    // class, or structural path) — the marker itself isn't included in the
    // attribute scan list so it's never what gets cached.
    const handle = await page.evaluateHandle(() => {
      let best: Element | null = null;
      let bestSize = Infinity;
      const all = document.querySelectorAll('body *');
      for (let i = 0; i < all.length; i++) {
        const el = all[i];
        if (!el) continue;
        const txt = (el.textContent || '').trim();
        if (txt.length > 200 || txt.length < 5) continue;
        if (!/subtotal/i.test(txt)) continue;
        if (!/\$\s*\d/.test(txt)) continue;
        if (txt.length < bestSize) {
          bestSize = txt.length;
          best = el;
        }
      }
      if (best) (best as HTMLElement).setAttribute('data-route-eval-label-match', 'subtotal');
      return best;
    });
    const el = handle.asElement();
    if (!el) {
      await handle.dispose();
      return null;
    }
    await handle.dispose();
    const loc = page.locator('[data-route-eval-label-match="subtotal"]');
    if (!(await loc.first().isVisible({ timeout: 500 }).catch(() => false))) return null;
    return loc.first();
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

  const synth = await synthesizeStableSelector(found);
  if (!synth.ok) {
    return { ok: false, reason: `synthesizer failed: ${synth.reason}` };
  }

  const verify = page.locator(synth.selector);
  if (!(await isUsable(verify))) {
    return {
      ok: false,
      reason: `synthesized selector "${synth.selector}" (via ${synth.via}) did not round-trip`,
    };
  }

  return { ok: true, loc: verify.first(), selector: synth.selector };
}
