import { test, expect, seedUnlocked, waitForVault, writeAccounts, TEST_SECRET } from './fixtures.js';

// The Free plan has no item limit: a 51st item is saved through every path
// a user adds data (popup Save, the 2FA code form, a page's Save login /
// Update, the API key offer, CSV and encrypted backup imports). The
// `otpilot-item-limit` lock stays: it serializes user-initiated adds.

const counted = n => Array.from({ length: n }, (_, i) => ({ name: `Site ${String(i).padStart(2, '0')}`, email: '', secret: '', urls: `site${i}.example`, password: 'x' }));

async function vaultWith(context, extensionId, accounts, plan = 'free') {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/popup.html`);
  await page.evaluate(() => Promise.all([chrome.storage.local.clear(), chrome.storage.session.clear()]));
  await seedUnlocked(page, { accounts: [], userPlan: plan });
  await page.reload();
  await waitForVault(page);
  if (accounts.length) await writeAccounts(page, accounts);
  await page.reload();
  return page;
}

async function editorWith(context, extensionId, accounts, plan = 'free') {
  const page = await vaultWith(context, extensionId, accounts, plan);
  await page.click('#nav-settings');
  await expect(page.locator('.acc-row')).toHaveCount(accounts.length);
  return page;
}

const allItems = page => page.evaluate(async () => (await VaultStore.readAll(await VaultKeys.getKey())).items);
const itemCount = async page => (await allItems(page)).length;
const noLimitCopy = async page => expect(page.locator('body')).not.toContainText(/Free plan holds|50 items/);

async function addAccount(page, name, { password = '', secret = '' } = {}) {
  await page.click('#btn-add');
  await page.click('[data-add-type="login"]');
  await page.fill('.acc-body.open .acc-name, #acc-detail .acc-name', name);
  if (password) await page.fill('#acc-detail .acc-password', password);
  if (secret) await page.fill('#acc-detail .acc-secret', secret);
  await page.click('#btn-save-all');
}

// ── Every path saves a 51st item on Free ─────────────────────────────────────

test('popup Save: a 51st login with a password is saved on Free', async ({ context, extensionId }) => {
  const page = await editorWith(context, extensionId, counted(50));
  await addAccount(page, 'Fifty-first', { password: 'p' });
  await expect.poll(() => itemCount(page)).toBe(51);
  await noLimitCopy(page);
});

test('popup Save: a 2FA-only login past 50 items gains a password on Free', async ({ context, extensionId }) => {
  const page = await editorWith(context, extensionId, [...counted(52), { name: 'ZZ Codes', email: '', secret: TEST_SECRET, urls: '' }]);
  await page.locator('.acc-head', { hasText: 'ZZ Codes' }).click();
  await page.fill('#acc-detail .acc-password', 'now-a-password');
  await page.click('#btn-save-all');
  await expect.poll(async () => page.evaluate(async () =>
    Vault.getValue((await VaultStore.readAll(await VaultKeys.getKey())).items.find(i => i.title === 'ZZ Codes'), 'password'))).toBe('now-a-password');
  await noLimitCopy(page);
});

test('the 2FA code form: a 51st item is saved on Free', async ({ context, extensionId }) => {
  const page = await editorWith(context, extensionId, counted(50));
  await page.click('#btn-add');
  await page.click('[data-add-type="2fa"]');
  await page.fill('#acc-detail .acc-secret', 'otpauth://totp/GitHub:me%40x.com?secret=JBSWY3DPEHPK3PXP&issuer=GitHub');
  await expect(page.locator('#acc-detail .acc-name')).toHaveValue('GitHub');
  await page.click('#btn-save-all');
  await expect.poll(() => itemCount(page)).toBe(51);
  await noLimitCopy(page);
});

// ── A page's Save login offer ────────────────────────────────────────────────

const SITE = 'http://localhost:8765/test';
async function signIn(site, email, password) {
  await site.goto(`${SITE}/login-nav.html`);
  await site.fill('input[name="email"]', email);
  await site.fill('input[name="password"]', password);
  await site.click('button');
}

test('page Save login: a 51st login is offered and saved on Free', async ({ context, extensionId }) => {
  const popup = await vaultWith(context, extensionId, counted(50));
  const site = await context.newPage();
  await signIn(site, 'one@example.com', 'fifty-one');
  const offer = site.locator('#otpilot-login-save');
  await expect(offer).toContainText('Save this login for localhost?');
  await expect(offer.locator('.otpilot-save-limit')).toHaveCount(0);
  await expect(offer).not.toContainText('Free plan');
  await offer.locator('.otpilot-save-confirm').click();
  await expect.poll(() => itemCount(popup)).toBe(51);
  const saved = (await allItems(popup)).find(i => i.title === 'localhost');
  expect(await popup.evaluate(i => [Vault.getValue(i, 'username'), Vault.getValue(i, 'password')], saved)).toEqual(['one@example.com', 'fifty-one']);
});

test('page Update: a 2FA-only login past 50 items gains a password on Free; Save as new is enabled', async ({ context, extensionId }) => {
  const popup = await vaultWith(context, extensionId, [...counted(50), { name: 'Local', email: 'me@example.com', secret: TEST_SECRET, urls: 'localhost' }]);
  const site = await context.newPage();
  await signIn(site, 'me@example.com', 'now-counted');
  const offer = site.locator('#otpilot-login-save');
  await expect(offer).toContainText('Update the password for Local?');
  await expect(offer.locator('.otpilot-save-limit')).toHaveCount(0);
  await expect(offer.locator('.otpilot-save-new')).toBeEnabled();
  await expect(offer.locator('.otpilot-save-confirm')).toBeEnabled();
  await offer.locator('.otpilot-save-confirm').click();
  await expect.poll(async () => popup.evaluate(async () =>
    Vault.getValue((await VaultStore.readAll(await VaultKeys.getKey())).items.find(i => i.title === 'Local'), 'password'))).toBe('now-counted');
});

test('the background plans a Free vault past 50 items without limit fields', async ({ context, extensionId }) => {
  await vaultWith(context, extensionId, [...counted(50), { name: 'Local', email: 'me@example.com', secret: TEST_SECRET, urls: 'localhost' }]);
  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent('serviceworker');
  const plans = await worker.evaluate(async () => {
    const shape = p => ({ kind: p.kind, keys: Object.keys(p).sort(), candidates: (p.candidates || []).map(c => Object.keys(c).sort()) });
    return {
      update: shape(await planPendingLogin({ host: 'localhost', username: 'me@example.com', password: 'pw' })),
      fresh: shape(await planPendingLogin({ host: 'localhost', username: 'new@example.com', password: 'pw' })),
    };
  });
  expect(plans).toEqual({
    update: { kind: 'update', keys: ['candidates', 'item', 'kind'], candidates: [['item']] },
    fresh: { kind: 'new', keys: ['kind'], candidates: [] },
  });
});

// ── The API key offer ────────────────────────────────────────────────────────

const KEY = 'sk-proj-' + 'Ab3dEf9hIjK1mNoPq7sTuVwXyZ0aB2cD4eF6gH8iJ0kL2mN4oP6qR8sT0uV2wX4y';
const KEY_PAGE = 'http://localhost:8765/settings/api-keys';
const keyHtml = key => `<!doctype html><html><head><title>Keys</title></head><body>
<h1>API keys</h1><button id="create">Create new secret key</button>
<script>document.getElementById('create').onclick = () => {
  const d = document.createElement('div'); d.setAttribute('role','dialog');
  d.innerHTML = '<h2>Save your key</h2><p>Please save your secret key in a safe place since you won\\'t be able to view it again.</p>'
   + '<input readonly value="${key}"><button>Copy</button>';
  document.body.appendChild(d);
};</script></body></html>`;

// The card is in a closed shadow root: reached through CDP, clicked with the
// mouse (trusted events), as in apiKeySave.spec.js.
function cardOf(page) {
  let cdp;
  const run = async (fn, ...args) => {
    cdp ??= await page.context().newCDPSession(page);
    const { root } = await cdp.send('DOM.getDocument', { depth: -1, pierce: true });
    const find = n => {
      const a = n.attributes || [];
      for (let i = 0; i < a.length; i += 2) if (a[i] === 'id' && a[i + 1] === 'otpilot-apikey-save') return n;
      for (const c of [...(n.children || []), ...(n.shadowRoots || [])]) { const f = find(c); if (f) return f; }
      return null;
    };
    const sr = find(root)?.shadowRoots?.[0];
    if (!sr) return null;
    const { object } = await cdp.send('DOM.resolveNode', { backendNodeId: sr.backendNodeId });
    const { result, exceptionDetails } = await cdp.send('Runtime.callFunctionOn', {
      objectId: object.objectId, functionDeclaration: fn.toString(), arguments: args.map(value => ({ value })), returnByValue: true,
    });
    if (exceptionDetails) throw new Error(exceptionDetails.exception?.description || exceptionDetails.text);
    return result.value ?? null;
  };
  return {
    text: () => run(function () { return this.textContent; }),
    count: sel => run(function (s) { return this.querySelectorAll(s).length; }, sel),
    prop: (sel, p) => run(function (s, k) { const e = this.querySelector(s); return e ? e[k] : null; }, sel, p),
    async click(sel) {
      const r = await run(function (s) {
        const b = this.querySelector(s)?.getBoundingClientRect();
        return b ? { x: b.x + b.width / 2, y: b.y + b.height / 2 } : null;
      }, sel);
      if (!r) throw new Error(`no ${sel} in the card`);
      await page.mouse.click(r.x, r.y);
    },
  };
}

test('API key offer: a 51st item is saved on Free', async ({ context, extensionId }) => {
  const popup = await vaultWith(context, extensionId, counted(50));
  const s = await context.newPage();
  await s.route(KEY_PAGE, r => r.fulfill({ contentType: 'text/html', body: keyHtml(KEY) }));
  await s.goto(KEY_PAGE);
  await s.waitForTimeout(500);
  const card = cardOf(s);
  await s.click('#create');
  await expect.poll(() => card.count('.otpilot-apikey-save')).toBe(1);
  expect(await card.count('.otpilot-save-limit')).toBe(0);
  expect(await card.prop('.otpilot-apikey-save', 'disabled')).toBe(false);
  expect(await card.text()).not.toMatch(/Free plan|50 items/);
  await card.click('.otpilot-apikey-save');
  await expect(s.locator('body')).toContainText('API key saved to OTPilot');
  await expect.poll(() => itemCount(popup)).toBe(51);
  expect((await allItems(popup)).filter(i => i.type === 'api')).toHaveLength(1);
});

// ── Imports ──────────────────────────────────────────────────────────────────

test('CSV import: 100 logins land in a Free vault already holding 50', async ({ context, extensionId }) => {
  const page = await vaultWith(context, extensionId, counted(50));
  await page.click('#nav-config');
  await page.click('#row-settings-csv-import');
  const rows = Array.from({ length: 100 }, (_, i) => `Imported ${i},https://imported${i}.example,u${i},p${i}`);
  await page.setInputFiles('#csv-import-file', {
    name: 'passwords.csv', mimeType: 'text/csv', buffer: Buffer.from(['name,url,username,password', ...rows].join('\n')),
  });
  await expect(page.locator('#csv-import-list .export-acc-row')).toHaveCount(100);
  await page.click('#csv-import-confirm');
  await expect(page.locator('#csv-import-status')).toContainText('Imported 100 logins');
  await expect(page.locator('#csv-import-status')).not.toContainText('Free plan');
  expect(await itemCount(page)).toBe(150);
});

test('encrypted backup import: 60 items land in a Free vault already holding 50', async ({ context, extensionId }) => {
  const page = await vaultWith(context, extensionId, counted(50));
  const file = await page.evaluate(async () => {
    const items = Array.from({ length: 60 }, (_, i) => Vault.newItem('note', { title: `Backup note ${i}`, notes: `n${i}` }));
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const key = await deriveKey('backup-pass', salt);
    const { iv, data } = await encryptData(key, JSON.stringify({ items }));
    return JSON.stringify({ v: 2, salt: b64enc(salt), iv, data });
  });
  await page.click('#nav-config');
  await page.click('#row-settings-backup');
  await page.setInputFiles('#import-file', { name: 'otpilot-backup.json', mimeType: 'application/json', buffer: Buffer.from(file) });
  await page.fill('#crypto-password', 'backup-pass');
  await page.click('#crypto-confirm');
  await expect(page.locator('#import-picker-list .export-acc-row')).toHaveCount(60);
  await page.click('#import-picker-confirm');
  await expect(page.locator('#status-msg')).toContainText('60 added');
  await expect(page.locator('#status-msg')).not.toContainText('Free plan');
  expect(await itemCount(page)).toBe(110);
});

// ── The Save guards that stay ────────────────────────────────────────────────

test('an account added while Save waits for the lock is not saved unchecked', async ({ context, extensionId }) => {
  const page = await editorWith(context, extensionId, counted(2));
  await page.evaluate(() => {
    window.releaseLock = null;
    navigator.locks.request('otpilot-item-limit', () => new Promise(r => { window.releaseLock = r; }));
  });
  await page.locator('.acc-head', { hasText: 'Site 00' }).click();
  await page.fill('#acc-detail .acc-name', 'Site 00 renamed');
  await page.click('#btn-save-all'); // queued behind the held lock
  // The user clicks Add meanwhile.
  await page.evaluate(() => { document.getElementById('btn-add').click(); document.querySelector('[data-add-type="login"]').click(); });
  await page.evaluate(() => window.releaseLock());
  await expect(page.locator('#status-msg')).toContainText('changed while saving');
  expect((await allItems(page)).map(i => i.title).sort()).toEqual(['Site 00', 'Site 01']);
});

test('a sync that deleted an account above the open one does not misplace the open edit on Save', async ({ context, extensionId }) => {
  const page = await editorWith(context, extensionId, [
    { name: 'Alpha', email: '', secret: TEST_SECRET, urls: '' },
    { name: 'Bravo', email: '', secret: 'GEZDGNBVGY3TQOJQ', urls: '' },
  ]);
  await page.locator('.acc-head', { hasText: 'Bravo' }).click();
  await page.fill('#acc-detail .acc-name', 'Bravo renamed');
  // Another device deleted Alpha; the sync lands while Bravo is open.
  await page.evaluate(async () => {
    const key = await VaultKeys.getKey();
    const alpha = (await VaultStore.readAll(key)).items.find(i => i.title === 'Alpha');
    await VaultStore.remove([alpha.id]);
    await reloadFromVault(key);
  });
  await page.click('#btn-save-all');
  await expect.poll(() => page.evaluate(async () =>
    (await VaultStore.readAll(await VaultKeys.getKey())).items.map(i => [i.title, i.totp?.secret]))).toEqual([['Bravo renamed', 'GEZDGNBVGY3TQOJQ']]);
});

test('typing in the open form while Save waits for the lock is not dropped', async ({ context, extensionId }) => {
  const page = await editorWith(context, extensionId, counted(2));
  await page.evaluate(() => {
    window.releaseLock = null;
    navigator.locks.request('otpilot-item-limit', () => new Promise(r => { window.releaseLock = r; }));
  });
  await page.locator('.acc-head', { hasText: 'Site 00' }).click();
  await page.fill('#acc-detail .acc-name', 'First edit');
  await page.click('#btn-save-all'); // queued behind the held lock
  await page.fill('#acc-detail .acc-name', 'Typed meanwhile');
  await page.evaluate(() => window.releaseLock());
  await expect(page.locator('#status-msg')).toContainText('changed while saving');
  await expect(page.locator('#acc-detail .acc-name')).toHaveValue('Typed meanwhile');
  await page.click('#btn-save-all');
  await expect.poll(async () => (await allItems(page)).some(i => i.title === 'Typed meanwhile')).toBe(true);
});

test('a double click on Save while renaming saves once, without touching other accounts', async ({ context, extensionId }) => {
  const page = await editorWith(context, extensionId, [
    { name: 'Alpha', email: 'a@x.com', secret: '', urls: '', password: 'pa' },
    { name: 'Bravo', email: 'b@x.com', secret: '', urls: '', password: 'pb' },
  ]);
  await page.locator('.acc-head', { hasText: 'Alpha' }).click();
  await page.fill('#acc-detail .acc-name', 'Zulu'); // re-sorts below Bravo on save
  await page.evaluate(() => { const b = document.getElementById('btn-save-all'); b.click(); b.click(); });
  await expect.poll(() => page.evaluate(async () => (await VaultStore.readAll(await VaultKeys.getKey())).items
    .map(i => [i.title, Vault.getValue(i, 'username'), Vault.getValue(i, 'password')]).sort())).toEqual([
    ['Bravo', 'b@x.com', 'pb'], ['Zulu', 'a@x.com', 'pa'],
  ]);
});

test('the editor\'s Save waits for another user-initiated add holding the lock', async ({ context, extensionId }) => {
  const page = await editorWith(context, extensionId, counted(49));
  const order = await page.evaluate(async () => {
    const events = [];
    let release;
    const held = navigator.locks.request('otpilot-item-limit', () => new Promise(r => { release = r; events.push('other save'); }));
    await new Promise(r => setTimeout(r, 50));
    const real = VaultAccounts.save;
    VaultAccounts.save = async (...a) => { events.push('editor save'); return real(...a); };
    document.getElementById('btn-add').click(); document.querySelector('[data-add-type="login"]').click();
    document.querySelector('#acc-detail .acc-name').value = 'Fiftieth';
    document.getElementById('btn-save-all').click();
    await new Promise(r => setTimeout(r, 300));
    events.push('other done');
    release();
    await held;
    await new Promise(r => setTimeout(r, 500));
    return events;
  });
  expect(order).toEqual(['other save', 'other done', 'editor save']);
});

test('a save queued behind the lock does not save an editing session started later', async ({ context, extensionId }) => {
  const page = await editorWith(context, extensionId, counted(2));
  const titles = async () => (await allItems(page)).map(i => i.title).sort();
  await page.evaluate(() => {
    window.releaseLock = null;
    navigator.locks.request('otpilot-item-limit', () => new Promise(r => { window.releaseLock = r; }));
  });
  await page.locator('.acc-head', { hasText: 'Site 00' }).click();
  await page.fill('#acc-detail .acc-name', 'Clicked save on this');
  await page.click('#btn-save-all'); // queued behind the held lock
  // The user leaves the editor and starts over, typing something else.
  await page.click('#nav-home');
  await page.click('#nav-settings');
  await page.locator('.acc-head', { hasText: 'Site 01' }).click();
  await page.fill('#acc-detail .acc-name', 'Never saved');
  await page.evaluate(() => window.releaseLock());
  await expect(page.locator('#status-msg')).toContainText('changed while saving');
  expect(await titles()).toEqual(['Site 00', 'Site 01']);
});
