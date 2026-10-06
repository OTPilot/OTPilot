import { test, expect } from './fixtures.js';

// vaultMigration.js isn't wired into any page yet, so each test loads it and
// its dependencies into the script-free test page, with clean storage.
async function migrationPage(context, extensionId) {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/test/blank.html`);
  await page.evaluate(() => Promise.all([chrome.storage.local.clear(), chrome.storage.session.clear()]));
  for (const f of ['vault.js', 'vaultCrypto.js', 'vaultKeys.js', 'vaultStore.js', 'vaultMigration.js']) {
    await page.addScriptTag({ url: `chrome-extension://${extensionId}/${f}` });
  }
  return page;
}

const V1_ACCOUNTS = [
  { name: 'GitHub', email: 'a@example.com', secret: 'JBSWY3DPEHPK3PXP', urls: 'github.com', autofill: true, category: 'Work', _updatedAt: '2026-09-01T10:00:00.000Z' },
  { name: 'GitHub', email: 'b@example.com', secret: 'GEZDGNBVGY3TQOJQ', urls: 'github.com', autofill: true, category: '', _updatedAt: '2026-09-02T10:00:00.000Z' },
  { name: 'Namecheap', email: '', secret: 'MFRGGZDFMZTWQ2LK', urls: '', autofill: false, category: 'Hosting' },
];
const V1_TOMBSTONES = { 'Old Bank': '2026-08-01T00:00:00.000Z' };

test('v1 accounts become encrypted vault items; v1 data stays and is backed up', async ({ context, extensionId }) => {
  const page = await migrationPage(context, extensionId);
  const result = await page.evaluate(async ([accounts, tombstones]) => {
    await chrome.storage.local.set({ accounts, tombstones });
    const run = await VaultMigration.migrate();
    const key = await VaultKeys.getKey();
    const { items, failed } = await VaultStore.readAll(key);
    const stored = await chrome.storage.local.get(null);
    return {
      run,
      failed,
      items: items.map(i => [i.title, Vault.getValue(i, 'username'), i.totp.secret]).sort((a, b) => a[1].localeCompare(b[1])),
      v1Accounts: stored.accounts,
      backup: stored.accountsV1Backup.accounts.length,
      v1Tombstones: stored.vaultV1Tombstones,
      meta: { version: stored.vaultMeta.version, count: stored.vaultMeta.count },
      secretsAtRest: JSON.stringify(Object.entries(stored).filter(([k]) => k.startsWith('vi:'))).includes('JBSWY3DP'),
    };
  }, [V1_ACCOUNTS, V1_TOMBSTONES]);

  expect(result.run).toEqual({ status: 'migrated', count: 3 });
  expect(result.failed).toEqual([]);
  // Two accounts with the same name both survive (v1 keyed tombstones by name).
  expect(result.items).toEqual([
    ['Namecheap', '', 'MFRGGZDFMZTWQ2LK'],
    ['GitHub', 'a@example.com', 'JBSWY3DPEHPK3PXP'],
    ['GitHub', 'b@example.com', 'GEZDGNBVGY3TQOJQ'],
  ]);
  expect(result.v1Accounts).toEqual(V1_ACCOUNTS);
  expect(result.backup).toBe(3);
  expect(result.v1Tombstones).toEqual(V1_TOMBSTONES);
  expect(result.meta).toEqual({ version: 2, count: 3 });
  expect(result.secretsAtRest).toBe(false);
});

test('migration runs once, even when called concurrently from two pages', async ({ context, extensionId }) => {
  const p1 = await migrationPage(context, extensionId);
  const p2 = await migrationPage(context, extensionId);
  await p1.evaluate(accounts => chrome.storage.local.set({ accounts }), V1_ACCOUNTS);
  const runs = await Promise.all([p1, p2, p1].map(p => p.evaluate(() => VaultMigration.migrate())));
  const count = await p1.evaluate(async () => Object.keys(await VaultStore.listRecords()).length);
  expect(runs.map(r => r.status).sort()).toEqual(['already', 'already', 'migrated']);
  expect(count).toBe(3);
});

test('a retry after a run that died before finishing does not duplicate items', async ({ context, extensionId }) => {
  const page = await migrationPage(context, extensionId);
  const count = await page.evaluate(async accounts => {
    await chrome.storage.local.set({ accounts });
    // Simulate a run that saved items but died before writing vaultMeta.
    const key = await VaultKeys.init();
    await VaultStore.save(accounts.map(a => Vault.fromV1Account(a)), key);
    await VaultMigration.migrate();
    return Object.keys(await VaultStore.listRecords()).length;
  }, V1_ACCOUNTS);
  expect(count).toBe(3);
});

test('a locked vault is not migrated', async ({ context, extensionId }) => {
  const page = await migrationPage(context, extensionId);
  const result = await page.evaluate(async accounts => {
    await chrome.storage.local.set({ accounts });
    await VaultKeys.init();
    await VaultKeys.setPassword('correct horse');
    await VaultKeys.lock();
    const run = await VaultMigration.migrate();
    return { run, migrated: await VaultMigration.isMigrated(), records: Object.keys(await VaultStore.listRecords()).length };
  }, V1_ACCOUNTS);
  expect(result).toEqual({ run: { status: 'locked' }, migrated: false, records: 0 });
});

test('an empty account list migrates to an empty vault', async ({ context, extensionId }) => {
  const page = await migrationPage(context, extensionId);
  const run = await page.evaluate(() => VaultMigration.migrate());
  expect(run).toEqual({ status: 'migrated', count: 0 });
});
