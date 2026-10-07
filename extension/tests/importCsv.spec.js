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

  const dashlane = await parse(page, 'username,username2,username3,title,password,note,url,category,otpSecret\nops@x.com,,,Vercel,pw7,team login,https://vercel.com,Work,\n');
  expect(dashlane.source).toBe('Dashlane');
  expect(dashlane.entries).toEqual([{ title: 'Vercel', urls: ['vercel.com'], username: 'ops@x.com', password: 'pw7', notes: 'team login', totp: '', tag: 'Work' }]);

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
    const out = Importers.toItems(entries, plans, items);
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
  await expect(page.locator('#csv-import-status')).toContainText('Imported 1 login, added 1 to existing logins.');
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

// ── Review hardening ─────────────────────────────────────────────────────────

test('a comma inside a URL never becomes another saved host; Bitwarden lists are split', async ({ context, extensionId }) => {
  const page = await lib(context, extensionId);
  const chrome = await parse(page, 'name,url,username,password\nX,"https://example.com/login?next=,other.example",me,pw\n');
  expect(chrome.entries[0].urls).toEqual(['example.com']);
  const bw = await parse(page, 'folder,favorite,type,name,notes,fields,reprompt,login_uri,login_username,login_password,login_totp\n,,login,X,,,0,"https://a.example,https://b.example",me,pw,\n');
  expect(bw.entries[0].urls).toEqual(['a.example', 'b.example']);
});

test('2FA settings OTPilot cannot generate are reported, not imported as wrong codes', async ({ context, extensionId }) => {
  const page = await lib(context, extensionId);
  const r = await parse(page, [
    'Title,Url,Username,Password,OTPAuth,Favorite,Archived,Tags,Notes',
    'Ok,ok.example,me,pw,otpauth://totp/Ok?secret=JBSWY3DPEHPK3PXP,,,,',
    'Eight,e.example,me,pw,otpauth://totp/E?secret=JBSWY3DPEHPK3PXP&digits=8,,,,',
    'Sha256,s.example,me,pw,otpauth://totp/S?secret=JBSWY3DPEHPK3PXP&algorithm=SHA256,,,,',
    'Hotp,h.example,me,pw,otpauth://hotp/H?secret=JBSWY3DPEHPK3PXP&counter=1,,,,',
    'Only,o.example,me,,otpauth://totp/O?secret=JBSWY3DPEHPK3PXP&period=60,,,,',
  ].join('\n'));
  expect(r.unsupportedTotp).toBe(4);
  expect(r.invalid).toBe(1); // nothing left to import on the last row
  expect(r.entries.map(e => [e.title, e.password, e.totp])).toEqual([
    ['Ok', 'pw', 'JBSWY3DPEHPK3PXP'], ['Eight', 'pw', ''], ['Sha256', 'pw', ''], ['Hotp', 'pw', ''],
  ]);
});

test('planning looks at every matching login, keeps folders on merge, and never overwrites a different 2FA secret', async ({ context, extensionId }) => {
  const page = await lib(context, extensionId);
  const r = await page.evaluate(() => {
    const mk = (title, user, pw, secret, tags = []) => {
      const i = Vault.newItem('login', { title, urls: ['site.example'], tags, totp: secret ? { secret } : null });
      Vault.getField(i, 'username').value = user;
      Vault.getField(i, 'password').value = pw;
      return i;
    };
    const items = [mk('First', 'me', 'one', ''), mk('Second', 'me', 'two', ''), mk('Codes', 'ops', '', 'JBSWY3DPEHPK3PXP', ['Work'])];
    const e = (username, password, totp = '', tag = '') => ({ title: 'X', urls: ['site.example'], username, password, notes: '', totp, tag });
    const entries = [e('me', 'two'), e('ops', '', 'GEZDGNBVGY3TQOJQ'), e('ops', '', 'JBSWY3DPEHPK3PXP'), e('ops', 'pw', '', 'Infra')];
    const plans = Importers.plan(entries, items);
    const merged = Importers.toItems([entries[3]], Importers.plan([entries[3]], items), items)[0];
    return { plans: plans.map(p => p.action), mergedTags: merged.tags, mergedPw: Vault.getValue(merged, 'password'), mergedSecret: merged.totp.secret };
  });
  // 'two' is already in Second; a different secret is not merged into Codes; the same secret exists.
  expect(r.plans).toEqual(['exists', 'new', 'exists', 'merge']);
  expect(r).toMatchObject({ mergedTags: ['Work', 'Infra'], mergedPw: 'pw', mergedSecret: 'JBSWY3DPEHPK3PXP' });
});

test('an unchecked row does not take the merge target of a checked one', async ({ context, extensionId }) => {
  const page = await popupWith(context, extensionId, [{ name: 'GitHub', email: 'me@x.com', secret: TEST_SECRET, urls: 'github.com' }]);
  await page.setInputFiles('#csv-import-file', csvFile('name,url,username,password\nGitHub,https://github.com,me@x.com,old-pass\nGitHub,https://github.com,me@x.com,new-pass\n'));
  await expect(page.locator('#csv-import-list .export-acc-row')).toHaveCount(2);
  await page.locator('#csv-import-list input').nth(0).uncheck();
  await page.click('#csv-import-confirm');
  await expect(page.locator('#csv-import-status')).toContainText('Imported 0 logins, added 1 to existing logins.');
  const items = await page.evaluate(async () => (await VaultStore.readAll(await VaultKeys.getKey())).items.map(i => [i.title, Vault.getValue(i, 'password')]));
  expect(items).toEqual([['GitHub', 'new-pass']]);
});

test('a double click on Import imports once', async ({ context, extensionId }) => {
  const page = await popupWith(context, extensionId, []);
  await page.setInputFiles('#csv-import-file', csvFile('name,url,username,password\nA,a.com,u,p\n'));
  await expect(page.locator('#csv-import-list .export-acc-row')).toHaveCount(1);
  await page.evaluate(() => { const b = document.getElementById('csv-import-confirm'); b.click(); b.click(); });
  await expect(page.locator('#csv-import-status')).toContainText('Imported 1 login');
  await page.waitForTimeout(500);
  expect(await page.evaluate(async () => (await VaultStore.readAll(await VaultKeys.getKey())).items.length)).toBe(1);
});

test('planning: exact usernames first; a row\'s missing 2FA secret is added, not skipped', async ({ context, extensionId }) => {
  const page = await lib(context, extensionId);
  const r = await page.evaluate(() => {
    const mk = (title, user, pw, secret) => {
      const i = Vault.newItem('login', { title, urls: ['site.example'], totp: secret ? { secret } : null });
      Vault.getField(i, 'username').value = user;
      Vault.getField(i, 'password').value = pw;
      return i;
    };
    const items = [mk('Upper', 'Alice', '', ''), mk('Lower', 'alice', '', ''), mk('Pw', 'bob', 'same', '')];
    const e = (username, password, totp = '') => ({ title: 'X', urls: ['site.example'], username, password, notes: '', totp, tag: '' });
    const entries = [e('alice', 'p1'), e('bob', 'same', 'JBSWY3DPEHPK3PXP')];
    const plans = Importers.plan(entries, items);
    const out = Importers.toItems(entries, plans, items);
    return { plans: plans.map(p => [p.action, items.find(i => i.id === p.target)?.title]), out: out.map(i => [i.title, Vault.getValue(i, 'password'), i.totp?.secret || '']) };
  });
  expect(r.plans).toEqual([['merge', 'Lower'], ['merge', 'Pw']]);
  expect(r.out).toEqual([['Lower', 'p1', ''], ['Pw', 'same', 'JBSWY3DPEHPK3PXP']]);
});

test('picking another file while a review loads shows only the newer file', async ({ context, extensionId }) => {
  const page = await popupWith(context, extensionId, []);
  await page.evaluate(() => {
    const real = VaultStore.readAll;
    let first = true;
    VaultStore.readAll = async (...a) => { if (first) { first = false; await new Promise(r => setTimeout(r, 600)); } return real(...a); };
  });
  await page.setInputFiles('#csv-import-file', csvFile('name,url,username,password\nOld,old.com,u,p\nOld2,old2.com,u,p\n'));
  await page.setInputFiles('#csv-import-file', csvFile('name,url,username,password\nNew,new.com,u,p\n'));
  await page.waitForTimeout(1000);
  await expect(page.locator('#csv-import-list .export-acc-row')).toHaveCount(1);
  await expect(page.locator('#csv-import-list')).toContainText('New');
});

test('a failed import says so and leaves the vault unchanged', async ({ context, extensionId }) => {
  const page = await popupWith(context, extensionId, []);
  await page.setInputFiles('#csv-import-file', csvFile('name,url,username,password\nA,a.com,u,p\n'));
  await expect(page.locator('#csv-import-list .export-acc-row')).toHaveCount(1);
  await page.evaluate(() => { VaultCrypto.encryptItem = async () => { throw new Error('QUOTA_BYTES quota exceeded'); }; });
  await page.click('#csv-import-confirm');
  await expect(page.locator('#csv-import-status')).toContainText('Import failed — nothing was changed');
  expect(await page.evaluate(async () => (await chrome.storage.local.get(null)) && Object.keys(await chrome.storage.local.get(null)).filter(k => k.startsWith('vi:')).length)).toBe(0);
});
