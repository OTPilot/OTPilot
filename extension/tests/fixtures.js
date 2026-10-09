import { test as base, chromium, expect as pwExpect } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const extensionPath = path.resolve(__dirname, '..');

export const test = base.extend({
  context: async ({}, use, testInfo) => {
    // Fresh isolated profile per test — prevents session-restore from stale tabs
    // and lock conflicts when tests run in parallel.
    const userDataDir = mkdtempSync(path.join(tmpdir(), 'otpilot-test-'));
    const launch = () => chromium.launchPersistentContext(userDataDir, {
      headless: false,
      args: [
        `--disable-extensions-except=${extensionPath}`,
        `--load-extension=${extensionPath}`,
        // BarcodeDetector requires an explicit opt-in on Linux in Playwright's
        // Chromium bundle — without this flag detect() silently returns [].
        '--enable-blink-features=BarcodeDetection',
      ],
    });
    // On CI (xvfb, several workers) Chromium sometimes exits right away with
    // "The platform failed to initialize" — it couldn't reach the virtual
    // display. Only that launch failure is retried, never a test.
    let context;
    for (let attempt = 1; ; attempt++) {
      try { context = await launch(); break; } catch (e) {
        if (attempt >= 3 || !/platform failed to initialize/i.test(String(e?.message))) throw e;
        await new Promise(r => setTimeout(r, 500 * attempt));
      }
    }
    // On failure, keep what each page showed and logged (content scripts
    // log to their page's console) — CI uploads test-results/.
    const logs = [];
    const watch = page => page.on('console', m => logs.push(`[${page.url()}] ${m.type()}: ${m.text()}`));
    context.pages().forEach(watch);
    context.on('page', watch);
    await use(context);
    if (testInfo.status !== testInfo.expectedStatus) {
      for (const [i, page] of context.pages().entries()) {
        await page.screenshot({ path: testInfo.outputPath(`page-${i}.png`) }).catch(() => {});
      }
      try { writeFileSync(testInfo.outputPath('console.txt'), logs.join('\n') || '(no console output)'); } catch { /* ignore */ }
    }
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
// an extension page (it needs chrome.storage.session). The seeded user has
// already confirmed saving their recovery key, so no one-time notice shows.
export function seedUnlocked(page, local = {}) {
  return page.evaluate(([wrapped, vk, extra]) => Promise.all([
    chrome.storage.local.set({ vaultKeyWrapped: wrapped, recoveryKeyAcknowledged: true, ...extra }),
    chrome.storage.session.set({ vaultKeyUnlocked: vk }),
  ]), [TEST_VAULT_KEY_WRAPPED, TEST_VAULT_KEY, local]);
}

// Same, but locked (master password set, vault key not in the session).
export function seedLocked(page, local = {}) {
  return page.evaluate(([wrapped, extra]) => Promise.all([
    chrome.storage.local.set({ vaultKeyWrapped: wrapped, recoveryKeyAcknowledged: true, ...extra }),
    chrome.storage.session.clear(),
  ]), [TEST_VAULT_KEY_WRAPPED, local]);
}
export const TEST_SECRET = 'JBSWY3DPEHPK3PXP'; // from test/qr-anchor.html

// 2.0: accounts live encrypted in the vault. Read/replace the v1-shaped list
// through the adapter, from an unlocked extension page (e.g. the popup).
export function readAccounts(page) {
  return page.evaluate(async () => VaultAccounts.load(await VaultKeys.getKey()));
}

export function writeAccounts(page, accounts) {
  return page.evaluate(async accs => {
    const key = await VaultKeys.getKey();
    const known = new Set((await VaultAccounts.load(key)).map(a => a._id));
    await VaultAccounts.save(accs, key, known);
  }, accounts);
}

// The popup hides its lock overlay before its first vault read (which runs the
// v1 migration) has finished: wait for that before asserting on storage.
export async function waitForVault(page) {
  await pwExpect.poll(() => page.evaluate(async () => !!(await chrome.storage.local.get('vaultMeta')).vaultMeta?.migratedAt)).toBe(true);
}
