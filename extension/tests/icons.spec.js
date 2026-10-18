import { test, expect, seedUnlocked, waitForVault, writeAccounts, TEST_SECRET } from './fixtures.js';

// 1×1 transparent PNG as a data URL — stands in for a cached favicon.
const PNG_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC';

// Seeds an unlocked vault with one account that has a cached icon and one without.
async function seed(page) {
  await seedUnlocked(page);
  await page.evaluate(([secret, dataUrl]) => {
    return new Promise(r => chrome.storage.local.set({
      accounts: [
        { name: 'GitHub', secret, urls: 'github.com', domain: 'github.com', email: '' },
        { name: 'Acme',   secret, urls: 'acme.test',  domain: 'acme.test',  email: '' },
      ],
      iconCache: { 'github.com': { dataUrl, fetchedAt: Date.now() } },
    }, r));
  }, [TEST_SECRET, PNG_DATA_URL]);
}

test('home list rows render the cached favicon as <img>, fall back to a letter avatar', async ({ context, extensionId }) => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/popup.html`);
  await seed(page);
  await page.reload();

  // The account with a cached icon renders an <img> avatar with the data URL.
  const img = page.locator('#home-list img.acc-av');
  await expect(img).toHaveCount(1);
  await expect(img).toHaveAttribute('src', /^data:image\/png/);

  // The account without a cached icon keeps the letter avatar (a <span>).
  await expect(page.locator('#home-list span.acc-av')).toHaveCount(1);
});

test('vault rows render the cached favicon as <img>', async ({ context, extensionId }) => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/popup.html`);
  await seed(page);
  await page.reload();

  await page.click('#nav-settings');
  await expect(page.locator('#settings-panel')).toBeVisible();

  // Two rows: GitHub (icon → img) and Acme (no icon → span).
  await expect(page.locator('.acc-head img.acc-av')).toHaveCount(1);
  await expect(page.locator('.acc-head span.acc-av')).toHaveCount(1);
});

test('a cached "no icon" is asked again when the page sends a hint, and expires after a day', async ({ context, extensionId }) => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/popup.html`);
  const [worker] = context.serviceWorkers().length ? context.serviceWorkers() : [await context.waitForEvent('serviceworker')];
  const r = await worker.evaluate(async dataUrl => {
    const now = Date.now();
    await chrome.storage.local.set({ iconCache: {
      'hinted.test': { dataUrl: null, fetchedAt: now },
      'old.test': { dataUrl: null, fetchedAt: now - 2 * 24 * 3600 * 1000 },
      'recent.test': { dataUrl: null, fetchedAt: now },
    } });
    const asked = [];
    const png = await (await fetch(dataUrl)).arrayBuffer();
    globalThis.fetch = async (url, opts) => {
      if (String(url).endsWith('/icons/resolve')) {
        const { domains } = JSON.parse(opts.body);
        asked.push(...domains);
        return new Response(JSON.stringify(Object.fromEntries(domains.map(d => [d, { status: 'ok', url: `https://cdn.test/${d}.png` }]))), { status: 200 });
      }
      return new Response(png, { status: 200, headers: { 'content-type': 'image/png' } });
    };
    await handleResolveIcons(['hinted.test', 'old.test', 'recent.test'], { 'hinted.test': 'https://hinted.test/icon.png' }, false);
    const { iconCache } = await chrome.storage.local.get('iconCache');
    return { asked: asked.sort(), got: Object.keys(iconCache).filter(d => iconCache[d].dataUrl).sort() };
  }, PNG_DATA_URL);
  expect(r).toEqual({ asked: ['hinted.test', 'old.test'], got: ['hinted.test', 'old.test'] });
});

test('an update forgets cached "no icon" answers and keeps the icons', async ({ context, extensionId }) => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/popup.html`);
  const [worker] = context.serviceWorkers().length ? context.serviceWorkers() : [await context.waitForEvent('serviceworker')];
  const cache = await worker.evaluate(async dataUrl => {
    await chrome.storage.local.set({ iconCache: {
      'github.com': { dataUrl, fetchedAt: Date.now() },
      'bbva.es': { dataUrl: null, fetchedAt: Date.now() },
    } });
    await forgetMissingIcons();
    return (await chrome.storage.local.get('iconCache')).iconCache;
  }, PNG_DATA_URL);
  expect(Object.keys(cache)).toEqual(['github.com']);
});

test('a download finishing after the update cleanup does not bring back "no icon" answers', async ({ context, extensionId }) => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/popup.html`);
  const [worker] = context.serviceWorkers().length ? context.serviceWorkers() : [await context.waitForEvent('serviceworker')];
  await context.route('**/icons/resolve', route => route.fulfill({
    contentType: 'application/json', body: JSON.stringify({ 'slow.test': { status: 'ok', url: 'https://icons.example/slow.test.png' } }),
  }));
  let release;
  const held = new Promise(r => { release = r; });
  await context.route('https://icons.example/**', async route => {
    await held;
    route.fulfill({ contentType: 'image/png', body: Buffer.from(PNG_DATA_URL.split(',')[1], 'base64') });
  });
  await worker.evaluate(() => chrome.storage.local.set({ iconCache: {
    'bbva.es': { dataUrl: null, fetchedAt: Date.now() },
  } }));
  // A request reads the cache, then waits on its download while the update runs.
  await worker.evaluate(() => { globalThis._pending = handleResolveIcons(['slow.test'], {}, false); });
  await page.waitForTimeout(300);
  await worker.evaluate(() => forgetMissingIcons());
  release();
  const cache = await worker.evaluate(async () => {
    await globalThis._pending;
    return (await chrome.storage.local.get('iconCache')).iconCache;
  });
  expect(Object.keys(cache)).toEqual(['slow.test']);
});

test('an item with no website shows the icon of a related login', async ({ context, extensionId }) => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/popup.html`);
  await page.evaluate(() => Promise.all([chrome.storage.local.clear(), chrome.storage.session.clear()]));
  await seedUnlocked(page, { accounts: [], obfuscated: false });
  await page.reload();
  await waitForVault(page);
  await writeAccounts(page, [
    { name: 'GitHub', email: 'a', secret: '', urls: 'github.com', password: 'p' },
    { name: 'Acme', email: 'b', secret: '', urls: 'acme.test', password: 'p' },
  ]);
  await page.evaluate(async dataUrl => {
    const key = await VaultKeys.getKey();
    const { items } = await VaultStore.readAll(key);
    const github = items.find(i => i.title === 'GitHub');
    const acme = items.find(i => i.title === 'Acme');
    // Links Acme first (no icon), then GitHub: the first one with an icon wins.
    const codes = Vault.newItem('note', { title: 'Backup codes', links: [acme.id, github.id] });
    const linkedBack = Vault.newItem('note', { title: 'Linked back' });
    const alone = Vault.newItem('note', { title: 'Alone' });
    await VaultStore.save([codes, linkedBack, alone, { ...github, links: [linkedBack.id] }], key);
    await chrome.storage.local.set({ iconCache: { 'github.com': { dataUrl, fetchedAt: Date.now() } } });
  }, PNG_DATA_URL);
  await page.reload();
  await waitForVault(page);
  await page.click('#nav-settings');

  const row = name => page.locator('.acc-head', { hasText: name });
  await expect(row('Backup codes').locator('img.acc-av')).toHaveAttribute('src', PNG_DATA_URL);
  await expect(row('Linked back').locator('img.acc-av')).toHaveAttribute('src', PNG_DATA_URL);
  await expect(row('Alone').locator('span.acc-av')).toHaveCount(1);
  await expect(row('Acme').locator('span.acc-av')).toHaveCount(1);
});

// A note linked to the GitHub login, with GitHub's icon cached or not.
async function noteLinkedToGitHub(context, extensionId, { cached }) {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/popup.html`);
  await page.evaluate(() => Promise.all([chrome.storage.local.clear(), chrome.storage.session.clear()]));
  await seedUnlocked(page, { accounts: [], obfuscated: false });
  await page.reload();
  await waitForVault(page);
  await writeAccounts(page, [{ name: 'GitHub', email: 'a', secret: '', urls: 'github.com', password: 'p' }]);
  await page.evaluate(async ([dataUrl, cached]) => {
    const key = await VaultKeys.getKey();
    const { items } = await VaultStore.readAll(key);
    const github = items.find(i => i.title === 'GitHub');
    await VaultStore.save([Vault.newItem('note', { title: 'Backup codes', links: [github.id] })], key);
    await chrome.storage.local.set({ iconCache: cached ? { 'github.com': { dataUrl, fetchedAt: Date.now() } } : {} });
  }, [PNG_DATA_URL, cached]);
  return page;
}

test('deleting the related login in the vault drops its icon from the note before saving', async ({ context, extensionId }) => {
  const page = await noteLinkedToGitHub(context, extensionId, { cached: true });
  await page.reload();
  await waitForVault(page);
  await page.click('#nav-settings');
  const note = page.locator('.acc-head', { hasText: 'Backup codes' });
  await expect(note.locator('img.acc-av')).toHaveCount(1);

  await page.locator('.acc-head', { hasText: 'GitHub' }).click();
  page.once('dialog', d => d.accept());
  await page.click('#acc-detail .btn-del:not(.btn-merge)');
  await expect(page.locator('.acc-head', { hasText: 'GitHub' })).toHaveCount(0);
  await expect(note.locator('span.acc-av')).toHaveCount(1);
});

test('Home shows a related note\'s icon once it is downloaded, keeping what was revealed', async ({ context, extensionId }) => {
  const png = Buffer.from(PNG_DATA_URL.split(',')[1], 'base64');
  let release;
  const held = new Promise(r => { release = r; });
  await context.route('**/icons/resolve', route => route.fulfill({
    contentType: 'application/json', body: JSON.stringify({ 'github.com': { status: 'ok', url: 'https://icons.example/github.com.png' } }),
  }));
  await context.route('https://icons.example/**', async route => { await held; route.fulfill({ contentType: 'image/png', body: png }); });

  const page = await noteLinkedToGitHub(context, extensionId, { cached: false });
  await page.reload();
  await waitForVault(page);
  await page.locator('#home-list .lc-row', { hasText: 'GitHub' }).click();
  const row = page.locator('#home-creds .home-rel-head', { hasText: 'Backup codes' });
  await expect(row.locator('span.acc-av')).toHaveCount(1);
  // A password shown before the icon lands stays shown (no rebuild).
  const password = page.locator('#home-creds .home-cred', { hasText: 'Password' });
  await password.locator('.home-cred-btn', { hasText: 'Show' }).click();
  await expect(password.locator('.home-cred-value')).toHaveText('p');

  release();
  await expect(row.locator('img.acc-av')).toHaveCount(1);
  await expect(password.locator('.home-cred-value')).toHaveText('p');
});
