import { test, expect, seedUnlocked, waitForVault, writeAccounts } from './fixtures.js';

// "Open & sign in" (2.0.1): the popup opens the login's website in a new tab
// and the sign-in there is filled and submitted (popup.js launchAccount →
// background launchLogin / launchFill → forms.js continueLaunch).

const SITE = 'localhost:8765/test';

async function popupWith(context, extensionId, accounts) {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/popup.html`);
  await page.evaluate(() => Promise.all([chrome.storage.local.clear(), chrome.storage.session.clear()]));
  await seedUnlocked(page, { accounts: [] });
  await page.reload();
  await waitForVault(page);
  await writeAccounts(page, accounts);
  await page.reload();
  await waitForVault(page);
  return page;
}

// Hovers the account's Home row and clicks its launch button; resolves to the
// tab it opened.
async function launchFromRow(context, popup, name) {
  const item = popup.locator('#home-list .lc-item', { hasText: name });
  // Shown on hover or focus: focus is steadier than a hover in CI.
  await item.locator('.lc-row').focus();
  const opened = context.waitForEvent('page');
  await item.locator('.lc-launch').click();
  return opened;
}

test('the row button opens the site and signs in', async ({ context, extensionId }) => {
  const popup = await popupWith(context, extensionId, [
    { name: 'Nav site', email: 'me@example.com', secret: '', urls: `${SITE}/login-nav.html`, password: 'pw-123' },
  ]);
  const site = await launchFromRow(context, popup, 'Nav site');
  // Filled and submitted: the form's GET lands on welcome.html with the values.
  await expect(site).toHaveURL(/welcome\.html\?email=me%40example\.com&password=pw-123/);
});

test('"Open & sign in" in the account works too, and a two-step sign-in gets both steps', async ({ context, extensionId }) => {
  const popup = await popupWith(context, extensionId, [
    { name: 'Two step', email: 'two@example.com', secret: '', urls: `${SITE}/login-step1.html`, password: 'tw0-step' },
  ]);
  await popup.locator('#home-list .lc-row', { hasText: 'Two step' }).click();
  await expect(popup.locator('#btn-launch')).toBeVisible();
  const opened = context.waitForEvent('page');
  await popup.click('#btn-launch');
  const site = await opened;
  await expect(site).toHaveURL(/welcome\.html\?password=tw0-step/);
});

test('a rejected password is not filled again', async ({ context, extensionId }) => {
  const popup = await popupWith(context, extensionId, [
    { name: 'Retry site', email: 'r@example.com', secret: '', urls: `${SITE}/login-step2-retry.html`, password: 'wrong-pass' },
  ]);
  const site = await launchFromRow(context, popup, 'Retry site');
  await expect(site.locator('#err')).toBeVisible(); // filled once, submitted, rejected
  await site.waitForTimeout(1500);
  await expect(site.locator('input[name="password"]')).toHaveValue('');
  await expect(site).toHaveURL(/login-step2-retry\.html/);
});

test('a sign-in page opened by hand is not filled on its own', async ({ context, extensionId }) => {
  await popupWith(context, extensionId, [
    { name: 'Nav site', email: 'me@example.com', secret: '', urls: `${SITE}/login-nav.html`, password: 'pw-123' },
  ]);
  const site = await context.newPage();
  await site.goto(`http://${SITE}/login-nav.html`);
  await site.waitForTimeout(1500);
  await expect(site.locator('input[name="password"]')).toHaveValue('');
});

test('accounts without a website have no launch button; the Website row opens the site', async ({ context, extensionId }) => {
  const popup = await popupWith(context, extensionId, [
    { name: 'No site', email: 'n@example.com', secret: '', urls: '', password: 'pw' },
    { name: 'Nav site', email: 'me@example.com', secret: '', urls: `${SITE}/login-nav.html`, password: 'pw-123' },
  ]);
  await popup.locator('#home-list .lc-item', { hasText: 'No site' }).hover();
  await expect(popup.locator('#home-list .lc-item', { hasText: 'No site' }).locator('.lc-launch')).toHaveCount(0);
  await popup.locator('#home-list .lc-row', { hasText: 'No site' }).click();
  await expect(popup.locator('#btn-launch')).toBeHidden();

  await popup.locator('#home-list .lc-row', { hasText: 'Nav site' }).click();
  const opened = context.waitForEvent('page');
  await popup.locator('#home-creds .home-cred', { hasText: 'Website' }).locator('.home-cred-btn', { hasText: 'Open' }).click();
  const site = await opened;
  await expect(site).toHaveURL(/login-nav\.html/);
  // Just opened: nothing filled.
  await site.waitForTimeout(1500);
  await expect(site.locator('input[name="password"]')).toHaveValue('');
});

test('a username the site remembered is replaced by the launched login\'s', async ({ context, extensionId }) => {
  const popup = await popupWith(context, extensionId, [
    { name: 'Prefilled', email: 'me@example.com', secret: '', urls: `${SITE}/login-prefilled.html`, password: 'pw-9' },
  ]);
  const site = await launchFromRow(context, popup, 'Prefilled');
  await expect(site).toHaveURL(/welcome\.html\?email=me%40example\.com&password=pw-9/);
});

test('an email box that isn\'t a sign-in step (a newsletter) is left alone', async ({ context, extensionId }) => {
  const popup = await popupWith(context, extensionId, [
    { name: 'News site', email: 'me@example.com', secret: '', urls: `${SITE}/newsletter.html`, password: 'pw' },
  ]);
  const site = await launchFromRow(context, popup, 'News site');
  await expect(site).toHaveURL(/newsletter\.html/);
  await site.waitForTimeout(1500);
  await expect(site.locator('input[name="newsletter_email"]')).toHaveValue('');
  await expect(site).toHaveURL(/newsletter\.html$/);
});

test('a public site is always opened over https, even when saved as http', async ({ context }) => {
  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent('serviceworker');
  const urls = await worker.evaluate(() => [
    launchUrlOf(['http://example.com/login']),
    launchUrlOf(['example.com']),
    launchUrlOf(['*.example.com']),
    launchUrlOf(['localhost:8765/test/login-nav.html']),
    launchUrlOf(['https://localhost:8443/login']),
    launchUrlOf(['javascript:alert(1)', 'site.org']),
    launchUrlOf(['']),
  ]);
  expect(urls).toEqual([
    'https://example.com/login',
    'https://example.com/',
    'https://example.com/',
    'http://localhost:8765/test/login-nav.html',
    'https://localhost:8443/login',
    'https://site.org/',
    null,
  ]);
});

test('a secondary "Sign up" button doesn\'t stop the username step', async ({ context, extensionId }) => {
  const popup = await popupWith(context, extensionId, [
    { name: 'Signup aside', email: 'me@example.com', secret: '', urls: `${SITE}/login-step1-signup.html`, password: 'pw-77' },
  ]);
  const site = await launchFromRow(context, popup, 'Signup aside');
  await expect(site).toHaveURL(/welcome\.html\?password=pw-77/);
});

test('a form-less username panel clicks its sign-in button, not a "Sign up" before it', async ({ context, extensionId }) => {
  const popup = await popupWith(context, extensionId, [
    { name: 'Panel site', email: 'me@example.com', secret: '', urls: `${SITE}/login-step1-panel.html`, password: 'pw-55' },
  ]);
  const site = await launchFromRow(context, popup, 'Panel site');
  await expect(site).toHaveURL(/welcome\.html\?password=pw-55/);
});

test('a form-less sign-in panel is submitted through its button outside the fields\' wrappers (Verify)', async ({ context, extensionId }) => {
  const popup = await popupWith(context, extensionId, [
    { name: 'Verify panel', email: 'me@example.com', secret: '', urls: `${SITE}/login-panel-verify.html`, password: 'pw-88' },
  ]);
  const site = await launchFromRow(context, popup, 'Verify panel');
  await expect(site).toHaveURL(/welcome\.html\?email=me%40example\.com&password=pw-88/);
});

test('a username step whose button the page replaces on input still goes through', async ({ context, extensionId }) => {
  const popup = await popupWith(context, extensionId, [
    { name: 'Replaced button', email: 'me@example.com', secret: '', urls: `${SITE}/login-step1-replaced.html`, password: 'pw-66' },
  ]);
  const site = await launchFromRow(context, popup, 'Replaced button');
  await expect(site).toHaveURL(/welcome\.html\?password=pw-66/);
});

test('a form-less sign-in panel never borrows another form\'s button (a search box)', async ({ context, extensionId }) => {
  const popup = await popupWith(context, extensionId, [
    { name: 'Search page', email: 'me@example.com', secret: '', urls: `${SITE}/login-panel-search.html`, password: 'pw-44' },
  ]);
  const site = await launchFromRow(context, popup, 'Search page');
  await expect(site).toHaveURL(/welcome\.html\?email=me%40example\.com&password=pw-44/);
});

test('a deeply wrapped form-less panel reaches its button, not a header search\'s', async ({ context, extensionId }) => {
  const popup = await popupWith(context, extensionId, [
    { name: 'Deep panel', email: 'me@example.com', secret: '', urls: `${SITE}/login-panel-deep.html`, password: 'pw-33' },
  ]);
  const site = await launchFromRow(context, popup, 'Deep panel');
  await expect(site).toHaveURL(/welcome\.html\?email=me%40example\.com&password=pw-33/);
});

test('a form-less panel with an already-filled extra field (organization) still submits', async ({ context, extensionId }) => {
  const popup = await popupWith(context, extensionId, [
    { name: 'Org panel', email: 'me@example.com', secret: '', urls: `${SITE}/login-panel-org.html`, password: 'pw-22' },
  ]);
  const site = await launchFromRow(context, popup, 'Org panel');
  await expect(site).toHaveURL(/welcome\.html\?org=acme&email=me%40example\.com&password=pw-22/);
});

test('a filled, form-less search box never takes the sign-in click', async ({ context, extensionId }) => {
  const popup = await popupWith(context, extensionId, [
    { name: 'Search beside', email: 'me@example.com', secret: '', urls: `${SITE}/login-panel-filled-search.html`, password: 'pw-11' },
  ]);
  const site = await launchFromRow(context, popup, 'Search beside');
  // Go is never clicked; Verify is outside the search's container, so the
  // fill stays and the click is the user's.
  await site.waitForTimeout(1500);
  await expect(site.locator('#went')).toHaveText('');
  await expect(site.locator('#password')).toHaveValue('pw-11');
});

test('a form-less panel skips "Forgot login?" / "Show password" buttons and clicks Sign in', async ({ context, extensionId }) => {
  const popup = await popupWith(context, extensionId, [
    { name: 'Help first', email: 'me@example.com', secret: '', urls: `${SITE}/login-panel-forgot.html`, password: 'pw-00' },
  ]);
  const site = await launchFromRow(context, popup, 'Help first');
  await expect(site).toHaveURL(/welcome\.html\?email=me%40example\.com&password=pw-00/);
});
