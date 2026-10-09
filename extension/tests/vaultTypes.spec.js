import { test, expect, seedUnlocked, waitForVault, writeAccounts, TEST_SECRET } from './fixtures.js';

// The Vault view with every item type: secure notes, servers, API credentials
// next to logins, multiple tags, and the type filter.

async function vault(context, extensionId, { accounts = [], items = [], plan } = {}) {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/popup.html`);
  await page.evaluate(() => Promise.all([chrome.storage.local.clear(), chrome.storage.session.clear()]));
  await seedUnlocked(page, { accounts: [], ...(plan ? { userPlan: plan } : {}) });
  await page.reload();
  await waitForVault(page);
  if (accounts.length) await writeAccounts(page, accounts);
  if (items.length) {
    await page.evaluate(async list => {
      const key = await VaultKeys.getKey();
      await VaultStore.save(list.map(([type, over, fields]) => {
        const item = Vault.newItem(type, over);
        for (const [id, value] of Object.entries(fields || {})) Vault.getField(item, id).value = value;
        return item;
      }), key);
    }, items);
  }
  await page.reload();
  await page.click('#nav-settings');
  await expect(page.locator('.acc-row')).toHaveCount(accounts.length + items.length);
  return page;
}

const stored = page => page.evaluate(async () => (await VaultStore.readAll(await VaultKeys.getKey())).items
  .map(i => ({ type: i.type, title: i.title, tags: i.tags, notes: i.notes, fields: Object.fromEntries((i.fields || []).map(f => [f.id, f.value])), updatedAt: i.updatedAt }))
  .sort((a, b) => a.title.localeCompare(b.title)));

test('Add offers every type, and the planned ones as Soon', async ({ context, extensionId }) => {
  const page = await vault(context, extensionId);
  await page.click('#btn-add');
  await expect(page.locator('#add-type-menu [data-add-type]')).toHaveText(['2FA code', 'Login', 'Secure note', 'Server', 'API credential']);
  await expect(page.locator('#add-type-menu .add-type.soon').first()).toBeDisabled();
  await expect(page.locator('#add-type-menu .add-type.soon')).toHaveCount(8);
  // A click elsewhere closes it.
  await page.click('#acc-detail');
  await expect(page.locator('#add-type-menu')).toBeHidden();
});

test("the header's + opens the type picker from Home; a pick opens that editor in the vault", async ({ context, extensionId }) => {
  const page = await vault(context, extensionId);
  await page.click('#nav-home');
  await page.click('#btn-quick-add');
  const menu = page.locator('#quick-add-menu');
  await expect(menu).toBeVisible();
  await expect(menu.locator('[data-add-type="2fa"]')).toBeVisible();
  await page.screenshot({ path: test.info().outputPath('quick-add.png') });
  await menu.locator('[data-add-type="note"]').click();
  await expect(menu).toBeHidden();
  await expect(page.locator('#settings-panel')).toBeVisible();
  await expect(page.locator('#acc-detail .item-title')).toBeFocused();
  // A second + while editing keeps that unsaved item.
  await page.fill('#acc-detail .item-title', 'Draft note');
  await page.click('#btn-quick-add');
  await page.locator('#quick-add-menu [data-add-type="2fa"]').click();
  await expect(page.locator('.acc-row')).toHaveCount(2);
  await expect(page.locator('.acc-row', { hasText: 'Draft note' })).toHaveCount(1);
});

test('a secure note with a category and more tags is saved as a note item', async ({ context, extensionId }) => {
  const page = await vault(context, extensionId, { accounts: [{ name: 'GitHub', email: '', secret: TEST_SECRET, urls: '' }] });
  await page.click('#btn-add');
  await page.click('[data-add-type="note"]');
  await page.fill('#acc-detail .item-title', 'Wifi oficina');
  await page.fill('#acc-detail .item-notes', 'SSID: Office\nPass: hunter2');
  await page.locator('#acc-detail .cat-choice.new').click();
  await page.fill('#acc-detail .cat-new-input', 'Office');
  await page.fill('#acc-detail .acc-more-tags', 'network, office ,network');
  await page.click('#btn-save-all');

  await expect.poll(() => stored(page)).toEqual([
    expect.objectContaining({ type: 'login', title: 'GitHub' }),
    expect.objectContaining({ type: 'note', title: 'Wifi oficina', notes: 'SSID: Office\nPass: hunter2', tags: ['Office', 'network', 'office'] }),
  ]);
  // The list shows it with its type, and the type filter appears.
  await page.click('#nav-settings');
  await expect(page.locator('.acc-row', { hasText: 'Wifi oficina' }).locator('.type-tag')).toHaveText('Secure note');
  await expect(page.locator('#vault-type-bar .type-pill')).toHaveText([/All\s*2/, /Logins\s*1/, /Secure notes\s*1/]);
  await page.locator('#vault-type-bar .type-pill', { hasText: 'Secure notes' }).click();
  await expect.poll(() => page.locator('.acc-row').evaluateAll(rows =>
    rows.filter(r => r.style.display !== 'none').map(r => r.querySelector('.acc-head-name').textContent))).toEqual(['Wifi oficina']);
  // Any tag filters, not only the first.
  await page.locator('#vault-type-bar .type-pill', { hasText: 'All' }).click();
  await page.locator('#vault-cat-bar .cat-pill', { hasText: 'network' }).click();
  await expect.poll(() => page.locator('.acc-row').evaluateAll(rows =>
    rows.filter(r => r.style.display !== 'none').length)).toBe(1);
});

test('a server: template fields, masked password with show, generate and copy', async ({ context, extensionId }) => {
  const page = await vault(context, extensionId);
  await page.click('#btn-add');
  await page.click('[data-add-type="server"]');
  await page.fill('#acc-detail .item-title', 'Prod DB');
  await page.fill('#acc-detail .item-field[data-id="host"]', 'db.internal');
  await page.fill('#acc-detail .item-field[data-id="port"]', '5432');
  await page.fill('#acc-detail .item-field[data-id="username"]', 'admin');
  const pw = page.locator('#acc-detail .item-field[data-id="password"]');
  await expect(pw).toHaveAttribute('type', 'password');
  await pw.locator('xpath=..').locator('.btn-gen-password').click();
  await expect(pw).toHaveAttribute('type', 'text');
  const generated = await pw.inputValue();
  expect(generated).toHaveLength(16);
  await pw.locator('xpath=..').locator('.btn-copy-field').click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(generated);
  await page.click('#btn-save-all');

  await expect.poll(async () => (await stored(page))[0]?.fields).toEqual({ host: 'db.internal', port: '5432', username: 'admin', password: generated });
  await page.click('#nav-settings');
  await expect(page.locator('.acc-row', { hasText: 'Prod DB' }).locator('.acc-head-email')).toHaveText('db.internal · admin');
});

test('editing one item rewrites only that item; deleting one removes it', async ({ context, extensionId }) => {
  const page = await vault(context, extensionId, { items: [
    ['api', { title: 'Stripe' }, { apiKey: 'sk_live_1', environment: 'prod' }],
    ['note', { title: 'Untouched', notes: 'keep me' }],
    ['note', { title: 'Old note', notes: 'bye' }],
  ] });
  const before = await stored(page);
  await page.locator('.acc-head', { hasText: 'Stripe' }).click();
  await page.fill('#acc-detail .item-field[data-id="apiKey"]', 'sk_live_2');
  await page.locator('.acc-head', { hasText: 'Old note' }).click();
  page.once('dialog', d => d.accept());
  await page.click('#acc-detail .btn-del');
  await page.click('#btn-save-all');

  await expect.poll(async () => (await stored(page)).map(i => i.title)).toEqual(['Stripe', 'Untouched']);
  const after = await stored(page);
  expect(after[0].fields.apiKey).toBe('sk_live_2');
  expect(after[1].updatedAt).toBe(before.find(i => i.title === 'Untouched').updatedAt);
  // The deletion is a tombstone, so sync carries it to other devices.
  expect(await page.evaluate(async () => Object.keys(await VaultStore.listTombstones()).length)).toBe(1);
});

test('Free plan: a secure note counts toward the 50 items', async ({ context, extensionId }) => {
  const full = Array.from({ length: 50 }, (_, i) => ({ name: `Site ${String(i).padStart(2, '0')}`, email: '', secret: '', urls: '', password: 'x' }));
  const page = await vault(context, extensionId, { accounts: full, plan: 'free' });
  await page.click('#btn-add');
  await page.click('[data-add-type="note"]');
  await page.fill('#acc-detail .item-title', 'One too many');
  await page.click('#btn-save-all');
  await expect(page.locator('#status-msg')).toContainText('Free plan holds 50 items');
  expect((await stored(page)).length).toBe(50);
});

test('logins get more tags too, and the category bar offers them', async ({ context, extensionId }) => {
  const page = await vault(context, extensionId, { accounts: [{ name: 'GitHub', email: '', secret: TEST_SECRET, urls: '', category: 'Work' }] });
  await page.locator('.acc-head', { hasText: 'GitHub' }).click();
  await expect(page.locator('#acc-detail .acc-more-tags')).toHaveValue('');
  await page.fill('#acc-detail .acc-more-tags', 'oss, critical');
  await page.click('#btn-save-all');
  await expect.poll(async () => (await stored(page))[0].tags).toEqual(['Work', 'oss', 'critical']);
  await page.click('#nav-settings');
  await expect(page.locator('#vault-cat-bar .cat-pill')).toHaveText([/All/, /critical/, /oss/, /Work/]);
});

test('an item changed by a sync while the editor is open, but untouched here, keeps the synced version', async ({ context, extensionId }) => {
  const page = await vault(context, extensionId, { items: [['note', { title: 'Shared', notes: 'v1' }], ['note', { title: 'Mine', notes: 'a' }]] });
  await page.locator('.acc-head', { hasText: 'Mine' }).click();
  await page.fill('#acc-detail .item-notes', 'b');
  // Another device edits "Shared"; the sync lands while the editor is open.
  await page.evaluate(async () => {
    const key = await VaultKeys.getKey();
    const shared = (await VaultStore.readAll(key)).items.find(i => i.title === 'Shared');
    await VaultStore.save({ ...shared, notes: 'v2 from elsewhere', updatedAt: new Date(Date.now() + 1000).toISOString() }, key);
    await reloadFromVault(key);
  });
  await page.click('#btn-save-all');
  await expect.poll(async () => (await stored(page)).map(i => [i.title, i.notes])).toEqual([['Mine', 'b'], ['Shared', 'v2 from elsewhere']]);
});

// ── Review hardening ─────────────────────────────────────────────────────────

test('a tag-only edit of a login is a change (new updatedAt), so a sync never prefers an older edit', async ({ context, extensionId }) => {
  const page = await vault(context, extensionId, { accounts: [{ name: 'GitHub', email: '', secret: TEST_SECRET, urls: '', category: 'Work', _updatedAt: '2020-01-01T00:00:00.000Z' }] });
  await page.locator('.acc-head', { hasText: 'GitHub' }).click();
  await page.fill('#acc-detail .acc-more-tags', 'oss');
  await page.click('#btn-save-all');
  await expect.poll(async () => (await stored(page))[0].tags).toEqual(['Work', 'oss']);
  expect((await stored(page))[0].updatedAt > '2020-01-01T00:00:00.000Z').toBe(true);
});

test('opening and saving an item never rewrites fields the user did not touch', async ({ context, extensionId }) => {
  const page = await vault(context, extensionId, { items: [['api', { title: 'Legacy' }, { apiKey: 'k1', expires: '07/10/2026' }]] });
  // A field of a kind this version doesn't know (from a newer one), multi-line.
  await page.evaluate(async () => {
    const key = await VaultKeys.getKey();
    const item = (await VaultStore.readAll(key)).items[0];
    item.fields.push({ id: 'cert', label: 'Certificate', kind: 'pem', value: 'line1\nline2' });
    await VaultStore.save(item, key);
  });
  await page.reload();
  await page.click('#nav-settings');
  await page.locator('.acc-head', { hasText: 'Legacy' }).click();
  await page.fill('#acc-detail .item-field[data-id="apiKey"]', 'k2');
  await page.click('#btn-save-all');
  await expect.poll(async () => (await stored(page))[0].fields).toEqual({
    clientId: '', clientSecret: '', apiKey: 'k2', environment: '', expires: '07/10/2026', cert: 'line1\nline2',
  });
});

// ── "2FA code" ───────────────────────────────────────────────────────────────

test('"2FA code" comes first and opens a 2FA-first form; a pasted otpauth link fills it in', async ({ context, extensionId }) => {
  const page = await vault(context, extensionId, { plan: 'free' });
  await page.click('#btn-add');
  await expect(page.locator('#add-type-menu [data-add-type]').first()).toHaveText('2FA code');
  await page.click('[data-add-type="2fa"]');
  await expect(page.locator('#acc-detail .acc-secret')).toBeFocused();
  await expect(page.locator('#acc-detail .acc-password-field')).toBeHidden();

  await page.fill('#acc-detail .acc-secret', 'otpauth://totp/GitHub:me%40x.com?secret=JBSWY3DPEHPK3PXP&issuer=GitHub');
  await expect(page.locator('#acc-detail .acc-secret')).toHaveValue('JBSWY3DPEHPK3PXP');
  await expect(page.locator('#acc-detail .acc-name')).toHaveValue('GitHub');
  await expect(page.locator('#acc-detail .acc-email')).toHaveValue('me@x.com');
  await page.click('#btn-save-all');

  await expect.poll(() => page.evaluate(async () => (await VaultStore.readAll(await VaultKeys.getKey())).items
    .map(i => ({ type: i.type, title: i.title, user: Vault.getValue(i, 'username'), pw: Vault.getValue(i, 'password'), secret: i.totp?.secret, counts: Vault.countsForLimit(i) }))))
    .toEqual([{ type: 'login', title: 'GitHub', user: 'me@x.com', pw: '', secret: 'JBSWY3DPEHPK3PXP', counts: false }]);
  // Reopened, it's a regular login (full form).
  await page.click('#nav-settings');
  await page.locator('.acc-head', { hasText: 'GitHub' }).click();
  await expect(page.locator('#acc-detail .acc-password-field')).toBeVisible();
});

test('"2FA code": "+ Add password" reveals the password; unsupported otpauth settings are refused', async ({ context, extensionId }) => {
  const page = await vault(context, extensionId);
  await page.click('#btn-add');
  await page.click('[data-add-type="2fa"]');
  await page.fill('#acc-detail .acc-secret', 'otpauth://totp/X?secret=JBSWY3DPEHPK3PXP&digits=8');
  await expect(page.locator('#status-msg')).toContainText("can't generate");
  await expect(page.locator('#acc-detail .acc-secret')).toHaveValue('');
  await page.click('#acc-detail .btn-add-password');
  await expect(page.locator('#acc-detail .acc-password')).toBeFocused();
  await expect(page.locator('#acc-detail .btn-add-password')).toHaveCount(0);
});

test('"2FA code": hex-looking link secrets keep their bytes; malformed links are refused; an added password stays visible', async ({ context, extensionId }) => {
  const page = await vault(context, extensionId);
  await page.click('#btn-add');
  await page.click('[data-add-type="2fa"]');
  await page.fill('#acc-detail .acc-secret', 'otpauth://totp/Example%?secret=JBSWY3DPEHPK3PXP');
  await expect(page.locator('#status-msg')).toContainText('malformed');
  await expect(page.locator('#acc-detail .acc-secret')).toHaveValue('');

  await page.fill('#acc-detail .acc-secret', 'otpauth://totp/Example:user?secret=ABCDEFABCDEFABCD');
  const stored = await page.locator('#acc-detail .acc-secret').inputValue();
  const expected = await page.evaluate(() => [...new Uint8Array(base32Decode('ABCDEFABCDEFABCD'))].map(b => b.toString(16).padStart(2, '0')).join(''));
  expect(stored).toBe(expected);

  await page.click('#acc-detail .btn-add-password');
  await page.fill('#acc-detail .acc-password', 'pw');
  await page.click('#btn-add');
  await page.click('[data-add-type="note"]');
  await page.locator('.acc-head', { hasText: 'Example' }).click();
  await expect(page.locator('#acc-detail .acc-password')).toHaveValue('pw');
  await expect(page.locator('#acc-detail .acc-password-field')).toBeVisible();
});

// ── Notes and custom fields ──────────────────────────────────────────────────

test('a login gets notes and custom fields (hidden ones masked), saved on the item', async ({ context, extensionId }) => {
  const page = await vault(context, extensionId, { accounts: [{ name: 'DigitalOcean', email: 'me@example.com', secret: TEST_SECRET, urls: 'digitalocean.com' }] });
  await page.locator('.acc-head', { hasText: 'DigitalOcean' }).click();
  await page.fill('#acc-detail .acc-notes', 'Billing contact: ops@team');
  await page.click('#acc-detail .cf-add');
  await page.locator('#acc-detail .cf-row').last().locator('.cf-label').fill('Droplet IP');
  await page.locator('#acc-detail .cf-row').last().locator('.cf-value').fill('10.0.0.5');
  await page.click('#acc-detail .cf-add');
  const token = page.locator('#acc-detail .cf-row').last();
  await token.locator('.cf-label').fill('API token');
  await token.locator('.cf-hide').click(); // hidden
  await page.locator('#acc-detail .cf-row').last().locator('.cf-value').fill('dop_v1_secret');
  await expect(page.locator('#acc-detail .cf-row').last().locator('.cf-value')).toHaveAttribute('type', 'password');
  await page.click('#btn-save-all');
  await expect.poll(async () => {
    const [i] = await page.evaluate(async () => (await VaultStore.readAll(await VaultKeys.getKey())).items);
    return { notes: i.notes, custom: i.fields.filter(f => f.custom).map(f => [f.label, f.value, f.kind]), totp: !!i.totp?.secret };
  }).toEqual({ notes: 'Billing contact: ops@team', custom: [['Droplet IP', '10.0.0.5', 'text'], ['API token', 'dop_v1_secret', 'password']], totp: true });

  // Reopened: still there; a removed field goes on the next save.
  await page.reload();
  await page.click('#nav-settings');
  await page.locator('.acc-head', { hasText: 'DigitalOcean' }).click();
  await expect(page.locator('#acc-detail .acc-notes')).toHaveValue('Billing contact: ops@team');
  await expect(page.locator('#acc-detail .cf-row')).toHaveCount(2);
  await page.locator('#acc-detail .cf-row').first().locator('.cf-del').click();
  await page.click('#btn-save-all');
  await expect.poll(async () => (await page.evaluate(async () => (await VaultStore.readAll(await VaultKeys.getKey())).items))[0]
    .fields.filter(f => f.custom).map(f => f.label)).toEqual(['API token']);
});

test('custom fields go in named sections, added by kind, kept on save and reopen', async ({ context, extensionId }) => {
  const page = await vault(context, extensionId, { accounts: [{ name: 'Bank', email: 'me@example.com', secret: '', urls: 'bank.example', password: 'pw' }] });
  await page.locator('.acc-head', { hasText: 'Bank' }).click();
  await page.click('#acc-detail .cf-new-section');
  const section = page.locator('#acc-detail .cf-section.cf-named');
  await expect(section.locator('.cf-section-name')).toBeFocused();
  await section.locator('.cf-section-name').fill('Bank details');
  // The new section starts with a row; a Hidden one is added from its chips.
  await section.locator('.cf-row').first().locator('.cf-label').fill('CBU');
  await section.locator('.cf-row').first().locator('.cf-value').fill('0070089020004021339812');
  await section.locator('.cf-add-kind[data-kind="password"]').click();
  await expect(section.locator('.cf-row').last().locator('.cf-label')).toBeFocused();
  await section.locator('.cf-row').last().locator('.cf-label').fill('Phone PIN');
  await section.locator('.cf-row').last().locator('.cf-value').fill('4321');
  await expect(section.locator('.cf-row').last().locator('.cf-value')).toHaveAttribute('type', 'password');
  // One in the default section too.
  await page.locator('#acc-detail .cf-section:not(.cf-named) .cf-add').click();
  await page.locator('#acc-detail .cf-section:not(.cf-named) .cf-row .cf-label').fill('Branch');
  await page.locator('#acc-detail .cf-section:not(.cf-named) .cf-row .cf-value').fill('Palermo');
  await page.click('#btn-save-all');

  // Stored in the order shown: the default section first.
  const stored = () => page.evaluate(async () => (await VaultStore.readAll(await VaultKeys.getKey())).items[0].fields
    .filter(f => f.custom).map(f => [f.section || '', f.label, f.value, f.kind]));
  await expect.poll(stored).toEqual([
    ['', 'Branch', 'Palermo', 'text'],
    ['Bank details', 'CBU', '0070089020004021339812', 'text'],
    ['Bank details', 'Phone PIN', '4321', 'password'],
  ]);

  await page.reload();
  await page.click('#nav-settings');
  await page.locator('.acc-head', { hasText: 'Bank' }).click();
  // The default section comes first, then the named one with its fields.
  await expect(page.locator('#acc-detail .cf-section')).toHaveCount(2);
  await expect(page.locator('#acc-detail .cf-section').first().locator('.cf-label')).toHaveValue('Branch');
  await expect(page.locator('#acc-detail .cf-section.cf-named .cf-section-name')).toHaveValue('Bank details');
  await expect(page.locator('#acc-detail .cf-section.cf-named .cf-row')).toHaveCount(2);

  // Renaming a section renames it on every field; removing it removes them.
  await page.locator('#acc-detail .cf-section-name').fill('Galicia');
  await page.click('#btn-save-all');
  await expect.poll(stored).toEqual([
    ['', 'Branch', 'Palermo', 'text'],
    ['Galicia', 'CBU', '0070089020004021339812', 'text'],
    ['Galicia', 'Phone PIN', '4321', 'password'],
  ]);
  await page.locator('.acc-head', { hasText: 'Bank' }).click();
  page.once('dialog', d => d.accept());
  await page.click('#acc-detail .cf-section-del');
  await page.click('#btn-save-all');
  await expect.poll(stored).toEqual([['', 'Branch', 'Palermo', 'text']]);
});

test('merging keeps the same field in two sections as two fields', async ({ context, extensionId }) => {
  const page = await vault(context, extensionId);
  const fields = await page.evaluate(() => mergeLogins(
    { name: 'A', customFields: [{ label: 'Email', value: 'me@example.com', kind: 'text', section: 'Billing' }] },
    { name: 'A', customFields: [{ label: 'Email', value: 'me@example.com', kind: 'text', section: 'Support' }] },
  ).customFields.map(f => f.section));
  expect(fields).toEqual(['Billing', 'Support']);
});

test('a field section survives the CSV export and import', async ({ context, extensionId }) => {
  const page = await vault(context, extensionId);
  const out = await page.evaluate(async () => {
    const item = Vault.newItem('login', { title: 'Bank', urls: ['bank.example'] });
    const withFields = VaultAccounts.withCustomFields(item, [
      { label: 'CBU', value: '123', kind: 'text', section: 'Bank details' },
      { label: 'Email', value: 'me@example.com', kind: 'text', section: 'Billing' },
      { label: 'Email', value: 'me@example.com', kind: 'text', section: 'Support' },
    ]);
    const csv = Importers.toCsv([withFields]);
    const { entries } = Importers.parse(csv);
    const [restored] = Importers.toItems(entries, Importers.plan(entries, []), []);
    return restored.fields.filter(f => f.custom).map(f => [f.label, f.value, f.section || '']);
  });
  // The same label and value in two sections are two fields.
  expect(out).toEqual([['CBU', '123', 'Bank details'], ['Email', 'me@example.com', 'Billing'], ['Email', 'me@example.com', 'Support']]);
});

test('custom fields on other item types too', async ({ context, extensionId }) => {
  const page = await vault(context, extensionId, { items: [['server', { title: 'Prod DB' }, { host: 'db.internal' }]] });
  await page.locator('.acc-head', { hasText: 'Prod DB' }).click();
  await page.click('#acc-detail .cf-add');
  await page.locator('#acc-detail .cf-row .cf-label').fill('Region');
  await page.locator('#acc-detail .cf-row .cf-value').fill('nyc3');
  await page.click('#btn-save-all');
  await expect.poll(async () => page.evaluate(async () => (await VaultStore.readAll(await VaultKeys.getKey())).items[0].fields
    .map(f => [f.label, f.value, !!f.custom]).filter(([, v]) => v))).toEqual([['Host', 'db.internal', false], ['Region', 'nyc3', true]]);
});

test('a page or a 1.x device saving the login keeps its notes and custom fields', async ({ context, extensionId }) => {
  const page = await vault(context, extensionId, { accounts: [{ name: 'Site', email: 'me@example.com', secret: '', urls: 'localhost', password: 'old' }] });
  await page.evaluate(async () => {
    const key = await VaultKeys.getKey();
    const [i] = (await VaultStore.readAll(key)).items;
    await VaultStore.save(VaultAccounts.withCustomFields({ ...i, notes: 'keep' }, [{ label: 'PIN', value: '1234', kind: 'password' }]), key);
    const [acc] = await VaultAccounts.load(key);
    // A caller that doesn't know about notes / custom fields (page update, v1 blob merge).
    const { notes, customFields, ...plain } = acc;
    await VaultAccounts.update(acc._id, acc, { password: 'new' }, key);
    await VaultAccounts.save([{ ...plain, name: 'Site (renamed)' }], key, new Set([acc._id]));
  });
  const i = (await page.evaluate(async () => (await VaultStore.readAll(await VaultKeys.getKey())).items))[0];
  expect([i.title, i.notes, i.fields.filter(f => f.custom).map(f => f.label)]).toEqual(['Site (renamed)', 'keep', ['PIN']]);
});

test('editing only notes or custom fields still stamps the login as changed (sync keeps this edit)', async ({ context, extensionId }) => {
  const page = await vault(context, extensionId, { accounts: [{ name: 'Site', email: 'me', secret: TEST_SECRET, urls: 'site.example' }] });
  const before = await page.evaluate(async () => (await VaultStore.readAll(await VaultKeys.getKey())).items[0].updatedAt);
  await page.waitForTimeout(20);
  await page.locator('.acc-head', { hasText: 'Site' }).click();
  await page.fill('#acc-detail .acc-notes', 'only the notes changed');
  await page.click('#btn-save-all');
  await expect.poll(async () => page.evaluate(async () => (await VaultStore.readAll(await VaultKeys.getKey())).items[0].notes)).toBe('only the notes changed');
  const after = await page.evaluate(async () => (await VaultStore.readAll(await VaultKeys.getKey())).items[0].updatedAt);
  expect(after > before).toBe(true);
});

test('existing custom fields keep their kind and line breaks when the login is saved', async ({ context, extensionId }) => {
  const page = await vault(context, extensionId, { accounts: [{ name: 'Site', email: 'me', secret: TEST_SECRET, urls: 'site.example' }] });
  await page.evaluate(async () => {
    const key = await VaultKeys.getKey();
    const [i] = (await VaultStore.readAll(key)).items;
    i.fields.push({ id: 'c-h', label: 'Answer', value: 'blue', kind: 'hidden', custom: true });
    i.fields.push({ id: 'c-m', label: 'Codes', value: 'a1\nb2', kind: 'multiline', custom: true });
    await VaultStore.save(i, key);
  });
  await page.reload();
  await page.click('#nav-settings');
  await page.locator('.acc-head', { hasText: 'Site' }).click();
  await expect(page.locator('#acc-detail .cf-row[data-id="c-h"] .cf-value')).toHaveAttribute('type', 'password');
  await page.fill('#acc-detail .acc-name', 'Site renamed');
  await page.click('#btn-save-all');
  await expect.poll(async () => page.evaluate(async () => (await VaultStore.readAll(await VaultKeys.getKey())).items[0]
    .fields.filter(f => f.custom).map(f => [f.label, f.value, f.kind]))).toEqual([['Answer', 'blue', 'hidden'], ['Codes', 'a1\nb2', 'multiline']]);
});

test('custom-field buttons do only their own job (no errors, copy does not unmask)', async ({ context, extensionId }) => {
  const page = await vault(context, extensionId, { items: [['server', { title: 'Prod DB' }, { host: 'db.internal' }]] });
  // A custom field already on the item when the editor opens.
  await page.evaluate(async () => {
    const key = await VaultKeys.getKey();
    const [i] = (await VaultStore.readAll(key)).items;
    i.fields.push({ id: 'c-t', label: 'Token', value: 't0k3n', kind: 'password', custom: true });
    await VaultStore.save(i, key);
  });
  await page.reload();
  await page.click('#nav-settings');
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.locator('.acc-head', { hasText: 'Prod DB' }).click();
  const value = page.locator('#acc-detail .cf-row .cf-value');
  await page.locator('#acc-detail .cf-row .cf-copy').click();
  await expect(value).toHaveAttribute('type', 'password');
  await page.locator('#acc-detail .cf-row .cf-eye').click();
  await expect(value).toHaveAttribute('type', 'text');
  await page.locator('#acc-detail .cf-row .cf-del').click();
  await expect(page.locator('#acc-detail .cf-row')).toHaveCount(0);
  expect(errors).toEqual([]);
});

// ── Merging logins ───────────────────────────────────────────────────────────

const items = page => page.evaluate(async () => (await VaultStore.readAll(await VaultKeys.getKey())).items.map(i => ({
  title: i.title, user: Vault.getValue(i, 'username'), password: Vault.getValue(i, 'password'), secret: i.totp?.secret || '',
  urls: i.urls, notes: i.notes, tags: i.tags, custom: i.fields.filter(f => f.custom).map(f => [f.label, f.value]),
  history: (i.passwordHistory || []).map(h => h.value),
})));

// Picks the other login in the merge panel's search.
async function pickMerge(page, text) {
  await page.fill('#acc-detail .merge-search', text);
  await page.locator('#acc-detail .merge-option', { hasText: text }).first().click();
}

test('the merge panel starts with nothing chosen; the search finds the other login and Change goes back', async ({ context, extensionId }) => {
  const page = await vault(context, extensionId, { accounts: [
    { name: 'DigitalOcean', email: 'me', secret: '', urls: 'digitalocean.com', password: 'p' },
    { name: 'AWS', email: 'root', secret: '', urls: 'aws.amazon.com', password: 'q' },
    { name: 'DO 2FA', email: 'me', secret: TEST_SECRET, urls: 'cloud.digitalocean.com' },
  ] });
  await page.locator('.acc-head', { hasText: 'DigitalOcean' }).click();
  await page.click('#acc-detail .btn-merge');
  await expect(page.locator('#acc-detail .merge-search')).toBeFocused();
  await expect(page.locator('#acc-detail .merge-apply')).toBeDisabled();
  await expect(page.locator('#acc-detail .merge-row')).toHaveCount(0);
  await expect(page.locator('#acc-detail .merge-option')).toHaveCount(2);
  // A subdomain of this login's site comes first, marked as the same site.
  await expect(page.locator('#acc-detail .merge-option').first()).toContainText('DO 2FA');
  await expect(page.locator('#acc-detail .merge-option').first().locator('.merge-same')).toHaveText('Same site');
  await page.fill('#acc-detail .merge-search', 'amazon');
  await expect(page.locator('#acc-detail .merge-option')).toHaveText([/AWS/]);
  await page.fill('#acc-detail .merge-search', 'do');
  await page.keyboard.press('Enter'); // the first match
  await expect(page.locator('#acc-detail .merge-picked')).toContainText('DO 2FA');
  await expect(page.locator('#acc-detail .merge-apply')).toBeEnabled();
  await page.click('#acc-detail .merge-change');
  await expect(page.locator('#acc-detail .merge-apply')).toBeDisabled();
  await expect(page.locator('#acc-detail .merge-search')).toBeVisible();
});

test('merging a 2FA-only login into the password login of the same account: one login with both', async ({ context, extensionId }) => {
  const page = await vault(context, extensionId, { accounts: [
    { name: 'DigitalOcean', email: 'me@example.com', secret: '', urls: 'digitalocean.com', password: 'pw', category: 'Infra' },
    { name: 'DigitalOcean', email: 'me@example.com', secret: TEST_SECRET, urls: 'cloud.digitalocean.com' },
  ] });
  await page.locator('.acc-head').first().click();
  await page.click('#acc-detail .btn-merge');
  await pickMerge(page, 'cloud.digitalocean');
  await expect(page.locator('#acc-detail .merge-hint')).toContainText('Nothing conflicts');
  await page.click('#acc-detail .merge-apply');
  await expect(page.locator('.acc-row')).toHaveCount(1);
  await page.click('#btn-save-all');
  await expect.poll(() => items(page)).toEqual([{
    title: 'DigitalOcean', user: 'me@example.com', password: 'pw', secret: TEST_SECRET,
    urls: ['digitalocean.com', 'cloud.digitalocean.com'], notes: '', tags: ['Infra'], custom: [], history: [],
  }]);
});

test('merge conflicts are chosen per field; the password left behind goes to the history; notes can keep both', async ({ context, extensionId }) => {
  const page = await vault(context, extensionId, { accounts: [
    { name: 'Work', email: 'me@example.com', secret: '', urls: 'a.example', password: 'old-pass', notes: 'first' },
    { name: 'Work (2)', email: 'me@example.com', secret: '', urls: 'b.example', password: 'new-pass', notes: 'second', customFields: [{ label: 'PIN', value: '1234', kind: 'password' }] },
  ] });
  await page.locator('.acc-head').first().click(); // "Work" (the list is sorted by name)
  await expect(page.locator('#acc-detail .acc-name')).toHaveValue('Work');
  await page.click('#acc-detail .btn-merge');
  await pickMerge(page, 'Work (2)');
  const rows = page.locator('#acc-detail .merge-row');
  await expect(rows).toHaveCount(3); // name, password, notes
  await rows.filter({ hasText: 'Password' }).locator('input[value="b"]').check();
  await page.click('#acc-detail .merge-apply');
  await page.click('#btn-save-all');
  await expect.poll(() => items(page)).toEqual([{
    title: 'Work', user: 'me@example.com', password: 'new-pass', secret: '',
    urls: ['a.example', 'b.example'], notes: 'first\n\nsecond', tags: [], custom: [['PIN', '1234']], history: ['old-pass'],
  }]);
});

test('keeping this login\'s password still keeps the other one in the history', async ({ context, extensionId }) => {
  const page = await vault(context, extensionId, { accounts: [
    { name: 'A', email: 'u', secret: '', urls: 'a.example', password: 'keep' },
    { name: 'B', email: 'u', secret: '', urls: 'a.example', password: 'drop' },
  ] });
  await page.locator('.acc-head', { hasText: 'A' }).first().click();
  await page.click('#acc-detail .btn-merge');
  await pickMerge(page, 'B');
  await page.click('#acc-detail .merge-apply');
  await page.click('#btn-save-all');
  await expect.poll(async () => (await items(page)).map(i => [i.title, i.password, i.history])).toEqual([['A', 'keep', ['drop']]]);
});

test('two merges before Save keep every password left behind, and the other login\'s history', async ({ context, extensionId }) => {
  const page = await vault(context, extensionId, { accounts: [
    { name: 'A', email: 'u', secret: '', urls: 'a.example', password: 'pa' },
    { name: 'B', email: 'u', secret: '', urls: 'a.example', password: 'pb' },
    { name: 'C', email: 'u', secret: '', urls: 'a.example', password: 'pc' },
  ] });
  // B already had an older password.
  await page.evaluate(async () => {
    const key = await VaultKeys.getKey();
    const b = (await VaultStore.readAll(key)).items.find(i => i.title === 'B');
    b.passwordHistory = [{ value: 'pb-old', changedAt: '2026-01-01T00:00:00.000Z' }];
    await VaultStore.save(b, key);
  });
  await page.reload();
  await page.click('#nav-settings');
  await page.locator('.acc-head').first().click(); // A
  for (const other of ['B', 'C']) {
    await page.click('#acc-detail .btn-merge');
    await pickMerge(page, other);
    await page.locator('#acc-detail .merge-row', { hasText: 'Password' }).locator('input[value="b"]').check();
    await page.click('#acc-detail .merge-apply');
  }
  await page.click('#btn-save-all');
  await expect.poll(async () => (await items(page)).map(i => [i.title, i.password, [...i.history].sort()]))
    .toEqual([['A', 'pc', ['pa', 'pb', 'pb-old']]]);
});

test('a password of only spaces is a password: merging with a login without one keeps it', async ({ context, extensionId }) => {
  const page = await vault(context, extensionId, { accounts: [
    { name: 'A', email: 'u', secret: '', urls: 'a.example', password: '   ' },
    { name: 'B', email: 'u', secret: TEST_SECRET, urls: 'a.example', password: '' },
  ] });
  await page.locator('.acc-head').first().click();
  await page.click('#acc-detail .btn-merge');
  await pickMerge(page, 'B');
  await expect(page.locator('#acc-detail .merge-row', { hasText: 'Password' })).toHaveCount(0);
  await page.click('#acc-detail .merge-apply');
  await page.click('#btn-save-all');
  await expect.poll(async () => (await items(page)).map(i => [i.password, i.secret])).toEqual([['   ', TEST_SECRET]]);
});

test('the merge panel can show the passwords it asks to choose between', async ({ context, extensionId }) => {
  const page = await vault(context, extensionId, { accounts: [
    { name: 'A', email: 'u', secret: '', urls: 'a.example', password: 'same-len-1' },
    { name: 'B', email: 'u', secret: '', urls: 'a.example', password: 'same-len-2' },
  ] });
  await page.locator('.acc-head').first().click();
  await page.click('#acc-detail .btn-merge');
  await pickMerge(page, 'B');
  const row = page.locator('#acc-detail .merge-row', { hasText: 'Password' });
  await expect(row.locator('.merge-secret')).toHaveText(['••••••••••', '••••••••••']);
  await row.locator('.merge-reveal').click();
  await expect(row.locator('.merge-secret')).toHaveText(['same-len-1', 'same-len-2']);
});

test('a conflict created in the editor while the merge panel is open is asked about, not decided silently', async ({ context, extensionId }) => {
  const page = await vault(context, extensionId, { accounts: [
    { name: 'Same', email: 'u', secret: '', urls: 'a.example', password: 'p' },
    { name: 'Same', email: 'u', secret: TEST_SECRET, urls: 'a.example', password: 'p' },
  ] });
  // The one without a 2FA secret.
  await page.locator('.acc-head').first().click();
  if (await page.locator('#acc-detail .acc-secret').inputValue()) await page.locator('.acc-head').nth(1).click();
  await page.click('#acc-detail .btn-merge');
  await pickMerge(page, 'Same');
  await expect(page.locator('#acc-detail .merge-hint')).toContainText('Nothing conflicts');
  await page.fill('#acc-detail .acc-secret', 'GEZDGNBVGY3TQOJQ'); // a different secret, typed meanwhile
  await page.click('#acc-detail .merge-apply');
  await expect(page.locator('#status-msg')).toContainText('review the choices');
  await expect(page.locator('#acc-detail .merge-row', { hasText: '2FA secret' })).toHaveCount(1);
  await expect(page.locator('.acc-row')).toHaveCount(2); // nothing merged yet
});

test('a merge that only sets a password aside still stamps the login as changed', async ({ context, extensionId }) => {
  const page = await vault(context, extensionId, { accounts: [
    { name: 'A', email: 'u', secret: '', urls: 'a.example', password: 'keep' },
    { name: 'A2', email: 'u', secret: '', urls: 'a.example', password: 'other' },
  ] });
  const before = await page.evaluate(async () => (await VaultStore.readAll(await VaultKeys.getKey())).items.find(i => i.title === 'A').updatedAt);
  await page.waitForTimeout(20);
  await page.locator('.acc-head').first().click(); // A: keeps its name and password (the defaults)
  await page.click('#acc-detail .btn-merge');
  await pickMerge(page, 'A2');
  await page.click('#acc-detail .merge-apply');
  await page.click('#btn-save-all');
  await expect.poll(async () => (await items(page)).map(i => [i.title, i.password, i.history])).toEqual([['A', 'keep', ['other']]]);
  const [merged] = await page.evaluate(async () => (await VaultStore.readAll(await VaultKeys.getKey())).items);
  expect(merged.updatedAt > before).toBe(true);
});

test('a custom field hidden on either side stays hidden after the merge', async ({ context, extensionId }) => {
  const page = await vault(context, extensionId, { accounts: [
    { name: 'A', email: 'u', secret: '', urls: 'a.example', password: 'p', customFields: [{ label: 'PIN', value: '1234', kind: 'text' }] },
    { name: 'B', email: 'u', secret: '', urls: 'a.example', password: 'p', customFields: [{ label: 'PIN', value: '1234', kind: 'password' }] },
  ] });
  await page.locator('.acc-head').first().click();
  await page.click('#acc-detail .btn-merge');
  await pickMerge(page, 'B');
  await page.click('#acc-detail .merge-apply');
  await page.click('#btn-save-all');
  await expect.poll(async () => page.evaluate(async () => (await VaultStore.readAll(await VaultKeys.getKey())).items
    .flatMap(i => i.fields.filter(f => f.custom).map(f => [f.label, f.kind])))).toEqual([['PIN', 'password']]);
});

test('arrowing through a long merge list keeps the highlighted login visible and announced', async ({ context, extensionId }) => {
  const many = Array.from({ length: 14 }, (_, i) => ({ name: `Site ${String(i).padStart(2, '0')}`, email: 'u', secret: '', urls: `s${i}.example`, password: 'p' }));
  const page = await vault(context, extensionId, { accounts: many });
  await page.locator('.acc-head').first().click();
  await page.click('#acc-detail .btn-merge');
  for (let i = 0; i < 11; i++) await page.keyboard.press('ArrowDown');
  const active = page.locator('#acc-detail .merge-option.active');
  await expect(active).toContainText('Site 12');
  await expect(active).toBeInViewport();
  await expect(page.locator('#acc-detail .merge-search')).toHaveAttribute('aria-activedescendant', await active.getAttribute('id'));
  await expect(active).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Enter');
  await expect(page.locator('#acc-detail .merge-picked')).toContainText('Site 12');
});

// ── Related items ────────────────────────────────────────────────────────────

const storedItems = page => page.evaluate(async () => (await VaultStore.readAll(await VaultKeys.getKey())).items
  .map(i => ({ id: i.id, type: i.type, title: i.title, notes: i.notes || '', links: i.links || [] })));

test('a note created from a login links back to it, and each shows the other as related', async ({ context, extensionId }) => {
  const page = await vault(context, extensionId, { accounts: [{ name: 'Bank', email: 'me@example.com', secret: '', urls: 'bank.example', password: 'pw' }] });
  await page.locator('.acc-head', { hasText: 'Bank' }).click();
  await expect(page.locator('#acc-detail .rel-row')).toHaveCount(0);
  await page.click('#acc-detail .rel-new-note');
  // The new note is open, titled after the login.
  await expect(page.locator('#acc-detail .item-title')).toHaveValue('Bank notes');
  await expect(page.locator('#acc-detail .item-notes')).toBeFocused();
  await page.fill('#acc-detail .item-notes', 'First pet: Rex');
  await expect(page.locator('#acc-detail .rel-row')).toHaveText(/Bank/);
  await page.click('#btn-save-all');

  await expect.poll(async () => {
    const items = await storedItems(page);
    const login = items.find(i => i.type === 'login');
    const note = items.find(i => i.type === 'note');
    return note && { title: note.title, notes: note.notes, linksLogin: note.links.includes(login.id) && note.links.length === 1, loginLinks: login.links };
  }).toEqual({ title: 'Bank notes', notes: 'First pet: Rex', linksLogin: true, loginLinks: [] });

  // From the login: the note is related; opening it shows the login.
  await page.reload();
  await page.click('#nav-settings');
  await page.locator('.acc-head').filter({ has: page.locator('.acc-head-name', { hasText: /^Bank$/ }) }).click();
  await expect(page.locator('#acc-detail .rel-section label')).toHaveText('Related · 1');
  await page.locator('#acc-detail .rel-row .rel-open', { hasText: 'Bank notes' }).click();
  await expect(page.locator('#acc-detail .item-title')).toHaveValue('Bank notes');
  await expect(page.locator('#acc-detail .rel-row')).toHaveText(/Bank/);
});

test('linking an existing item from the search, and unlinking it from either side', async ({ context, extensionId }) => {
  const page = await vault(context, extensionId, {
    accounts: [{ name: 'Bank', email: 'me@example.com', secret: '', urls: 'bank.example', password: 'pw' }],
    items: [['note', { title: 'Card PINs', notes: '1234' }], ['note', { title: 'Wifi', notes: 'x' }]],
  });
  await page.locator('.acc-head', { hasText: 'Bank' }).click();
  await page.click('#acc-detail .rel-link');
  await expect(page.locator('#acc-detail .rel-search')).toBeFocused();
  await expect(page.locator('#acc-detail .rel-option')).toHaveCount(2);
  await page.fill('#acc-detail .rel-search', 'pin');
  await expect(page.locator('#acc-detail .rel-option')).toHaveCount(1);
  await page.press('#acc-detail .rel-search', 'Enter');
  await expect(page.locator('#acc-detail .rel-row')).toHaveCount(1);
  await expect(page.locator('#acc-detail .rel-row')).toContainText('Card PINs');
  // Already related: not offered again.
  await page.click('#acc-detail .rel-link');
  await expect(page.locator('#acc-detail .rel-option')).toHaveCount(1);
  await expect(page.locator('#acc-detail .rel-option')).toContainText('Wifi');
  await page.click('#btn-save-all');

  const linksOfLogin = async () => {
    const items = await storedItems(page);
    const pins = items.find(i => i.title === 'Card PINs');
    return items.find(i => i.type === 'login').links.map(id => (id === pins.id ? 'Card PINs' : id));
  };
  await expect.poll(linksOfLogin).toEqual(['Card PINs']);

  // Unlinked from the note's side: the link stored on the login goes; both items stay.
  await page.locator('.acc-head', { hasText: 'Card PINs' }).click();
  await expect(page.locator('#acc-detail .rel-row')).toContainText('Bank');
  await page.click('#acc-detail .rel-unlink');
  await expect(page.locator('#acc-detail .rel-row')).toHaveCount(0);
  await page.click('#btn-save-all');
  await expect.poll(linksOfLogin).toEqual([]);
  expect((await storedItems(page)).length).toBe(3);
});

test('a login not saved yet asks to be saved before linking', async ({ context, extensionId }) => {
  const page = await vault(context, extensionId);
  await page.click('#btn-add');
  await page.click('[data-add-type="login"]');
  await expect(page.locator('#acc-detail .rel-section')).toContainText('Save this login first');
  await expect(page.locator('#acc-detail .rel-link')).toHaveCount(0);
});

test('merging two logins keeps both sides\' related items', async ({ context, extensionId }) => {
  const page = await vault(context, extensionId, {
    accounts: [
      { name: 'Bank', email: 'me@example.com', secret: '', urls: 'bank.example', password: 'pw' },
      { name: 'Bank old', email: 'me@example.com', secret: '', urls: 'bank.example', password: 'pw' },
    ],
    items: [['note', { title: 'Old bank PINs', notes: '1' }]],
  });
  // The note links the login that goes away in the merge.
  await page.evaluate(async () => {
    const key = await VaultKeys.getKey();
    const { items } = await VaultStore.readAll(key);
    const old = items.find(i => i.title === 'Bank old');
    const note = items.find(i => i.type === 'note');
    await VaultStore.save([{ ...note, links: [old.id] }], key);
  });
  await page.reload();
  await page.click('#nav-settings');
  await page.locator('.acc-head').filter({ has: page.locator('.acc-head-name', { hasText: /^Bank$/ }) }).click();
  await page.click('#acc-detail .btn-merge');
  await page.locator('#acc-detail .merge-option', { hasText: 'Bank old' }).click();
  await page.click('#acc-detail .merge-actions .btn-crypto-ok');
  await expect(page.locator('#acc-detail .rel-row')).toContainText('Old bank PINs');
  await page.click('#btn-save-all');
  await expect.poll(async () => {
    const items = await storedItems(page);
    const login = items.find(i => i.type === 'login');
    return items.filter(i => i.type === 'login').length === 1 && items.find(i => i.type === 'note').links[0] === login.id;
  }).toBe(true);
});
