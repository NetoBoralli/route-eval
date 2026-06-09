import { test } from './fixtures.js';
import { getMerchant } from '../src/merchants/registry.js';
import { runWidgetCheck } from '../src/flow/widgetCheckFlow.js';

test.describe('scheels.com — Route widget', () => {
  test('renders, prices at ~5%, toggles correctly', async ({ page }, info) => {
    const profile = getMerchant('scheels');
    await runWidgetCheck(page, profile, info);
  });
});
