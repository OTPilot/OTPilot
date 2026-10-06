import { test as base, chromium } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const extensionPath = path.resolve(__dirname, '..');

export const test = base.extend({
  context: async ({}, use) => {
    // Fresh isolated profile per test — prevents session-restore from stale tabs
    // and lock conflicts when tests run in parallel.
    const userDataDir = mkdtempSync(path.join(tmpdir(), 'otpilot-test-'));
    const context = await chromium.launchPersistentContext(userDataDir, {
      headless: false,
      args: [
        `--disable-extensions-except=${extensionPath}`,
        `--load-extension=${extensionPath}`,
        // BarcodeDetector requires an explicit opt-in on Linux in Playwright's
        // Chromium bundle — without this flag detect() silently returns [].
        '--enable-blink-features=BarcodeDetection',
      ],
    });
    await use(context);
    await context.close();
    try { rmSync(userDataDir, { recursive: true, force: true }); } catch { /* ignore */ }
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

// 2.0 lock (vaultLock.js): a vault key wrapped with master password "test",
// precomputed so tests don't pay 600k PBKDF2 iterations to seed state.
export const TEST_PASSWORD = 'test';
export const TEST_VAULT_KEY = 'InTvldGAh9nN01G9O515s6SYk2Y2PpsIqcOcerUwniA=';
export const TEST_VAULT_KEY_WRAPPED = {
  v: 1, kdf: 'PBKDF2-SHA256', iterations: 600000,
  salt: 'JoyBwLfbf2jvCvB8DpfgnA==', iv: 'Mkz2NDaKMeHzl4mC',
  ct: 'bWPI8+0v+o+7dOkjYq9bswymxr7+HrO/26b4cKtcQPHgTga1TX19NCJNbyUUUa+H',
};
// A real v1 `auth` sentinel for master password "test" (PBKDF2 200k), for the
// v1 → 2.0 lock migration.
export const LEGACY_AUTH_TEST = {
  salt: 'JA8fy6ewiqPiiX/V27PBag==', iv: 'SAKjjnloyIl4alNE',
  data: 'ZgB6qHt38D93fmJfMdgHjKqWGBeOEP0K8CVyTzrqOw==',
};

// Seeds an unlocked vault plus any extra chrome.storage.local data. Call from
// an extension page (it needs chrome.storage.session).
export function seedUnlocked(page, local = {}) {
  return page.evaluate(([wrapped, vk, extra]) => Promise.all([
    chrome.storage.local.set({ vaultKeyWrapped: wrapped, ...extra }),
    chrome.storage.session.set({ vaultKeyUnlocked: vk }),
  ]), [TEST_VAULT_KEY_WRAPPED, TEST_VAULT_KEY, local]);
}

// Same, but locked (master password set, vault key not in the session).
export function seedLocked(page, local = {}) {
  return page.evaluate(([wrapped, extra]) => Promise.all([
    chrome.storage.local.set({ vaultKeyWrapped: wrapped, ...extra }),
    chrome.storage.session.clear(),
  ]), [TEST_VAULT_KEY_WRAPPED, local]);
}
export const TEST_SECRET = 'JBSWY3DPEHPK3PXP'; // from test/qr-anchor.html
