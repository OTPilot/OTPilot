// Chrome Web Store screenshots (1280×800), generated from the real extension
// with demo data. Run from extension/:
//   npx playwright test -c store/playwright.config.js
// Writes store/screenshots/<n>-<name>.png, plus the store's small promo tile
// (store/promo-tile.png, 440×280), the marquee promo tile (store/marquee.png,
// 1400×560) and the X header (store/x-header.png, 1500×500). The demo site is a fictional
// "Northwind" (store/pages), served as northwind.example.
import { test as base, chromium, expect } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';
import { mkdtempSync, rmSync, readFileSync, readdirSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { seedUnlocked, writeAccounts, waitForVault, TEST_SECRET } from '../tests/fixtures.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const extensionPath = path.resolve(__dirname, '..');
const OUT = path.join(__dirname, 'screenshots');
const SITE = 'http://northwind.example:8765/store/pages';

// The headline used everywhere (extension, store, website, Twitter).
const HEADLINE = 'Password manager with built-in 2FA';

const test = base.extend({
  context: async ({}, use) => {
    const dir = mkdtempSync(path.join(tmpdir(), 'otpilot-shots-'));
    const context = await chromium.launchPersistentContext(dir, {
      headless: false,
      deviceScaleFactor: 1,
      args: [
        `--disable-extensions-except=${extensionPath}`,
        `--load-extension=${extensionPath}`,
        '--host-resolver-rules=MAP northwind.example 127.0.0.1',
        // Served over http: without this the page isn't a secure context and
        // has no crypto.subtle, which TOTP needs (real sites are https).
        '--unsafely-treat-insecure-origin-as-secure=http://northwind.example:8765',
      ],
    });
    await use(context);
    await context.close();
    rmSync(dir, { recursive: true, force: true });
  },
  extensionId: async ({ context }, use) => {
    let [worker] = context.serviceWorkers();
    if (!worker) worker = await context.waitForEvent('serviceworker');
    await use(new URL(worker.url()).host);
  },
});

const icon = domain => `data:image/png;base64,${readFileSync(path.join(__dirname, 'icons', `${domain}.png`)).toString('base64')}`;
const iconCache = Object.fromEntries(readdirSync(path.join(__dirname, 'icons'))
  .map(f => f.replace(/\.png$/, ''))
  .map(d => [d.replace(/^www\./, ''), { dataUrl: icon(d), fetchedAt: Date.now() }]));

const ACCOUNTS = [
  { name: 'Northwind', email: 'alex@northwind.example', secret: TEST_SECRET, urls: 'northwind.example', password: 'k8#Vq2!mPz7wR4' },
  { name: 'Northwind (admin)', email: 'admin@northwind.example', secret: '', urls: 'northwind.example', password: 'Tq9$wLm2#xP4' },
  { name: 'GitHub', email: 'alex-dev', secret: TEST_SECRET, urls: 'github.com', password: 'gh-9fK2#p' },
  { name: 'Google', email: 'alex@gmail.com', secret: TEST_SECRET, urls: 'google.com', password: 'g00gle-Pw' },
  { name: 'AWS', email: 'alex@northwind.example', secret: TEST_SECRET, urls: 'aws.amazon.com', password: 'aws-Pw-7', category: 'Work' },
  { name: 'Notion', email: 'alex@northwind.example', secret: '', urls: 'notion.so', password: 'n0tion!', category: 'Work' },
  { name: 'Stripe', email: 'alex@northwind.example', secret: TEST_SECRET, urls: 'dashboard.stripe.com', password: 'Str1pe#Pw', domain: 'stripe.com', category: 'Work',
    notes: 'Owner of the Northwind account. Payouts every Friday.',
    customFields: [
      { label: 'Account ID', value: 'acct_1NwX4kLm9Qe2', kind: 'text', section: 'Billing' },
      { label: 'Support PIN', value: '482913', kind: 'password', section: 'Billing' },
      { label: 'Tax ID', value: 'US 84-2913377', kind: 'text', section: 'Billing' },
    ] },
  { name: 'Figma', email: 'alex@northwind.example', secret: '', urls: 'figma.com', password: 'f1gma!', category: 'Work' },
  { name: 'Linear', email: 'alex@northwind.example', secret: TEST_SECRET, urls: 'linear.app', password: 'l1near', category: 'Work' },
  { name: 'Slack', email: 'alex@northwind.example', secret: '', urls: 'slack.com', password: 'sl4ck', category: 'Work' },
  { name: 'Netflix', email: 'alex@gmail.com', secret: '', urls: 'netflix.com', password: 'n3tflix' },
  { name: 'DigitalOcean', email: 'alex@northwind.example', secret: TEST_SECRET, urls: 'digitalocean.com', password: 'd0cean', category: 'Work' },
];

async function seed(context, extensionId) {
  const page = await context.newPage();
  await page.setViewportSize({ width: 600, height: 580 });
  await page.goto(`chrome-extension://${extensionId}/popup.html`);
  await page.evaluate(() => Promise.all([chrome.storage.local.clear(), chrome.storage.session.clear()]));
  // No auto-submit on the demo site, so the filled code stays on screen.
  await seedUnlocked(page, { iconCache, obfuscated: false, userPlan: 'personal', 'noAutoSubmit:northwind.example': true });
  await page.reload();
  await waitForVault(page);
  await writeAccounts(page, ACCOUNTS);
  // Items linked to Stripe, and a few other types for the vault.
  await page.evaluate(async () => {
    const key = await VaultKeys.getKey();
    const { items } = await VaultStore.readAll(key);
    const stripe = items.find(i => i.title === 'Stripe');
    const note = Vault.newItem('note', { title: 'Stripe recovery codes', notes: '8f2k-9q3m  4n7x-2p8w\n6h1v-3c9z  7t5b-1r6y', links: [stripe.id], tags: ['Work'] });
    const api = Vault.newItem('api', { title: 'Stripe API (live)', links: [stripe.id], tags: ['Work'] });
    Vault.getField(api, 'apiKey').value = 'sk_live_51NwX4kLm9Qe2aB7';
    Vault.getField(api, 'environment').value = 'production';
    const server = Vault.newItem('server', { title: 'Production database', tags: ['Work'] });
    Vault.getField(server, 'host').value = 'db.northwind.example';
    Vault.getField(server, 'port').value = '5432';
    Vault.getField(server, 'username').value = 'app';
    Vault.getField(server, 'password').value = 'pg-Pw-2026!';
    const wifi = Vault.newItem('note', { title: 'Office Wi-Fi', notes: 'Network: Northwind-5G\nPassword: tea-and-biscuits-42' });
    await VaultStore.save([note, api, server, wifi], key);
  });
  await page.reload();
  await waitForVault(page);
  await page.addStyleTag({ content: '::-webkit-scrollbar { display: none; }' }); // no scrollbars in the images
  return page;
}

// One store image: the headline on the left, the UI shot on the right.
async function compose(context, name, title, subtitle, png, { width } = {}) {
  const page = await context.newPage();
  await page.setViewportSize({ width: 1280, height: 800 });
  const img = `data:image/png;base64,${png.toString('base64')}`;
  await page.setContent(`<!doctype html><html><head><meta charset="utf-8"><style>
    body { margin: 0; width: 1280px; height: 800px; overflow: hidden; display: flex; align-items: center; gap: 56px; padding: 0 64px; box-sizing: border-box;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      background: radial-gradient(1200px 700px at 85% 50%, #16304f 0%, #0f172a 55%, #0b1222 100%); color: #f1f5f9; }
    .copy { flex: 0 0 380px; }
    .brand { display: flex; align-items: center; gap: 10px; font-size: 18px; font-weight: 700; color: #38bdf8; margin-bottom: 26px; letter-spacing: .02em; }
    h1 { font-size: 44px; line-height: 1.08; margin: 0 0 18px; letter-spacing: -.01em; }
    p { font-size: 19px; line-height: 1.45; color: #cbd5e1; margin: 0; }
    .shot { flex: 1; display: flex; justify-content: center; }
    .shot img { ${width ? `width: ${width}px;` : 'max-width: 720px; max-height: 680px;'} border-radius: 14px; box-shadow: 0 30px 80px rgba(0,0,0,.55), 0 0 0 1px rgba(255,255,255,.06); }
  </style></head><body>
    <div class="copy"><div class="brand">OTPilot</div><h1>${title}</h1><p>${subtitle}</p></div>
    <div class="shot"><img src="${img}"></div>
  </body></html>`);
  await page.locator('img').evaluate(i => i.decode());
  mkdirSync(OUT, { recursive: true });
  await page.screenshot({ path: path.join(OUT, `${name}.png`) });
  await page.close();
}

// A banner of any size: `body` is its inner HTML, on the screenshots' background.
async function banner(context, file, width, height, css, body) {
  const page = await context.newPage();
  await page.setViewportSize({ width, height });
  await page.setContent(`<!doctype html><html><head><meta charset="utf-8"><style>
    body { margin: 0; width: ${width}px; height: ${height}px; overflow: hidden; box-sizing: border-box;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; color: #f1f5f9;
      background: radial-gradient(1200px 700px at 85% 50%, #16304f 0%, #0f172a 55%, #0b1222 100%); }
    .brand { color: #38bdf8; font-weight: 700; letter-spacing: .02em; }
    h1 { margin: 0; letter-spacing: -.01em; line-height: 1.05; }
    p { margin: 0; color: #cbd5e1; line-height: 1.4; }
    ${css}
  </style></head><body>${body}</body></html>`);
  await page.evaluate(() => Promise.all([...document.images].map(i => i.decode())));
  await page.screenshot({ path: path.join(__dirname, file) });
  await page.close();
}

test.setTimeout(180000);

test('store screenshots', async ({ context, extensionId }) => {
  const popup = await seed(context, extensionId);

  // 1. Sign-in page: the in-field dropdown offers the site's logins.
  const site = await context.newPage();
  await site.setViewportSize({ width: 640, height: 540 });
  await site.goto(`${SITE}/signin.html`);
  await site.click('#email');
  await expect(site.locator('#otpilot-login-dropdown .otpilot-login-choice')).toHaveCount(2);
  await site.locator('#otpilot-login-fill').evaluate(el => el.remove()).catch(() => {}); // the corner offer: one UI per shot
  await compose(context, '1-fill-login', HEADLINE,
    'Fills your password and your 2FA code on any login page. End-to-end encrypted, synced across devices.',
    await site.screenshot());

  // 2. 2FA page: the code is filled in.
  await site.locator('#otpilot-login-dropdown .otpilot-login-choice').first().click();
  await site.click('button');
  await expect(site).toHaveURL(/verify\.html/);
  await expect(site.locator('#code')).toHaveValue(/^\d{6}$/, { timeout: 15000 });
  await site.waitForTimeout(800);
  await compose(context, '2-fill-2fa', 'Your 2FA code, filled in for you',
    'No phone, no copying six digits. OTPilot generates the code and types it on the page.',
    await site.screenshot());

  // 3. Home in the popup: everything about one account.
  await popup.locator('#home-list .lc-row', { hasText: 'Stripe' }).click();
  await popup.locator('#home-detail').evaluate(el => { el.scrollTop = 0; });
  await popup.waitForTimeout(300);
  await compose(context, '3-account', 'Everything about an account in one place',
    'Password, 2FA code, extra fields and related notes, a click away from copy.',
    await popup.screenshot());

  // 4. Saving a new sign-in.
  await site.goto(`${SITE}/signin.html`);
  await site.keyboard.press('Escape');
  await site.fill('#email', 'jamie@northwind.example');
  await site.fill('#password', 'Gx7#pQ2m!vR9');
  await site.click('button');
  await expect(site).toHaveURL(/verify\.html/);
  await site.goto(`${SITE}/home.html`);
  await expect(site.locator('#otpilot-login-save')).toBeVisible();
  await compose(context, '4-save-login', 'Saves new logins as you sign in',
    'Sign in once and OTPilot offers to save it, or to update the password you just changed.',
    await site.screenshot());

  // 5. The vault: logins, notes, servers and API keys.
  await popup.click('#nav-settings');
  await popup.locator('.acc-head', { hasText: 'Production database' }).click();
  await popup.waitForTimeout(300);
  await compose(context, '5-vault', 'Not just passwords',
    'Secure notes, servers and API keys, each with its own fields. Bring everything over from your browser or another password manager.',
    await popup.screenshot());
});

test('promo tiles and X header', async ({ context, extensionId }) => {
  const popup = await seed(context, extensionId);
  await popup.locator('#home-list .lc-row', { hasText: 'Stripe' }).click();
  await popup.locator('#home-detail').evaluate(el => { el.scrollTop = 0; });
  await popup.waitForTimeout(300);
  const shot = `data:image/png;base64,${(await popup.screenshot()).toString('base64')}`;

  // Small promo tile (440×280): the headline, nothing else to read at that size.
  await banner(context, 'promo-tile.png', 440, 280, `
    body { display: flex; flex-direction: column; justify-content: center; padding: 0 34px; }
    .brand { font-size: 15px; margin-bottom: 14px; }
    h1 { font-size: 38px; }`,
    `<div class="brand">OTPilot</div><h1>${HEADLINE}</h1>`);

  // Marquee promo tile (1400×560): headline and sentence, the popup beside them.
  await banner(context, 'marquee.png', 1400, 560, `
    .copy { position: absolute; left: 90px; top: 50%; transform: translateY(-50%); width: 600px; }
    .brand { font-size: 20px; margin-bottom: 20px; }
    h1 { font-size: 60px; margin-bottom: 20px; }
    p { font-size: 22px; }
    img { position: absolute; right: 80px; top: 50%; transform: translateY(-50%); height: 470px; border-radius: 14px;
      box-shadow: 0 30px 80px rgba(0,0,0,.55), 0 0 0 1px rgba(255,255,255,.06); }`,
    `<div class="copy"><div class="brand">OTPilot</div><h1>${HEADLINE}</h1>
      <p>Fills your password and your 2FA code on any login page. End&#8209;to&#8209;end encrypted, synced across devices.</p></div>
     <img src="${shot}">`);

  // X header (1500×500). The avatar covers the bottom-left corner: the copy
  // sits higher up, the popup on the right.
  await banner(context, 'x-header.png', 1500, 500, `
    .copy { position: absolute; left: 80px; top: 70px; width: 620px; }
    .brand { font-size: 20px; margin-bottom: 18px; }
    h1 { font-size: 58px; margin-bottom: 18px; }
    p { font-size: 22px; }
    img { position: absolute; right: 90px; top: 40px; height: 420px; border-radius: 14px;
      box-shadow: 0 30px 80px rgba(0,0,0,.55), 0 0 0 1px rgba(255,255,255,.06); }`,
    `<div class="copy"><div class="brand">OTPilot</div><h1>${HEADLINE}</h1>
      <p>Fills your password and your 2FA code on any login page. End&#8209;to&#8209;end encrypted, synced across devices.</p></div>
     <img src="${shot}">`);
});
