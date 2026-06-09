import { writeFileSync } from 'node:fs';
import type { Landmark, SelectorHint } from '../merchants/types.js';
import { LANDMARKS } from '../merchants/types.js';
import { getMerchant } from '../merchants/registry.js';
import {
  crawledFilePath,
  readCrawledFile,
  type CrawledFile,
} from '../merchants/registry.js';
import { crawlMerchant } from '../crawl/crawl.js';
import { runWidgetCheckPlain } from '../flow/widgetCheckPlain.js';
import { stealthChromium } from '../util/stealthChromium.js';
import { writeFeedbackFromFailure } from './feedback.js';

export type HealLoopOptions = {
  maxAttempts?: number;
  headed?: boolean;
};

function describeHint(hint: SelectorHint): string {
  switch (hint.kind) {
    case 'css':
      return hint.css;
    case 'testId':
      return `[data-testid="${hint.testId}"]`;
    case 'role':
      return `role=${hint.role}${hint.name ? ` name=${hint.name}` : ''}`;
    case 'text':
      return `text=${hint.text}${hint.tag ? ` (in <${hint.tag}>)` : ''}`;
  }
}

// Remove specific landmarks from the merchant's crawled.json so the next
// crawl re-discovers them via Claude (with the feedback we just wrote).
function invalidateEntries(
  merchantName: string,
  landmarksToInvalidate: Landmark[],
): { previousHints: Partial<Record<Landmark, string>>; remaining: CrawledFile | null } {
  const file = readCrawledFile(merchantName);
  if (!file) return { previousHints: {}, remaining: null };
  const previousHints: Partial<Record<Landmark, string>> = {};
  for (const lm of landmarksToInvalidate) {
    const entry = file.entries[lm];
    if (entry) {
      previousHints[lm] = describeHint(entry.hint);
      delete file.entries[lm];
    }
  }
  writeFileSync(crawledFilePath(merchantName), `${JSON.stringify(file, null, 2)}\n`, 'utf8');
  return { previousHints, remaining: file };
}

function snapshotCurrentHints(merchantName: string): Partial<Record<Landmark, string>> {
  const file = readCrawledFile(merchantName);
  if (!file) return {};
  const out: Partial<Record<Landmark, string>> = {};
  for (const lm of LANDMARKS) {
    const entry = file.entries[lm];
    if (entry) out[lm] = describeHint(entry.hint);
  }
  return out;
}

async function runTestOnce(merchantName: string, headed: boolean): Promise<
  { ok: true } | { ok: false; failure: import('../flow/widgetCheckPlain.js').FlowFailure }
> {
  const profile = getMerchant(merchantName);
  const browser = await stealthChromium.launch({ headless: !headed });
  const context = await browser.newContext({
    locale: 'en-US',
    viewport: { width: 1440, height: 900 },
  });
  const page = await context.newPage();
  try {
    return await runWidgetCheckPlain(page, profile);
  } finally {
    await browser.close();
  }
}

export async function healLoop(
  merchantName: string,
  options: HealLoopOptions = {},
): Promise<boolean> {
  const maxAttempts = options.maxAttempts ?? 3;
  const headed = options.headed ?? false;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // eslint-disable-next-line no-console
    console.log(`\n=== heal attempt ${attempt}/${maxAttempts} ===`);

    // Crawl. On first attempt this respects the existing cache; on retries it
    // sees feedback.json for the invalidated landmarks and re-runs Claude only
    // for those.
    try {
      const profile = getMerchant(merchantName);
      await crawlMerchant(profile, { headed });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[heal] crawl failed: ${(err as Error).message}`);
      if (attempt === maxAttempts) return false;
      continue;
    }

    // Snapshot the hints we just produced — we'll need them to attribute the
    // failure to the right previous selector.
    const hintsBeforeTest = snapshotCurrentHints(merchantName);

    // Test
    let testResult;
    try {
      testResult = await runTestOnce(merchantName, headed);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[heal] test crashed: ${(err as Error).message}`);
      if (attempt === maxAttempts) return false;
      continue;
    }

    if (testResult.ok) {
      // eslint-disable-next-line no-console
      console.log(`\n✓ Passed on attempt ${attempt}.`);
      return true;
    }

    const failure = testResult.failure;
    const readSummary =
      failure.readValues && Object.keys(failure.readValues).length > 0
        ? `\n  values read:\n` +
          Object.entries(failure.readValues)
            .map(([k, v]) => `    ${k}: ${JSON.stringify(v)}`)
            .join('\n')
        : '';
    const selectorSummary =
      failure.suspectLandmarks.length > 0
        ? `\n  current selectors:\n` +
          failure.suspectLandmarks
            .map((lm) => `    ${lm}: ${hintsBeforeTest[lm] ?? '<none>'}`)
            .join('\n')
        : '';
    // eslint-disable-next-line no-console
    console.log(
      `✗ Failed at step "${failure.step}": ${failure.message}\n` +
        `  suspect landmarks: ${failure.suspectLandmarks.join(', ') || '(none)'}` +
        selectorSummary +
        readSummary,
    );

    if (failure.suspectLandmarks.length === 0 || attempt === maxAttempts) {
      // eslint-disable-next-line no-console
      console.log(
        attempt === maxAttempts
          ? `\nGiving up after ${maxAttempts} attempts.`
          : `\nNo recoverable suspect landmarks — bailing.`,
      );
      return false;
    }

    // Invalidate suspect entries and write feedback for the next crawl.
    const { previousHints } = invalidateEntries(merchantName, failure.suspectLandmarks);
    writeFeedbackFromFailure(merchantName, attempt + 1, failure, {
      ...hintsBeforeTest,
      ...previousHints,
    });
    // eslint-disable-next-line no-console
    console.log(
      `  invalidated ${failure.suspectLandmarks.join(', ')} and wrote feedback for next attempt.`,
    );
  }

  return false;
}
