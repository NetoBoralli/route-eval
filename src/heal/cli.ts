import 'dotenv/config';
import { listMerchants } from '../merchants/registry.js';
import { healLoop } from './loop.js';

function parseArgs(argv: string[]): {
  merchants: string[];
  headed: boolean;
  maxAttempts: number;
} {
  const args = argv.slice(2);
  const headed = args.includes('--headed');
  let maxAttempts = 3;
  const attemptsArg = args.find((a) => a.startsWith('--attempts='));
  if (attemptsArg) {
    const n = Number(attemptsArg.split('=')[1]);
    if (Number.isFinite(n) && n > 0) maxAttempts = n;
  }
  const merchants = args.filter((a) => !a.startsWith('--'));
  return { merchants, headed, maxAttempts };
}

async function main(): Promise<void> {
  const { merchants, headed, maxAttempts } = parseArgs(process.argv);
  const targets = merchants.length > 0 ? merchants : listMerchants();

  if (!process.env.ANTHROPIC_API_KEY) {
    // eslint-disable-next-line no-console
    console.error('ANTHROPIC_API_KEY required.');
    process.exit(1);
  }

  let failures = 0;
  for (const name of targets) {
    // eslint-disable-next-line no-console
    console.log(`\n┌─ Healing ${name} (max ${maxAttempts} attempts${headed ? ', headed' : ''})`);
    const ok = await healLoop(name, { headed, maxAttempts });
    // eslint-disable-next-line no-console
    console.log(`└─ ${name}: ${ok ? 'PASS' : 'FAIL'}`);
    if (!ok) failures += 1;
  }

  if (failures > 0) process.exit(1);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
