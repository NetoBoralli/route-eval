import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { LANDMARKS, type Landmark } from '../merchants/types.js';
import type { FlowFailure } from '../flow/widgetCheckPlain.js';

const FeedbackFileSchema = z.object({
  merchant: z.string(),
  writtenAt: z.string(),
  attempt: z.number(),
  entries: z.record(z.enum(LANDMARKS), z.string()),
});

export type FeedbackFile = z.infer<typeof FeedbackFileSchema>;

export function feedbackFilePath(merchantName: string): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, '..', 'merchants', `${merchantName}.feedback.json`);
}

export function readFeedback(merchantName: string): FeedbackFile | undefined {
  const path = feedbackFilePath(merchantName);
  if (!existsSync(path)) return undefined;
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    const parsed = FeedbackFileSchema.safeParse(raw);
    if (!parsed.success) return undefined;
    return parsed.data;
  } catch {
    return undefined;
  }
}

export function clearFeedback(merchantName: string): void {
  const path = feedbackFilePath(merchantName);
  if (existsSync(path)) {
    try {
      unlinkSync(path);
    } catch {
      // best-effort
    }
  }
}

// Construct the per-landmark feedback strings to seed Claude's next prompt
// from a flow failure. Each suspect landmark gets a tailored explanation of
// what went wrong with its previous selector.
export function writeFeedbackFromFailure(
  merchantName: string,
  attempt: number,
  failure: FlowFailure,
  previousHints: Partial<Record<Landmark, string>>,
): void {
  const entries: Partial<Record<Landmark, string>> = {};
  for (const landmark of failure.suspectLandmarks) {
    const prevSelector = previousHints[landmark] ?? '<unknown>';
    const prevText = failure.readValues?.[landmark];
    const parts: string[] = [
      `Your previous selector for "${landmark}" was: ${prevSelector}.`,
    ];
    if (prevText) {
      parts.push(`Reading from that selector returned text: ${JSON.stringify(prevText)}.`);
    }
    parts.push(`Test failure at step "${failure.step}": ${failure.message}`);
    parts.push(
      `Find a DIFFERENT element. Do not return the previous selector again. ` +
        `Read the HTML carefully and identify the element that actually matches "${landmark}".`,
    );
    entries[landmark] = parts.join(' ');
  }
  const payload: FeedbackFile = {
    merchant: merchantName,
    writtenAt: new Date().toISOString(),
    attempt,
    entries,
  };
  writeFileSync(feedbackFilePath(merchantName), `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}
