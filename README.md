# route-eval

End-to-end validation of the Route protection widget on top merchant carts. Starts with `scheels.com`; adding the next merchant is a config file, not a code change.

## Two-stage flow

The tool is deliberately split into a **discovery** stage and a **verification** stage so the Playwright test is deterministic and never depends on an LLM at runtime.

### 1. Crawl (Claude discovers selectors)

```bash
npm run crawl:scheels
```

Drives a real browser through product → cart, and at each landmark (add-to-cart, cart link, subtotal, total, Route toggle, Route price) writes a CSS selector to `src/merchants/<name>.crawled.json`.

**First run:** no cache exists, so Claude discovers every landmark from scratch.

**Subsequent runs:** for each landmark, the crawler tries the cached selector against the live DOM first; if it still resolves, the entry is reused (zero API calls) and tagged `source: "cached"`. If it doesn't resolve (the merchant redesigned that area), Claude re-discovers that one landmark and tags it `source: "llm"` with the new timestamp.

Add `-- --force` to ignore the cache and rediscover everything via Claude.

### 2. Test (Playwright verifies behavior)

```bash
npm test
```

The Playwright spec drives product → cart and asserts:

- Route widget renders with a price.
- Route price is ~5% of subtotal (within a 2-cent tolerance).
- Unchecking Route drops the cart total by exactly the Route price.
- Re-checking Route restores the cart total.

The resolver consults sources in this order for each landmark:

1. **`overrides`** — hand-curated in `<name>.overrides.ts`. Final say.
2. **`crawled`** — written by the crawl above. Stale crawl → re-run `npm run crawl`.
3. **`hints`** — heuristic chain in the profile, universal fallback.
4. Throws with a clear message and re-crawl suggestion.

## Setup

```bash
npm install
npm run install:browsers
cp .env.example .env   # configure LLM provider for the crawl
```

### LLM providers

The crawl supports two providers, switched via `LLM_PROVIDER` in `.env`:

- **`anthropic`** (default). Requires `ANTHROPIC_API_KEY`. Default model `claude-sonnet-4-6`; set `ANTHROPIC_MODEL=claude-haiku-4-5-20251001` for a cheaper, smaller model.
- **`ollama`**. Local inference, no API key. Install [Ollama](https://ollama.com), pull a model that's good at structured output and ~Haiku-class:
  ```bash
  ollama pull qwen2.5:7b
  ```
  Then in `.env`:
  ```
  LLM_PROVIDER=ollama
  OLLAMA_MODEL=qwen2.5:7b
  OLLAMA_NUM_CTX=16384
  ```
  `OLLAMA_NUM_CTX` matters — Ollama's default 2048-token context will truncate the 30k-char HTML snapshot and the model will return garbage. 16384 is the safe floor.

## Common commands

```bash
npm run crawl:scheels         # discover/refresh selectors for scheels.com
npm run crawl:scheels -- --headed   # watch the crawler work
npm test                      # run the validation suite (headless)
npm run test:headed           # watch the test run
npm run report                # open the last Playwright HTML report
npm run typecheck             # tsc --noEmit
```

## Adding a merchant

1. Copy `src/merchants/scheels.ts` → `src/merchants/<name>.ts`. Update `baseUrl`, `productEntry`, and the `hints` map (a few good hints save LLM calls).
2. Copy `src/merchants/scheels.overrides.ts` → `src/merchants/<name>.overrides.ts` (empty to start).
3. Register the profile in `src/merchants/registry.ts`.
4. Copy `tests/scheels.spec.ts` → `tests/<name>.spec.ts` and swap the merchant name.
5. `npm run crawl:<name>` then `npm test -- <name>`.
