import { test, expect } from './fixtures.js';

// vault.js isn't wired into any page yet, so each test loads it into a
// blank extension page (same origin, so the extension CSP allows it).
async function vaultPage(context, extensionId) {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/test/blank.html`);
  await page.addScriptTag({ url: `chrome-extension://${extensionId}/vault.js` });
  return page;
}

const V1 = {
  name: 'GitHub',
  email: 'alberto@example.com',
  secret: 'JBSWY3DPEHPK3PXP',
  urls: 'github.com\n *.github.com \n',
  autofill: true,
  category: 'Work',
  domain: 'github.com',
  _updatedAt: '2026-09-01T10:00:00.000Z',
};

test('new items start from their type template', async ({ context, extensionId }) => {
  const page = await vaultPage(context, extensionId);
  const items = await page.evaluate(() => ({
    login: Vault.newItem('login'),
    server: Vault.newItem('server', { title: 'prod-api-01' }),
    note: Vault.newItem('note'),
  }));

  expect(items.login.fields.map(f => f.id)).toEqual(['username', 'password']);
  expect(items.login.autofill).toBe(true);
  expect(items.login.id).toMatch(/^[0-9a-f-]{36}$/);
  expect(items.server.fields.map(f => f.id)).toEqual(['host', 'port', 'username', 'password']);
  expect(items.server.title).toBe('prod-api-01');
  expect(items.server.autofill).toBe(false);
  expect(items.note.fields).toEqual([]);
});

test('unknown types are rejected when creating', async ({ context, extensionId }) => {
  const page = await vaultPage(context, extensionId);
  const error = await page.evaluate(() => {
    try { Vault.newItem('ssh'); return null; } catch (e) { return e.message; }
  });
  expect(error).toBe('unknown item type: ssh');
});

test('a v1 account converts to a v2 login', async ({ context, extensionId }) => {
  const page = await vaultPage(context, extensionId);
  const item = await page.evaluate(acc => Vault.fromV1Account(acc), V1);

  expect(item.type).toBe('login');
  expect(item.title).toBe('GitHub');
  expect(item.fields.find(f => f.id === 'username').value).toBe('alberto@example.com');
  expect(item.fields.find(f => f.id === 'password').value).toBe('');
  expect(item.urls).toEqual(['github.com', '*.github.com']);
  expect(item.tags).toEqual(['Work']);
  expect(item.totp).toEqual({ secret: 'JBSWY3DPEHPK3PXP', digits: 6, period: 30, algorithm: 'SHA1' });
  expect(item.iconDomain).toBe('github.com');
  expect(item.updatedAt).toBe('2026-09-01T10:00:00.000Z');
});

test('v1 → v2 → v1 round-trips for the transition blob', async ({ context, extensionId }) => {
  const page = await vaultPage(context, extensionId);
  const back = await page.evaluate(acc => Vault.toV1Account(Vault.fromV1Account(acc)), V1);
  expect(back).toEqual({ ...V1, urls: 'github.com\n*.github.com' });
});

test('items without a 2FA secret never reach the transition blob', async ({ context, extensionId }) => {
  const page = await vaultPage(context, extensionId);
  const result = await page.evaluate(() => {
    const pwOnly = Vault.newItem('login', { title: 'Netflix' });
    pwOnly.fields.find(f => f.id === 'password').value = 'hunter2';
    return [Vault.toV1Account(pwOnly), Vault.toV1Account(Vault.newItem('server'))];
  });
  expect(result).toEqual([null, null]);
});

test('free limit: only 2FA-only logins are exempt', async ({ context, extensionId }) => {
  const page = await vaultPage(context, extensionId);
  const result = await page.evaluate(acc => {
    const twoFaOnly = Vault.fromV1Account(acc);
    const withPassword = Vault.fromV1Account(acc);
    withPassword.fields.find(f => f.id === 'password').value = 'hunter2';
    const withCustom = Vault.fromV1Account(acc);
    withCustom.fields.push({ id: 'f_1', label: 'PIN', kind: 'hidden', value: '1234', custom: true });
    const withNotes = { ...Vault.fromV1Account(acc), notes: 'recovery codes: 1234 5678' };
    const withHistory = { ...Vault.fromV1Account(acc), passwordHistory: [{ value: 'old', changedAt: '2026-01-01' }] };
    const usernameOnly = Vault.newItem('login', { title: 'Forum' });
    usernameOnly.fields.find(f => f.id === 'username').value = 'alberto';
    return {
      twoFaOnly: Vault.countsForLimit(twoFaOnly),
      withPassword: Vault.countsForLimit(withPassword),
      withCustom: Vault.countsForLimit(withCustom),
      withNotes: Vault.countsForLimit(withNotes),
      withHistory: Vault.countsForLimit(withHistory),
      usernameOnly: Vault.countsForLimit(usernameOnly),
      emptyNote: Vault.countsForLimit(Vault.newItem('note')),
    };
  }, V1);
  expect(result).toEqual({ twoFaOnly: false, withPassword: true, withCustom: true, withNotes: true, withHistory: true, usernameOnly: true, emptyNote: true });
});

test('free users can save up to 50 counted items; 2FA-only logins are never blocked', async ({ context, extensionId }) => {
  const page = await vaultPage(context, extensionId);
  const result = await page.evaluate(acc => {
    const notes = n => Array.from({ length: n }, () => Vault.newItem('note'));
    const twoFa = () => Vault.fromV1Account(acc);
    const full = notes(50);
    return {
      at49: Vault.canSaveItem(notes(49), 'free', Vault.newItem('note')),
      at50: Vault.canSaveItem(full, 'free', Vault.newItem('note')),
      at50PlusManyTwoFa: Vault.canSaveItem([...notes(49), ...Array.from({ length: 80 }, twoFa)], 'free', Vault.newItem('note')),
      twoFaAtCap: Vault.canSaveItem(full, 'free', twoFa()),
      paid: Vault.canSaveItem(notes(500), 'personal', Vault.newItem('note')),
      noPlan: Vault.canSaveItem(full, undefined, Vault.newItem('note')),
      unknownPlan: Vault.canSaveItem(full, 'enterprise', Vault.newItem('note')),
      counted: Vault.countedItems([...notes(3), twoFa()]),
    };
  }, V1);
  expect(result).toEqual({
    at49: true, at50: false, at50PlusManyTwoFa: true, twoFaAtCap: true,
    paid: true, noPlan: false, unknownPlan: false, counted: 3,
  });
});

test('over the free limit, counted items stay editable but 2FA-only logins cannot gain a password', async ({ context, extensionId }) => {
  const page = await vaultPage(context, extensionId);
  const result = await page.evaluate(acc => {
    const items = Array.from({ length: 60 }, () => Vault.newItem('note'));
    const twoFa = Vault.fromV1Account(acc);
    items.push(twoFa);
    const editedNote = { ...items[0], title: 'renamed' };
    const upgraded = structuredClone(twoFa);
    upgraded.fields.find(f => f.id === 'password').value = 'hunter2';
    return {
      editCounted: Vault.canSaveItem(items, 'free', editedNote),
      addPassword: Vault.canSaveItem(items, 'free', upgraded),
    };
  }, V1);
  expect(result).toEqual({ editCounted: true, addPassword: false });
});
