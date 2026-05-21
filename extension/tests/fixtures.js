import { test as base, chromium } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const extensionPath = path.resolve(__dirname, '..');

export const test = base.extend({
  context: async ({}, use) => {
    const context = await chromium.launchPersistentContext('', {
      headless: false,
      args: [
        `--disable-extensions-except=${extensionPath}`,
        `--load-extension=${extensionPath}`,
      ],
    });
    await use(context);
    await context.close();
  },

  extensionId: async ({ context }, use) => {
    const page = await context.newPage();
    await page.goto('chrome://extensions/');

    const id = await page.evaluate(() => {
      const manager = document.querySelector('extensions-manager');
      const items = manager?.shadowRoot
        ?.querySelector('extensions-item-list')
        ?.shadowRoot?.querySelectorAll('extensions-item');
      return items?.[0]?.id ?? '';
    });

    await page.close();
    await use(id);
  },
});

export { expect } from '@playwright/test';

export const FAKE_AUTH = { salt: 'dGVzdA==', iv: 'dGVzdA==', data: 'dGVzdA==' };
export const SESSION_24H = () => Date.now() + 86400000;
export const TEST_SECRET = 'JBSWY3DPEHPK3PXP'; // from test/qr-anchor.html
