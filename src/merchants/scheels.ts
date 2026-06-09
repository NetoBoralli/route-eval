import type { SiteProfile } from './types.js';
import { scheelsOverrides } from './scheels.overrides.js';

export const scheels: SiteProfile = {
  name: 'scheels',
  baseUrl: 'https://www.scheels.com',
  cartUrl: 'https://www.scheels.com/cart',
  productEntry: {
    type: 'directUrl',
    url: 'https://www.scheels.com/p/48400002508?queryID=53ebd0e9d1b0d160',
  },
  hints: {
    addToCart: [
      { kind: 'css', css: '#add-to-cart' },
      { kind: 'role', role: 'button', name: /^add to cart$/i },
      { kind: 'role', role: 'button', name: /add to cart/i },
    ],
    cartLink: [
      { kind: 'role', role: 'link', name: /^(view |go to )?cart$/i },
      { kind: 'role', role: 'link', name: /cart/i },
      { kind: 'css', css: 'a[href*="/cart"]' },
    ],
    cartSubtotal: [
      { kind: 'text', text: /subtotal/i, tag: 'section' },
      { kind: 'css', css: '[data-testid*="subtotal" i]' },
    ],
    cartTotal: [
      { kind: 'text', text: /^total$/i },
      { kind: 'css', css: '[data-testid*="order-total" i], [data-testid*="grand-total" i]' },
    ],
    routeToggle: [
      { kind: 'role', role: 'checkbox', name: /route/i },
      { kind: 'role', role: 'switch', name: /route/i },
      { kind: 'css', css: 'input[type="checkbox"][name*="route" i]' },
      { kind: 'css', css: '[data-testid*="route" i] input[type="checkbox"]' },
    ],
    routePrice: [
      { kind: 'css', css: '[data-testid="pw-quote"]' },
      { kind: 'css', css: '.pw-quote' },
    ],
  },
  popupHints: [
    { kind: 'role', role: 'button', name: /accept all|accept cookies/i },
    { kind: 'role', role: 'button', name: /^close$/i },
    { kind: 'role', role: 'button', name: /no thanks|not now|maybe later/i },
  ],
  overrides: scheelsOverrides,
};
