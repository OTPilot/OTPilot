import { test, expect, seedUnlocked, waitForVault, writeAccounts, TEST_SECRET } from './fixtures.js';
import { installFakeAgents } from './fakeAgents.js';

// 2.1 AI agents (docs/agents/plan.md): approving an agent after checking its
// code, letting it use accounts (copies encrypted for its key, holding only
// the allowed scope), answering its requests, copies following the vault,
// the editor's section and the notices.

const ACCOUNTS = [
  { name: 'GitHub', email: 'me@gh.io', password: 'gh-pass', secret: TEST_SECRET, urls: 'github.com' },
  { name: 'Bank', email: 'me@bank.io', password: 'bank-pass', urls: 'bank.example' },
];

async function setup(context, extensionId, { free = false } = {}) {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/popup.html`);
  await page.evaluate(() => Promise.all([chrome.storage.local.clear(), chrome.storage.session.clear()]));
  await seedUnlocked(page, { accounts: [], userPlan: free ? 'free' : 'personal', obfuscated: false, cloudSession: { user: { id: 'user-me' }, access_token: 't', expires_at: 4102444800000 } });
  await page.reload();
  await waitForVault(page);
  await writeAccounts(page, ACCOUNTS);
  await page.evaluate(() => { SupabaseAuth.getSession = async () => ({ user: { id: 'user-me' } }); });
  await installFakeAgents(page, { free });
  await page.evaluate(async () => reloadFromVault(await VaultKeys.getKey()));
  return page;
}

const itemId = (page, title) => page.evaluate(async t => (await Agents.vaultItems(await VaultKeys.getKey())).find(i => i.title === t).id, title);

test('the verification code matches the shared test vector', async ({ context, extensionId }) => {
  const page = await setup(context, extensionId);
  const key = 'BAcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=';
  expect(await page.evaluate(k => Agents.code(k), key)).toBe('5ZOI-GAGN');
});

test('approve a pending agent after its code, then let it use a 2FA code only', async ({ context, extensionId }) => {
  const page = await setup(context, extensionId);
  const agent = await page.evaluate(async () => {
    const a = await fakeAgents.addAgent({ name: 'Codex' });
    return { id: a.id, code: await Agents.code(a.public_key) };
  });
  await page.click('#nav-agents');
  const detail = page.locator('#agents-detail');
  await expect(detail).toContainText('Codex wants to connect');
  await expect(detail.locator('.code')).toHaveText(agent.code);
  await detail.getByRole('button', { name: 'Codes match · Connect' }).click();

  // Connected: the add-account picker opens; GitHub, 2FA only.
  await expect(page.locator('#agents-list')).toContainText('Connected');
  await detail.locator('.ag-pick button', { hasText: 'GitHub' }).click();
  await expect(detail.locator('.ag-scope')).toHaveValue('2fa');
  await detail.getByRole('button', { name: 'Allow' }).click();
  await expect(detail.locator('.ag-card-row', { hasText: 'GitHub' })).toContainText('2FA code');

  const copy = await page.evaluate(async ({ id, item }) => fakeAgents.openGrant(id, item), { id: agent.id, item: await itemId(page, 'GitHub') });
  expect(copy.title).toBe('GitHub');
  expect(copy.totp.secret).toBe(TEST_SECRET);
  expect(copy.fields).toEqual([]); // no username, no password
  const label = await page.evaluate(async ({ id, item }) => fakeAgents.openLabel(id, item), { id: agent.id, item: await itemId(page, 'GitHub') });
  expect([label.title, label.urls, label.totp]).toEqual(['GitHub', ['github.com'], null]);
  expect((await page.evaluate(() => chrome.storage.local.get('agentPins'))).agentPins[agent.id].code).toBe(agent.code);
});

test('denying a pending agent removes it', async ({ context, extensionId }) => {
  const page = await setup(context, extensionId);
  await page.evaluate(() => fakeAgents.addAgent({ name: 'Stranger' }));
  await page.click('#nav-agents');
  await page.locator('#agents-detail').getByRole('button', { name: 'Deny' }).click();
  await expect(page.locator('#agents-detail')).toContainText('Let your AI agents sign in, safely');
  expect(await page.evaluate(() => fakeAgents.agents.size)).toBe(0);
});

test('an agent asking for an account: the match is offered and allowed with its sign-in', async ({ context, extensionId }) => {
  const page = await setup(context, extensionId);
  const agentId = await page.evaluate(async () => {
    const a = await fakeAgents.addAgent({ name: 'Claude Code', status: 'active' });
    await Agents.pin({ id: a.id, public_key: a.public_key });
    fakeAgents.addRequest(a.id, { query: 'bank', reason: 'check the transfer', tool: 'browser_login' });
    return a.id;
  });
  await page.click('#nav-agents');
  const detail = page.locator('#agents-detail');
  await expect(detail).toContainText('Claude Code asks for bank');
  await expect(detail).toContainText('check the transfer');
  await detail.locator('.ag-pick button', { hasText: 'Bank' }).click();
  await expect(detail.locator('.ag-scope')).toHaveValue('login'); // no 2FA on this one
  await detail.getByRole('button', { name: /Allow Bank for Claude Code/ }).click();
  await expect(page.locator('#agents-list')).not.toContainText('asks for');

  const bank = await itemId(page, 'Bank');
  const copy = await page.evaluate(({ a, i }) => fakeAgents.openGrant(a, i), { a: agentId, i: bank });
  expect(copy.fields.map(f => [f.id, f.value])).toEqual([['username', 'me@bank.io'], ['password', 'bank-pass']]);
  expect(await page.evaluate(() => [...fakeAgents.requests.values()][0].status)).toBe('allowed');
});

test('an agent approved on another device has to be checked here before writing copies', async ({ context, extensionId }) => {
  const page = await setup(context, extensionId);
  await page.evaluate(() => fakeAgents.addAgent({ name: 'Cursor', status: 'active' }));
  await page.click('#nav-agents');
  const detail = page.locator('#agents-detail');
  await expect(detail).toContainText('Approved on another device');
  await expect(detail.getByRole('button', { name: '+ Add account' })).toBeDisabled();
  const refused = await page.evaluate(async () => {
    const a = [...fakeAgents.agents.values()][0];
    const item = (await Agents.vaultItems(await VaultKeys.getKey()))[0];
    return Agents.grant(a, item, {}).then(() => 'granted', e => e.message);
  });
  expect(refused).toContain('Check this agent');
  await detail.getByRole('button', { name: 'Codes match' }).click();
  await expect(detail.getByRole('button', { name: '+ Add account' })).toBeEnabled();
});

test('copies follow the vault: an edited password is re-sent, a deleted item loses its grant', async ({ context, extensionId }) => {
  const page = await setup(context, extensionId);
  const agentId = await page.evaluate(async () => {
    const a = await fakeAgents.addAgent({ status: 'active' });
    await Agents.pin(a);
    const key = await VaultKeys.getKey();
    for (const item of await Agents.vaultItems(key)) await Agents.grant(a, item, { scope: { kind: 'login' } });
    return a.id;
  });
  const [gh, bank] = [await itemId(page, 'GitHub'), await itemId(page, 'Bank')];
  // Nothing changed: nothing re-sent.
  expect(await page.evaluate(async () => Agents.syncCopies(await VaultKeys.getKey()))).toBe(0);
  await page.evaluate(async ({ gh, bank }) => {
    const key = await VaultKeys.getKey();
    const item = (await Agents.vaultItems(key)).find(i => i.id === gh);
    Vault.getField(item, 'password').value = 'new-pass';
    await VaultStore.save([{ ...item, updatedAt: new Date().toISOString() }], key);
    await VaultStore.remove([bank]);
  }, { gh, bank });
  expect(await page.evaluate(async () => Agents.syncCopies(await VaultKeys.getKey()))).toBe(1);
  const copy = await page.evaluate(({ a, i }) => fakeAgents.openGrant(a, i), { a: agentId, i: gh });
  expect(copy.fields.find(f => f.id === 'password').value).toBe('new-pass');
  expect(await page.evaluate(a => [...fakeAgents.agents.get(a).grants.keys()], agentId)).toEqual([gh]);
});

test('free plan: the limit shows and a fourth account is refused', async ({ context, extensionId }) => {
  const page = await setup(context, extensionId, { free: true });
  await page.evaluate(async () => {
    const a = await fakeAgents.addAgent({ status: 'active' });
    await Agents.pin(a);
    for (let i = 0; i < 3; i++) a.grants.set(crypto.randomUUID(), { scope: { kind: '2fa' }, commands: [] });
  });
  await page.click('#nav-agents');
  await expect(page.locator('#agents-limit')).toContainText('3 of 3 accounts used');
  const detail = page.locator('#agents-detail');
  await detail.getByRole('button', { name: '+ Add account' }).click();
  await detail.locator('.ag-pick button', { hasText: 'GitHub' }).click();
  await detail.getByRole('button', { name: 'Allow' }).click();
  await expect(detail.locator('.ag-err')).toContainText('one agent use up to 3 accounts');
});

test('the editor lists the agents that can use a login and allows one', async ({ context, extensionId }) => {
  const page = await setup(context, extensionId);
  await page.evaluate(async () => {
    const a = await fakeAgents.addAgent({ name: 'Claude Code', status: 'active' });
    await Agents.pin(a);
  });
  await page.click('#nav-settings');
  await page.locator('#accounts-list .acc-row, #accounts-list .lc-row', { hasText: 'GitHub' }).first().click();
  const section = page.locator('#acc-detail .ag-editor');
  await expect(section).toContainText('No agent can use this account');
  await section.getByRole('button', { name: /Allow \(2FA code\)/ }).click();
  await expect(section.locator('.ag-card-row')).toContainText('Claude Code');
  await section.locator('.ag-x').click();
  await expect(section).toContainText('No agent can use this account');
});

test('agents waiting show in the bell and on the rail', async ({ context, extensionId }) => {
  const page = await setup(context, extensionId);
  await page.evaluate(() => renderNotices({ invites: [], notices: [], agents: { pending: 1, requests: 2 } }));
  await expect(page.locator('#nav-agents-dot')).toBeVisible();
  await expect(page.locator('#notices-count')).toHaveText('3');
  await page.click('#btn-notices');
  await expect(page.locator('#notices-menu')).toContainText('An AI agent wants to connect');
  await expect(page.locator('#notices-menu')).toContainText('asking to use 2 accounts');
  await page.locator('#notices-menu .notice-btn', { hasText: 'Review' }).first().click();
  await expect(page.locator('#agents-panel')).toBeVisible();
});
