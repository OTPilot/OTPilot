import { test, expect, seedUnlocked, waitForVault, writeAccounts } from './fixtures.js';

// A sign-in form inside a same-site iframe (App Store Connect frames Apple's
// idmsa.apple.com): frameForms.js asks the background, which loads forms.js
// there only when the frame and its page are the same site; a login fills
// there only when it covers both hosts; a sign-in typed there is offered on
// the page. *.localhost resolves to this machine: app.otp.localhost (the
// page) and id.otp.localhost (the frame) are one site (otp.localhost).

const PORT = 8765;
const page = (host, frameHost) =>
  `http://${host}:${PORT}/test/frame-top.html?frame=${encodeURIComponent(`http://${frameHost}:${PORT}/test/frame-login.html`)}`;
const APP = 'app.otp.localhost';
const ID = 'id.otp.localhost';

async function vaultWith(context, extensionId, accounts) {
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await popup.evaluate(() => Promise.all([chrome.storage.local.clear(), chrome.storage.session.clear()]));
  await seedUnlocked(popup, { accounts: [] });
  await popup.reload();
  await waitForVault(popup);
  if (accounts.length) await writeAccounts(popup, accounts);
  return popup;
}

const logins = popup => popup.evaluate(async () =>
  (await VaultStore.readAll(await VaultKeys.getKey())).items
    .filter(i => i.type === 'login')
    .map(i => ({ title: i.title, urls: i.urls, username: Vault.getValue(i, 'username'), password: Vault.getValue(i, 'password') })));

const apple = { name: 'Apple ID', email: 'me@apple.test', secret: '', password: 'fr4me-pass!' };

test('a login covering the page and its same-site frame is offered and filled inside the frame', async ({ context, extensionId }) => {
  await vaultWith(context, extensionId, [{ ...apple, urls: 'otp.localhost' }]);
  const site = await context.newPage();
  await site.goto(page(APP, ID));
  const frame = site.frameLocator('#signin');
  const overlay = frame.locator('#otpilot-login-fill');
  await expect(overlay).toBeVisible();
  await expect(overlay).toContainText('Apple ID');
  await expect(frame.locator('input[name="password"]')).toHaveValue('');
  await overlay.locator('.otpilot-login-choice').click();
  await expect(frame.locator('input[name="email"]')).toHaveValue('me@apple.test');
  await expect(frame.locator('input[name="password"]')).toHaveValue('fr4me-pass!');
});

test('a login covering only one of the two hosts is not offered in the frame', async ({ context, extensionId }) => {
  await vaultWith(context, extensionId, [{ ...apple, urls: ID }]);
  const site = await context.newPage();
  await site.goto(page(APP, ID));
  const frame = site.frameLocator('#signin');
  // forms.js runs there (its badge shows), but nothing is offered.
  await expect(frame.locator('.otpilot-field-badge').first()).toBeVisible();
  await site.waitForTimeout(800);
  await expect(frame.locator('#otpilot-login-fill')).toHaveCount(0);
});

test("another site's sign-in frame gets nothing", async ({ context, extensionId }) => {
  await vaultWith(context, extensionId, [{ ...apple, urls: 'otp.localhost\nother.localhost' }]);
  const site = await context.newPage();
  await site.goto(page('app.other.localhost', ID));
  const frame = site.frameLocator('#signin');
  await expect(frame.locator('input[name="password"]')).toBeVisible();
  await site.waitForTimeout(1500);
  await expect(frame.locator('.otpilot-field-badge')).toHaveCount(0);
  await expect(frame.locator('#otpilot-login-fill')).toHaveCount(0);
});

test('a sign-in typed in the frame is offered on the page and saved for both hosts', async ({ context, extensionId }) => {
  const popup = await vaultWith(context, extensionId, []);
  const site = await context.newPage();
  await site.goto(page(APP, ID));
  const frame = site.frameLocator('#signin');
  await expect(frame.locator('.otpilot-field-badge').first()).toBeVisible();
  await frame.locator('input[name="email"]').fill('new@apple.test');
  await frame.locator('input[name="password"]').fill('n3w-fr4me!');
  await frame.getByRole('button', { name: 'Sign in' }).click();
  await expect(frame.locator('body')).toContainText('Signed in');

  const offer = site.locator('#otpilot-login-save'); // on the page, not in the frame
  await expect(offer).toBeVisible();
  await expect(offer).toContainText(`Save this login for ${APP}?`);
  expect(await site.locator('body').innerHTML()).not.toContain('n3w-fr4me!');
  await offer.locator('.otpilot-save-confirm').click();
  await expect.poll(() => logins(popup)).toEqual([
    { title: APP, urls: [`${APP}:${PORT}`, ID], username: 'new@apple.test', password: 'n3w-fr4me!' },
  ]);

  // Saved that way, it's offered in the frame next time.
  await site.goto(page(APP, ID));
  await expect(site.frameLocator('#signin').locator('#otpilot-login-fill')).toContainText('new@apple.test');
});

test("signing in through the frame with a login saved for the page adds the frame's host to it", async ({ context, extensionId }) => {
  const popup = await vaultWith(context, extensionId, [{ ...apple, urls: APP }]);
  const site = await context.newPage();
  await site.goto(page(APP, ID));
  const frame = site.frameLocator('#signin');
  await expect(frame.locator('.otpilot-field-badge').first()).toBeVisible();
  await frame.locator('input[name="email"]').fill('me@apple.test');
  await frame.locator('input[name="password"]').fill('fr4me-pass!');
  await frame.getByRole('button', { name: 'Sign in' }).click();

  const offer = site.locator('#otpilot-login-save');
  await expect(offer).toContainText('Use Apple ID to sign in here too?');
  await offer.locator('.otpilot-save-confirm').click();
  await expect.poll(() => logins(popup)).toEqual([
    { title: 'Apple ID', urls: [APP, ID], username: 'me@apple.test', password: 'fr4me-pass!' },
  ]);
});

test('the background serves a frame only on the same site as its page, over https (or this machine)', async ({ context }) => {
  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent('serviceworker');
  const r = await worker.evaluate(() => {
    const s = (url, top, frameId = 3) => formSender({ tab: { id: 1, url: top }, frameId, url });
    return {
      sameSite: s('https://idmsa.apple.com/auth', 'https://appstoreconnect.apple.com/login'),
      otherSite: s('https://idmsa.apple.com/auth', 'https://evil.example/'),
      plainHttp: s('http://idmsa.apple.com/auth', 'https://appstoreconnect.apple.com/'),
      sharedHosting: s('https://a.github.io/', 'https://b.github.io/'),
      top: s('https://appstoreconnect.apple.com/login', 'https://appstoreconnect.apple.com/login', 0),
      covers: coversAll(['appstoreconnect.apple.com', 'idmsa.apple.com'], s('https://idmsa.apple.com/auth', 'https://appstoreconnect.apple.com/login')),
      coversOne: coversAll(['appstoreconnect.apple.com'], s('https://idmsa.apple.com/auth', 'https://appstoreconnect.apple.com/login')),
    };
  });
  expect(r.sameSite).toEqual({ host: 'idmsa.apple.com', top: 'appstoreconnect.apple.com', hosts: ['idmsa.apple.com', 'appstoreconnect.apple.com'], frame: true });
  expect([r.otherSite, r.plainHttp, r.sharedHosting]).toEqual([null, null, null]);
  expect(r.top).toEqual({ host: 'appstoreconnect.apple.com', hosts: ['appstoreconnect.apple.com'] });
  expect([r.covers, r.coversOne]).toEqual([true, false]);
  // An ancestor of another site (a frame of the site inside someone else's frame): nothing is loaded.
  const injected = await worker.evaluate(() => injectFrameForms(
    { tab: { id: 1, url: 'https://appstoreconnect.apple.com/' }, frameId: 3, url: 'https://idmsa.apple.com/auth' },
    ['https://evil.example', 'https://appstoreconnect.apple.com']));
  expect(injected).toBe(false);
});

const spaPage = then => `http://${APP}:${PORT}/test/frame-top.html?frame=${encodeURIComponent(`http://${ID}:${PORT}/test/frame-login-spa.html?then=${then}`)}`;

test('an app that removes its sign-in frame once signed in still gets the offer', async ({ context, extensionId }) => {
  await vaultWith(context, extensionId, []);
  const site = await context.newPage();
  await site.goto(spaPage('remove'));
  const frame = site.frameLocator('#signin');
  await expect(frame.locator('.otpilot-field-badge').first()).toBeVisible();
  await frame.locator('input[name="email"]').fill('spa@apple.test');
  await frame.locator('input[name="password"]').fill('spa-fr4me!');
  await frame.getByRole('button', { name: 'Sign in' }).click();
  await expect(site.locator('#signin')).toHaveCount(0);
  await expect(site.locator('#otpilot-login-save')).toContainText('spa@apple.test');
});

test('a rejected password in the frame is never offered, even when another frame of the site loads', async ({ context, extensionId }) => {
  await vaultWith(context, extensionId, [{ ...apple, urls: 'otp.localhost' }]);
  const site = await context.newPage();
  await site.goto(spaPage('reject'));
  const frame = site.frameLocator('#signin');
  await expect(frame.locator('.otpilot-field-badge').first()).toBeVisible();
  await frame.locator('input[name="email"]').fill('me@apple.test');
  await frame.locator('input[name="password"]').fill('wrong-pass');
  await frame.locator('input[name="password"]').press('Enter'); // the login offer covers the button
  await expect(site.locator('#other')).toHaveCount(1);
  await expect(site.frameLocator('#other').locator('body')).toContainText('Signed in');
  await site.waitForTimeout(3000); // the frame's own 2 s check, and the page's
  await expect(site.locator('#otpilot-login-save')).toHaveCount(0);
});

test("a login saved only for the frame's host never gets the page's host (a page framing another tenant's sign-in)", async ({ context, extensionId }) => {
  const popup = await vaultWith(context, extensionId, [{ ...apple, urls: ID }]);
  const site = await context.newPage();
  await site.goto(page(APP, ID));
  const frame = site.frameLocator('#signin');
  await expect(frame.locator('.otpilot-field-badge').first()).toBeVisible();
  await frame.locator('input[name="email"]').fill('me@apple.test');
  await frame.locator('input[name="password"]').fill('fr4me-pass!');
  await frame.getByRole('button', { name: 'Sign in' }).click();
  const offer = site.locator('#otpilot-login-save');
  // Only a new login of its own, never "use Apple ID here too".
  await expect(offer).toContainText(`Save this login for ${APP}?`);
  await expect(offer).not.toContainText('here too');
  await offer.locator('.otpilot-save-later').click();
  expect((await logins(popup)).map(l => l.urls)).toEqual([[ID]]);
});

test('a rejected keypad PIN in the frame (read-only, filled after first sight) holds back the offer', async ({ context, extensionId }) => {
  await vaultWith(context, extensionId, [{ name: 'Bank', email: 'me@bank.test', secret: '', password: '1111', urls: 'otp.localhost' }]);
  const site = await context.newPage();
  await site.goto(`http://${APP}:${PORT}/test/frame-top.html?frame=${encodeURIComponent(`http://${ID}:${PORT}/test/frame-pin.html`)}`);
  const frame = site.frameLocator('#signin');
  await expect(frame.locator('.otpilot-field-badge').first()).toBeVisible();
  await site.keyboard.press('Escape');
  await frame.locator('input[name="user"]').fill('me@bank.test');
  for (const d of '2468') await frame.locator('.key', { hasText: d }).click();
  await frame.locator('input[name="user"]').press('Enter');
  await expect(site.locator('#other')).toHaveCount(1);
  await site.waitForTimeout(3000);
  await expect(site.locator('#otpilot-login-save')).toHaveCount(0);
});

test('an IP address is its own site, and plain http is trusted only on this machine', async ({ context }) => {
  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent('serviceworker');
  const r = await worker.evaluate(() => {
    const s = (url, top) => formSender({ tab: { id: 1, url: top }, frameId: 3, url });
    return {
      ipOctets: s('https://192.168.1.5/login', 'https://203.0.1.5/'),
      ipSame: !!s('https://192.168.1.5/login', 'https://192.168.1.5/'),
      lanHttp: s('http://192.168.1.5/login', 'http://192.168.1.5/'),
      loopHttp: !!s('http://id.otp.localhost/login', 'http://app.otp.localhost/'),
      publicIpLocal: isLocalHost('203.0.1.5'),
      lanLocal: isLocalHost('192.168.1.5'),
    };
  });
  expect(r).toEqual({ ipOctets: null, ipSame: true, lanHttp: null, loopHttp: true, publicIpLocal: false, lanLocal: true });
});

test('same site is decided by the Public Suffix List: each tenant of a shared or registry-sold host is its own site', async ({ context }) => {
  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent('serviceworker');
  const r = await worker.evaluate(() => ({
    apple: sameSite('idmsa.apple.com', 'appstoreconnect.apple.com'),
    ukCom: sameSite('a.uk.com', 'b.uk.com'),
    tunnel: sameSite('a.trycloudflare.com', 'b.trycloudflare.com'),
    pages: sameSite('a.github.io', 'b.github.io'),
    bank: sameSite('online.bbva.com.ar', 'www.bbva.com.ar'),
    coUk: sameSite('www.google.co.uk', 'accounts.google.co.uk'),
    ipOctets: sameSite('192.168.1.5', '203.0.1.5'),
    // The Gmail code check (EmailCodes.fromSite) uses the list too, in the background.
    email: EmailCodes.registrableDomain('mail.a.uk.com'),
    updated: /^\d{4}-\d{2}-\d{2}$/.test(PublicSuffix.updated),
  }));
  expect(r).toEqual({ apple: true, ukCom: false, tunnel: false, pages: false, bank: true, coUk: true, ipOctets: false, email: 'a.uk.com', updated: true });
});
