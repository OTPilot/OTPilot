import { test, expect, seedUnlocked, waitForVault, TEST_PASSWORD } from './fixtures.js';

// Export everything as CSV (Settings → Backup & Restore) and its round trip
// through the CSV import.

async function lib(context, extensionId) {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/test/blank.html`);
  await page.addScriptTag({ url: `chrome-extension://${extensionId}/vault.js` });
  await page.addScriptTag({ url: `chrome-extension://${extensionId}/importers.js` });
  return page;
}

const sample = () => {
  const login = Vault.newItem('login', { title: 'GitHub, Inc', urls: ['github.com', 'gist.github.com'], tags: ['Work', 'oss'], notes: 'line 1\nline "2"', totp: { secret: 'JBSWY3DPEHPK3PXP' } });
  Vault.getField(login, 'username').value = 'me@x.com';
  Vault.getField(login, 'password').value = 'p,a"ss';
  const note = Vault.newItem('note', { title: 'Wifi', notes: 'SSID Home', tags: ['Home'] });
  const server = Vault.newItem('server', { title: 'DB' });
  Vault.getField(server, 'host').value = 'db.internal';
  Vault.getField(server, 'password').value = 'secret';
  return [login, note, server];
};

test('the CSV escapes what needs it and reads back as the same logins and notes', async ({ context, extensionId }) => {
  const page = await lib(context, extensionId);
  const r = await page.evaluate(sample => {
    const items = (new Function(`return (${sample})()`))();
    const csv = Importers.toCsv(items);
    const parsed = Importers.parse(csv);
    const back = Importers.toItems(parsed.entries, Importers.plan(parsed.entries, []), []);
    return {
      header: csv.split('\r\n')[0],
      source: parsed.source,
      rows: Importers.parseCsv(csv).length,
      back: back.map(i => ({ type: i.type, title: i.title, urls: i.urls, tags: i.tags, notes: i.notes, user: Vault.getValue(i, 'username'), pw: Vault.getValue(i, 'password'), totp: i.totp?.secret || '' })),
      serverRow: Importers.parseCsv(csv).find(r => r[0] === 'server'),
    };
  }, sample.toString());
  expect(r.header).toBe('type,name,url,username,password,totp,notes,folder,fields');
  expect(r.source).toBe('OTPilot');
  expect(r.rows).toBe(4);
  expect(r.back).toEqual([
    { type: 'login', title: 'GitHub, Inc', urls: ['github.com', 'gist.github.com'], tags: ['Work', 'oss'], notes: 'line 1\nline "2"', user: 'me@x.com', pw: 'p,a"ss', totp: 'JBSWY3DPEHPK3PXP' },
    { type: 'note', title: 'Wifi', urls: [], tags: ['Home'], notes: 'SSID Home', user: '', pw: '', totp: '' },
  ]);
  // Other types keep their fields in the `fields` column.
  expect(r.serverRow[8]).toBe('Host: db.internal\nPassword: secret');
});

test('Settings: the export needs the master password and downloads the whole vault', async ({ context, extensionId }) => {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/popup.html`);
  await page.evaluate(() => Promise.all([chrome.storage.local.clear(), chrome.storage.session.clear()]));
  await seedUnlocked(page, { accounts: [] });
  await page.reload();
  await waitForVault(page);
  await page.evaluate(async s => VaultStore.save((new Function(`return (${s})()`))(), await VaultKeys.getKey()), sample.toString());
  await page.click('#nav-config');
  await page.click('#row-settings-backup');
  await page.click('#btn-export-csv');
  await expect(page.locator('#csv-export-form')).toContainText('plain text');

  await page.fill('#csv-export-password', 'wrong');
  await page.click('#csv-export-confirm');
  await expect(page.locator('#status-msg')).toHaveText('Incorrect password');

  await page.fill('#csv-export-password', TEST_PASSWORD);
  const [download] = await Promise.all([page.waitForEvent('download'), page.click('#csv-export-confirm')]);
  expect(download.suggestedFilename()).toMatch(/^otpilot-export-\d{4}-\d{2}-\d{2}\.csv$/);
  const text = await (await download.createReadStream()).toArray().then(chunks => Buffer.concat(chunks).toString());
  expect(text.split('\r\n')[0]).toBe('type,name,url,username,password,totp,notes,folder,fields');
  expect(text).toContain('db.internal');
  await expect(page.locator('#status-msg')).toContainText('Exported 3 items');
  await expect(page.locator('#csv-export-form')).toBeHidden();
  await expect(page.locator('#csv-export-password')).toHaveValue('');
});
