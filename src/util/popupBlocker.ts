import type { BrowserContext, Page } from '@playwright/test';

// Installed via page.addInitScript so it runs before any other JS on every
// frame. Watches the DOM for marketing modals (Klaviyo, Privy, Bouncer, etc.)
// and removes them the moment they're injected. Merchants frequently render
// these on a delay AFTER initial load, where our sweepPopups call has already
// happened — the observer catches them mid-test before they intercept clicks.
const INIT_SCRIPT = `
(function () {
  if (window.__routeEvalPopupBlockerInstalled) return;
  window.__routeEvalPopupBlockerInstalled = true;

  var BLOCK_PATTERNS = [
    function (el) {
      // Klaviyo signup modals
      var cls = el.className || '';
      return typeof cls === 'string' && /kl-private-reset-css/.test(cls);
    },
    function (el) {
      // Any modal dialog whose aria-label includes "POPUP" or "signup" or
      // "newsletter" — these are almost always marketing.
      if (el.getAttribute('role') !== 'dialog') return false;
      if (el.getAttribute('aria-modal') !== 'true') return false;
      var label = (el.getAttribute('aria-label') || '').toLowerCase();
      return /popup|signup|newsletter|subscribe|email/.test(label);
    },
  ];

  function shouldBlock(el) {
    if (!(el instanceof Element)) return false;
    for (var i = 0; i < BLOCK_PATTERNS.length; i++) {
      try { if (BLOCK_PATTERNS[i](el)) return true; } catch (e) {}
    }
    return false;
  }

  function sweep(root) {
    if (!root || !root.querySelectorAll) return;
    var candidates = root.querySelectorAll('[role="dialog"], [class*="kl-private"]');
    for (var i = 0; i < candidates.length; i++) {
      if (shouldBlock(candidates[i])) {
        try { candidates[i].remove(); } catch (e) {}
      }
    }
  }

  function install() {
    var target = document.body || document.documentElement;
    if (!target) {
      setTimeout(install, 50);
      return;
    }
    sweep(target);
    var observer = new MutationObserver(function (mutations) {
      for (var i = 0; i < mutations.length; i++) {
        var added = mutations[i].addedNodes;
        for (var j = 0; j < added.length; j++) {
          var node = added[j];
          if (shouldBlock(node)) {
            try { node.remove(); } catch (e) {}
          } else if (node && node.querySelectorAll) {
            sweep(node);
          }
        }
      }
    });
    observer.observe(target, { childList: true, subtree: true });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', install);
  } else {
    install();
  }
})();
`;

export async function installPopupBlocker(target: Page | BrowserContext): Promise<void> {
  await target.addInitScript(INIT_SCRIPT);
}
