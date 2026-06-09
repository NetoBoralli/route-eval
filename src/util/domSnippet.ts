import type { Page } from '@playwright/test';

const MAX_CHARS = 60_000;

const DROP_TAGS = ['script', 'style', 'svg', 'noscript', 'iframe', 'link'];
const KEEP_ATTRS = [
  'id',
  'class',
  'name',
  'role',
  'aria-label',
  'aria-labelledby',
  'data-testid',
  'data-test',
  'data-qa',
  'data-cy',
  'href',
  'type',
  'value',
  'placeholder',
  'alt',
  'title',
];

// Returns a trimmed HTML snapshot of the page suitable for LLM consumption.
// Strips noisy tags (<script>, <style>, etc.) and most attributes that don't
// help locate elements. Truncates to MAX_CHARS to stay within token budgets.
//
// The in-browser callback intentionally avoids inner named functions: tsx/
// esbuild wraps named declarations with __name() for stack-trace fidelity,
// and that reference doesn't exist when Playwright serializes the function
// into the page context (ReferenceError: __name is not defined).
export async function snapshotDom(page: Page): Promise<string> {
  const raw = await page.evaluate(
    ({ dropTags, keepAttrs }) => {
      const clone = document.body.cloneNode(true) as HTMLElement;
      for (const sel of dropTags) {
        clone.querySelectorAll(sel).forEach((n) => n.remove());
      }
      const keep = new Set(keepAttrs);
      const stack: Element[] = [clone];
      while (stack.length > 0) {
        const el = stack.pop()!;
        for (const attr of Array.from(el.attributes)) {
          if (!keep.has(attr.name)) el.removeAttribute(attr.name);
        }
        for (const child of Array.from(el.children)) stack.push(child);
      }
      return clone.outerHTML;
    },
    { dropTags: DROP_TAGS, keepAttrs: KEEP_ATTRS },
  );
  return raw.length > MAX_CHARS ? `${raw.slice(0, MAX_CHARS)}\n<!-- truncated -->` : raw;
}
