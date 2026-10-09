import { test, expect, seedUnlocked, waitForVault, writeAccounts, TEST_SECRET } from './fixtures.js';

// The 2FA code is filled in on its own when a page asks for it and one saved
// login with a code matches the site.

test('a page asking for a 2FA code gets it filled in on load', async ({ context, extensionId }) => {
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await popup.evaluate(() => Promise.all([chrome.storage.local.clear(), chrome.storage.session.clear()]));
  await seedUnlocked(popup, { accounts: [] });
  await popup.reload();
  await waitForVault(popup);
  // A second login for the site, without a 2FA code, doesn't count.
  await writeAccounts(popup, [
    { name: 'TestApp', email: 'me@example.com', secret: TEST_SECRET, urls: 'localhost', password: 'pw' },
    { name: 'TestApp (admin)', email: 'admin@example.com', secret: '', urls: 'localhost', password: 'pw2' },
  ]);

  const page = await context.newPage();
  await page.goto('http://localhost:8765/test/autofill.html');
  // Filled, then auto-submitted: the page shows the code it received.
  await expect(page.locator('#result-code')).toHaveText(/^Code accepted: \d{6}$/, { timeout: 10000 });
});
