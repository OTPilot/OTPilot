// API keys shown once on a page (apiKeyOffer.js + background vaultAddApiKey,
// vaultApiKeyContext, apiKeyNeverSave) and the pure detection rules (apiKeys.js).
import { test, expect, seedUnlocked, seedLocked, waitForVault, writeAccounts } from './fixtures.js';
const KEY = 'sk-proj-' + 'Ab3dEf9hIjK1mNoPq7sTuVwXyZ0aB2cD4eF6gH8iJ0kL2mN4oP6qR8sT0uV2wX4y';
const PAGE = 'http://localhost:8765/settings/api-keys';
const html = (key, extra = '') => `<!doctype html><html><head><title>Keys</title></head><body>
<h1>API keys</h1><button id="create">Create new secret key</button>${extra}
<script>document.getElementById('create').onclick = () => {
  const d = document.createElement('div'); d.setAttribute('role','dialog');
  d.innerHTML = '<h2>Save your key</h2><p>Please save your secret key in a safe place since you won\\'t be able to view it again.</p>'
   + '<input readonly value="${key}"><button>Copy</button>';
  document.body.appendChild(d);
};</script></body></html>`;
async function vaultWith(context, extensionId, accounts, local = {}, locked = false) {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/popup.html`);
  await page.evaluate(() => Promise.all([chrome.storage.local.clear(), chrome.storage.session.clear()]));
  await (locked ? seedLocked : seedUnlocked)(page, { accounts: [], ...local });
  await page.reload();
  if (!locked) { await waitForVault(page); if (accounts.length) await writeAccounts(page, accounts); }
  return page;
}
const items = page => page.evaluate(async () => (await VaultStore.readAll(await VaultKeys.getKey())).items);
async function site(context, body) {
  const s = await context.newPage();
  await s.route(PAGE, r => r.fulfill({ contentType: 'text/html', body }));
  await s.goto(PAGE);
  await s.waitForTimeout(500);
  return s;
}
// The card is in a closed shadow root, which page scripts (and Playwright's
// locators) can't reach. Tests reach it through DevTools (CDP sees closed
// roots) and click it with the mouse: trusted events, like the user's.
function cardOf(page) {
  let cdp;
  const rootId = async () => {
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
    return (await cdp.send('DOM.resolveNode', { backendNodeId: sr.backendNodeId })).object.objectId;
  };
  // `fn` runs with `this` = the card's shadow root; null without a card.
  const run = async (fn, ...args) => {
    const objectId = await rootId();
    if (!objectId) return null;
    const { result, exceptionDetails } = await cdp.send('Runtime.callFunctionOn', {
      objectId, functionDeclaration: fn.toString(), arguments: args.map(value => ({ value })), returnByValue: true,
    });
    if (exceptionDetails) throw new Error(exceptionDetails.exception?.description || exceptionDetails.text);
    return result.value ?? null;
  };
  return {
    run,
    shown: async () => !!(await run(function () { return true; })),
    text: (sel = '.otpilot-apikey-root') => run(function (s) { return this.querySelector(s)?.textContent ?? null; }, sel),
    html: () => run(function () { return this.innerHTML; }),
    prop: (sel, p) => run(function (s, k) { const e = this.querySelector(s); return e ? e[k] : null; }, sel, p),
    attr: (sel, name) => run(function (s, n) { return this.querySelector(s)?.getAttribute(n) ?? null; }, sel, name),
    count: sel => run(function (s) { return this.querySelectorAll(s).length; }, sel),
    async click(sel) {
      const r = await run(function (s) {
        const e = this.querySelector(s);
        if (!e) return null;
        const b = e.getBoundingClientRect();
        return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
      }, sel);
      if (!r) throw new Error(`no ${sel} in the card`);
      await page.mouse.click(r.x, r.y);
    },
  };
}
const apiItems = async popup => (await items(popup)).filter(i => i.type === 'api');
const ApiKeysMask = k => `${['sk-proj-', 'ghp_', 'sk_live_'].find(p => k.startsWith(p)) || ''}••••••••${k.slice(-4)}`;
const fieldOf = (item, id) => item.fields.find(f => f.id === id)?.value;

// What a page script could try, on the page and with find-in-page (which,
// unlike the DOM, sees into closed shadow roots).
const pageSees = (page, words) => page.evaluate(ws => {
  const host = document.getElementById('otpilot-apikey-save');
  document.execCommand('selectAll');
  const selected = String(getSelection());
  getSelection().removeAllRanges();
  const dump = [document.documentElement.outerHTML, document.body.innerText, document.body.textContent, selected].join('\n');
  return {
    host: !!host, shadowRoot: host?.shadowRoot ?? null, children: host?.childNodes.length,
    ours: document.querySelectorAll('option, select, label, .otpilot-apikey-link, .otpilot-apikey-save').length,
    leaked: ws.filter(w => dump.includes(w) || window.find(w)),
  };
}, words);

test('one login: linked by default, saved, key never in card', async ({ context, extensionId }) => {
  const popup = await vaultWith(context, extensionId, [{ name: 'OpenAI', email: 'me@x.com', secret: '', urls: 'localhost', password: 'pw' }]);
  const s = await site(context, html(KEY));
  const card = cardOf(s);
  await s.click('#create');
  await expect.poll(() => card.text()).toContain('Save this API key from localhost?');
  expect(await card.text('.otpilot-apikey-masked')).toBe('sk-proj-••••••••' + KEY.slice(-4));
  expect(await card.prop('.otpilot-apikey-link input', 'checked')).toBe(true);
  // The line names the site, never the login (nothing drawn names it before a click).
  expect(await card.text('.otpilot-apikey-link-text')).toBe('Link to your saved localhost login');
  expect(await card.html()).not.toContain('OpenAI');
  expect(await card.html()).not.toContain('me@x.com');
  expect(await card.html()).not.toContain(KEY.slice(8, 30));
  // A script click (not the user's) saves nothing.
  await card.run(function () { this.querySelector('.otpilot-apikey-save').click(); });
  await s.waitForTimeout(400);
  expect(await apiItems(popup)).toHaveLength(0);
  await card.click('.otpilot-apikey-save');
  await expect.poll(() => card.shown()).toBe(false);
  // The toast is in the page's DOM: it doesn't name the login.
  await expect(s.locator('body')).toContainText('API key saved to OTPilot, linked to your login');
  expect((await pageSees(s, ['OpenAI', 'me@x.com'])).leaked).toEqual([]);
  const all = await items(popup);
  const login = all.find(i => i.type === 'login');
  const api = all.find(i => i.type === 'api');
  expect(api.title).toBe('Localhost');
  expect(api.urls).toEqual(['localhost']);
  expect(api.links).toEqual([login.id]);
  expect(fieldOf(api, 'apiKey')).toBe(KEY);
  // Same key again: already saved, no offer.
  await s.reload(); await s.waitForTimeout(400); await s.click('#create');
  await s.waitForTimeout(1200);
  await expect(s.locator('#otpilot-apikey-save')).toHaveCount(0);
  expect(await apiItems(popup)).toHaveLength(1);
});


test('the page cannot read the card: no login name or username in its DOM', async ({ context, extensionId }) => {
  const popup = await vaultWith(context, extensionId, [
    { name: 'Zebrafinch Ops', email: 'quokka@corp.test', secret: '', urls: 'localhost', password: 'pw' },
    { name: 'Marmoset Dev', email: 'wallaby@corp.test', secret: '', urls: 'localhost', password: 'pw' }]);
  const s = await site(context, html(KEY));
  const card = cardOf(s);
  await s.click('#create');
  await expect.poll(() => card.count('select option')).toBe(3);
  // The options name them (shown once the user opens the select); closed,
  // it draws "Don't link".
  const shown = await card.text();
  for (const w of ['Zebrafinch', 'quokka@corp.test', 'Marmoset', 'wallaby@corp.test']) expect(shown).toContain(w);
  expect(await card.run(function () { const s = this.querySelector('select'); return s.options[s.selectedIndex].text; })).toBe("Don't link");
  // The page's scripts find nothing.
  expect(await pageSees(s, ['Zebrafinch', 'quokka', 'Marmoset', 'wallaby'])).toEqual({ host: true, shadowRoot: null, children: 0, ours: 0, leaked: [] });

  // One login: a ticked line naming the site only, no title / tooltip.
  await writeAccounts(popup, [{ name: 'Zebrafinch Ops', email: 'quokka@corp.test', secret: '', urls: 'localhost', password: 'pw' }]);
  const one = await site(context, html(KEY));
  const card1 = cardOf(one);
  await one.click('#create');
  await expect.poll(() => card1.text('.otpilot-apikey-link-text')).toBe('Link to your saved localhost login');
  const drawn = await card1.html();
  for (const w of ['Zebrafinch', 'quokka']) expect(drawn).not.toContain(w);
  expect(await card1.attr('.otpilot-apikey-link', 'title')).toBe(null);
  expect(await pageSees(one, ['Zebrafinch', 'quokka'])).toEqual({ host: true, shadowRoot: null, children: 0, ours: 0, leaked: [] });
  // Tokens the page rewrites on the host don't change the card's font.
  await one.evaluate(() => document.getElementById('otpilot-apikey-save').style.setProperty('--font-ui', '"PageFont"'));
  const fonts = await card1.run(function () {
    return ['.otpilot-apikey-link-text', '.otpilot-apikey-name', '.otpilot-apikey-save', '.otpilot-apikey-masked']
      .map(s => getComputedStyle(this.querySelector(s)).fontFamily);
  });
  expect(fonts).toEqual(['system-ui, sans-serif', 'system-ui, sans-serif', 'system-ui, sans-serif', 'monospace']);
});

test('a page modal with a focus trap: the Name field still takes typing', async ({ context, extensionId }) => {
  const popup = await vaultWith(context, extensionId, []);
  // A simple trap, like Radix FocusScope / react-focus-lock: focus leaving
  // the dialog (document focusin capture, focusout with a relatedTarget
  // outside) is pulled back to the dialog's input.
  const s = await site(context, `<!doctype html><html><body><button id="c">Create</button><script>
const pull = () => document.querySelector('[role=dialog] .filter');
document.addEventListener('focusin', e => { const d = document.querySelector('[role=dialog]'); if (d && !d.contains(e.target)) pull().focus(); }, true);
document.addEventListener('focusout', e => { const d = document.querySelector('[role=dialog]'); if (d && e.relatedTarget && !d.contains(e.relatedTarget)) pull().focus(); });
c.onclick = () => {
  const d = document.createElement('div'); d.setAttribute('role', 'dialog');
  d.innerHTML = '<p>Copy your secret key now. You won\\'t be able to see it again.</p><input class="filter" aria-label="Filter"><input readonly value="${KEY}"><button>Copy</button>';
  document.body.appendChild(d); pull().focus();
};</script></body></html>`);
  const card = cardOf(s);
  await s.click('#c');
  await expect.poll(() => card.count('.otpilot-apikey-name')).toBe(1);
  await card.click('.otpilot-apikey-name');
  await s.keyboard.press('End');
  await s.keyboard.type(' trapped');
  await expect.poll(() => card.prop('.otpilot-apikey-name', 'value')).toBe('Localhost trapped');
  expect(await s.locator('.filter').inputValue()).toBe('');
  await card.click('.otpilot-apikey-save');
  await expect.poll(async () => (await apiItems(popup)).length).toBe(1);
  expect((await apiItems(popup))[0].title).toBe('Localhost trapped');
});

test('several logins: Don\'t link by default', async ({ context, extensionId }) => {
  const popup = await vaultWith(context, extensionId, [
    { name: 'A', email: 'a@x.com', secret: '', urls: 'localhost', password: 'pw' },
    { name: 'B', email: 'b@x.com', secret: '', urls: 'localhost', password: 'pw' }]);
  const s = await site(context, html(KEY));
  const card = cardOf(s);
  await s.click('#create');
  await expect.poll(() => card.prop('select', 'value')).toBe('');
  await card.click('.otpilot-apikey-save');
  await expect.poll(async () => (await apiItems(popup)).length).toBe(1);
  expect((await apiItems(popup))[0].links ?? []).toEqual([]);
});

test('no logins, masked key, docs page: no link line / no offer', async ({ context, extensionId }) => {
  await vaultWith(context, extensionId, []);
  const s = await site(context, html('sk-proj-••••••••a9F2'));
  await s.click('#create'); await s.waitForTimeout(1200);
  await expect(s.locator('#otpilot-apikey-save')).toHaveCount(0);
  const docs = await site(context, `<html><body><pre>curl -H "Authorization: Bearer ${KEY}" https://api.x</pre><button>Copy</button></body></html>`);
  await docs.waitForTimeout(1200);
  await expect(docs.locator('#otpilot-apikey-save')).toHaveCount(0);
  const s2 = await site(context, html(KEY));
  const card = cardOf(s2);
  await s2.click('#create');
  await expect.poll(() => card.count('.otpilot-apikey-save')).toBe(1);
  expect(await card.count('.otpilot-apikey-link')).toBe(0);
});

test('Never stores the host; Free limit disables Save; locked shows unlock frame', async ({ context, extensionId }) => {
  const full = Array.from({ length: 50 }, (_, i) => ({ name: `S${i}`, email: '', secret: '', urls: `s${i}.example`, password: 'x' }));
  const popup = await vaultWith(context, extensionId, full, { userPlan: 'free' });
  const s = await site(context, html(KEY));
  const card = cardOf(s);
  await s.click('#create');
  await expect.poll(() => card.text('.otpilot-save-limit')).toContain('50 items');
  expect(await card.prop('.otpilot-apikey-save', 'disabled')).toBe(true);
  await card.click('.otpilot-apikey-never');
  await expect.poll(() => popup.evaluate(async () => (await chrome.storage.local.get('apiKeyNeverSave')).apiKeyNeverSave)).toEqual(['localhost']);
  const s2 = await site(context, html(KEY));
  await s2.click('#create'); await s2.waitForTimeout(1200);
  await expect(s2.locator('#otpilot-apikey-save')).toHaveCount(0);
});
test('locked: unlock frame', async ({ context, extensionId }) => {
  await vaultWith(context, extensionId, [], {}, true);
  const s = await site(context, html(KEY));
  const card = cardOf(s);
  await s.click('#create');
  await expect.poll(() => card.count('iframe')).toBe(1);
  await expect.poll(() => s.frames().some(f => f.url().includes('/unlock.html'))).toBe(true);
});

test('a code sample on a docs page and a key with no copy control are not offered', async ({ context, extensionId }) => {
  await vaultWith(context, extensionId, []);
  const bare = await site(context, `<html><body><p>Your new key:</p><code>${KEY}</code></body></html>`);
  await bare.waitForTimeout(1200);
  await expect(bare.locator('#otpilot-apikey-save')).toHaveCount(0);
});

test('a generic token on a page with every signal is offered; without the copy-once wording it is not', async ({ context, extensionId }) => {
  await vaultWith(context, extensionId, []);
  const token = 'q7Zk2mXv9LpR4tYw8NbC3dFgH6jKs1Ae';
  const withAll = await site(context, `<html><body><button id="c">Create</button><script>c.onclick=()=>{const d=document.createElement('div');d.setAttribute('role','dialog');d.innerHTML='<p>Your API key. Copy it now, it will not be shown again.</p><input readonly value="${token}"><button>Copy</button>';document.body.appendChild(d)}</script></body></html>`);
  await withAll.click('#c');
  await expect.poll(() => cardOf(withAll).count('.otpilot-apikey-save')).toBe(1);
  const quiet = await site(context, `<html><body><button id="c">Create</button><script>c.onclick=()=>{const d=document.createElement('div');d.setAttribute('role','dialog');d.innerHTML='<p>API key</p><p>Here it is.</p><input readonly value="${token}"><button>Copy</button>';document.body.appendChild(d)}</script></body></html>`);
  await quiet.click('#c'); await quiet.waitForTimeout(1200);
  await expect(quiet.locator('#otpilot-apikey-save')).toHaveCount(0);
});

test('Not now closes the card and saves nothing', async ({ context, extensionId }) => {
  const popup = await vaultWith(context, extensionId, []);
  const s = await site(context, html(KEY));
  const card = cardOf(s);
  await s.click('#create');
  await expect.poll(() => card.count('.otpilot-apikey-later')).toBe(1);
  await card.click('.otpilot-apikey-later');
  await expect.poll(() => card.shown()).toBe(false);
  await expect(s.locator('#otpilot-apikey-save')).toHaveCount(0);
  expect(await apiItems(popup)).toHaveLength(0);
});

const AWS_ID = 'AKIAZ3MXQ7P2LR5TW8NB';
const AWS_SECRET = 'q8Vt2/Lm9ZrX4+bN7kP3wYc6Hs1JdF5gT0aRe8Uz';
const awsPage = parts => `<!doctype html><html><body><button id="c">Create access key</button><script>c.onclick = () => {
  const d = document.createElement('div'); d.setAttribute('role', 'dialog');
  d.innerHTML = '<h2>Retrieve access keys</h2><p>This is the only time that the secret access key can be viewed. Copy it now.</p>'
    + ${JSON.stringify(parts)} + '<button>Copy</button>';
  document.body.appendChild(d);
};</script></body></html>`;

test('AWS: the access key ID and its secret are saved together; one half alone is not offered', async ({ context, extensionId }) => {
  const popup = await vaultWith(context, extensionId, []);
  const idOnly = await site(context, awsPage(`<label>Access key</label><input readonly value="${AWS_ID}">`));
  await idOnly.click('#c'); await idOnly.waitForTimeout(1200);
  await expect(idOnly.locator('#otpilot-apikey-save')).toHaveCount(0);
  const secretOnly = await site(context, awsPage(`<label>Secret access key</label><input readonly value="${AWS_SECRET}">`));
  await secretOnly.click('#c'); await secretOnly.waitForTimeout(1200);
  await expect(secretOnly.locator('#otpilot-apikey-save')).toHaveCount(0);

  const s = await site(context, awsPage(`<label>Access key</label><input readonly value="${AWS_ID}"><label>Secret access key</label><input readonly value="${AWS_SECRET}">`));
  const card = cardOf(s);
  await s.click('#c');
  await expect.poll(() => card.text('.otpilot-apikey-masked')).toBe('••••••••' + AWS_SECRET.slice(-4));
  expect(await card.html()).not.toContain(AWS_SECRET.slice(0, 20));
  await card.click('.otpilot-apikey-save');
  await expect.poll(async () => (await apiItems(popup)).length).toBe(1);
  const [api] = await apiItems(popup);
  expect([fieldOf(api, 'clientId'), fieldOf(api, 'clientSecret'), fieldOf(api, 'apiKey')]).toEqual([AWS_ID, AWS_SECRET, '']);
});

test('a 40-character generic token (AWS-secret shaped) without an access key ID is judged as a generic key', async ({ context, extensionId }) => {
  await vaultWith(context, extensionId, []);
  const token = 'q8Vt2Lm9ZrX4bN7kP3wYc6Hs1JdF5gT0aRe8Uz4Q';
  expect(token).toHaveLength(40);
  const s = await site(context, awsPage(`<label>Your API key</label><input readonly value="${token}">`));
  const card = cardOf(s);
  await s.click('#c');
  await expect.poll(() => card.count('.otpilot-apikey-save')).toBe(1);
});

test('a read-only field filled later by a script (input.value =) is offered', async ({ context, extensionId }) => {
  const popup = await vaultWith(context, extensionId, []);
  const s = await site(context, `<!doctype html><html><body><div role="dialog"><p>Save your secret key in a safe place since you won't be able to view it again.</p>
    <input id="k" readonly value=""><button>Copy</button></div>
    <script>setTimeout(() => { document.getElementById('k').value = ${JSON.stringify(KEY)}; }, 1500);</script></body></html>`);
  const card = cardOf(s);
  await expect.poll(() => card.count('.otpilot-apikey-save'), { timeout: 5000 }).toBe(1);
  await card.click('.otpilot-apikey-save');
  await expect.poll(async () => (await apiItems(popup)).length).toBe(1);
  expect(fieldOf((await apiItems(popup))[0], 'apiKey')).toBe(KEY);
});

// A credentials list that keeps showing the key (freesound.org/apiv2/apply/):
// no dialog, no copy-once wording, no Copy button.
const LIST = 'http://localhost:8765/apiv2/apply/';
const FS_ID = 'qT4mZ8rVx2LkP9wNb6Hd';
const FS_KEY = 'Xk7Pq2Wm9Rt4Yv8Nb3Lz6Hc1Jd5Gf0Sa2Ue7Qo4';
const listPage = (header = 'Client secret/Api key') => `<!doctype html><html><body><h1>Freesound API credentials</h1>
<table><thead><tr><th>Name</th><th>Client id</th><th>${header}</th><th>Redirect url</th><th>Actions</th></tr></thead>
<tbody><tr><td>demoreel</td><td>${FS_ID}</td><td>${FS_KEY}</td><td>https://demoreel.test/cb</td><td><a href="#">edit</a></td></tr></tbody></table>
<h2>Create new API credentials</h2><form><label>Name*<input name="name"></label></form></body></html>`;
async function listSite(context, body) {
  const s = await context.newPage();
  await s.route(LIST, r => r.fulfill({ contentType: 'text/html', body }));
  await s.goto(LIST);
  return s;
}

test('a credentials table (Freesound): the key column is offered with its client id and name; once saved, not again', async ({ context, extensionId }) => {
  const popup = await vaultWith(context, extensionId, []);
  const s = await listSite(context, listPage());
  const card = cardOf(s);
  await expect.poll(() => card.count('.otpilot-apikey-save'), { timeout: 5000 }).toBe(1);
  expect(await card.text('.otpilot-apikey-masked')).toBe('••••••••' + FS_KEY.slice(-4));
  expect(await card.prop('.otpilot-apikey-name', 'value')).toContain('demoreel');
  expect(await card.html()).not.toContain(FS_KEY.slice(0, 20));
  await card.click('.otpilot-apikey-save');
  await expect.poll(async () => (await apiItems(popup)).length).toBe(1);
  const [api] = await apiItems(popup);
  expect([fieldOf(api, 'clientId'), fieldOf(api, 'clientSecret')]).toEqual([FS_ID, FS_KEY]);
  expect(api.urls).toEqual(['localhost']);
  // Next visit: already saved, no card.
  await s.reload(); await s.waitForTimeout(1500);
  await expect(s.locator('#otpilot-apikey-save')).toHaveCount(0);
});

test('a credentials table with two keys: the second comes up after the first (saved or dismissed); a client id in a read-only field is kept', async ({ context, extensionId }) => {
  const popup = await vaultWith(context, extensionId, []);
  const KEY2 = 'Z7qWm3Xc9VbN2kLp5RtY8uIo4AsD6fGh1JkE0wQz';
  const two = `<!doctype html><html><body><table><tr><th>Name</th><th>Client id</th><th>Client secret/Api key</th></tr>
<tr><td>one</td><td>${FS_ID}</td><td>${FS_KEY}</td></tr>
<tr><td>two</td><td><input readonly value="clientTwo123"></td><td>${KEY2}</td></tr></table></body></html>`;
  const s = await listSite(context, two);
  const card = cardOf(s);
  await expect.poll(() => card.count('.otpilot-apikey-save'), { timeout: 5000 }).toBe(1);
  await card.click('.otpilot-apikey-save');
  // The second row's key, once the first card is gone.
  await expect.poll(async () => (await card.prop('.otpilot-apikey-name', 'value')) || '', { timeout: 5000 }).toContain('two');
  await card.click('.otpilot-apikey-save');
  await expect.poll(async () => (await apiItems(popup)).length).toBe(2);
  const second = (await apiItems(popup)).find(i => fieldOf(i, 'clientSecret') === KEY2);
  expect(fieldOf(second, 'clientId')).toBe('clientTwo123');
  // Next visit: the first is saved (no card), the second too: nothing.
  await s.reload(); await s.waitForTimeout(1500);
  await expect(s.locator('#otpilot-apikey-save')).toHaveCount(0);
});

test('a credentials table whose first key is already saved: the next one is offered', async ({ context, extensionId }) => {
  const popup = await vaultWith(context, extensionId, []);
  const first = await listSite(context, listPage());
  const c1 = cardOf(first);
  await expect.poll(() => c1.count('.otpilot-apikey-save'), { timeout: 5000 }).toBe(1);
  await c1.click('.otpilot-apikey-save');
  await expect.poll(async () => (await apiItems(popup)).length).toBe(1);
  await first.close();
  const KEY2 = 'Z7qWm3Xc9VbN2kLp5RtY8uIo4AsD6fGh1JkE0wQz';
  const s = await listSite(context, listPage().replace('</tbody>', `<tr><td>second</td><td>idTwo1234</td><td>${KEY2}</td><td></td><td></td></tr></tbody>`));
  const card = cardOf(s);
  await expect.poll(async () => (await card.prop('.otpilot-apikey-name', 'value')) || '', { timeout: 5000 }).toContain('second');
});

test('a table whose column is not a key column (an id, a name) is not offered', async ({ context, extensionId }) => {
  await vaultWith(context, extensionId, []);
  const s = await listSite(context, listPage('Request id'));
  await s.waitForTimeout(1500);
  await expect(s.locator('#otpilot-apikey-save')).toHaveCount(0);
});

test('a key inside a same-origin or cross-origin iframe is not offered', async ({ context, extensionId }) => {
  await vaultWith(context, extensionId, []);
  const frameBody = `<!doctype html><html><body><div role="dialog"><p>Copy it now: you won't be able to see it again.</p><input readonly value="${KEY}"><button>Copy</button></div>
<script>setTimeout(() => { const d = document.createElement('div'); d.setAttribute('role', 'dialog'); d.innerHTML = '<p>Copy it now.</p><input readonly value="${KEY}"><button>Copy</button>'; document.body.appendChild(d); }, 100);</script></body></html>`;
  for (const src of ['http://localhost:8765/settings/frame-keys', 'http://127.0.0.1:8765/settings/frame-keys']) {
    const s = await context.newPage();
    await s.route(src, r => r.fulfill({ contentType: 'text/html', body: frameBody }));
    await s.route(PAGE, r => r.fulfill({ contentType: 'text/html', body: `<!doctype html><html><body><h1>API keys</h1><iframe src="${src}" width="600" height="300"></iframe></body></html>` }));
    await s.goto(PAGE);
    const frame = s.frameLocator('iframe');
    await expect(frame.locator('input').first()).toHaveValue(KEY);
    await s.waitForTimeout(1200);
    await expect(s.locator('#otpilot-apikey-save')).toHaveCount(0);
    await expect(frame.locator('#otpilot-apikey-save')).toHaveCount(0);
    await s.close();
  }
});

test('keys shown in quick succession or while a card is up are offered one after the other', async ({ context, extensionId }) => {
  const popup = await vaultWith(context, extensionId, []);
  const KEY2 = 'ghp_aB3dE5gH7jK9mN1pQ3sT5vW7yZ9bD1fH3jL5';
  const KEY3 = 'sk_live_' + 'Zq4Wm8Rt2Yp6Lk3Nv9Bx7Cd5Hf1Jg0Ks';
  const dialog = k => `<p>Make sure to copy your token now.</p><input readonly value="${k}"><button>Copy</button>`;
  const s = await site(context, `<!doctype html><html><body><button id="c">Create</button><script>
window.add = html => { const d = document.createElement('div'); d.setAttribute('role', 'dialog'); d.innerHTML = html; document.body.appendChild(d); };
c.onclick = () => { add(${JSON.stringify(dialog(KEY))}); setTimeout(() => add(${JSON.stringify(dialog(KEY2))}), 50); };
</script></body></html>`);
  const card = cardOf(s);
  const masked = k => ApiKeysMask(k);
  await s.click('#c');
  await expect.poll(() => card.text('.otpilot-apikey-masked')).toBe(masked(KEY));
  // A third key while the card is up: kept for later, the card stays.
  await s.evaluate(html => window.add(html), dialog(KEY3));
  await s.waitForTimeout(700);
  expect(await card.text('.otpilot-apikey-masked')).toBe(masked(KEY));
  await card.click('.otpilot-apikey-later');
  const offered = [];
  for (let i = 0; i < 2; i++) {
    await expect.poll(() => card.text('.otpilot-apikey-masked')).not.toBe(null);
    offered.push(await card.text('.otpilot-apikey-masked'));
    await card.click('.otpilot-apikey-save');
    await expect.poll(async () => (await apiItems(popup)).length).toBe(i + 1);
    await expect.poll(async () => offered.includes(await card.text('.otpilot-apikey-masked'))).toBe(false);
  }
  expect(offered.sort()).toEqual([masked(KEY2), masked(KEY3)].sort());
  expect((await apiItems(popup)).map(i => fieldOf(i, 'apiKey')).sort()).toEqual([KEY2, KEY3].sort());
  // All handled: nothing more.
  await s.waitForTimeout(800);
  expect(await card.shown()).toBe(false);
});

test('the login to link was deleted meanwhile: the card asks again, then saves unlinked', async ({ context, extensionId }) => {
  const popup = await vaultWith(context, extensionId, [{ name: 'OpenAI', email: 'me@x.com', secret: '', urls: 'localhost', password: 'pw' }]);
  const s = await site(context, html(KEY));
  const card = cardOf(s);
  await s.click('#create');
  await expect.poll(() => card.prop('.otpilot-apikey-link input', 'checked')).toBe(true);
  await card.run(function () { const n = this.querySelector('.otpilot-apikey-name'); n.value = 'Prod key'; });
  await writeAccounts(popup, []);
  await card.click('.otpilot-apikey-save');
  await expect.poll(() => card.text('.otpilot-apikey-note')).toBe('That login changed. Pick again.');
  expect(await card.count('.otpilot-apikey-link')).toBe(0);
  expect(await card.prop('.otpilot-apikey-name', 'value')).toBe('Prod key');
  expect(await apiItems(popup)).toHaveLength(0);
  await card.click('.otpilot-apikey-save');
  await expect.poll(async () => (await apiItems(popup)).length).toBe(1);
  const [api] = await apiItems(popup);
  expect([api.title, api.links ?? null, fieldOf(api, 'apiKey')]).toEqual(['Prod key', null, KEY]);
});

// ── apiKeys.js, pure ──────────────────────────────────────────────────────
test.describe('ApiKeys detection', () => {
  test.beforeEach(async ({ page }) => {
    await page.route('http://localhost:8765/blank', r => r.fulfill({ contentType: 'text/html', body: '<html></html>' }));
    await page.goto('http://localhost:8765/blank');
    await page.addScriptTag({ path: new URL('../apiKeys.js', import.meta.url).pathname });
  });
  const run = (page, fn, arg) => page.evaluate(`(${fn})(${JSON.stringify(arg)})`);

  test('known prefixes need their shape and one context signal', async ({ page }) => {
    const r = await run(page, a => ({
      openai: ApiKeys.decide(a.openai, { copyOnce: true })?.provider,
      ghp: ApiKeys.decide('ghp_' + a.rand36, { copyControl: true })?.provider,
      stripe: ApiKeys.decide('sk_live_' + a.rand36, { copyOnce: true })?.environment,
      noContext: ApiKeys.decide(a.openai, {}),
      shortGhp: ApiKeys.decide('ghp_' + a.rand36.slice(0, 20), { copyOnce: true }),
    }), { openai: KEY, rand36: 'aB3dE5gH7jK9mN1pQ3sT5vW7yZ9bD1fH3jL5' });
    expect(r).toEqual({ openai: 'OpenAI', ghp: 'GitHub', stripe: 'live', noContext: null, shortGhp: null });
  });

  test('pk_ publishable keys are never offered', async ({ page }) => {
    const r = await run(page, () => {
      const v = 'pk_live_' + 'aB3dE5gH7jK9mN1pQ3sT5vW7yZ9bD1fH3jL5';
      return [ApiKeys.decide(v, { copyOnce: true, copyControl: true, keyWord: true, path: '/settings/api-keys' }), ApiKeys.known(v), ApiKeys.generic(v)];
    });
    expect(r).toEqual([null, null, false]);
  });

  test('placeholders, masked values and low entropy are refused', async ({ page }) => {
    const r = await run(page, () => {
      const ctx = { copyOnce: true, copyControl: true, keyWord: true, path: '/api-keys' };
      return [
        ApiKeys.decide('sk-proj-YOUR_API_KEY_HERE_0123456789abcdefghijklmnop', ctx),
        ApiKeys.decide('sk-proj-••••••••••••••••••••••••••••••••••••a9F2', ctx),
        ApiKeys.decide('sk_test_' + 'a'.repeat(32), ctx),
        ApiKeys.decide('aaaaaaaaaaaaaaaaaaaaaaaaaaaa1111', ctx),
        ApiKeys.decide('my-project-name-for-the-demo-app', ctx),
        ApiKeys.decide('123e4567-e89b-12d3-a456-426614174000', ctx),
        ApiKeys.isMasked('sk-…a9F2'),
      ];
    });
    expect(r).toEqual([null, null, null, null, null, null, true]);
  });

  test('the generic tier needs every signal and a keys-like path segment', async ({ page }) => {
    const r = await run(page, () => {
      const t = 'q7Zk2mXv9LpR4tYw8NbC3dFgH6jKs1Ae';
      const all = { copyOnce: true, copyControl: true, keyWord: true, path: '/settings/api-keys' };
      return [
        !!ApiKeys.decide(t, all),
        ...['copyOnce', 'copyControl', 'keyWord'].map(k => !!ApiKeys.decide(t, { ...all, [k]: false })),
        !!ApiKeys.decide(t, { ...all, path: '/blog/2024/hello' }),
        !!ApiKeys.decide(t, { ...all, path: '/monkeys' }), // a substring is not a segment
      ];
    });
    expect(r).toEqual([true, false, false, false, false, false]);
  });

  test('mask keeps the prefix and the last four, entropy is in bits', async ({ page }) => {
    const r = await run(page, k => [ApiKeys.mask(k), ApiKeys.entropy('aaaa'), ApiKeys.entropy('abcd')], KEY);
    expect(r[0]).toBe('sk-proj-••••••••' + KEY.slice(-4));
    expect(r[1]).toBe(0);
    expect(r[2]).toBe(2);
  });
});

// ── Pages that cover the card, reveal the key later, or pair it with an id ──
// Made-up values, split so secret scanners don't take them for real ones.
const GKEY = 'AIza' + 'SyQ7fake0-xR2mLp9VbN3kTw8ZcY4HdJ6sE';

test('a side panel drawn over everything (Google Cloud) does not hide the card: it is in the top layer', async ({ context, extensionId }) => {
  await vaultWith(context, extensionId, []);
  const s = await site(context, `<!doctype html><html><body><button id="c">Create</button><script>c.onclick = () => {
    const p = document.createElement('div');
    p.style.cssText = 'position:fixed;top:0;right:0;width:600px;height:100vh;background:#333;z-index:2147483647';
    p.innerHTML = '<h2>API key created</h2><label for="k">Your API key</label><input id="k" readonly value="${GKEY}"><button aria-label="Copy to clipboard">⧉</button>';
    setTimeout(() => document.body.appendChild(p), 50);
  };</script></body></html>`);
  const card = cardOf(s);
  await s.click('#c');
  await expect.poll(() => card.count('.otpilot-apikey-save'), { timeout: 5000 }).toBe(1);
  // The panel is appended after the card would be: the card still wins.
  await s.evaluate(() => { const p = document.createElement('div'); p.style.cssText = 'position:fixed;inset:0;z-index:2147483647;background:rgba(0,0,0,.3)'; document.body.appendChild(p); });
  const onTop = await s.evaluate(() => {
    const host = document.getElementById('otpilot-apikey-save');
    const r = host.getBoundingClientRect();
    return document.elementFromPoint(r.x + r.width / 2, r.y + 10) === host && host.matches(':popover-open');
  });
  expect(onTop).toBe(true);
});

test('a key in a modal <dialog>: the card goes inside it and Save works', async ({ context, extensionId }) => {
  const popup = await vaultWith(context, extensionId, []);
  const s = await site(context, `<!doctype html><html><body><button id="c">Create</button><dialog id="d"><h2>API key created</h2>
    <label for="k">Your API key</label><input id="k" readonly value="${GKEY}"><button>Copy</button></dialog>
    <script>c.onclick = () => d.showModal();</script></body></html>`);
  const card = cardOf(s);
  await s.click('#c');
  await expect.poll(() => card.count('.otpilot-apikey-save'), { timeout: 5000 }).toBe(1);
  expect(await s.evaluate(() => !!document.querySelector('dialog #otpilot-apikey-save'))).toBe(true);
  await card.click('.otpilot-apikey-save');
  await expect.poll(async () => (await apiItems(popup)).length).toBe(1);
  expect(fieldOf((await apiItems(popup))[0], 'apiKey')).toBe(GKEY);
});

test('a secret shown only after "Show" (labelled Client secret), with its Client ID: both saved', async ({ context, extensionId }) => {
  const popup = await vaultWith(context, extensionId, []);
  const SECRET = 'GOCSPX' + '-q7Zk2mXv9LpR4tYw8NbC3dFgH6jKs1A';
  const ID = '1234567890-abcdefg.apps.' + 'googleusercontent.com';
  // Long after load (the first polling window is over), by script on a click.
  const s = await site(context, `<!doctype html><html><body><h1>Client details</h1>
    <div><span>Client ID</span><span>${ID}</span></div>
    <div><label for="sec">Client secret</label><input id="sec" readonly value="••••••••••••"><button id="show">Show</button></div>
    <script>show.onclick = () => { sec.value = ${JSON.stringify(SECRET)}; };</script></body></html>`);
  await s.waitForTimeout(16000);
  const card = cardOf(s);
  await expect(s.locator('#otpilot-apikey-save')).toHaveCount(0);
  await s.click('#show');
  await expect.poll(() => card.count('.otpilot-apikey-save'), { timeout: 5000 }).toBe(1);
  await card.click('.otpilot-apikey-save');
  await expect.poll(async () => (await apiItems(popup)).length).toBe(1);
  const [api] = await apiItems(popup);
  expect([fieldOf(api, 'clientId'), fieldOf(api, 'clientSecret')]).toEqual([ID, SECRET]);
});

test('an OAuth "client created" dialog: the Client ID beside the secret is saved too', async ({ context, extensionId }) => {
  const popup = await vaultWith(context, extensionId, []);
  const SECRET = 'GOCSPX' + '-Ab3dEf9hIjK1mNoPq7sTuVwXyZ0a';
  const ID = '98765-zyxwv.apps.' + 'googleusercontent.com';
  const s = await site(context, `<!doctype html><html><body><button id="c">Create</button><script>c.onclick = () => {
    const d = document.createElement('div'); d.setAttribute('role', 'dialog');
    d.innerHTML = '<h2>OAuth client created</h2><div><div>Client ID</div><div>${ID}</div><button>Copy</button></div>'
      + '<div><div>Client secret</div><div>${SECRET}</div><button>Copy</button></div>';
    document.body.appendChild(d);
  };</script></body></html>`);
  const card = cardOf(s);
  await s.click('#c');
  await expect.poll(() => card.count('.otpilot-apikey-save'), { timeout: 5000 }).toBe(1);
  await card.click('.otpilot-apikey-save');
  await expect.poll(async () => (await apiItems(popup)).length).toBe(1);
  const [api] = await apiItems(popup);
  expect([fieldOf(api, 'clientId'), fieldOf(api, 'clientSecret')]).toEqual([ID, SECRET]);
});

test('two clients on one page: a revealed secret is paired with its own Client ID (a short one in a span too), never the other\'s', async ({ context, extensionId }) => {
  const popup = await vaultWith(context, extensionId, []);
  const SECRET2 = 'GOCSPX' + '-Zx9Wv8Ut7Sr6Qp5On4Ml3Kj2Ih1G';
  const s = await site(context, `<!doctype html><html><body><h1>Clients</h1>
    <section><h2>Web client</h2><div><span>Client ID</span><span>webClient77</span></div>
      <div><label for="s1">Client secret</label><input id="s1" readonly value="••••••••"></div></section>
    <section><h2>CLI client</h2><div><span>Client ID</span><span>cliOne12</span></div>
      <div><label for="s2">Client secret</label><input id="s2" readonly value="••••••••"><button id="show2">Show</button></div></section>
    <script>show2.onclick = () => { s2.value = ${JSON.stringify(SECRET2)}; };</script></body></html>`);
  const card = cardOf(s);
  await s.click('#show2');
  await expect.poll(() => card.count('.otpilot-apikey-save'), { timeout: 5000 }).toBe(1);
  await card.click('.otpilot-apikey-save');
  await expect.poll(async () => (await apiItems(popup)).length).toBe(1);
  const [api] = await apiItems(popup);
  expect([fieldOf(api, 'clientId'), fieldOf(api, 'clientSecret')]).toEqual(['cliOne12', SECRET2]);
});

test('a key whose nearest scope shows two different client IDs gets none', async ({ context, extensionId }) => {
  const popup = await vaultWith(context, extensionId, []);
  const SECRET = 'GOCSPX' + '-Ab3dEf9hIjK1mNoPq7sTuVwXyZ0a';
  const s = await site(context, `<!doctype html><html><body><div role="dialog"><h2>Keys</h2>
    <div><span>Client ID</span><span>firstClient1</span></div><div><span>Client ID</span><span>secondClient2</span></div>
    <div><label for="k">Client secret</label><input id="k" readonly value="${SECRET}"><button>Copy</button></div></div></body></html>`);
  const card = cardOf(s);
  await expect.poll(() => card.count('.otpilot-apikey-save'), { timeout: 5000 }).toBe(1);
  await card.click('.otpilot-apikey-save');
  await expect.poll(async () => (await apiItems(popup)).length).toBe(1);
  const [api] = await apiItems(popup);
  expect([fieldOf(api, 'clientId'), fieldOf(api, 'apiKey')]).toEqual(['', SECRET]);
});

test('the page closes or removes the modal holding the card: the card moves out, or the offer ends and a later key is offered', async ({ context, extensionId }) => {
  await vaultWith(context, extensionId, []);
  const KEY2 = 'sk-proj-' + 'Zz9yXx8wWv7uUt6sSr5qQp4oOn3mMl2kKj1iIh0gGf9eEd8cCb7a';
  const page = (id, key) => `<dialog id="${id}"><h2>API key created</h2><label for="k${id}">Your API key</label><input id="k${id}" readonly value="${key}"><button>Copy</button></dialog>`;
  const s = await site(context, `<!doctype html><html><body><button id="a">A</button><button id="b">B</button>${page('d1', GKEY)}
    <script>a.onclick = () => d1.showModal();</script></body></html>`);
  const card = cardOf(s);
  await s.click('#a');
  await expect.poll(() => card.count('.otpilot-apikey-save'), { timeout: 5000 }).toBe(1);
  // Closed (not removed): the card leaves the dialog and stays usable.
  await s.evaluate(() => document.getElementById('d1').close());
  await expect.poll(() => s.evaluate(() => document.getElementById('otpilot-apikey-save')?.parentElement?.tagName)).toBe('BODY');
  expect(await s.evaluate(() => document.getElementById('otpilot-apikey-save').matches(':popover-open'))).toBe(true);
  await card.click('.otpilot-apikey-later');
  await expect.poll(() => card.shown()).toBe(false);

  // Removed with the card inside: the offer ends; a later key gets one.
  const s2 = await site(context, `<!doctype html><html><body><button id="a">A</button>${page('d1', GKEY)}
    <script>a.onclick = () => d1.showModal();</script></body></html>`);
  const c2 = cardOf(s2);
  await s2.click('#a');
  await expect.poll(() => c2.count('.otpilot-apikey-save'), { timeout: 5000 }).toBe(1);
  await s2.evaluate(() => document.getElementById('d1').remove());
  await s2.waitForTimeout(800);
  await s2.evaluate(k => { const d = document.createElement('div'); d.setAttribute('role', 'dialog');
    d.innerHTML = '<p>Copy it now, you won\'t be able to see it again.</p><input readonly value="' + k + '"><button>Copy</button>'; document.body.appendChild(d); }, KEY2);
  await expect.poll(() => c2.text('.otpilot-apikey-masked'), { timeout: 5000 }).toBe('sk-proj-••••••••' + KEY2.slice(-4));
});

test('two modals open, the newer earlier in the document: the card goes into the active one', async ({ context, extensionId }) => {
  await vaultWith(context, extensionId, []);
  const s = await site(context, `<!doctype html><html><body><button id="a">A</button>
    <dialog id="newer"><h2>API key created</h2><label for="k">Your API key</label><input id="k" readonly value="${GKEY}"><button id="cp">Copy</button></dialog>
    <dialog id="older"><p>Settings</p><button id="next">Create key</button></dialog>
    <script>a.onclick = () => older.showModal(); next.onclick = () => { newer.showModal(); cp.focus(); };</script></body></html>`);
  const card = cardOf(s);
  await s.click('#a');
  await s.click('#next');
  await expect.poll(() => card.count('.otpilot-apikey-save'), { timeout: 5000 }).toBe(1);
  expect(await s.evaluate(() => document.getElementById('otpilot-apikey-save').parentElement.id)).toBe('newer');
  await card.click('.otpilot-apikey-later');
  await expect.poll(() => card.shown()).toBe(false);
});
