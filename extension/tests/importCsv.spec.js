import { test, expect, seedUnlocked, waitForVault, writeAccounts, TEST_SECRET } from './fixtures.js';

// Importing logins from other password managers' CSV exports (importers.js
// + Settings → From a password manager).

async function lib(context, extensionId) {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/test/blank.html`);
  await page.addScriptTag({ url: `chrome-extension://${extensionId}/vault.js` });
  await page.addScriptTag({ url: `chrome-extension://${extensionId}/importers.js` });
  return page;
}

const parse = (page, csv) => page.evaluate(text => Importers.parse(text), csv);

test('CSV parsing: quotes, escaped quotes, commas and newlines inside fields, CRLF, BOM', async ({ context, extensionId }) => {
  const page = await lib(context, extensionId);
  const rows = await page.evaluate(() => Importers.parseCsv('﻿a,b,c\r\n"x, y","say ""hi""","line1\nline2"\r\n\r\n1,,3'));
  expect(rows).toEqual([['a', 'b', 'c'], ['x, y', 'say "hi"', 'line1\nline2'], ['1', '', '3']]);
});

test('each manager\'s export maps to logins', async ({ context, extensionId }) => {
  const page = await lib(context, extensionId);

  const chrome = await parse(page, 'name,url,username,password,note\nGitHub,https://github.com/login,me@x.com,pw1,hello\n');
  expect(chrome.source).toBe('Chrome');
  expect(chrome.entries).toEqual([{ title: 'GitHub', urls: ['github.com'], username: 'me@x.com', password: 'pw1', notes: 'hello', totp: '', tag: '' }]);

  const bitwarden = await parse(page, [
    'folder,favorite,type,name,notes,fields,reprompt,login_uri,login_username,login_password,login_totp',
    `Work,,login,AWS,,,0,"https://console.aws.amazon.com,https://aws.amazon.com",admin,pw2,otpauth://totp/AWS:admin?secret=${'JBSWY3DPEHPK3PXP'}&issuer=AWS`,
    ',,note,Wifi,the code is 1234,,0,,,,',
  ].join('\n'));
  expect(bitwarden.source).toBe('Bitwarden');
  expect(bitwarden.notes).toBe(1);
  expect(bitwarden.entries).toEqual([{ title: 'AWS', urls: ['console.aws.amazon.com', 'aws.amazon.com'], username: 'admin', password: 'pw2', notes: '', totp: 'JBSWY3DPEHPK3PXP', tag: 'Work' }]);

  const onePassword = await parse(page, 'Title,Url,Username,Password,OTPAuth,Favorite,Archived,Tags,Notes\nStripe,dashboard.stripe.com,ops@x.com,pw3,,false,false,Finance,\n');
  expect(onePassword.source).toBe('1Password');
  expect(onePassword.entries[0]).toMatchObject({ title: 'Stripe', urls: ['dashboard.stripe.com'], tag: 'Finance' });

  const lastpass = await parse(page, 'url,username,password,totp,extra,name,grouping,fav\nhttps://namecheap.com,me,pw4,JBSW Y3DP EHPK 3PXP,,Namecheap,Domains,0\nhttp://sn,,,,secret note,Note,,0\n');
  expect(lastpass.source).toBe('LastPass');
  expect(lastpass.notes).toBe(1);
  expect(lastpass.entries[0]).toMatchObject({ title: 'Namecheap', urls: ['namecheap.com'], totp: 'JBSWY3DPEHPK3PXP', tag: 'Domains' });

  const keepass = await parse(page, '"Group","Title","Username","Password","URL","Notes","TOTP"\n"Root/Email","Fastmail","me","pw5","https://app.fastmail.com","",""\n');
  expect(keepass.source).toBe('KeePass');
  expect(keepass.entries[0]).toMatchObject({ title: 'Fastmail', tag: 'Email' });

  const firefox = await parse(page, '"url","username","password","httpRealm","formActionOrigin","guid","timeCreated","timeLastUsed","timePasswordChanged"\n"https://www.reddit.com","me","pw6",,"https://www.reddit.com","{x}","1","1","1"\n');
  expect(firefox.source).toBe('Firefox');
  expect(firefox.entries[0]).toMatchObject({ title: 'www.reddit.com', urls: ['www.reddit.com'], password: 'pw6' });
});

test('rows without a password (or 2FA secret) and non-web URIs are skipped; a file with no password column is refused', async ({ context, extensionId }) => {
  const page = await lib(context, extensionId);
  const r = await parse(page, 'name,url,username,password\nApp,android://com.app,me,pw\nEmpty,https://x.com,me,\n');
  expect(r.invalid).toBe(1);
  expect(r.entries).toEqual([{ title: 'App', urls: [], username: 'me', password: 'pw', notes: '', totp: '', tag: '' }]);
  await expect(page.evaluate(() => Importers.parse('name,url\nA,b.com\n'))).rejects.toThrow('No password column found');
});

test('planning: a password for an existing 2FA-only login is merged into it; an identical login is skipped', async ({ context, extensionId }) => {
  const page = await lib(context, extensionId);
  const r = await page.evaluate(() => {
    const twofa = Vault.newItem('login', { title: 'GitHub', urls: ['github.com'], totp: { secret: 'JBSWY3DPEHPK3PXP' } });
    Vault.getField(twofa, 'username').value = 'Me@X.com';
    const saved = Vault.newItem('login', { title: 'AWS', urls: ['aws.amazon.com'] });
    Vault.getField(saved, 'username').value = 'admin';
    Vault.getField(saved, 'password').value = 'pw2';
    const entries = [
      { title: 'GitHub', urls: ['github.com'], username: 'me@x.com', password: 'gh', notes: 'n', totp: '', tag: '' },
      { title: 'AWS', urls: ['console.aws.amazon.com'], username: 'admin', password: 'pw2', notes: '', totp: '', tag: '' },
      { title: 'GitHub 2', urls: ['github.com'], username: 'other', password: 'x', notes: '', totp: '', tag: '' },
    ];
    const items = [twofa, saved];
    const plans = Importers.plan(entries, items);
    const out = Importers.toItems(entries, plans, items, [0, 1, 2]);
    return {
      plans: plans.map(p => p.action),
      out: out.map(i => ({ same: i.id === twofa.id, title: i.title, pw: Vault.getValue(i, 'password'), secret: i.totp?.secret || '', notes: i.notes })),
    };
  });
  expect(r.plans).toEqual(['merge', 'exists', 'new']);
  expect(r.out).toEqual([
    { same: true, title: 'GitHub', pw: 'gh', secret: 'JBSWY3DPEHPK3PXP', notes: 'n' },
    { same: false, title: 'GitHub 2', pw: 'x', secret: '', notes: '' },
  ]);
});

async function popupWith(context, extensionId, accounts, local = {}) {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/popup.html`);
  await page.evaluate(() => Promise.all([chrome.storage.local.clear(), chrome.storage.session.clear()]));
  await seedUnlocked(page, { accounts: [], ...local });
  await page.reload();
  await waitForVault(page);
  if (accounts.length) await writeAccounts(page, accounts);
  await page.reload();
  await page.click('#nav-config');
  await page.click('#row-settings-csv-import');
  return page;
}

const csvFile = text => ({ name: 'passwords.csv', mimeType: 'text/csv', buffer: Buffer.from(text) });

test('Settings import: review, then the logins land in the vault and the account list', async ({ context, extensionId }) => {
  const page = await popupWith(context, extensionId, [{ name: 'GitHub', email: 'me@x.com', secret: TEST_SECRET, urls: 'github.com' }]);
  await page.setInputFiles('#csv-import-file', csvFile([
    'name,url,username,password,note',
    'GitHub,https://github.com,me@x.com,gh-pass,',
    'Netflix,https://www.netflix.com,tv@x.com,nf-pass,shared with family',
  ].join('\n')));
  await expect(page.locator('#csv-import-status')).toContainText('Chrome: 2 logins found');
  const rows = page.locator('#csv-import-list .export-acc-row');
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toContainText('adds password to GitHub');

  await page.click('#csv-import-confirm');
  await expect(page.locator('#csv-import-status')).toContainText('Imported 1 login, added 1 password to existing logins.');
  const items = await page.evaluate(async () => (await VaultStore.readAll(await VaultKeys.getKey())).items
    .map(i => [i.title, Vault.getValue(i, 'password'), i.totp?.secret || '', i.notes]).sort());
  expect(items).toEqual([
    ['GitHub', 'gh-pass', 'JBSWY3DPEHPK3PXP', ''],
    ['Netflix', 'nf-pass', '', 'shared with family'],
  ]);
  // The locked-vault index and the account list know the new login.
  expect((await page.evaluate(() => VaultAccounts.readIndex())).map(e => e.name).sort()).toEqual(['GitHub', 'Netflix']);
  await page.click('#nav-settings');
  await expect(page.locator('.acc-row')).toHaveCount(2);

  // Importing the same file again finds nothing new.
  await page.click('#nav-config');
  await page.click('#row-settings-csv-import');
  await page.setInputFiles('#csv-import-file', csvFile('name,url,username,password\nGitHub,https://github.com,me@x.com,gh-pass\n'));
  await expect(page.locator('#csv-import-list .export-acc-row')).toContainText('already in vault');
});

test('Settings import respects the Free plan limit', async ({ context, extensionId }) => {
  const full = Array.from({ length: 49 }, (_, i) => ({ name: `S${i}`, email: '', secret: '', urls: `s${i}.example`, password: 'x' }));
  const page = await popupWith(context, extensionId, full, { userPlan: 'free' });
  await page.setInputFiles('#csv-import-file', csvFile('name,url,username,password\nA,a.com,u,p\nB,b.com,u,p\n'));
  await page.click('#csv-import-confirm');
  await expect(page.locator('#csv-import-status')).toContainText('select at most 1 more');
  expect(await page.evaluate(async () => (await VaultStore.readAll(await VaultKeys.getKey())).items.length)).toBe(49);

  await page.locator('#csv-import-list input').nth(1).uncheck();
  await page.click('#csv-import-confirm');
  await expect(page.locator('#csv-import-status')).toContainText('Imported 1 login');
});
