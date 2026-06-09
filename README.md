# route-eval

End-to-end validation of the Route protection widget on top merchant carts. Starts with `scheels.com`; adding the next merchant is a config file, not a code change.

The headline feature is **`npm run heal`** — one command that crawls the merchant site to discover DOM selectors, runs the validation test, and on failure feeds the diagnostic back to the LLM and tries again. Up to N attempts. Most failures repair themselves.

## What it validates

For each configured merchant: drives a real (stealth) browser through product → cart, then asserts that Route's protection toggle actually changes the cart total. Specifically:

- The cart total isn't the same DOM element as Route's price (a common LLM mistake).
- Unchecking the Route toggle drops the cart total by exactly the Route price.
- Re-checking restores it.

The 5% subtotal rule isn't asserted — Route runs different plans per merchant (Scheels appears to be ~2.3%, others 5%). The toggle semantics are what we actually care about.

## The heal loop

```bash
npm run heal:scheels             # default 3 attempts
npm run heal:scheels -- --headed # watch it
npm run heal:scheels -- --attempts=5
```

Per attempt:

1. **Crawl.** Cache short-circuits previously-discovered landmarks. Any landmark missing from the cache is rediscovered by Claude. If a previous attempt failed, `<merchant>.feedback.json` exists with per-landmark hints — Claude's first prompt for those landmarks is seeded with "Your previous selector for X was Y, returned text Z, which doesn't fit; find a DIFFERENT element."
2. **Test.** Stealth Chromium runs the same flow as the Playwright spec but as a plain function that returns a structured `FlowFailure` instead of throwing.
3. **On fail.** Identify which landmark(s) are the most likely cause, delete those entries from `<merchant>.crawled.json`, write `<merchant>.feedback.json`, loop.
4. **On pass.** Clear `<merchant>.feedback.json` and exit ✓.

Discovery has three layers at crawl time (in order):

1. **Cache** — re-validate previously-discovered selectors against the current DOM.
2. **LLM** — Claude (or Ollama) inspects a trimmed DOM snapshot and returns a CSS selector.
3. **Label heuristic** — deterministic: search the live DOM for the landmark's well-known text label (`Subtotal`, `Total`, `Route`, etc.), find the nearest matching element, synthesize a selector from its real `id` / `data-testid` / `aria-label`.

Each candidate is gated by an **acceptance check** — price landmarks must yield text containing `$\d`, toggles must actually be checkboxes/switches, links must be clickable. A selector that resolves to *some* visible element but doesn't fit the landmark's shape is rejected so the next layer can try.

At runtime (the standalone test), the resolver consults: **`overrides`** (hand-curated final say) → **`crawled`** (heal-loop output) → **`hints`** (heuristic chain in the profile).

## Setup

```bash
npm install
npm run install:browsers
cp .env.example .env   # configure LLM provider
```

### LLM providers

Switched via `LLM_PROVIDER` in `.env`:

- **`anthropic`** (default). Needs `ANTHROPIC_API_KEY`. Default model `claude-sonnet-4-6`; `claude-haiku-4-5-20251001` is ~5× cheaper and works fine for selector picking.
- **`ollama`**. Local inference, no API key. `ollama pull qwen2.5:7b` (or `qwen2.5-coder:14b` for better selector quality on stronger hardware), then in `.env`:
  ```
  LLM_PROVIDER=ollama
  OLLAMA_MODEL=qwen2.5:7b
  OLLAMA_NUM_CTX=16384
  ```
  `OLLAMA_NUM_CTX` matters — the default 2048-token context truncates the 30k+ char HTML snapshot and the model returns garbage. 16384 is the safe floor.

## Other commands

```bash
npm run crawl:scheels              # crawl only (no test)
npm run crawl:scheels -- --force   # ignore cache, redo every landmark via LLM
npm test                           # Playwright spec only (assumes cache is valid)
npm run test:headed                # watch the test run
npm run report                     # open last Playwright HTML report
npm run typecheck                  # tsc --noEmit
```

## Inspecting what happened

| File / path | What it shows | When |
|---|---|---|
| `src/merchants/<name>.crawled.json` | Current selectors per landmark with `source` (`llm` / `cached` / `label`) and `confidence`. | Always. |
| `src/merchants/<name>.feedback.json` | Per-landmark feedback sent to Claude on the next crawl attempt — the exact "your previous selector returned X, find different" prompt. | Exists between a failed attempt and the next successful crawl. |
| `debug/crawl/<landmark>.<n>.{snippet.html,prompt.txt,response.txt}` | What Claude saw, what we asked, what it returned. | `CRAWL_DEBUG=1 npm run heal:scheels` |
| `playwright-report/` | Full HTML report with step screenshots and traces. | After `npm test`. Open with `npm run report`. |
| `test-results/<test>/trace.zip` | Time-traveling Playwright trace. | After a test failure. `npx playwright show-trace <path>`. |

The heal loop itself prints, on each failure: the step that failed, the current selector for each suspect landmark, and the text we actually read from each. That's usually enough to know whether the next attempt has a real chance.

## Adding a merchant

1. Copy `src/merchants/scheels.ts` → `src/merchants/<name>.ts`. Update `baseUrl`, optionally `cartUrl`, `productEntry`, and the `hints` map (a few good hints save LLM calls).
2. Copy `src/merchants/scheels.overrides.ts` → `src/merchants/<name>.overrides.ts` (empty is fine to start).
3. Register the profile in `src/merchants/registry.ts`.
4. Add `tests/<name>.spec.ts` (mirror `scheels.spec.ts`, swap the merchant name).
5. `npm run heal:<name>`.

## Notable internals

- **Stealth Playwright** via `playwright-extra` + `puppeteer-extra-plugin-stealth` — Cloudflare's bot detection blocks vanilla headless Chromium on most top merchants.
- **Hydration-aware navigation** — both crawl and test wait for `load`, `networkidle`, and a body-content threshold before discovering or asserting. Bare `domcontentloaded` races the SPA hydration on most merchants.
- **Post-add-to-cart wait** — many sites use optimistic UI for the "Added to cart" slide-out; the cart-save XHR finishes after the dialog renders. Navigating too eagerly drops the cart. 2.5s belt-and-braces wait between add and navigate.
- **Modal dismissal** — the popup sweep targets `[role="dialog"][aria-modal="true"]` overlays, tries close buttons inside the dialog, falls back to Escape.
- **`cartUrl` shortcut** — set on the merchant profile to navigate directly to the cart page instead of clicking a header icon (sidesteps mini-cart slide-out click-interception entirely).
