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

// ── BBVA as online.bbva.com.ar renders it (login-bbva.html?live=1) ───────────
// The number field has no name and a new random id on each load; Usuario
// and Clave are read-only for a moment after load.

const docNumber = site => site.locator('input[data-doc]');
const isReadOnly = (site, name) => site.locator(`input[name="${name}"]`).evaluate(el => el.readOnly);
// Saved by #192 from the live page: keyed by that load's random id.
const STALE_ID_FILL = { tag: 'input', type: 'number', id: '_iimft4p9kg', label: 'Número de documento' };
const bbvaLive = {
  ...bbva,
  customFields: [{ label: 'Número de documento', value: '12345678', kind: 'hidden', fill: STALE_ID_FILL }],
};

test('BBVA live: picked while Usuario and Clave are still read-only, the username and password go to their own fields', async ({ context, extensionId }) => {
  await vaultWith(context, extensionId, [{ ...bbvaLive, autoLogin: false }]);
  const site = await context.newPage();
  await site.goto(`${SITE}/login-bbva.html?live=1&ro=6000`);
  // A badge in both, not only in Usuario.
  await expect(site.locator('.otpilot-field-badge')).toHaveCount(2);
  expect(await isReadOnly(site, 'password')).toBe(true);
  await pick(site);
  await expect(site.locator('input[name="username"]')).toHaveValue('user-77');
  await expect(site.locator('input[name="password"]')).toHaveValue('clave-1');
  // The number saved with an id of an earlier load: filled by its label.
  await expect(docNumber(site)).toHaveValue('12345678');
  expect(await isReadOnly(site, 'username')).toBe(true); // still in the read-only window
});

test('BBVA live: Open & sign in while the fields are read-only fills each one and signs in', async ({ context, extensionId }) => {
  const popup = await vaultWith(context, extensionId, [{ ...bbvaLive, urls: `${SITE.replace('http://', '')}/login-bbva.html?live=1&ro=6000` }]);
  await popup.reload();
  await waitForVault(popup);
  const item = popup.locator('#home-list .lc-item', { hasText: 'BBVA' });
  await item.locator('.lc-row').focus();
  const opened = context.waitForEvent('page');
  await item.locator('.lc-launch').click();
  const site = await opened;
  await expect(result(site)).toHaveText(/clave-1/);
  expect(JSON.parse(await result(site).textContent())).toEqual({ documentType: '0', username: 'user-77', password: 'clave-1' });
  await expect(docNumber(site)).toHaveValue('12345678');
  expect(site.url()).not.toContain('clave-1');
});

test('BBVA live: the number field is saved by its label (never its random id) and fills on the next load', async ({ context, extensionId }) => {
  const popup = await vaultWith(context, extensionId, []);
  const site = await context.newPage();
  await site.goto(`${SITE}/login-bbva.html?live=1&ro=200&spa=1`);
  await expect.poll(() => isReadOnly(site, 'password')).toBe(false);
  await docNumber(site).fill('12345678');
  await site.fill('input[name="username"]', 'user-77');
  await site.fill('input[name="password"]', 'clave-1');
  await site.click('x-button');
  await expect(site.locator('h1')).toHaveText('Panel');
  const offer = site.locator('#otpilot-login-save');
  await expect(offer.locator('.otpilot-save-extras')).toHaveText('Also saves: Número de documento');
  await offer.locator('.otpilot-save-confirm').click();
  await expect.poll(async () => (await logins(popup)).map(l => [l.username, l.password, l.fields])).toEqual([
    ['user-77', 'clave-1', [{ label: 'Número de documento', value: '12345678', kind: 'hidden', fill: { tag: 'input', type: 'number', label: 'Número de documento' } }]],
  ]);

  // A new load: new ids. Filled and signed in.
  await site.goto(`${SITE}/login-bbva.html?live=1&ro=200`);
  await pick(site);
  await expect(result(site)).toHaveText(/clave-1/);
  await expect(docNumber(site)).toHaveValue('12345678');
});

test('BBVA live: a number saved under an id that does not look generated still fills, and a new save updates it in place', async ({ context, extensionId }) => {
  const popup = await vaultWith(context, extensionId, [{ ...bbvaLive, customFields: [
    { label: 'Número de documento', value: '12345678', kind: 'hidden', fill: { tag: 'input', type: 'number', id: '_ghijklmnop', label: 'Número de documento' } },
  ] }]);
  const site = await context.newPage();
  await site.goto(`${SITE}/login-bbva.html?live=1&ro=200`);
  await expect.poll(() => isReadOnly(site, 'password')).toBe(false);
  await pick(site);
  await expect(docNumber(site)).toHaveValue('12345678');
  await site.goto(`${SITE}/login-bbva.html?live=1&ro=200&spa=1`);
  await expect.poll(() => isReadOnly(site, 'password')).toBe(false);
  await docNumber(site).fill('87654321');
  await site.fill('input[name="username"]', 'user-77');
  await site.fill('input[name="password"]', 'clave-1');
  await site.click('x-button');
  await expect(site.locator('h1')).toHaveText('Panel');
  await site.locator('#otpilot-login-save .otpilot-save-confirm').click();
  await expect.poll(async () => (await logins(popup))[0].fields.length).toBe(1);
  expect((await logins(popup))[0].fields[0].value).toBe('87654321');
  expect((await logins(popup))[0].fields[0].fill.id).toBeUndefined();
});

test('BBVA live: a login saved with the random id is updated in place, not given a second number field', async ({ context, extensionId }) => {
  const popup = await vaultWith(context, extensionId, [bbvaLive]);
  const site = await context.newPage();
  await site.goto(`${SITE}/login-bbva.html?live=1&ro=200&spa=1`);
  await expect.poll(() => isReadOnly(site, 'password')).toBe(false);
  await docNumber(site).fill('87654321');
  await site.fill('input[name="username"]', 'user-77');
  await site.fill('input[name="password"]', 'clave-1');
  await site.click('x-button');
  await expect(site.locator('h1')).toHaveText('Panel');
  const offer = site.locator('#otpilot-login-save');
  await expect(offer).toContainText('Update');
  await offer.locator('.otpilot-save-confirm').click();
  await expect.poll(async () => (await logins(popup))[0].fields).toEqual([
    { label: 'Número de documento', value: '87654321', kind: 'hidden', fill: { tag: 'input', type: 'number', label: 'Número de documento' } },
  ]);
});

// The document type as the live page has it: <x-select-items> keeps the
// list (DNI, LC, LE, PASAPORTE) in its `items` attribute, and a one-option
// placeholder <select name=documentType> before it holds the chosen key.

const docType = site => site.locator('select[name="documentType"]');
const docTypeShown = site => site.locator('x-select-items .content-text');
const pickDocType = async (site, label) => {
  await site.locator('x-select-items #button').click();
  await site.locator('x-select-items [role="option"]', { hasText: label }).click();
  await expect(docTypeShown(site)).toHaveText(label);
};
const ITEMS_FILL = { tag: 'select', type: 'select-one', name: 'documentType', label: 'Tipo de documento' };
const signInLive = async (site, { type, number = '12345678', user = 'user-77', password = 'clave-1' } = {}) => {
  await site.goto(`${SITE}/login-bbva.html?live=1&ro=200&spa=1`);
  await expect.poll(() => isReadOnly(site, 'password')).toBe(false);
  if (type) await pickDocType(site, type);
  await docNumber(site).fill(number);
  await site.fill('input[name="username"]', user);
  await site.fill('input[name="password"]', password);
  await site.click('x-button');
  await expect(site.locator('h1')).toHaveText('Panel');
};

test('BBVA live: a document type from the component\'s items list is saved by its label (LE, not its key)', async ({ context, extensionId }) => {
  const popup = await vaultWith(context, extensionId, []);
  const site = await context.newPage();
  await signInLive(site, { type: 'LE' });
  const offer = site.locator('#otpilot-login-save');
  await expect(offer.locator('.otpilot-save-extras')).toHaveText('Also saves: Tipo de documento, Número de documento');
  await offer.locator('.otpilot-save-confirm').click();
  await expect.poll(async () => (await logins(popup))[0]?.fields).toEqual([
    { label: 'Tipo de documento', value: 'LE', kind: 'text', fill: ITEMS_FILL },
    { label: 'Número de documento', value: '12345678', kind: 'hidden', fill: { tag: 'input', type: 'number', label: 'Número de documento' } },
  ]);
});

test('BBVA live: a saved LE is picked in the component (it shows LE, its select holds LE\'s key) and signed in', async ({ context, extensionId }) => {
  await vaultWith(context, extensionId, [{ ...bbvaLive, customFields: [{ label: 'Tipo de documento', value: 'LE', kind: 'text', fill: ITEMS_FILL }, ...bbvaLive.customFields] }]);
  const site = await context.newPage();
  await site.goto(`${SITE}/login-bbva.html?live=1&ro=200`);
  await expect.poll(() => isReadOnly(site, 'password')).toBe(false);
  await expect(docTypeShown(site)).toHaveText('DNI');
  await pick(site);
  await expect(docTypeShown(site)).toHaveText('LE');
  await expect(docType(site)).toHaveValue('2');
  await expect(result(site)).toHaveText(/clave-1/);
  expect(JSON.parse(await result(site).textContent())).toEqual({ documentType: '2', username: 'user-77', password: 'clave-1' });
  await expect(docNumber(site)).toHaveValue('12345678');
  // The list closed again.
  await expect(site.locator('x-select-items #list')).not.toHaveClass(/opened/);
});

test('BBVA live: the default document type (DNI) is never captured on its own', async ({ context, extensionId }) => {
  const popup = await vaultWith(context, extensionId, []);
  const site = await context.newPage();
  await signInLive(site, { type: 'DNI' });
  const offer = site.locator('#otpilot-login-save');
  await expect(offer.locator('.otpilot-save-extras')).toHaveText('Also saves: Número de documento');
  await offer.locator('.otpilot-save-confirm').click();
  await expect.poll(async () => (await logins(popup))[0]?.fields.map(f => f.label)).toEqual(['Número de documento']);
});

test('BBVA live: a saved LE switched back to DNI in the component is an update to DNI', async ({ context, extensionId }) => {
  const popup = await vaultWith(context, extensionId, [{ ...bbvaLive, customFields: [
    { label: 'Tipo de documento', value: 'LE', kind: 'text', fill: ITEMS_FILL },
    { label: 'Número de documento', value: '12345678', kind: 'hidden', fill: { tag: 'input', type: 'number', label: 'Número de documento' } },
  ] }]);
  const site = await context.newPage();
  await signInLive(site); // left on DNI
  const offer = site.locator('#otpilot-login-save');
  await expect(offer).toContainText('Update BBVA?');
  await expect(offer.locator('.otpilot-save-extras')).toHaveText('Saves: Tipo de documento');
  await offer.getByRole('button', { name: 'Update' }).click();
  await expect.poll(async () => (await logins(popup))[0].fields.map(f => [f.label, f.value])).toEqual([
    ['Tipo de documento', 'DNI'], ['Número de documento', '12345678'],
  ]);
});

test('BBVA live: a saved document type the component doesn\'t list is not signed in; the toast names the field', async ({ context, extensionId }) => {
  await vaultWith(context, extensionId, [{ ...bbvaLive, customFields: [{ label: 'Tipo de documento', value: 'RENAPER', kind: 'text', fill: ITEMS_FILL }, ...bbvaLive.customFields] }]);
  const site = await context.newPage();
  await site.goto(`${SITE}/login-bbva.html?live=1&ro=200`);
  await expect.poll(() => isReadOnly(site, 'password')).toBe(false);
  await pick(site);
  await expect(site.getByText('Check Tipo de documento before signing in')).toBeVisible();
  await expect(site.locator('input[name="password"]')).toHaveValue('clave-1');
  await site.waitForTimeout(1500);
  await expect(result(site)).toHaveText('');
  await expect(docTypeShown(site)).toHaveText('DNI');
  await expect(docType(site)).toHaveValue('0');
});

const bbvaLE = { ...bbvaLive, customFields: [{ label: 'Tipo de documento', value: 'LE', kind: 'text', fill: ITEMS_FILL }, ...bbvaLive.customFields] };
const listOpen = site => site.locator('x-select-items #button').getAttribute('aria-expanded');
const compClicks = site => site.evaluate(() => window.__compClicks);
// Not signed in: the toast names the field; the component still shows DNI.
const notSignedIn = async site => {
  await expect(site.getByText('Check Tipo de documento before signing in')).toBeVisible();
  await expect(site.locator('input[name="password"]')).toHaveValue('clave-1');
  await site.waitForTimeout(1500);
  await expect(result(site)).toHaveText('');
  await expect(docType(site)).toHaveValue('0');
};

test('BBVA live: options the component renders 300 ms after the list opens are waited for: LE is picked and signed in', async ({ context, extensionId }) => {
  await vaultWith(context, extensionId, [bbvaLE]);
  const site = await context.newPage();
  await site.goto(`${SITE}/login-bbva.html?live=1&ro=200&late=300`);
  await expect.poll(() => isReadOnly(site, 'password')).toBe(false);
  await pick(site);
  await expect(result(site)).toHaveText(/clave-1/);
  expect(JSON.parse(await result(site).textContent())).toEqual({ documentType: '2', username: 'user-77', password: 'clave-1' });
  await expect(docTypeShown(site)).toHaveText('LE');
  expect(await listOpen(site)).toBe('false');
});

test('BBVA live: options that never render: the list is closed again, not signed in, the toast names the field', async ({ context, extensionId }) => {
  await vaultWith(context, extensionId, [bbvaLE]);
  const site = await context.newPage();
  await site.goto(`${SITE}/login-bbva.html?live=1&ro=200&late=never`);
  await expect.poll(() => isReadOnly(site, 'password')).toBe(false);
  await pick(site);
  await notSignedIn(site);
  await expect(docTypeShown(site)).toHaveText('DNI');
  expect(await listOpen(site)).toBe('false');
  await expect(site.locator('x-select-items #list')).not.toHaveClass(/opened/);
});

test('BBVA live: a component with a closed shadow root is never clicked; not signed in, the toast names the field', async ({ context, extensionId }) => {
  await vaultWith(context, extensionId, [bbvaLE]);
  const site = await context.newPage();
  await site.goto(`${SITE}/login-bbva.html?live=1&ro=200&shadow=closed`);
  await expect.poll(() => isReadOnly(site, 'password')).toBe(false);
  await pick(site);
  await notSignedIn(site);
  expect(await compClicks(site)).toBe(0);
});

// A broken `items` attribute is no key ↔ label map: the plain select path
// (its one option "0" isn't LE), never a click in the component.
for (const items of ['malformed', 'dup', 'many', 'big']) {
  test(`BBVA live: an \`items\` attribute that is ${items} falls back to the plain select: no click, not signed in, toast`, async ({ context, extensionId }) => {
    await vaultWith(context, extensionId, [bbvaLE]);
    const site = await context.newPage();
    await site.goto(`${SITE}/login-bbva.html?live=1&ro=200&items=${items}`);
    await expect.poll(() => isReadOnly(site, 'password')).toBe(false);
    await pick(site);
    await notSignedIn(site);
    await expect(docTypeShown(site)).toHaveText('DNI');
    expect(await compClicks(site)).toBe(0);
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

test('no username captured: the login holding the password gets the extras update, never another login\'s password', async ({ context, extensionId }) => {
  const DOCTYPE_FILL = { tag: 'select', type: 'select-one', name: 'doctype', label: 'Document type' };
  const popup = await vaultWith(context, extensionId, [
    { name: 'Bank A', email: '', secret: '', urls: 'localhost', password: 'bank-pw',
      customFields: [{ label: 'Document type', value: 'NIE', kind: 'text', fill: DOCTYPE_FILL }] },
    { name: 'Bank B', email: '', secret: '', urls: 'localhost', password: 'other-pw' },
  ]);
  const site = await context.newPage();
  // Only the document type and the password: no username is captured.
  const signIn = async type => {
    await site.goto(`${SITE}/login-bank-extra.html`);
    await site.selectOption('select[name="doctype"]', { label: type });
    await site.fill('input[name="password"]', 'bank-pw');
    // Enter: the site's logins are offered in the corner, over the button.
    await site.press('input[name="password"]', 'Enter');
    await expect(site).toHaveURL(/welcome\.html/);
  };
  const state = async () => (await logins(popup))
    .map(l => [l.title, l.password, l.fields.map(f => [f.label, f.value])]).sort();

  await signIn('Pasaporte');
  const offer = site.locator('#otpilot-login-save');
  await expect(offer).toContainText('Update Bank A?');
  await expect(offer.locator('.otpilot-save-extras')).toHaveText('Saves: Document type');
  await expect(offer).not.toContainText('Bank B');
  await expect(offer.locator('.otpilot-save-target')).toHaveCount(0);
  await offer.locator('.otpilot-save-confirm').click();
  await expect.poll(state).toEqual([
    ['Bank A', 'bank-pw', [['Document type', 'Pasaporte']]],
    ['Bank B', 'other-pw', []],
  ]);

  // The same sign-in again: it matches Bank A as saved, no offer.
  await signIn('Pasaporte');
  await site.waitForTimeout(1500);
  await expect(site.locator('#otpilot-login-save')).toHaveCount(0);
  expect(await state()).toEqual([
    ['Bank A', 'bank-pw', [['Document type', 'Pasaporte']]],
    ['Bank B', 'other-pw', []],
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

// before-other: slotted, before a component with another name; before-plain:
// slotted, before an element that is no component. Neither is an extra.
for (const trap of ['host', 'before-other', 'before-plain']) {
  test(`a hidden slotted select the page adds (${trap}) is never captured`, async ({ context, extensionId }) => {
    const popup = await vaultWith(context, extensionId, []);
    const site = await context.newPage();
    await site.goto(`${SITE}/login-bbva.html?spa=1&trap=${trap}`);
    await site.selectOption('select[name="trapSelect"]', 'b', { force: true });
    await site.fill('input[name="documentNumber"]', '12345678');
    await site.fill('input[name="username"]', 'user-77');
    await site.fill('input[name="password"]', 'clave-1');
    await site.click('x-button');
    await expect(site.locator('h1')).toHaveText('Panel');
    const offer = site.locator('#otpilot-login-save');
    await expect(offer.locator('.otpilot-save-extras')).toHaveText('Also saves: Número de documento');
    await offer.locator('.otpilot-save-confirm').click();
    await expect.poll(async () => (await logins(popup))[0]?.fields.map(f => f.label)).toEqual(['Número de documento']);
  });
}

for (const trap of ['hidden', 'host', 'before-other', 'before-plain']) {
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
