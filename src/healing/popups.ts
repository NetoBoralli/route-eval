import type { Locator, Page } from '@playwright/test';
import type { SelectorHint, SiteProfile } from '../merchants/types.js';
import { buildLocator, describeHint } from './resolver.js';

// Conservative global popup patterns. Tries each one with a short timeout
// so we don't slow the flow down when nothing's blocking.
const GLOBAL_HINTS: SelectorHint[] = [
  { kind: 'role', role: 'button', name: /^accept all$/i },
  { kind: 'role', role: 'button', name: /accept (all )?cookies?/i },
  { kind: 'role', role: 'button', name: /^i agree$/i },
  { kind: 'role', role: 'button', name: /^agree$/i },
  { kind: 'role', role: 'button', name: /^got it$/i },
  { kind: 'role', role: 'button', name: /^no thanks$/i },
  { kind: 'role', role: 'button', name: /^not now$/i },
  { kind: 'role', role: 'button', name: /^maybe later$/i },
  { kind: 'role', role: 'button', name: /^close$/i },
  { kind: 'role', role: 'button', name: /dismiss/i },
];

// Modal dialogs (the post-add-to-cart slide-out on Scheels, etc.) often don't
// have a matching button at the page level — the close button only exists
// inside the dialog itself. Find any visible modal and try to dismiss it.
async function dismissModalDialogs(page: Page): Promise<boolean> {
  const dialogs = page.locator('[role="dialog"][aria-modal="true"]');
  const count = await dialogs.count().catch(() => 0);
  let dismissed = false;
  for (let i = 0; i < count; i++) {
    const dlg = dialogs.nth(i);
    if (!(await dlg.isVisible({ timeout: 250 }).catch(() => false))) continue;
    const closeCandidates = dlg.locator(
      [
        'button[aria-label*="close" i]',
        'button[aria-label*="dismiss" i]',
        'button[title*="close" i]',
        '[role="button"][aria-label*="close" i]',
      ].join(', '),
    );
    if (await closeCandidates.first().isVisible({ timeout: 250 }).catch(() => false)) {
      try {
        await closeCandidates.first().click({ timeout: 1500 });
        // eslint-disable-next-line no-console
        console.log('[popup] dismissed modal via in-dialog close button');
        dismissed = true;
        await page.waitForTimeout(250);
        continue;
      } catch {
        // fall through to Escape
      }
    }
    try {
      await page.keyboard.press('Escape');
      // eslint-disable-next-line no-console
      console.log('[popup] sent Escape to dismiss modal');
      dismissed = true;
      await page.waitForTimeout(250);
    } catch {
      // continue to nuclear option
    }

    // Nuclear fallback: if the dialog is STILL visible after close-button and
    // Escape, remove it from the DOM directly. Marketing popups (Klaviyo etc.)
    // often trap Escape and have no detectable close button — this guarantees
    // they won't intercept downstream clicks.
    if (await dlg.isVisible({ timeout: 250 }).catch(() => false)) {
      try {
        await dlg.evaluate((node) => {
          if (node instanceof Element) node.remove();
        });
        // eslint-disable-next-line no-console
        console.log('[popup] removed stuck modal from DOM');
        dismissed = true;
      } catch {
        // best-effort
      }
    }
  }
  return dismissed;
}

export async function sweepPopups(page: Page, profile: SiteProfile): Promise<void> {
  const hints = [...(profile.popupHints ?? []), ...GLOBAL_HINTS];
  for (const hint of hints) {
    let loc: Locator;
    try {
      loc = buildLocator(page, hint);
    } catch {
      continue;
    }
    try {
      const count = await loc.count();
      if (count === 0) continue;
      const first = loc.first();
      if (!(await first.isVisible({ timeout: 250 }).catch(() => false))) continue;
      await first.click({ timeout: 1500 });
      // eslint-disable-next-line no-console
      console.log(`[popup] dismissed via ${describeHint(hint)}`);
      await page.waitForTimeout(250);
      return sweepPopups(page, profile);
    } catch {
      // best-effort
    }
  }
  // After hint-based sweep, dismiss any modal dialogs still blocking the page.
  if (await dismissModalDialogs(page)) {
    // Re-run the sweep in case dismissing the modal revealed another popup underneath.
    return sweepPopups(page, profile);
  }
}
