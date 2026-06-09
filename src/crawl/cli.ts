import 'dotenv/config';
import { getMerchant, listMerchants } from '../merchants/registry.js';
import { crawlMerchant } from './crawl.js';

function parseArgs(argv: string[]): {
  merchants: string[];
  headed: boolean;
  force: boolean;
} {
  const args = argv.slice(2);
  const headed = args.includes('--headed');
  const force = args.includes('--force');
  const merchants = args.filter((a) => !a.startsWith('--'));
  return { merchants, headed, force };
}

async function main(): Promise<void> {
  const { merchants, headed, force } = parseArgs(process.argv);
  const targets = merchants.length > 0 ? merchants : listMerchants();
  if (targets.length === 0) {
    // eslint-disable-next-line no-console
    console.error('No merchants registered.');
    process.exit(1);
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    // eslint-disable-next-line no-console
    console.error(
      'ANTHROPIC_API_KEY is required for crawling. Set it in .env or the shell.',
    );
    process.exit(1);
  }

  let failures = 0;
  for (const name of targets) {
    try {
      const profile = getMerchant(name);
      // eslint-disable-next-line no-console
      console.log(
        `[crawl] starting ${name}${headed ? ' (headed)' : ''}${force ? ' (force)' : ''}`,
      );
      await crawlMerchant(profile, { headed, force });
    } catch (err) {
      failures += 1;
      // eslint-disable-next-line no-console
      console.error(`[crawl] ${name} failed: ${(err as Error).message}`);
    }
  }

  if (failures > 0) process.exit(1);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
