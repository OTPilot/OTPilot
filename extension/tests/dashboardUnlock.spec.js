import { test, expect, seedUnlocked, seedLocked, TEST_PASSWORD, TEST_VAULT_KEY } from './fixtures.js';

// The web dashboard (CONFIG.DASHBOARD_URL — http://localhost:9999 in
// config.test.js) asks the extension for the vault key instead of the user
// pasting their recovery key; the user approves in an extension window.

const ME = { id: 'user-me', email: 'me@acme.io' };
const SESSION = { user: ME, access_token: 't', refresh_token: 'r', expires_at: 4102444800000 };

async function setup(context, extensionId, { locked = false, sync = true } = {}) {
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await popup.evaluate(() => Promise.all([chrome.storage.local.clear(), chrome.storage.session.clear()]));
  await seedUnlocked(popup, { cloudSession: SESSION, userPlan: 'team_lite', ...(sync ? { syncEnabled: true } : {}) });
  // The team keypair, as the extension makes it on first use.
  const pub = await popup.evaluate(async () => { await TeamKeys.getPrivateKey(); return TeamKeys.getPublicKeyB64(); });
  if (locked) await seedLocked(popup);
  await popup.close();
  return pub;
}

// A page on `origin` that messages the extension (callback form: resolves
// { error } when nothing answers).
async function dashboard(context, origin = 'http://localhost:9999') {
  await context.route(`${origin}/**`, r => r.fulfill({ contentType: 'text/html', body: '<html><body>Dashboard</body></html>' }));
  const page = await context.newPage();
  await page.goto(`${origin}/dashboard/team`);
  return page;
}
const send = (page, extensionId, msg) => page.evaluate(([id, msg]) => new Promise(resolve => {
  if (!globalThis.chrome?.runtime?.sendMessage) { resolve({ error: 'no-runtime' }); return; }
  chrome.runtime.sendMessage(id, msg, res => resolve(chrome.runtime.lastError ? { error: 'no-answer' } : res));
}), [extensionId, msg]);
// Starts an unlock request; returns [the approval window, the answer].
async function requestUnlock(context, page, extensionId, userId = ME.id) {
  const opened = context.waitForEvent('page', p => p.url().includes('dashboardUnlock.html'));
  const answer = send(page, extensionId, { action: 'unlockVault', userId });
  const win = await opened;
  await expect(win.locator('body')).toHaveAttribute('data-ready', '1');
  return [win, answer];
}

test('allowed in the extension, the dashboard gets the vault key and the team key', async ({ context, extensionId }) => {
  const pub = await setup(context, extensionId);
  const page = await dashboard(context);
  expect(await send(page, extensionId, { action: 'hello', userId: ME.id })).toEqual({ ok: true, account: 'same' });

  const [win, answer] = await requestUnlock(context, page, extensionId);
  await expect(win.locator('#email')).toHaveText(ME.email);
  await expect(win.locator('#site')).toHaveText('localhost:9999');
  await expect(win.locator('#pw')).toBeHidden();
  await win.click('#allow');
  const res = await answer;
  expect(res.ok).toBe(true);
  expect(res.vaultKey).toBe(TEST_VAULT_KEY);
  // The private half of the public key the extension uploads.
  const derived = await page.evaluate(async jwk => {
    const k = await crypto.subtle.importKey('jwk', { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y }, { name: 'ECDH', namedCurve: 'P-256' }, true, []);
    return btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.exportKey('raw', k))));
  }, res.teamKey);
  expect(res.teamKey.d).toBeTruthy();
  expect(derived).toBe(pub);
  await expect.poll(() => win.isClosed()).toBe(true);
});

test('denying, or closing the window, gives nothing', async ({ context, extensionId }) => {
  await setup(context, extensionId);
  const page = await dashboard(context);

  let [win, answer] = await requestUnlock(context, page, extensionId);
  await win.click('#deny');
  expect(await answer).toEqual({ ok: false, error: 'denied' });

  [win, answer] = await requestUnlock(context, page, extensionId);
  await win.close();
  expect(await answer).toEqual({ ok: false, error: 'denied' });
});

test('a locked extension unlocks with the master password in the window', async ({ context, extensionId }) => {
  await setup(context, extensionId, { locked: true });
  const page = await dashboard(context);
  const [win, answer] = await requestUnlock(context, page, extensionId);
  await expect(win.locator('#pw')).toBeVisible();
  await expect(win.locator('#allow')).toHaveText('Unlock & allow');
  await win.fill('#pw', 'wrong');
  await win.click('#allow');
  await expect(win.locator('#err')).toHaveText('Incorrect password');
  await win.fill('#pw', TEST_PASSWORD);
  await win.click('#allow');
  const res = await answer;
  expect(res.ok).toBe(true);
  expect(res.vaultKey).toBe(TEST_VAULT_KEY);
});

test('another account, signed out or sync off: refused without asking', async ({ context, extensionId }) => {
  await setup(context, extensionId, { sync: false });
  const page = await dashboard(context);
  expect(await send(page, extensionId, { action: 'hello', userId: 'someone-else' })).toEqual({ ok: true, account: 'other' });
  expect(await send(page, extensionId, { action: 'unlockVault', userId: 'someone-else' })).toEqual({ ok: false, error: 'other' });
  expect(await send(page, extensionId, { action: 'unlockVault', userId: ME.id })).toEqual({ ok: false, error: 'no-sync' });

  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await popup.evaluate(() => chrome.storage.local.remove('cloudSession'));
  expect(await send(page, extensionId, { action: 'unlockVault', userId: ME.id })).toEqual({ ok: false, error: 'signed-out' });
  expect(context.pages().some(p => p.url().includes('dashboardUnlock.html'))).toBe(false);
});

test('only the dashboard origin gets an answer', async ({ context, extensionId }) => {
  await setup(context, extensionId);
  // Matched by externally_connectable (any localhost) but not the dashboard.
  const other = await dashboard(context, 'http://localhost:8765');
  expect(await send(other, extensionId, { action: 'hello', userId: ME.id })).toEqual({ error: 'no-answer' });
  expect(await send(other, extensionId, { action: 'unlockVault', userId: ME.id })).toEqual({ error: 'no-answer' });
  expect(context.pages().some(p => p.url().includes('dashboardUnlock.html'))).toBe(false);
});
