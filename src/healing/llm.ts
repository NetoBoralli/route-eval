import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import type { Page } from '@playwright/test';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { Landmark } from '../merchants/types.js';
import { snapshotDom } from '../util/domSnippet.js';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describeLocator, locatorIsUsable } from './resolver.js';

// Find the first balanced top-level {...} in a string, respecting strings and
// escapes. Robust to models that emit prose before/after the JSON. The naive
// indexOf('{')..lastIndexOf('}') extraction failed when Claude trailed the JSON
// with explanatory text containing another close-brace.
function extractFirstJsonObject(raw: string): string | null {
  let start = -1;
  let depth = 0;
  let inString: '"' | "'" | null = null;
  let escape = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (inString) {
      if (escape) {
        escape = false;
        continue;
      }
      if (ch === '\\') {
        escape = true;
        continue;
      }
      if (ch === inString) inString = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = ch;
      continue;
    }
    if (ch === '{') {
      if (start === -1) start = i;
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0 && start !== -1) return raw.slice(start, i + 1);
    }
  }
  return null;
}

type PostJsonResult = { status: number; text: string };

// Plain node:http POST. Bypasses undici/fetch's 30s headers timeout — local
// model inference (especially first-call model-load) routinely exceeds that.
function postJson(url: string, body: unknown, timeoutMs: number): Promise<PostJsonResult> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const transport = u.protocol === 'https:' ? httpsRequest : httpRequest;
    const payload = JSON.stringify(body);
    const req = transport(
      {
        method: 'POST',
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: `${u.pathname}${u.search}`,
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload).toString(),
        },
      },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, text: data }));
        res.on('error', reject);
      },
    );
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`request timed out after ${timeoutMs}ms`));
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

const LandmarkDescriptions: Record<Landmark, string> = {
  addToCart: 'the primary "Add to Cart" button on a product page',
  cartLink: 'a link or button that navigates to the shopping cart page',
  cartSubtotal:
    'the cart subtotal amount — total of items BEFORE the Route protection fee, taxes, or shipping',
  cartTotal: 'the cart grand total amount including all line items, Route fee, tax, etc.',
  routeToggle:
    'the Route package protection toggle (checkbox or switch) that adds/removes the Route fee from the cart',
  routePrice: 'the displayed price of the Route package protection line item in the cart',
};

const ResponseSchema = z.object({
  selector: z.string().min(1),
  confidence: z.enum(['high', 'medium', 'low']),
  reasoning: z.string().optional(),
});

export type LlmHealResult =
  | { ok: true; selector: string; confidence: 'high' | 'medium' | 'low' }
  | { ok: false; reason: string };

type Provider = 'anthropic' | 'ollama';

function currentProvider(): Provider {
  const raw = (process.env.LLM_PROVIDER ?? 'anthropic').toLowerCase();
  return raw === 'ollama' ? 'ollama' : 'anthropic';
}

const SYSTEM_PROMPT =
  'You inspect a trimmed HTML snapshot of a live e-commerce page and return a single ' +
  'standard CSS selector for a specific landmark element. You MUST use attribute values ' +
  'that literally appear in the HTML — do not invent or guess attribute values. Respond ' +
  'with JSON only — no prose, no markdown fences, no code blocks.';

function userPromptFor(landmark: Landmark, snippet: string, feedback?: string): string {
  const feedbackBlock = feedback
    ? `\n\nIMPORTANT — your previous answer failed:\n${feedback}\n\nLook again at the HTML. Find the actual element. Use attribute values that exist verbatim in the HTML below.\n`
    : '';
  return (
    `Landmark to locate: ${landmark} — ${LandmarkDescriptions[landmark]}\n\n` +
    `Return JSON in this exact shape:\n` +
    `{"selector": "<one CSS selector for page.locator(...)>", "confidence": "high|medium|low", "reasoning": "<one short sentence>"}\n\n` +
    `STRICT RULES:\n` +
    `- Return exactly ONE selector. No commas, no alternatives, no fallbacks.\n` +
    `- Standard CSS only. No XPath. No Playwright pseudo-classes like :has-text(), :visible, :nth-match().\n` +
    `- Every attribute value in the selector MUST appear literally in the HTML below. If the HTML shows id="add-to-cart", use #add-to-cart — do not invent data-testid="addToCart".\n` +
    `- Prefer in order: #id → [data-testid="..."] → [aria-label="..."] → tag+role-based attribute → class name.\n` +
    `- The selector must match exactly one visible element.${feedbackBlock}\n\n` +
    `HTML:\n${snippet}`
  );
}

type ProviderCall =
  | { ok: true; text: string }
  | { ok: false; reason: string };

async function callAnthropic(userPrompt: string): Promise<ProviderCall> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return { ok: false, reason: 'ANTHROPIC_API_KEY not set' };
  const client = new Anthropic({ apiKey });
  const model = process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-4-6';
  try {
    const response = await client.messages.create({
      model,
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: [{ type: 'text', text: userPrompt }] }],
    });
    const block = response.content.find((b) => b.type === 'text');
    if (!block || block.type !== 'text') return { ok: false, reason: 'LLM returned no text block' };
    return { ok: true, text: block.text.trim() };
  } catch (err) {
    return { ok: false, reason: `Anthropic call failed: ${(err as Error).message}` };
  }
}

async function callOllama(userPrompt: string): Promise<ProviderCall> {
  const baseUrl = (process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434').replace(/\/$/, '');
  const model = process.env.OLLAMA_MODEL ?? 'qwen2.5:7b';
  // qwen2.5:7b ships with 32k context; default Ollama num_ctx is 2048 which truncates
  // our 30k-char prompt. Match the snapshot ceiling generously.
  const numCtx = Number(process.env.OLLAMA_NUM_CTX ?? '16384');
  // Local models can take a long time on first call (model load + 30k-char prompt).
  // Default 10 minutes; override with OLLAMA_TIMEOUT_MS.
  const timeoutMs = Number(process.env.OLLAMA_TIMEOUT_MS ?? '600000');
  try {
    const res = await postJson(
      `${baseUrl}/api/chat`,
      {
        model,
        stream: false,
        format: 'json',
        options: { temperature: 0, num_ctx: numCtx },
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: userPrompt },
        ],
      },
      timeoutMs,
    );
    if (res.status < 200 || res.status >= 300) {
      return { ok: false, reason: `Ollama HTTP ${res.status}: ${res.text.slice(0, 300)}` };
    }
    const json = JSON.parse(res.text) as { message?: { content?: string } };
    const text = json.message?.content?.trim();
    if (!text) return { ok: false, reason: 'Ollama returned no message content' };
    return { ok: true, text };
  } catch (err) {
    return { ok: false, reason: `Ollama call to ${baseUrl} failed: ${(err as Error).message}` };
  }
}

// Split "a, b, c" into ["a","b","c"] — respects parens and brackets so we don't
// cut through `:has(x, y)` or `[attr="a, b"]`. Falls back to the original string
// when the result would be empty.
function splitAlternatives(selector: string): string[] {
  const parts: string[] = [];
  let buf = '';
  let depth = 0;
  let quote: string | null = null;
  for (const ch of selector) {
    if (quote) {
      buf += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      buf += ch;
      continue;
    }
    if (ch === '(' || ch === '[') depth++;
    else if (ch === ')' || ch === ']') depth--;
    if (ch === ',' && depth === 0) {
      const t = buf.trim();
      if (t) parts.push(t);
      buf = '';
      continue;
    }
    buf += ch;
  }
  const t = buf.trim();
  if (t) parts.push(t);
  return parts.length > 0 ? parts : [selector];
}

type AttemptDetail = { selector: string; count: number; visible: boolean; error?: string };

// Try the LLM's raw selector against the page. Handles comma-separated
// alternatives by testing each individually. Returns the first that resolves
// to a visible element, or a detailed breakdown of every attempt.
async function pickUsableAlternative(
  page: Page,
  rawSelector: string,
): Promise<{ ok: true; selector: string } | { ok: false; tried: AttemptDetail[] }> {
  const alternatives = splitAlternatives(rawSelector);
  const tried: AttemptDetail[] = [];
  for (const alt of alternatives) {
    try {
      const loc = page.locator(alt);
      if (await locatorIsUsable(loc)) {
        return { ok: true, selector: alt };
      }
      const detail = await describeLocator(loc);
      tried.push({ selector: alt, count: detail.count, visible: detail.visible });
    } catch (err) {
      tried.push({ selector: alt, count: 0, visible: false, error: (err as Error).message });
    }
  }
  return { ok: false, tried };
}

function formatTried(tried: AttemptDetail[]): string {
  return tried
    .map((t) => {
      if (t.error) return `${JSON.stringify(t.selector)} → parse error: ${t.error}`;
      if (t.count === 0) return `${JSON.stringify(t.selector)} → 0 matches`;
      return `${JSON.stringify(t.selector)} → ${t.count} match(es), first visible=${t.visible}`;
    })
    .join(' | ');
}

// Per-run debug dump dir (set via CRAWL_DEBUG_DIR or implied by CRAWL_DEBUG=1).
function debugDir(): string | null {
  if (process.env.CRAWL_DEBUG_DIR) return process.env.CRAWL_DEBUG_DIR;
  if (process.env.CRAWL_DEBUG === '1') return 'debug/crawl';
  return null;
}

function dumpDebug(landmark: Landmark, attempt: number, files: Record<string, string>): void {
  const dir = debugDir();
  if (!dir) return;
  try {
    mkdirSync(dir, { recursive: true });
    for (const [name, content] of Object.entries(files)) {
      writeFileSync(join(dir, `${landmark}.${attempt}.${name}`), content, 'utf8');
    }
  } catch {
    // best-effort
  }
}

async function runOneAttempt(
  page: Page,
  landmark: Landmark,
  snippet: string,
  provider: Provider,
  feedback: string | undefined,
  attemptNumber: number,
): Promise<{ ok: true; selector: string; confidence: 'high' | 'medium' | 'low' } | { ok: false; reason: string }> {
  const userPrompt = userPromptFor(landmark, snippet, feedback);
  dumpDebug(landmark, attemptNumber, { 'snippet.html': snippet, 'prompt.txt': userPrompt });

  const call = provider === 'ollama' ? await callOllama(userPrompt) : await callAnthropic(userPrompt);
  if (!call.ok) return { ok: false, reason: `[${provider}] ${call.reason}` };

  dumpDebug(landmark, attemptNumber, { 'response.txt': call.text });

  const raw = call.text;
  const jsonText = extractFirstJsonObject(raw);
  if (!jsonText) {
    return { ok: false, reason: `[${provider}] response is not JSON: ${raw.slice(0, 200)}` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch (err) {
    return { ok: false, reason: `[${provider}] JSON parse failed: ${(err as Error).message}` };
  }
  const validated = ResponseSchema.safeParse(parsed);
  if (!validated.success) {
    return { ok: false, reason: `[${provider}] JSON shape invalid: ${validated.error.message}` };
  }

  const picked = await pickUsableAlternative(page, validated.data.selector);
  if (!picked.ok) {
    return {
      ok: false,
      reason: `[${provider}] ${formatTried(picked.tried)}`,
    };
  }
  return { ok: true, selector: picked.selector, confidence: validated.data.confidence };
}

export type HealOptions = {
  // Seeded feedback from a previous failed test run — included in the LLM's
  // first prompt so it doesn't just return the same selector again.
  initialFeedback?: string;
};

export async function healWithLLM(
  page: Page,
  landmark: Landmark,
  options: HealOptions = {},
): Promise<LlmHealResult> {
  let snippet: string;
  try {
    snippet = await snapshotDom(page);
  } catch (err) {
    return { ok: false, reason: `DOM snapshot failed: ${(err as Error).message}` };
  }
  if (!snippet || snippet.length < 200) {
    const url = page.url();
    const title = await page.title().catch(() => '<no title>');
    return {
      ok: false,
      reason:
        `DOM snapshot too small (${snippet?.length ?? 0} chars). ` +
        `url=${url} title=${JSON.stringify(title)}. ` +
        `Either the page didn't hydrate before snapshot, or the merchant is bot-blocking.`,
    };
  }

  const provider = currentProvider();
  const first = await runOneAttempt(page, landmark, snippet, provider, options.initialFeedback, 1);
  if (first.ok) return first;

  // One retry with feedback — gives the model a second chance to actually read
  // the HTML after its first guess didn't match.
  // eslint-disable-next-line no-console
  console.log(`[heal ${landmark}] retrying after: ${first.reason}`);
  const retry = await runOneAttempt(page, landmark, snippet, provider, first.reason, 2);
  if (retry.ok) return retry;
  return { ok: false, reason: `first attempt: ${first.reason}; retry: ${retry.reason}` };
}
