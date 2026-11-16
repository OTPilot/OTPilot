import { test, expect, seedUnlocked, waitForVault, writeAccounts } from './fixtures.js';

// Extra sign-in fields (a document type, a customer number): captured with a
// sign-in, saved as the login's custom fields with the control they came from
// (`fill`), filled with it. forms.js extraFields / fillExtras +
// background applyExtras / matchExtras.

const SITE = 'http://localhost:8765/test';

async function vaultWith(context, extensionId, accounts, local = {}) {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/popup.html`);
  await page.evaluate(() => Promise.all([chrome.storage.local.clear(), chrome.storage.session.clear()]));
  await seedUnlocked(page, { accounts: [], ...local });
  await page.reload();
  await waitForVault(page);
  if (accounts.length) await writeAccounts(page, accounts);
  return page;
}

const logins = page => page.evaluate(async () =>
  (await VaultStore.readAll(await VaultKeys.getKey())).items
    .filter(i => i.type === 'login')
    .map(i => ({
      title: i.title, urls: i.urls,
      username: Vault.getValue(i, 'username'), password: Vault.getValue(i, 'password'),
      fields: (i.fields || []).filter(f => f.custom).map(f => ({ label: f.label, value: f.value, kind: f.kind, fill: f.fill })),
    })));

const SELECT_FILL = { tag: 'select', type: 'select-one', name: 'documentType', label: 'Tipo de documento' };
const NUMBER_FILL = { tag: 'input', type: 'number', name: 'documentNumber', label: 'Número de documento' };

// A BBVA-like login saved with both extra fields.
const bbva = {
  name: 'BBVA', email: 'user-77', secret: '', urls: 'localhost', password: 'clave-1',
  customFields: [
    { label: 'Tipo de documento', value: 'LE', kind: 'text', fill: SELECT_FILL },
    { label: 'Número de documento', value: '12345678', kind: 'hidden', fill: NUMBER_FILL },
  ],
};

const result = site => site.locator('#result');
const pick = site => site.locator('#otpilot-login-fill .otpilot-login-choice').click();

// ── BBVA: web components, masked username, slotted select ────────────────────

test('BBVA: a sign-in is offered with its document fields, saved as custom fields with their control, then filled and submitted', async ({ context, extensionId }) => {
  const popup = await vaultWith(context, extensionId, []);
  const site = await context.newPage();
  await site.goto(`${SITE}/login-bbva.html?spa=1`);
  await site.selectOption('select[name="documentType"]', { label: 'LE' }, { force: true });
  await expect(site.locator('x-select .shown')).toHaveText('LE');
  await site.fill('input[name="documentNumber"]', '12345678');
  await site.fill('input[name="username"]', 'user-77');
  await site.fill('input[name="password"]', 'clave-1');
  await site.click('x-button');
  await expect(site.locator('h1')).toHaveText('Panel');

  const offer = site.locator('#otpilot-login-save');
  await expect(offer).toContainText('user-77');
  await expect(offer.locator('.otpilot-save-extras')).toHaveText('Also saves: Tipo de documento, Número de documento');
  // The offer never shows the password.
  expect(await offer.innerHTML()).not.toContain('clave-1');
  await offer.locator('.otpilot-save-confirm').click();

  await expect.poll(() => logins(popup)).toEqual([{
    title: 'localhost', urls: ['localhost:8765'], username: 'user-77', password: 'clave-1',
    fields: [
      { label: 'Tipo de documento', value: 'LE', kind: 'text', fill: SELECT_FILL },
      { label: 'Número de documento', value: '12345678', kind: 'hidden', fill: NUMBER_FILL },
    ],
  }]);
  const [login] = await logins(popup);
  // A control with a name is described by it: no generated id in either.
  for (const f of login.fields) expect(f.fill.id).toBeUndefined();

  // Next visit: the pick selects LE, shows it in the component, fills the
  // others and signs in.
  await site.goto(`${SITE}/login-bbva.html`);
  await pick(site);
  await expect(site.locator('select[name="documentType"]')).toHaveValue('02');
  await expect(site.locator('x-select .shown')).toHaveText('LE');
  await expect(result(site)).toHaveText(/documentType/);
  expect(JSON.parse(await result(site).textContent())).toEqual({
    documentType: '02', documentNumber: '12345678', username: 'user-77', password: 'clave-1',
  });
  // Never a password in the URL, and no gender / remember-me.
  expect(site.url()).toBe(`${SITE}/login-bbva.html`);
});

test('BBVA: the button that only listens on its shadow <button> still submits, once', async ({ context, extensionId }) => {
  await vaultWith(context, extensionId, [bbva]);
  const site = await context.newPage();
  await site.addInitScript(() => {
    window.__submits = 0;
    document.addEventListener('submit', () => { window.__submits++; }, true);
  });
  await site.goto(`${SITE}/login-bbva.html?btn=inner`);
  await pick(site);
  await expect(result(site)).toHaveText(/clave-1/, { timeout: 5000 });
  expect(JSON.parse(await result(site).textContent())).toEqual({
    documentType: '02', documentNumber: '12345678', username: 'user-77', password: 'clave-1',
  });
  await site.waitForTimeout(1500);
  expect(await site.evaluate(() => window.__submits)).toBe(1);
  expect(site.url()).not.toContain('clave-1');
  expect(site.url()).not.toContain('?password');
});

test('BBVA: a select component that puts its own value back is not signed in; the toast names the field', async ({ context, extensionId }) => {
  await vaultWith(context, extensionId, [bbva]);
  const site = await context.newPage();
  await site.goto(`${SITE}/login-bbva.html?controlled=1`);
  await pick(site);
  await expect(site.getByText('Check Tipo de documento before signing in')).toBeVisible();
  await site.waitForTimeout(1500);
  await expect(result(site)).toHaveText('');
});

for (const [stale, label] of [['number', 'Número de documento'], ['username', 'Usuario']]) {
  test(`BBVA: a component that puts a stale ${stale} back is not signed in; the toast names the field, never a value`, async ({ context, extensionId }) => {
    await vaultWith(context, extensionId, [bbva]);
    const site = await context.newPage();
    await site.goto(`${SITE}/login-bbva.html?stale=${stale}`);
    await pick(site);
    const toast = site.getByText(`Check ${label} before signing in`);
    await expect(toast).toBeVisible();
    for (const secret of ['12345678', 'user-77', 'clave-1', '11112222', 'user-stale']) expect(await toast.textContent()).not.toContain(secret);
    await site.waitForTimeout(1500);
    await expect(result(site)).toHaveText('');
  });
}

test('BBVA: a page that clears the number when the type changes still gets the number', async ({ context, extensionId }) => {
  await vaultWith(context, extensionId, [bbva]);
  const site = await context.newPage();
  await site.goto(`${SITE}/login-bbva.html?clearOnType=1`);
  await pick(site);
  await expect(site.locator('input[name="documentNumber"]')).toHaveValue('12345678');
  await expect(result(site)).toHaveText(/documentNumber/, { timeout: 5000 });
  expect(JSON.parse(await result(site).textContent()).documentType).toBe('02');
});

test('BBVA: the default document type is never captured; the radio and checkbox are never captured or filled', async ({ context, extensionId }) => {
  const popup = await vaultWith(context, extensionId, []);
  const site = await context.newPage();
  await site.goto(`${SITE}/login-bbva.html?spa=1`);
  await site.fill('input[name="documentNumber"]', '55555555'); // type left on DNI
  await site.check('input[name="remember"]');
  await site.fill('input[name="username"]', 'user-88');
  await site.fill('input[name="password"]', 'clave-2');
  await site.click('x-button');
  const offer = site.locator('#otpilot-login-save');
  await expect(offer.locator('.otpilot-save-extras')).toHaveText('Also saves: Número de documento');
  await offer.locator('.otpilot-save-confirm').click();
  await expect.poll(async () => (await logins(popup))[0]?.fields.map(f => f.label)).toEqual(['Número de documento']);

  // Filling touches neither the radio group nor the checkbox.
  await site.goto(`${SITE}/login-bbva.html`);
  await pick(site);
  await expect(result(site)).toHaveText(/documentNumber/, { timeout: 5000 });
  const sent = JSON.parse(await result(site).textContent());
  expect(sent).toEqual({ documentType: '01', documentNumber: '55555555', username: 'user-88', password: 'clave-2' });
  await expect(site.locator('input[name="remember"]')).not.toBeChecked();
  await expect(site.locator('input[name="gender"][value="F"]')).not.toBeChecked();
});

// ── Updates ──────────────────────────────────────────────────────────────────

test('the same sign-in with unchanged extras gets no offer; a changed number is an extras-only update', async ({ context, extensionId }) => {
  const popup = await vaultWith(context, extensionId, [bbva]);
  const site = await context.newPage();
  const signIn = async number => {
    await site.goto(`${SITE}/login-bbva.html?spa=1`);
    await site.selectOption('select[name="documentType"]', { label: 'LE' }, { force: true });
    await site.fill('input[name="documentNumber"]', number);
    await site.fill('input[name="username"]', 'user-77');
    await site.fill('input[name="password"]', 'clave-1');
    await site.click('x-button');
    await expect(site.locator('h1')).toHaveText('Panel');
  };
  await signIn('12345678');
  await site.waitForTimeout(1500);
  await expect(site.locator('#otpilot-login-save')).toHaveCount(0);

  await signIn('87654321');
  const offer = site.locator('#otpilot-login-save');
  await expect(offer).toContainText('Update BBVA?');
  await expect(offer.locator('.otpilot-save-extras')).toContainText('Número de documento');
  await expect(offer).not.toContainText('Update the password');
  await offer.getByRole('button', { name: 'Update' }).click();
  await expect.poll(async () => (await logins(popup))[0].fields.map(f => [f.label, f.value])).toEqual([
    ['Tipo de documento', 'LE'], ['Número de documento', '87654321'],
  ]);
  const [login] = await logins(popup);
  expect(login.password).toBe('clave-1');
  expect(login.fields[1].fill).toEqual(NUMBER_FILL);
});

test('a saved document type switched back to the default (DNI) is an update; without a saved one the default adds no field', async ({ context, extensionId }) => {
  const popup = await vaultWith(context, extensionId, [bbva, {
    name: 'Other', email: 'user-99', secret: '', urls: 'localhost', password: 'clave-9',
    customFields: [{ label: 'Número de documento', value: '999', kind: 'hidden', fill: NUMBER_FILL }],
  }]);
  const site = await context.newPage();
  const signIn = async (user, password, number) => {
    await site.goto(`${SITE}/login-bbva.html?spa=1`);
    await site.fill('input[name="documentNumber"]', number); // type left on DNI
    await site.fill('input[name="username"]', user);
    await site.fill('input[name="password"]', password);
    await site.click('x-button');
    await expect(site.locator('h1')).toHaveText('Panel');
  };
  await signIn('user-77', 'clave-1', '12345678');
  const offer = site.locator('#otpilot-login-save');
  await expect(offer).toContainText('Update BBVA?');
  await expect(offer.locator('.otpilot-save-extras')).toHaveText('Saves: Tipo de documento');
  await offer.getByRole('button', { name: 'Update' }).click();
  const fieldsOf = async name => (await logins(popup)).find(l => l.username === name)?.fields;
  await expect.poll(() => fieldsOf('user-77')).toEqual([
    { label: 'Tipo de documento', value: 'DNI', kind: 'text', fill: SELECT_FILL },
    { label: 'Número de documento', value: '12345678', kind: 'hidden', fill: NUMBER_FILL },
  ]);

  // A login that never saved a document type: DNI adds nothing, no offer.
  await signIn('user-99', 'clave-9', '999');
  await site.waitForTimeout(1500);
  await expect(site.locator('#otpilot-login-save')).toHaveCount(0);
  expect(await fieldsOf('user-99')).toEqual([{ label: 'Número de documento', value: '999', kind: 'hidden', fill: NUMBER_FILL }]);
});

test('an extras update keeps a field a sync added between the offer and the write', async ({ context, extensionId }) => {
  const popup = await vaultWith(context, extensionId, [bbva]);
  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent('serviceworker');
  // A sync lands right before the background writes: after it planned the
  // update from the item it read.
  await worker.evaluate(() => {
    const update = VaultAccounts.update;
    VaultAccounts.update = async (id, expected, patch, key) => {
      const item = await VaultStore.get(id, key);
      item.fields.push({ id: 'c-synced', label: 'Synced note', value: 'from another device', kind: 'text', custom: true });
      item.updatedAt = new Date().toISOString();
      await VaultStore.save([item], key);
      return update(id, expected, patch, key);
    };
  });
  const site = await context.newPage();
  await site.goto(`${SITE}/login-bbva.html?spa=1`);
  await site.selectOption('select[name="documentType"]', { label: 'LE' }, { force: true });
  await site.fill('input[name="documentNumber"]', '87654321');
  await site.fill('input[name="username"]', 'user-77');
  await site.fill('input[name="password"]', 'clave-1');
  await site.click('x-button');
  const offer = site.locator('#otpilot-login-save');
  await expect(offer).toContainText('Update BBVA?');
  await offer.getByRole('button', { name: 'Update' }).click();
  await expect.poll(async () => (await logins(popup))[0].fields.map(f => [f.label, f.value])).toEqual([
    ['Tipo de documento', 'LE'], ['Número de documento', '87654321'], ['Synced note', 'from another device'],
  ]);
});

// ── Plain bank form, two-step ────────────────────────────────────────────────

test('a plain bank form saves its select and number, and fills them', async ({ context, extensionId }) => {
  const popup = await vaultWith(context, extensionId, []);
  const site = await context.newPage();
  await site.goto(`${SITE}/login-bank-extra.html`);
  await site.selectOption('select[name="doctype"]', { label: 'NIE' });
  await site.fill('input[name="docnumber"]', 'X1234567');
  await site.fill('input[name="user"]', 'ana');
  await site.fill('input[name="password"]', 'bank-pw');
  await site.click('button');
  await expect(site).toHaveURL(/welcome\.html/);
  const offer = site.locator('#otpilot-login-save');
  await expect(offer.locator('.otpilot-save-extras')).toHaveText('Also saves: Document type, Document number');
  await offer.locator('.otpilot-save-confirm').click();
  await expect.poll(async () => (await logins(popup))[0]?.fields.map(f => [f.label, f.value, f.kind])).toEqual([
    ['Document type', 'NIE', 'text'], ['Document number', 'X1234567', 'hidden'],
  ]);

  await site.goto(`${SITE}/login-bank-extra.html`);
  await pick(site);
  await expect(site).toHaveURL(/welcome\.html\?doctype=2&docnumber=X1234567&user=ana&password=bank-pw/);
});

test('two-step bank sign-in: one save with both steps\' extras, and step 1 never gets the password', async ({ context, extensionId }) => {
  const popup = await vaultWith(context, extensionId, []);
  const site = await context.newPage();
  await site.goto(`${SITE}/login-bank-extra-step1.html`);
  await site.selectOption('select[name="doctype"]', { label: 'Pasaporte' });
  await site.fill('input[name="docnumber"]', 'P777');
  await site.fill('input[name="user"]', 'beto');
  await site.click('button');
  await expect(site).toHaveURL(/login-bank-extra-step2\.html/);
  await site.fill('input[name="password"]', 'step-pw');
  await site.click('button');
  await expect(site).toHaveURL(/welcome\.html/);

  const offer = site.locator('#otpilot-login-save');
  await expect(offer).toContainText('beto');
  await expect(offer.locator('.otpilot-save-extras')).toHaveText('Also saves: Document type, Document number');
  await offer.locator('.otpilot-save-confirm').click();
  await expect.poll(async () => (await logins(popup)).map(l => [l.username, l.password, l.fields.map(f => [f.label, f.value])])).toEqual([
    ['beto', 'step-pw', [['Document type', 'Pasaporte'], ['Document number', 'P777']]],
  ]);

  // Filling: step 1 gets the extras and the username, no password; step 2 the password.
  await site.goto(`${SITE}/login-bank-extra-step1.html`);
  await pick(site);
  await expect(site).toHaveURL(/login-bank-extra-step2\.html\?doctype=3&docnumber=P777&user=beto$/);
  expect(site.url()).not.toContain('step-pw');
});

const BANK_DOC = [
  { label: 'Document type', kind: 'text', fill: { tag: 'select', type: 'select-one', name: 'doctype', label: 'Document type' } },
  { label: 'Document number', kind: 'hidden', fill: { tag: 'input', type: 'text', name: 'docnumber', label: 'Document number' } },
];
for (const [name, page, values, expected] of [
  ['one-page', 'login-bank-extra.html', ['NIE', 'X1234567'], /welcome\.html\?doctype=2&docnumber=X1234567&user=ana&password=bank-pw/],
  ['two-step', 'login-bank-extra-step1.html', ['Pasaporte', 'P777'], /welcome\.html\?password=bank-pw/],
]) {
  test(`Open & sign in fills the extras of a ${name} bank form`, async ({ context, extensionId }) => {
    const popup = await vaultWith(context, extensionId, [{
      name: 'Bank', email: 'ana', secret: '', urls: `localhost:8765/test/${page}`, password: 'bank-pw',
      customFields: BANK_DOC.map((f, i) => ({ ...f, value: values[i] })),
    }]);
    await popup.reload();
    await waitForVault(popup);
    const item = popup.locator('#home-list .lc-item', { hasText: 'Bank' });
    await item.locator('.lc-row').focus();
    const opened = context.waitForEvent('page');
    await item.locator('.lc-launch').click();
    const site = await opened;
    await expect(site).toHaveURL(expected);
  });
}

// ── Page tricks ──────────────────────────────────────────────────────────────

test('an extra control the login does not have is left empty', async ({ context, extensionId }) => {
  await vaultWith(context, extensionId, [bbva]);
  const site = await context.newPage();
  await site.goto(`${SITE}/login-bbva.html?trap=extra`);
  await pick(site);
  await expect(result(site)).toHaveText(/clave-1/, { timeout: 5000 });
  await expect(site.locator('input[name="branchCode"]')).toHaveValue('');
});

for (const trap of ['hidden', 'host']) {
  test(`a hidden select the page adds (${trap}) is never filled, even when a saved field names it`, async ({ context, extensionId }) => {
    await vaultWith(context, extensionId, [{
      ...bbva,
      customFields: [...bbva.customFields,
        { label: 'Trap', value: 'Secret', kind: 'text', fill: { tag: 'select', type: 'select-one', name: 'trapSelect', label: 'Trap' } }],
    }]);
    const site = await context.newPage();
    await site.goto(`${SITE}/login-bbva.html?trap=${trap}`);
    await pick(site);
    await expect(result(site)).toHaveText(/clave-1/, { timeout: 5000 });
    // Still on its first option; the visible controls were filled.
    await expect(site.locator('select[name="trapSelect"]')).toHaveValue('a');
  });
}

test('another host gets no login, no extras', async ({ context, extensionId }) => {
  await vaultWith(context, extensionId, [bbva]);
  const site = await context.newPage();
  await site.goto('http://127.0.0.1:8765/test/login-bbva.html');
  await site.waitForTimeout(1200);
  await expect(site.locator('#otpilot-login-fill')).toHaveCount(0);
  await expect(site.locator('input[name="documentNumber"]')).toHaveValue('');
});

test('the background answers extras only to a tab\'s top frame, never to an extension page', async ({ context, extensionId }) => {
  const popup = await vaultWith(context, extensionId, [bbva]);
  const r = await popup.evaluate(async () => {
    const id = (await VaultAccounts.load(await VaultKeys.getKey()))[0]._id;
    const fields = [{ tag: 'input', type: 'number', name: 'documentNumber' }];
    return {
      fill: await chrome.runtime.sendMessage({ action: 'vaultFillLogin', id, fields }),
      launch: await chrome.runtime.sendMessage({ action: 'vaultLaunchFill', step: 'password', fields }),
    };
  });
  expect(r.fill).toEqual({ ok: false });
  expect(r.launch?.ok).toBeFalsy();
  expect(JSON.stringify(r)).not.toContain('12345678');
});

test('malformed extras from a page are ignored, never saved', async ({ context, extensionId }) => {
  const popup = await vaultWith(context, extensionId, []);
  // An extension page can't impersonate a tab; the checks are exercised
  // through the helpers the capture handler uses.
  const r = await popup.evaluate(() => ({
    password: VaultAccounts.fillDesc({ tag: 'input', type: 'password', name: 'pw' }),
    file: VaultAccounts.fillDesc({ tag: 'input', type: 'file', name: 'f' }),
    noTag: VaultAccounts.fillDesc({ name: 'x' }),
    ac: VaultAccounts.fillDesc({ tag: 'input', type: 'text', ac: 'current-password' }),
    ok: VaultAccounts.fillDesc({ tag: 'select', type: 'select-one', name: 'doc', id: 'ignored', label: ' Tipo ' }),
  }));
  expect(r.password).toBeNull();
  expect(r.file).toBeNull();
  expect(r.noTag).toBeNull();
  expect(r.ac).toBeNull();
  expect(r.ok).toEqual({ tag: 'select', type: 'select-one', name: 'doc', label: 'Tipo' });
});

// ── Fields without `fill` are never released ─────────────────────────────────

test('a login whose custom fields were added by hand (no fill) never fills a control with the same label', async ({ context, extensionId }) => {
  await vaultWith(context, extensionId, [{
    name: 'BBVA', email: 'user-77', secret: '', urls: 'localhost', password: 'clave-1',
    customFields: [
      { label: 'Tipo de documento', value: 'PAS', kind: 'text' },
      { label: 'Número de documento', value: '1357', kind: 'hidden' },
    ],
  }]);
  const site = await context.newPage();
  await site.goto(`${SITE}/login-bbva.html`);
  await pick(site);
  await expect(result(site)).toHaveText(/clave-1/, { timeout: 5000 });
  expect(JSON.parse(await result(site).textContent())).toEqual({
    documentType: '01', documentNumber: '', username: 'user-77', password: 'clave-1',
  });
});

test('a field the page adds, labelled like a hand-added "PIN", gets nothing', async ({ context, extensionId }) => {
  await vaultWith(context, extensionId, [{
    ...bbva, customFields: [...bbva.customFields, { label: 'PIN', value: '4321', kind: 'hidden' }],
  }]);
  const site = await context.newPage();
  await site.goto(`${SITE}/login-bbva.html?trap=pin`);
  await pick(site);
  await expect(result(site)).toHaveText(/clave-1/, { timeout: 5000 });
  await expect(site.locator('input[name="pin"]')).toHaveValue('');
  expect(JSON.parse(await result(site).textContent())).toEqual({
    documentType: '02', documentNumber: '12345678', username: 'user-77', password: 'clave-1', pin: '',
  });
});

test('the offer reads the same whether a value equals a hand-added field\'s or not (the page\'s own label)', async ({ context, extensionId }) => {
  await vaultWith(context, extensionId, [{
    name: 'BBVA', email: 'user-77', secret: '', urls: 'localhost', password: 'clave-1',
    customFields: [{ label: 'PIN', value: '4321', kind: 'hidden' }],
  }]);
  const site = await context.newPage();
  const offerFor = async pin => {
    await site.goto(`${SITE}/login-bbva.html?spa=1&trap=pin&pinLabel=${encodeURIComponent('pIn:')}`);
    await site.fill('input[name="username"]', 'user-77');
    await site.fill('input[name="password"]', 'clave-1');
    await site.fill('input[name="pin"]', pin);
    await site.click('x-button');
    const offer = site.locator('#otpilot-login-save');
    await expect(offer).toBeVisible();
    return offer.innerText();
  };
  const right = await offerFor('4321');
  const wrong = await offerFor('9999');
  expect(right).toContain('pIn');
  expect(right).not.toContain('PIN');
  expect(wrong).toBe(right);
});

test('a sign-in never overwrites a hand-made field: a different value is a new field, the same value gets `fill` and then fills', async ({ context, extensionId }) => {
  const popup = await vaultWith(context, extensionId, [{
    name: 'BBVA', email: 'user-77', secret: '', urls: 'localhost', password: 'clave-1',
    customFields: [
      { label: 'Tipo de documento', value: 'LE', kind: 'text' },
      { label: 'Número de documento', value: '1357', kind: 'hidden' },
    ],
  }]);
  const site = await context.newPage();
  await site.goto(`${SITE}/login-bbva.html?spa=1`);
  await site.selectOption('select[name="documentType"]', { label: 'LE' }, { force: true });
  await site.fill('input[name="documentNumber"]', '12345678');
  await site.fill('input[name="username"]', 'user-77');
  await site.fill('input[name="password"]', 'clave-1');
  await site.click('x-button');
  const offer = site.locator('#otpilot-login-save');
  await expect(offer).toContainText('Update BBVA?');
  await expect(offer.locator('.otpilot-save-extras')).toHaveText('Saves: Tipo de documento, Número de documento');
  await offer.getByRole('button', { name: 'Update' }).click();
  await expect.poll(async () => (await logins(popup))[0].fields).toEqual([
    { label: 'Tipo de documento', value: 'LE', kind: 'text', fill: SELECT_FILL },
    { label: 'Número de documento', value: '1357', kind: 'hidden' },
    { label: 'Número de documento', value: '12345678', kind: 'hidden', fill: NUMBER_FILL },
  ]);

  // Filling: the type (now with its control) and the captured number; the
  // hand-made number stays in the vault.
  await site.goto(`${SITE}/login-bbva.html`);
  await pick(site);
  await expect(result(site)).toHaveText(/clave-1/, { timeout: 5000 });
  expect(JSON.parse(await result(site).textContent())).toEqual({
    documentType: '02', documentNumber: '12345678', username: 'user-77', password: 'clave-1',
  });
});

// ── Component submit: never twice ────────────────────────────────────────────

test('BBVA: a button that signs in from its own click handler (no submit event) is clicked once', async ({ context, extensionId }) => {
  await vaultWith(context, extensionId, [bbva]);
  const site = await context.newPage();
  await site.goto(`${SITE}/login-bbva.html?btn=handler`);
  await pick(site);
  await expect(result(site)).toHaveText(/clave-1/, { timeout: 5000 });
  await site.waitForTimeout(2000);
  expect(await site.evaluate(() => window.__calls)).toBe(1);
});

test('BBVA: a button whose handler only posts with fetch, on a page whose resource-timing buffer is full, is clicked once', async ({ context, extensionId }) => {
  await vaultWith(context, extensionId, [bbva]);
  const site = await context.newPage();
  await site.goto(`${SITE}/login-bbva.html?btn=fetch`);
  await site.waitForFunction(() => window.__ready === true);
  // The buffer is full: a new request no longer shows there.
  expect(await site.evaluate(() => performance.getEntriesByType('resource').length)).toBe(250);
  await pick(site);
  await expect.poll(() => site.evaluate(() => window.__calls), { timeout: 5000 }).toBe(1);
  expect(await site.evaluate(() => window.__sent)).toEqual({
    documentType: '02', documentNumber: '12345678', username: 'user-77', password: 'clave-1',
  });
  await site.waitForTimeout(2000);
  expect(await site.evaluate(() => window.__calls)).toBe(1);
});

test('BBVA: a slow sign-in (its request answers after 2 s, nothing changes meanwhile) is clicked once', async ({ context, extensionId }) => {
  await vaultWith(context, extensionId, [bbva]);
  const site = await context.newPage();
  await site.route('**/slow-signin*', async route => {
    await new Promise(r => setTimeout(r, 2000));
    await route.fulfill({ status: 200, body: 'ok' });
  });
  await site.goto(`${SITE}/login-bbva.html?btn=slow`);
  await pick(site);
  await expect.poll(() => site.evaluate(() => window.__calls), { timeout: 5000 }).toBe(1);
  expect(await site.evaluate(() => window.__sent)).toEqual({
    documentType: '02', documentNumber: '12345678', username: 'user-77', password: 'clave-1',
  });
  await site.waitForTimeout(3000);
  expect(await site.evaluate(() => window.__calls)).toBe(1);
});

// ── Slotted controls: only in a component the user can see ───────────────────

const PIN_FIELD = { label: 'PIN', value: '4321', kind: 'hidden', fill: { tag: 'input', type: 'text', name: 'pin', label: 'PIN' } };
for (const [trap, expected] of [['slot-tiny', ''], ['slot-full', '4321']]) {
  test(`a control slotted into a ${trap === 'slot-tiny' ? '2×2 px component gets nothing' : 'normal-size component is filled'}`, async ({ context, extensionId }) => {
    await vaultWith(context, extensionId, [{ ...bbva, customFields: [...bbva.customFields, PIN_FIELD] }]);
    const site = await context.newPage();
    await site.goto(`${SITE}/login-bbva.html?trap=${trap}`);
    await pick(site);
    await expect(result(site)).toHaveText(/clave-1/, { timeout: 5000 });
    await expect(site.locator('input[name="pin"]')).toHaveValue(expected);
    expect(JSON.parse(await result(site).textContent()).pin).toBe(expected);
  });
}

// ── What is never an extra ───────────────────────────────────────────────────

const EDGE = `${SITE}/login-extras-edge.html`;

test('more than 8 filled fields beside the password: no extra is saved', async ({ context, extensionId }) => {
  const popup = await vaultWith(context, extensionId, []);
  const site = await context.newPage();
  await site.goto(`${EDGE}?mode=many`);
  await site.fill('input[name="user"]', 'many-user');
  for (let i = 1; i <= 10; i++) await site.fill(`input[name="f${i}"]`, `value ${i}`);
  await site.fill('input[name="password"]', 'many-pw');
  await site.click('button');
  const offer = site.locator('#otpilot-login-save');
  await expect(offer).toContainText('many-user');
  await expect(offer.locator('.otpilot-save-extras')).toHaveCount(0);
  await offer.locator('.otpilot-save-confirm').click();
  await expect.poll(async () => (await logins(popup)).map(l => [l.username, l.password, l.fields])).toEqual([
    ['many-user', 'many-pw', []],
  ]);
});

test('a sign-up (password + confirmation) saves no extra fields', async ({ context, extensionId }) => {
  const popup = await vaultWith(context, extensionId, []);
  const site = await context.newPage();
  await site.goto(`${EDGE}?mode=signup`);
  // Still a sign-up: both password fields get the generator.
  await expect(site.locator('.otpilot-field-badge[data-kind="generate"]')).toHaveCount(2);
  await site.focus('input[name="password"]');
  await expect(site.locator('#otpilot-password-suggest')).toBeVisible();
  await site.locator('#otpilot-password-suggest .otpilot-overlay-close').click();
  await site.fill('input[name="firstName"]', 'Ana');
  await site.fill('input[name="company"]', 'Acme');
  await site.fill('input[name="email"]', 'ana@example.com');
  await site.fill('input[name="password"]', 'signup-pw');
  await site.fill('input[name="confirm_password"]', 'signup-pw');
  await site.click('button');
  const offer = site.locator('#otpilot-login-save');
  await expect(offer).toContainText('ana@example.com');
  await expect(offer.locator('.otpilot-save-extras')).toHaveCount(0);
  await offer.locator('.otpilot-save-confirm').click();
  await expect.poll(async () => (await logins(popup)).map(l => [l.username, l.password, l.fields])).toEqual([
    ['ana@example.com', 'signup-pw', []],
  ]);
});

test('a sign-in inside a checkout saves no card number, CVV, expiry, IBAN or card holder', async ({ context, extensionId }) => {
  const popup = await vaultWith(context, extensionId, []);
  const site = await context.newPage();
  await site.goto(`${EDGE}?mode=checkout`);
  await site.fill('input[name="email"]', 'buyer@example.com');
  await site.fill('input[name="password"]', 'buy-pw');
  await site.fill('input[name="customer"]', 'C-778');
  await site.fill('input[name="ccnum"]', '4111111111111111');
  await site.fill('input[name="sec"]', '123');
  await site.fill('input[name="exp"]', '12/30');
  await site.fill('input[name="bankacct"]', 'ES9121000418450200051332');
  await site.fill('input[name="holder"]', 'Buyer Name');
  await site.click('button');
  const offer = site.locator('#otpilot-login-save');
  await expect(offer.locator('.otpilot-save-extras')).toHaveText('Also saves: Customer number');
  await offer.locator('.otpilot-save-confirm').click();
  await expect.poll(async () => (await logins(popup)).map(l => [l.username, l.fields.map(f => [f.label, f.value])])).toEqual([
    ['buyer@example.com', [['Customer number', 'C-778']]],
  ]);
});
