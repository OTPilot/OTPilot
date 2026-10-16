import { test, expect, seedUnlocked, waitForVault, writeAccounts } from './fixtures.js';
import { readFileSync } from 'fs';

// Files in the vault (popup): Secure file and SSH key items, a file added
// from "+ Add → From a file…" or dropped on the vault (recognized by
// FileKinds), a File custom field on any item, the per-item size limit, and
// files on Home.

async function vault(context, extensionId, { accounts = [] } = {}) {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/popup.html`);
  await page.evaluate(() => Promise.all([chrome.storage.local.clear(), chrome.storage.session.clear()]));
  await seedUnlocked(page, { accounts: [] });
  await page.reload();
  await waitForVault(page);
  if (accounts.length) await writeAccounts(page, accounts);
  await page.reload();
  await page.click('#nav-settings');
  return page;
}

const stored = page => page.evaluate(async () => (await VaultStore.readAll(await VaultKeys.getKey())).items
  .map(i => ({
    type: i.type, title: i.title,
    fields: (i.fields || []).map(f => ({ label: f.label, kind: f.kind, value: f.kind === 'file' ? Vault.fileOf(f.value) && { name: Vault.fileOf(f.value).name, text: Vault.fileText(Vault.fileOf(f.value)) } : f.value })),
  })));

async function addType(page, label) {
  await page.click('#btn-add');
  await page.click(`#add-type-menu .add-type:text-is("${label}")`);
}

const values = locator => locator.evaluateAll(els => els.map(e => e.value));

const P8 = '-----BEGIN PRIVATE KEY-----\nMIGTAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBHkwdwIBAQQg\n-----END PRIVATE KEY-----\n';

test('a Secure file: choose it, save, then Show / Copy / Download it', async ({ context, extensionId }) => {
  const page = await vault(context, extensionId);
  await addType(page, 'Secure file');
  await page.fill('#acc-detail .item-title', 'Firebase · acme-prod');
  const chooser = page.waitForEvent('filechooser');
  await page.click('#acc-detail .file-choose');
  await (await chooser).setFiles({ name: 'google-services.json', mimeType: 'application/json', buffer: Buffer.from('{"project_info":{"project_id":"acme-prod"}}') });
  const chip = page.locator('#acc-detail .file-chip');
  await expect(chip.locator('.file-name')).toHaveText('google-services.json');
  await expect(chip.locator('.file-size')).toHaveText('43 B · text');
  await page.click('#btn-save-all');
  await expect.poll(() => stored(page)).toEqual([{ type: 'file', title: 'Firebase · acme-prod', fields: [
    { label: 'File', kind: 'file', value: { name: 'google-services.json', text: '{"project_info":{"project_id":"acme-prod"}}' } },
  ] }]);
  // The row shows the file name and size, and search finds it by file name.
  await expect(page.locator('.acc-row .acc-head-email')).toHaveText('google-services.json · 43 B');
  await page.fill('#acc-search', 'google-services');
  await expect(page.locator('.acc-row:visible')).toHaveCount(1);

  await page.locator('.acc-row .acc-head').click();
  await page.click('#acc-detail .file-show');
  await expect(page.locator('#acc-detail .file-preview')).toHaveText('{"project_info":{"project_id":"acme-prod"}}');
  await page.click('#acc-detail .file-copy');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('{"project_info":{"project_id":"acme-prod"}}');
  const download = page.waitForEvent('download');
  await page.click('#acc-detail .file-download');
  const d = await download;
  expect(d.suggestedFilename()).toBe('google-services.json');
  expect(readFileSync(await d.path(), 'utf8')).toBe('{"project_info":{"project_id":"acme-prod"}}');
  await page.screenshot({ path: test.info().outputPath('secure-file.png') });
});

test('From a file…: an Apple .p8 becomes an API credential, or a plain file if asked', async ({ context, extensionId }) => {
  const page = await vault(context, extensionId);
  await page.click('#btn-add');
  await expect(page.locator('#add-type-menu [data-add-type]')).toHaveText(['2FA code', 'Login', 'Secure note', 'Server', 'API credential', 'SSH key', 'Secure file', 'Crypto wallet', 'From a file…']);
  const chooser = page.waitForEvent('filechooser');
  await page.click('#add-type-menu [data-add-type="from-file"]');
  await (await chooser).setFiles({ name: 'AuthKey_2X9R4HXF34.p8', mimeType: '', buffer: Buffer.from(P8) });
  await expect(page.locator('#acc-detail .file-detected')).toContainText('Recognized: Apple .p8 key');
  await expect(page.locator('#acc-detail .item-title')).toHaveValue('Apple API key 2X9R4HXF34');
  expect(await values(page.locator('#acc-detail .cf-row .cf-label'))).toEqual(['Key ID', 'Issuer ID', 'Private key (.p8)']);
  await page.screenshot({ path: test.info().outputPath('p8-detected.png') });
  await page.locator('#acc-detail .cf-row').nth(1).locator('.cf-value').fill('69a6de7f-0000-47e3-e053-5b8c7c11a4d1');
  await page.click('#btn-save-all');
  await expect.poll(() => stored(page)).toEqual([{ type: 'api', title: 'Apple API key 2X9R4HXF34', fields: [
    { label: 'Client ID', kind: 'text', value: '' }, { label: 'Client secret', kind: 'password', value: '' }, { label: 'API key', kind: 'password', value: '' },
    { label: 'Environment', kind: 'text', value: '' }, { label: 'Expires', kind: 'date', value: '' },
    { label: 'Key ID', kind: 'text', value: '2X9R4HXF34' }, { label: 'Issuer ID', kind: 'text', value: '69a6de7f-0000-47e3-e053-5b8c7c11a4d1' },
    { label: 'Private key (.p8)', kind: 'file', value: { name: 'AuthKey_2X9R4HXF34.p8', text: P8 } },
  ] }]);
  // The note is draft-only: reopened, the item has none.
  await page.locator('.acc-row .acc-head').click();
  await expect(page.locator('#acc-detail .file-detected')).toHaveCount(0);

  // Another one, kept as a plain file.
  const chooser2 = page.waitForEvent('filechooser');
  await page.click('#btn-add');
  await page.click('#add-type-menu [data-add-type="from-file"]');
  await (await chooser2).setFiles({ name: 'AuthKey_Q4M81ZZ02P.p8', mimeType: '', buffer: Buffer.from(P8) });
  await page.click('#acc-detail .file-alt:text("Save as a plain file")');
  await expect(page.locator('#acc-detail .item-body')).toHaveAttribute('data-type', 'file');
  await expect(page.locator('#acc-detail .item-title')).toHaveValue('AuthKey_Q4M81ZZ02P');
  await expect(page.locator('#acc-detail .file-name')).toHaveText('AuthKey_Q4M81ZZ02P.p8');
});

test('an .env can be split into hidden fields', async ({ context, extensionId }) => {
  const page = await vault(context, extensionId);
  const chooser = page.waitForEvent('filechooser');
  await page.click('#btn-add');
  await page.click('#add-type-menu [data-add-type="from-file"]');
  await (await chooser).setFiles({ name: '.env.staging', mimeType: '', buffer: Buffer.from('API_URL=https://api.acme.io\n# c\nTOKEN="s3cret"\n') });
  await expect(page.locator('#acc-detail .file-detected')).toContainText('.env file (2 variables)');
  await page.click('#acc-detail .file-alt:text("Split into fields")');
  expect(await values(page.locator('#acc-detail .cf-row .cf-label'))).toEqual(['API_URL', 'TOKEN']);
  await expect(page.locator('#acc-detail .cf-row .cf-value').nth(1)).toHaveAttribute('type', 'password');
  await page.click('#btn-save-all');
  await expect.poll(() => stored(page)).toEqual([{ type: 'note', title: '.env.staging', fields: [
    { label: 'API_URL', kind: 'password', value: 'https://api.acme.io' }, { label: 'TOKEN', kind: 'password', value: 's3cret' },
  ] }]);
});

test('files dropped on the vault become items; one over the limit is refused', async ({ context, extensionId }) => {
  const page = await vault(context, extensionId);
  const drop = (selector, files) => page.evaluate(([selector, files]) => {
    const dt = new DataTransfer();
    for (const f of files) dt.items.add(new File([new Uint8Array(f.size ?? 0).fill(65), f.text ?? ''], f.name));
    const el = document.querySelector(selector);
    el.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true }));
    el.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
  }, [selector, files]);
  await drop('#accounts-list', [{ name: 'notes.txt', text: 'hello' }]);
  await expect(page.locator('#acc-detail .file-detected')).toContainText('Added as a secure file');
  await expect(page.locator('#acc-detail .item-title')).toHaveValue('notes');
  await expect(page.locator('.acc-row')).toHaveCount(1);

  await drop('#accounts-list', [{ name: 'passport-scan.pdf', size: 70 * 1024 }]);
  await expect(page.locator('#status-msg')).toContainText('passport-scan.pdf is 70 KB: an item holds up to 64 KB of files');
  await expect(page.locator('.acc-row')).toHaveCount(1);

  // Dropped on a file field: that field's file (the item's total still counts).
  await addType(page, 'Secure file');
  await drop('#acc-detail .file-field', [{ name: 'a.bin', size: 40 * 1024 }]);
  await expect(page.locator('#acc-detail .file-name')).toHaveText('a.bin');
  await expect(page.locator('.acc-row')).toHaveCount(2);
});

test('a File custom field on a login: saved with the login, listed on Home with Download', async ({ context, extensionId }) => {
  const page = await vault(context, extensionId, { accounts: [{ name: 'Apple Developer', email: 'dev@acme.io', secret: 'JBSWY3DPEHPK3PXP', urls: 'developer.apple.com' }] });
  await page.locator('.acc-row .acc-head').click();
  const chooser = page.waitForEvent('filechooser');
  await page.click('#acc-detail .cf-add-kind[data-kind="file"]');
  await (await chooser).setFiles({ name: 'AuthKey_2X9R4HXF34.p8', mimeType: '', buffer: Buffer.from(P8) });
  await page.locator('#acc-detail .cf-row.cf-file .cf-label').fill('App Store Connect key');
  await expect(page.locator('#acc-detail .cf-row.cf-file .file-name')).toHaveText('AuthKey_2X9R4HXF34.p8');
  // Over the item's limit with the file it already has: refused.
  const chooser2 = page.waitForEvent('filechooser');
  await page.click('#acc-detail .cf-add-kind[data-kind="file"]');
  await (await chooser2).setFiles({ name: 'big.bin', mimeType: '', buffer: Buffer.alloc(64 * 1024 - 10) });
  await expect(page.locator('#status-msg')).toContainText('big.bin is 64 KB');
  await page.click('#btn-save-all');
  await expect.poll(async () => (await stored(page))[0].fields.filter(f => f.kind === 'file'))
    .toEqual([{ label: 'App Store Connect key', kind: 'file', value: { name: 'AuthKey_2X9R4HXF34.p8', text: P8 } }]);

  await page.click('#nav-home');
  await page.locator('#home-list .lc-row', { hasText: 'Apple Developer' }).click();
  const row = page.locator('#home-creds .home-cred', { hasText: 'App Store Connect key' });
  await expect(row.locator('.home-cred-value')).toHaveText('AuthKey_2X9R4HXF34.p8 · 103 B');
  const download = page.waitForEvent('download');
  await row.locator('.home-cred-btn:text("Download")').click();
  expect(readFileSync(await (await download).path(), 'utf8')).toBe(P8);
  // Content scripts never get it.
  const forPage = await page.evaluate(() => new Promise(r => chrome.runtime.sendMessage({ action: 'vaultAccounts' }, r)));
  expect(JSON.stringify(forPage)).not.toContain('PRIVATE KEY');
});

test('an SSH key: generate one, or pick a key file and its public key follows', async ({ context, extensionId }) => {
  const page = await vault(context, extensionId);
  await addType(page, 'SSH key');
  await page.fill('#acc-detail .ssh-gen-comment', 'deploy@acme-api');
  await page.click('#acc-detail .ssh-gen-go');
  await expect(page.locator('#acc-detail .item-title')).toHaveValue('deploy@acme-api');
  await expect(page.locator('#acc-detail .item-field[data-id="publicKey"]')).toHaveValue(/^ssh-ed25519 \S+ deploy@acme-api$/);
  await expect(page.locator('#acc-detail .item-field[data-id="fingerprint"]')).toHaveValue(/^SHA256:/);
  await expect(page.locator('#acc-detail .file-name')).toHaveText('id_ed25519');
  await expect(page.locator('#acc-detail .ssh-gen')).toHaveCount(0);
  await expect(page.locator('#acc-detail .ssh-add-link')).toHaveText(['GitHub ↗', 'GitLab ↗', 'Bitbucket ↗']);
  await page.screenshot({ path: test.info().outputPath('ssh-generated.png') });
  await page.click('#btn-save-all');
  await expect(page.locator('.acc-row .acc-head-email')).toHaveText(/^Ed25519 · SHA256:.{8}…$/);
  const [item] = await stored(page);
  expect(item.type).toBe('ssh');
  expect(item.fields[0].value.text).toMatch(/^-----BEGIN OPENSSH PRIVATE KEY-----/);

  // Generating counts toward the item's files limit too.
  await addType(page, 'SSH key');
  const chooserBig = page.waitForEvent('filechooser');
  await page.click('#acc-detail .cf-add-kind[data-kind="file"]');
  await (await chooserBig).setFiles({ name: 'big.bin', mimeType: '', buffer: Buffer.alloc(64 * 1024 - 100) });
  await expect(page.locator('#acc-detail .cf-row.cf-file .file-name')).toHaveText('big.bin');
  await page.click('#acc-detail .ssh-gen-go');
  await expect(page.locator('#status-msg')).toContainText(/id_ed25519 is \d+ B: an item holds up to 64 KB/);
  await expect(page.locator('#acc-detail .file-choose')).toHaveCount(1); // still no key
  await expect(page.locator('#acc-detail .ssh-gen-go')).toBeEnabled();

  // A key file of its own: public key and fingerprint come from it.
  const other = await page.evaluate(() => SshKeys.generate('ed25519', 'me@laptop'));
  await addType(page, 'SSH key');
  const chooser = page.waitForEvent('filechooser');
  await page.click('#acc-detail .file-choose');
  await (await chooser).setFiles({ name: 'id_ed25519', mimeType: '', buffer: Buffer.from(other.privateKey) });
  await expect(page.locator('#acc-detail .item-field[data-id="publicKey"]')).toHaveValue(other.publicKey);
  await expect(page.locator('#acc-detail .item-field[data-id="fingerprint"]')).toHaveValue(other.fingerprint);
  await expect(page.locator('#acc-detail .item-title')).toHaveValue('me@laptop');
});
