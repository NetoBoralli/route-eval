import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { Landmark, SelectorHint, SiteProfile } from './types.js';
import { LANDMARKS } from './types.js';
import { scheels } from './scheels.js';

const SelectorHintSchema: z.ZodType<SelectorHint> = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('role'),
    role: z.enum(['button', 'link', 'checkbox', 'switch']),
    name: z.string().optional(),
  }),
  z.object({ kind: z.literal('testId'), testId: z.string() }),
  z.object({ kind: z.literal('text'), text: z.string(), tag: z.string().optional() }),
  z.object({ kind: z.literal('css'), css: z.string() }),
]);

export type CrawledSource = 'llm' | 'cached' | 'label';

export type CrawledEntry = {
  hint: SelectorHint;
  source: CrawledSource;
  discoveredAt: string;
  // Optional LLM-reported confidence ('high' | 'medium' | 'low'). Only set when source === 'llm'.
  confidence?: 'high' | 'medium' | 'low';
};

export type CrawledFile = {
  merchant: string;
  crawledAt: string;
  entries: Partial<Record<Landmark, CrawledEntry>>;
};

const CrawledEntrySchema: z.ZodType<CrawledEntry> = z.object({
  hint: SelectorHintSchema,
  source: z.enum(['llm', 'cached', 'label']),
  discoveredAt: z.string(),
  confidence: z.enum(['high', 'medium', 'low']).optional(),
});

const CrawledFileSchema: z.ZodType<CrawledFile> = z.object({
  merchant: z.string(),
  crawledAt: z.string(),
  entries: z.record(z.enum(LANDMARKS), CrawledEntrySchema),
});

export function crawledFilePath(merchantName: string): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, `${merchantName}.crawled.json`);
}

export function readCrawledFile(merchantName: string): CrawledFile | undefined {
  const path = crawledFilePath(merchantName);
  if (!existsSync(path)) return undefined;
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    const parsed = CrawledFileSchema.safeParse(raw);
    if (!parsed.success) {
      // eslint-disable-next-line no-console
      console.warn(
        `[registry] ${path} failed schema validation, ignoring: ${parsed.error.message}`,
      );
      return undefined;
    }
    return parsed.data;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`[registry] failed to read ${path}: ${(err as Error).message}`);
    return undefined;
  }
}

function hydrate(profile: SiteProfile): SiteProfile {
  const file = readCrawledFile(profile.name);
  if (!file) return profile;
  const crawled: Partial<Record<Landmark, SelectorHint>> = {};
  for (const landmark of LANDMARKS) {
    const entry = file.entries[landmark];
    if (entry) crawled[landmark] = entry.hint;
  }
  return { ...profile, crawled };
}

export const merchants: Record<string, SiteProfile> = {
  scheels: hydrate(scheels),
};

export function getMerchant(name: string): SiteProfile {
  const profile = merchants[name];
  if (!profile) {
    throw new Error(
      `Unknown merchant "${name}". Registered: ${Object.keys(merchants).join(', ') || '(none)'}`,
    );
  }
  return profile;
}

export function listMerchants(): string[] {
  return Object.keys(merchants);
}
