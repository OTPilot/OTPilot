import { test, expect, seedUnlocked, waitForVault, writeAccounts, TEST_PASSWORD, TEST_SECRET } from './fixtures.js';

// In-page sign-in form fill (forms.js + background vaultLoginsForPage /
// vaultFillLogin).

const SITE = 'http://localhost:8765/test';

async function vaultWith(context, extensionId, accounts) {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/popup.html`);
  await page.evaluate(() => Promise.all([chrome.storage.local.clear(), chrome.storage.session.clear()]));
  await seedUnlocked(page, { accounts: [] });
  await page.reload();
  await waitForVault(page);
  await writeAccounts(page, accounts);
  return page;
}

const github = { name: 'GitHub', email: 'me@example.com', secret: '', urls: 'localhost', password: 'hunter2!' };

test('a matching login is offered and filled only on click', async ({ context, extensionId }) => {
  await vaultWith(context, extensionId, [github]);
  const site = await context.newPage();
  await site.goto(`${SITE}/login.html`);

  const overlay = site.locator('#otpilot-login-fill');
  await expect(overlay).toBeVisible();
  await expect(overlay.locator('.otpilot-login-choice')).toHaveCount(1);
  await expect(overlay).toContainText('GitHub');
  await expect(overlay).toContainText('me@example.com');
  // Nothing is filled until the user picks the login, and the page's DOM
  // holds no password before that.
  await expect(site.locator('input[name="password"]')).toHaveValue('');
  expect(await site.content()).not.toContain('hunter2!');

  await overlay.locator('.otpilot-login-choice').click();
  await expect(site.locator('input[name="email"]')).toHaveValue('me@example.com');
  await expect(site.locator('input[name="password"]')).toHaveValue('hunter2!');
  await expect(overlay).toHaveCount(0);
  // The sign-up form on the same page is left alone.
  await expect(site.locator('input[name="new_user"]')).toHaveValue('');
  await expect(site.locator('input[name="new_pw"]')).toHaveValue('');
});

test('only logins with a password whose URLs cover the page are offered', async ({ context, extensionId }) => {
  await vaultWith(context, extensionId, [
    github,
    { name: 'Elsewhere', email: 'x@example.com', secret: '', urls: 'example.com', password: 'nope' },
    { name: 'Codes only', email: 'y@example.com', secret: TEST_SECRET, urls: 'localhost' },
    { name: 'Work GitHub', email: 'work@example.com', secret: '', urls: 'http://localhost:8765/login', password: 'w0rk' },
  ]);
  const site = await context.newPage();
  await site.goto(`${SITE}/login.html`);
  const choices = site.locator('#otpilot-login-fill .otpilot-login-choice');
  await expect(choices).toHaveCount(2);
  await expect(choices.nth(0)).toContainText('GitHub');
  await expect(choices.nth(1)).toContainText('Work GitHub');

  await choices.nth(1).click();
  await expect(site.locator('input[name="password"]')).toHaveValue('w0rk');
});

test('no offer where no login matches, or on a sign-up form', async ({ context, extensionId }) => {
  await vaultWith(context, extensionId, [{ ...github, urls: 'example.com' }]);
  const site = await context.newPage();
  await site.goto(`${SITE}/login.html`);
  await site.waitForTimeout(1000);
  await expect(site.locator('#otpilot-login-fill')).toHaveCount(0);

  await vaultWith(context, extensionId, [github]);
  await site.goto(`${SITE}/signup.html`);
  await site.waitForTimeout(1000);
  await expect(site.locator('#otpilot-login-fill')).toHaveCount(0);
});

test('a form that appears after load is offered too; closing the offer keeps it closed', async ({ context, extensionId }) => {
  await vaultWith(context, extensionId, [github]);
  const site = await context.newPage();
  await site.goto(`${SITE}/login-late.html`);
  const overlay = site.locator('#otpilot-login-fill');
  await expect(overlay).toBeVisible();

  await overlay.locator('.otpilot-overlay-close').click();
  await expect(overlay).toHaveCount(0);
  // The page keeps changing (a re-rendered form): the offer stays closed.
  await site.evaluate(() => { document.getElementById('app').innerHTML = '<input name="user"><input type="password" name="pass2">'; });
  await site.waitForTimeout(1000);
  await expect(overlay).toHaveCount(0);
});

test('locked: the offer unlocks in the extension frame, then fills', async ({ context, extensionId }) => {
  const page = await vaultWith(context, extensionId, [github]);
  await page.evaluate(() => VaultLock.lock());
  const site = await context.newPage();
  await site.goto(`${SITE}/login.html`);

  const overlay = site.locator('#otpilot-login-fill');
  await expect(overlay).toBeVisible();
  const frame = site.frameLocator('#otpilot-login-fill iframe');
  await expect(frame.locator('#label')).toContainText('GitHub');
  await frame.locator('#pw').fill(TEST_PASSWORD);
  await frame.locator('#unlock').click();

  await expect(site.locator('input[name="password"]')).toHaveValue('hunter2!');
  await expect(site.locator('input[name="email"]')).toHaveValue('me@example.com');
  await expect(overlay).toHaveCount(0);
});

test('locked: after unlocking in the popup, a page navigating the stale unlock frame gets no fill', async ({ context, extensionId }) => {
  const page = await vaultWith(context, extensionId, [github]);
  await page.evaluate(() => VaultLock.lock());
  const site = await context.newPage();
  await site.goto(`${SITE}/login.html`);
  const overlay = site.locator('#otpilot-login-fill');
  await expect(overlay.locator('iframe')).toBeVisible();
  // Unlocked from the popup; the page's frame is still there and the page
  // points it at its own content, which claims the unlock.
  expect(await page.evaluate(pw => VaultLock.unlock(pw), TEST_PASSWORD)).toBeTruthy();
  await site.evaluate(() => {
    document.querySelector('#otpilot-login-fill iframe').src =
      'data:text/html,<script>parent.postMessage({ source: "otpilot-unlock", result: "unlocked" }, "*")</script>';
  });
  await site.waitForTimeout(800);
  await expect(site.locator('input[name="password"]')).toHaveValue('');
  await expect(overlay).toBeVisible();
});

test('the plaintext index says whether a login has a password, never the password', async ({ context, extensionId }) => {
  const page = await vaultWith(context, extensionId, [github, { name: 'Codes only', email: '', secret: TEST_SECRET, urls: 'localhost' }]);
  const index = await page.evaluate(() => VaultAccounts.readIndex());
  expect(index.map(e => [e.name, e.hasPassword])).toEqual([['GitHub', true], ['Codes only', false]]);
  expect(JSON.stringify(index)).not.toContain('hunter2!');
  expect(JSON.stringify(index)).not.toContain('me@example.com');
});

test('the background serves passwords only to a top-frame page its URLs cover', async ({ context, extensionId }) => {
  const page = await vaultWith(context, extensionId, [github]);
  // An extension page is not a tab's top frame: nothing is listed or released.
  const r = await page.evaluate(async () => {
    const id = (await VaultAccounts.load(await VaultKeys.getKey()))[0]._id;
    return {
      list: await chrome.runtime.sendMessage({ action: 'vaultLoginsForPage' }),
      fill: await chrome.runtime.sendMessage({ action: 'vaultFillLogin', id }),
    };
  });
  expect(r.list.logins).toEqual([]);
  expect(r.fill).toEqual({ ok: false });
});

test('password URL matching: the saved host or its subdomains, never a parent', async ({ context, extensionId }) => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/test/blank.html`);
  await page.addScriptTag({ url: `chrome-extension://${extensionId}/vault.js` });
  const r = await page.evaluate(() => {
    const m = (urls, host) => Vault.loginCoversHost(urls, host);
    return [
      m(['github.com'], 'github.com'),
      m(['github.com'], 'gist.github.com'),
      m(['https://www.github.com/login'], 'github.com'),
      m(['*.github.com'], 'api.github.com'),
      m('example.com\ngithub.com:443', 'github.com'),
      m(['gist.github.com'], 'github.com'),        // parent: no
      m(['github.com'], 'evilgithub.com'),         // not a subdomain: no
      m(['github.com'], 'github.com.evil.io'),     // no
      m(['myname.github.io'], 'evil.github.io'),   // sibling: no
      m([''], 'github.com'),
    ];
  });
  expect(r).toEqual([true, true, true, true, true, false, false, false, false, false]);
});

test('logins in a team collection unlocked this session are offered and filled too; not after locking', async ({ context, extensionId }) => {
  const page = await vaultWith(context, extensionId, []);
  await page.evaluate(async () => {
    const cid = crypto.randomUUID();
    const ck = VaultCrypto.b64e(VaultCrypto.generateKey());
    const item = Vault.newItem('login', { title: 'Shared admin', urls: ['localhost'] });
    Vault.getField(item, 'username').value = 'ops@team.test';
    Vault.getField(item, 'password').value = 'team-pass';
    await chrome.storage.local.set({ [`cr:${cid}:${item.id}`]: await VaultCrypto.encryptItem(item, ck) });
    await chrome.storage.session.set({ collectionKeys: { [cid]: ck } });
  });
  const site = await context.newPage();
  await site.goto(`${SITE}/login.html`);
  const choice = site.locator('#otpilot-login-fill .otpilot-login-choice');
  await expect(choice).toContainText('Shared admin');
  await choice.click();
  await expect(site.locator('input[name="password"]')).toHaveValue('team-pass');
  await expect(site.locator('input[name="email"]')).toHaveValue('ops@team.test');

  await page.evaluate(() => VaultLock.lock());
  const again = await context.newPage();
  await again.goto(`${SITE}/login.html`);
  await again.waitForTimeout(1000);
  await expect(again.locator('#otpilot-login-fill')).toHaveCount(0); // locked: no index entry, keys gone
});

// ── In-field badge and dropdown ──────────────────────────────────────────────

test('sign-in fields get a badge; focusing the empty username opens the logins under it, and a pick fills', async ({ context, extensionId }) => {
  await vaultWith(context, extensionId, [github]);
  const site = await context.newPage();
  await site.goto(`${SITE}/login.html`);
  await expect(site.locator('#otpilot-login-fill')).toBeVisible(); // the corner offer stays
  await expect(site.locator('.otpilot-field-badge[data-kind="login"]')).toHaveCount(2);

  await site.focus('input[name="email"]');
  const drop = site.locator('#otpilot-login-dropdown');
  await expect(drop).toBeVisible();
  const field = await site.locator('input[name="email"]').boundingBox();
  const box = await drop.boundingBox();
  expect(Math.abs(box.y - (field.y + field.height + 6))).toBeLessThan(2);
  expect(Math.abs(box.x - field.x)).toBeLessThan(2);
  await site.screenshot({ path: test.info().outputPath('dropdown.png') });

  await drop.locator('.otpilot-login-choice').click();
  await expect(site.locator('input[name="email"]')).toHaveValue('me@example.com');
  await expect(site.locator('input[name="password"]')).toHaveValue('hunter2!');
  await expect(drop).toHaveCount(0);
  await expect(site.locator('#otpilot-login-fill')).toHaveCount(0);
});

test('the badge toggles the dropdown; Escape, typing or a click elsewhere closes it', async ({ context, extensionId }) => {
  await vaultWith(context, extensionId, [github]);
  const site = await context.newPage();
  await site.goto(`${SITE}/login.html`);
  const drop = site.locator('#otpilot-login-dropdown');
  const badge = site.locator('.otpilot-field-badge[data-kind="login"]').nth(1); // the password field's
  await expect(badge).toBeVisible();
  await badge.click();
  await expect(drop).toBeVisible();
  await badge.click();
  await expect(drop).toHaveCount(0);

  await site.focus('input[name="email"]');
  await expect(drop).toBeVisible();
  await site.keyboard.press('Escape');
  await expect(drop).toHaveCount(0);

  await site.locator('input[name="email"]').blur();
  await site.focus('input[name="email"]');
  await expect(drop).toBeVisible();
  await site.keyboard.type('x');
  await expect(drop).toHaveCount(0);

  await badge.click();
  await expect(drop).toBeVisible();
  await site.mouse.click(5, 5);
  await expect(drop).toHaveCount(0);
});

test('no badge without a saved login for the site', async ({ context, extensionId }) => {
  await vaultWith(context, extensionId, [{ ...github, urls: 'elsewhere.example' }]);
  const site = await context.newPage();
  await site.goto(`${SITE}/login.html`);
  await site.focus('input[name="email"]');
  await site.waitForTimeout(800);
  await expect(site.locator('.otpilot-field-badge[data-kind="login"]')).toHaveCount(0);
  await expect(site.locator('#otpilot-login-dropdown')).toHaveCount(0);
});

test('locked: the dropdown unlocks in the extension frame, then fills', async ({ context, extensionId }) => {
  const page = await vaultWith(context, extensionId, [github]);
  await page.evaluate(() => VaultLock.lock());
  const site = await context.newPage();
  await site.goto(`${SITE}/login.html`);
  await site.focus('input[name="password"]');
  const frame = site.frameLocator('#otpilot-login-dropdown iframe');
  await frame.locator('#pw').fill(TEST_PASSWORD);
  await frame.locator('#unlock').click();
  await expect(site.locator('input[name="password"]')).toHaveValue('hunter2!');
});
