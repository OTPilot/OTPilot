import { test, expect, seedUnlocked, waitForVault, TEST_SECRET } from './fixtures.js';
import { readFileSync } from 'fs';

// The encrypted backup (Settings → Backup & Restore): v2 carries every item
// with every field, so exporting on one browser and importing on another
// restores the whole vault.

async function vault(context, extensionId) {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/popup.html`);
  await page.evaluate(() => Promise.all([chrome.storage.local.clear(), chrome.storage.session.clear()]));
  await seedUnlocked(page, { accounts: [], userPlan: 'personal' });
  await page.reload();
  await waitForVault(page);
  return page;
}

const snapshot = page => page.evaluate(async () => (await VaultStore.readAll(await VaultKeys.getKey())).items
  .map(i => ({ ...i, position: undefined }))
  .sort((a, b) => a.id.localeCompare(b.id)));

async function seedEverything(page, secret) {
  await page.evaluate(async secret => {
    const key = await VaultKeys.getKey();
    const login = Vault.newItem('login', { title: 'DigitalOcean', urls: ['digitalocean.com'], notes: 'billing: ops', tags: ['Infra', 'cloud'],
      totp: { secret, digits: 6, period: 30, algorithm: 'SHA1' }, passwordHistory: [{ value: 'older', changedAt: '2026-01-01T00:00:00.000Z' }] });
    Vault.getField(login, 'username').value = 'me@example.com';
    Vault.getField(login, 'password').value = 'hunter2';
    const withCustom = { ...login, fields: [...login.fields,
      { id: 'c-1', label: 'API token', value: 'dop_v1', kind: 'password', custom: true },
      { id: 'c-2', label: 'Region', value: 'nyc3', kind: 'text', custom: true }] };
    const server = Vault.newItem('server', { title: 'Prod DB' });
    Vault.getField(server, 'host').value = 'db.internal';
    Vault.getField(server, 'password').value = 'pg-pass';
    const note = Vault.newItem('note', { title: 'Wifi', notes: 'SSID: home\npass: 1234' });
    await VaultStore.save([withCustom, server, note], key);
  }, secret);
}

async function exportBackup(page, password) {
  await page.click('#nav-config');
  await page.click('#row-settings-backup');
  await page.click('#btn-export');
  await expect(page.locator('#export-picker-list .export-acc-row')).toHaveCount(3);
  await page.click('#export-picker-confirm');
  await page.fill('#crypto-password', password);
  const [download] = await Promise.all([page.waitForEvent('download'), page.click('#crypto-confirm')]);
  return readFileSync(await download.path());
}

async function importBackup(page, file, password) {
  await page.setInputFiles('#import-file', { name: 'otpilot-backup.json', mimeType: 'application/json', buffer: file });
  await page.fill('#crypto-password', password);
  await page.click('#crypto-confirm');
  await expect(page.locator('#import-picker')).toBeVisible();
}

test('an exported backup restores every item and field after the vault is gone', async ({ context, extensionId }) => {
  const page = await vault(context, extensionId);
  await seedEverything(page, TEST_SECRET);
  const before = await snapshot(page);
  await page.reload();
  const file = await exportBackup(page, 'backup-pass');
  expect(JSON.parse(file.toString()).v).toBe(2);
  expect(file.toString()).not.toContain('hunter2');

  // Another browser: an empty vault.
  await page.evaluate(() => VaultStore.clear());
  await page.reload();
  await page.click('#nav-config');
  await page.click('#row-settings-backup');
  await importBackup(page, file, 'backup-pass');
  await expect(page.locator('#import-picker-list .export-acc-row')).toHaveCount(3);
  await page.click('#import-picker-confirm');
  await expect(page.locator('#status-msg')).toContainText('3 added');
  expect(await snapshot(page)).toEqual(before);
});

test('importing again: identical items are skipped, an item newer in the backup is updated', async ({ context, extensionId }) => {
  const page = await vault(context, extensionId);
  await seedEverything(page, TEST_SECRET);
  await page.reload();
  const file = await exportBackup(page, 'pw');
  // This vault's server goes back to an older edit; the backup's is newer.
  await page.evaluate(async () => {
    const key = await VaultKeys.getKey();
    const server = (await VaultStore.readAll(key)).items.find(i => i.type === 'server');
    Vault.getField(server, 'host').value = 'stale.internal';
    server.updatedAt = '2020-01-01T00:00:00.000Z';
    await VaultStore.save(server, key);
  });
  await page.reload();
  await page.click('#nav-config');
  await page.click('#row-settings-backup');
  await importBackup(page, file, 'pw');
  await expect(page.locator('#import-picker-list .export-acc-row', { hasText: 'Prod DB' })).toContainText('newer — will update');
  await expect(page.locator('#import-picker-list .export-acc-row', { hasText: 'Wifi' })).toContainText('already in vault');
  await page.click('#import-picker-confirm');
  await expect(page.locator('#status-msg')).toContainText('1 updated');
  const host = await page.evaluate(async () => Vault.getValue((await VaultStore.readAll(await VaultKeys.getKey())).items.find(i => i.type === 'server'), 'host'));
  expect(host).toBe('db.internal');
});

test('a v1 backup (1.x) still imports its accounts', async ({ context, extensionId }) => {
  const page = await vault(context, extensionId);
  const file = await page.evaluate(async secret => {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const key = await deriveKey('old-pass', salt);
    const { iv, data } = await encryptData(key, JSON.stringify([{ name: 'GitHub', email: 'me@example.com', secret, urls: 'github.com' }]));
    return JSON.stringify({ v: 1, salt: b64enc(salt), iv, data });
  }, TEST_SECRET);
  await page.click('#nav-config');
  await page.click('#row-settings-backup');
  await importBackup(page, Buffer.from(file), 'old-pass');
  await page.click('#import-picker-confirm');
  await expect.poll(async () => page.evaluate(async () => (await VaultAccounts.load(await VaultKeys.getKey())).map(a => [a.name, a.secret])))
    .toEqual([['GitHub', TEST_SECRET]]);
});
