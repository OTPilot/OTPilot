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
      otherTypes: parsed.otherTypes,
      rows: Importers.parseCsv(csv).length,
      back: back.map(i => ({ type: i.type, title: i.title, urls: i.urls, tags: i.tags, notes: i.notes, user: Vault.getValue(i, 'username'), pw: Vault.getValue(i, 'password'), totp: i.totp?.secret || '' })),
      serverRow: Importers.parseCsv(csv).find(r => r[0] === 'server'),
    };
  }, sample.toString());
  expect(r.header).toBe('type,name,url,username,password,totp,notes,folder,fields');
  expect(r.source).toBe('OTPilot');
  expect(r.otherTypes).toBe(1); // the server: reported, not imported as a login
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

// ── Review hardening ─────────────────────────────────────────────────────────

test('the round trip is exact: password-less logins, tags with separators, untrimmed notes, dotless hosts, hex secrets', async ({ context, extensionId }) => {
  const page = await lib(context, extensionId);
  await page.addScriptTag({ url: `chrome-extension://${extensionId}/totp.js` });
  const r = await page.evaluate(async () => {
    const plain = Vault.newItem('login', { title: 'Router', urls: ['router', '*.lan'], tags: ['client;x', 'back\\slash', 'ok'] });
    Vault.getField(plain, 'username').value = 'admin';
    const note = Vault.newItem('note', { title: 'Spaces', notes: '  indented\n\ntrailing  \n' });
    const hex = Vault.newItem('login', { title: 'Hex', totp: { secret: '3132333435363738393031323334353637383930' } });
    Vault.getField(hex, 'password').value = 'pw';
    const csv = Importers.toCsv([plain, note, hex]);
    const parsed = Importers.parse(csv);
    const back = Importers.toItems(parsed.entries, Importers.plan(parsed.entries, []), []);
    const byTitle = Object.fromEntries(back.map(i => [i.title, i]));
    return {
      invalid: parsed.invalid,
      router: { urls: byTitle.Router.urls, tags: byTitle.Router.tags, user: Vault.getValue(byTitle.Router, 'username') },
      notes: byTitle.Spaces.notes,
      hexSecret: byTitle.Hex.totp.secret,
      sameCode: (await generateTOTP(byTitle.Hex.totp.secret)) === (await generateTOTP(hex.totp.secret)),
    };
  });
  expect(r.invalid).toBe(0);
  expect(r.router).toEqual({ urls: ['router', '*.lan'], tags: ['client;x', 'back\\slash', 'ok'], user: 'admin' });
  expect(r.notes).toBe('  indented\n\ntrailing  \n');
  expect(r.hexSecret).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
  expect(r.sameCode).toBe(true);
});

async function backupView(context, extensionId) {
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
  return page;
}

test('cancelling while the export checks the password downloads nothing and clears the password', async ({ context, extensionId }) => {
  const page = await backupView(context, extensionId);
  await page.evaluate(() => {
    const real = VaultLock.revealRecoveryKey;
    VaultLock.revealRecoveryKey = async (...a) => { await new Promise(r => setTimeout(r, 500)); return real(...a); };
  });
  let downloads = 0;
  page.on('download', () => { downloads++; });
  await page.fill('#csv-export-password', TEST_PASSWORD);
  await page.click('#csv-export-confirm');
  await page.click('#csv-export-cancel');
  await page.waitForTimeout(1200);
  expect(downloads).toBe(0);
  // Reopening the form (also after closing it with its own button) never shows an old password.
  await page.click('#btn-export-csv');
  await expect(page.locator('#csv-export-password')).toHaveValue('');
  await page.fill('#csv-export-password', 'typed');
  await page.click('#btn-export-csv');
  await page.click('#btn-export-csv');
  await expect(page.locator('#csv-export-password')).toHaveValue('');
});

test('a double click exports once; an unreadable vault says so', async ({ context, extensionId }) => {
  const page = await backupView(context, extensionId);
  let downloads = 0;
  page.on('download', () => { downloads++; });
  await page.fill('#csv-export-password', TEST_PASSWORD);
  await page.evaluate(() => { const b = document.getElementById('csv-export-confirm'); b.click(); b.click(); });
  await expect(page.locator('#status-msg')).toContainText('Exported 3 items');
  await page.waitForTimeout(500);
  expect(downloads).toBe(1);

  // Every record unreadable (encrypted under another key).
  await page.evaluate(async () => {
    await VaultStore.clear();
    await VaultStore.save(Vault.newItem('note', { title: 'x' }), VaultCrypto.b64e(VaultCrypto.generateKey()));
  });
  await page.click('#btn-export-csv');
  await page.fill('#csv-export-password', TEST_PASSWORD);
  await page.click('#csv-export-confirm');
  await expect(page.locator('#status-msg')).toHaveText('Could not export: 1 unreadable item');
});

test('re-importing an export into the same vault finds every login (hex secrets, URLs with path/port)', async ({ context, extensionId }) => {
  const page = await lib(context, extensionId);
  const plans = await page.evaluate(() => {
    const hex = Vault.newItem('login', { title: 'Hex', urls: ['https://example.com/login'], totp: { secret: '3132333435363738393031323334353637383930' } });
    Vault.getField(hex, 'username').value = 'me';
    const port = Vault.newItem('login', { title: 'Admin', urls: ['example.org:8080'] });
    Vault.getField(port, 'username').value = 'root';
    Vault.getField(port, 'password').value = 'pw';
    const items = [hex, port];
    const parsed = Importers.parse(Importers.toCsv(items));
    return Importers.plan(parsed.entries, items).map(p => p.action);
  });
  expect(plans).toEqual(['exists', 'exists']);
});

test('OTPilot exports keep short 2FA secrets, and a login saved with the URL http://sn stays a login', async ({ context, extensionId }) => {
  const page = await lib(context, extensionId);
  const back = await page.evaluate(() => {
    const short = Vault.newItem('login', { title: 'Short', totp: { secret: 'JBSWY3DP' } });
    Vault.getField(short, 'password').value = 'pw';
    const sn = Vault.newItem('login', { title: 'SN box', urls: ['http://sn'] });
    Vault.getField(sn, 'username').value = 'admin';
    Vault.getField(sn, 'password').value = 'pw';
    const parsed = Importers.parse(Importers.toCsv([short, sn]));
    return parsed.entries.map(e => [e.type, e.title, e.totp, e.username, e.urls]);
  });
  expect(back).toEqual([['login', 'Short', 'JBSWY3DP', '', []], ['login', 'SN box', '', 'admin', ['http://sn']]]);
});
