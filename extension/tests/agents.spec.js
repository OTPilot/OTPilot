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

test("an account added from the agent's page answers its open request", async ({ context, extensionId }) => {
  const page = await setup(context, extensionId);
  const agentId = await page.evaluate(async () => {
    const a = await fakeAgents.addAgent({ name: 'Claude Code', status: 'active' });
    await Agents.pin({ id: a.id, public_key: a.public_key });
    fakeAgents.addRequest(a.id, { query: 'an account to test with' });
    return a.id;
  });
  await page.click('#nav-agents');
  await page.click(`#agents-list .lc-row[data-kind=agent][data-id="${agentId}"]`);
  const detail = page.locator('#agents-detail');
  await expect(detail.locator('.ag-request[data-req]')).toContainText('Asks for an account to test with');
  await detail.getByRole('button', { name: '+ Add account' }).click();
  await detail.locator('.ag-pick button', { hasText: 'Bank' }).click();
  await expect(detail.locator('.ag-answers')).toBeChecked();
  await detail.locator('.ag-adding [data-act=allow]').click();
  await expect(page.locator('#agents-list')).not.toContainText('asks for');
  const req = await page.evaluate(() => [...fakeAgents.requests.values()][0]);
  expect([req.status, req.item_id]).toEqual(['allowed', await itemId(page, 'Bank')]);
});

test('unticking "Answers its request" adds the account and leaves the request waiting', async ({ context, extensionId }) => {
  const page = await setup(context, extensionId);
  const agentId = await page.evaluate(async () => {
    const a = await fakeAgents.addAgent({ name: 'Claude Code', status: 'active' });
    await Agents.pin({ id: a.id, public_key: a.public_key });
    fakeAgents.addRequest(a.id, { query: 'github' });
    return a.id;
  });
  await page.click('#nav-agents');
  await page.click(`#agents-list .lc-row[data-kind=agent][data-id="${agentId}"]`);
  const detail = page.locator('#agents-detail');
  await detail.getByRole('button', { name: '+ Add account' }).click();
  await detail.locator('.ag-pick button', { hasText: 'Bank' }).click();
  await detail.locator('.ag-answers').uncheck();
  await detail.locator('.ag-adding [data-act=allow]').click();
  await expect(detail.locator('.ag-card-row[data-item]')).toContainText('Bank');
  expect(await page.evaluate(() => [...fakeAgents.requests.values()][0].status)).toBe('pending');
  await expect(page.locator('#agents-list')).toContainText('asks for github');
});

test('a request answered elsewhere meanwhile still leaves the account added', async ({ context, extensionId }) => {
  const page = await setup(context, extensionId);
  const agentId = await page.evaluate(async () => {
    const a = await fakeAgents.addAgent({ name: 'Claude Code', status: 'active' });
    await Agents.pin({ id: a.id, public_key: a.public_key });
    fakeAgents.addRequest(a.id, { query: 'bank' });
    return a.id;
  });
  await page.click('#nav-agents');
  await page.click(`#agents-list .lc-row[data-kind=agent][data-id="${agentId}"]`);
  const detail = page.locator('#agents-detail');
  await detail.getByRole('button', { name: '+ Add account' }).click();
  await detail.locator('.ag-pick button', { hasText: 'Bank' }).click();
  await page.evaluate(() => { [...fakeAgents.requests.values()][0].status = 'denied'; }); // answered on another device
  await detail.locator('.ag-adding [data-act=allow]').click();
  await expect(detail.locator('.ag-card-row[data-item]')).toContainText('Bank');
  await expect(detail.locator('.ag-err')).toHaveCount(0);
});

test('a request that fails to be answered stays pending and the page says so', async ({ context, extensionId }) => {
  const page = await setup(context, extensionId);
  const agentId = await page.evaluate(async () => {
    const a = await fakeAgents.addAgent({ name: 'Claude Code', status: 'active' });
    await Agents.pin({ id: a.id, public_key: a.public_key });
    fakeAgents.addRequest(a.id, { query: 'bank' });
    return a.id;
  });
  await page.click('#nav-agents');
  await page.click(`#agents-list .lc-row[data-kind=agent][data-id="${agentId}"]`);
  const detail = page.locator('#agents-detail');
  await detail.getByRole('button', { name: '+ Add account' }).click();
  await detail.locator('.ag-pick button', { hasText: 'Bank' }).click();
  await page.evaluate(() => { const real = Agents.answer; Agents.answer = async () => { Agents.answer = real; throw Object.assign(new Error('agents 503'), { status: 503 }); }; });
  await detail.locator('.ag-adding [data-act=allow]').click();
  await expect(detail.locator('.ag-card-row[data-item]')).toContainText('Bank');
  await expect(detail.locator('.ag-err')).toContainText("Bank is added, but its request couldn't be answered");
  await expect(page.locator('#agents-list')).toContainText('asks for bank');
});

test('Review on the agent page opens its request', async ({ context, extensionId }) => {
  const page = await setup(context, extensionId);
  const agentId = await page.evaluate(async () => {
    const a = await fakeAgents.addAgent({ name: 'Claude Code', status: 'active' });
    await Agents.pin({ id: a.id, public_key: a.public_key });
    fakeAgents.addRequest(a.id, { query: 'bank' });
    return a.id;
  });
  await page.click('#nav-agents');
  await page.click(`#agents-list .lc-row[data-kind=agent][data-id="${agentId}"]`);
  await page.locator('#agents-detail').getByRole('button', { name: 'Review' }).click();
  await expect(page.locator('#agents-detail')).toContainText('Claude Code asks for bank');
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

test('a grant follows its item to the new id sync gave it (Free, all slots used)', async ({ context, extensionId }) => {
  const page = await setup(context, extensionId, { free: true });
  const agentId = await page.evaluate(async () => {
    const a = await fakeAgents.addAgent({ status: 'active' });
    await Agents.pin(a);
    const key = await VaultKeys.getKey();
    const item = (await Agents.vaultItems(key)).find(i => i.title === 'GitHub');
    await Agents.grant(a, item, { scope: { kind: 'login' }, commands: ['gh'] });
    for (let i = 0; i < 2; i++) a.grants.set(crypto.randomUUID(), { scope: { kind: '2fa' }, commands: [], revision: 0 });
    // Sync moved it to a new id (its old one was another account's).
    const fresh = crypto.randomUUID();
    await VaultStore.save([{ ...item, id: fresh }], key);
    await (await VaultStore.transaction(tx => tx.drop(item.id)));
    await chrome.storage.local.set({ vaultRemapped: { [item.id]: fresh } });
    return a.id;
  });
  expect(await page.evaluate(async () => Agents.syncCopies(await VaultKeys.getKey()))).toBe(1);
  const grants = await page.evaluate(a => [...fakeAgents.agents.get(a).grants.entries()].map(([id, g]) => [id, g.commands]), agentId);
  expect(grants).toHaveLength(3);
  const gh = grants.find(([, c]) => c[0] === 'gh');
  expect(await page.evaluate(async id => !!(await VaultStore.get(id, await VaultKeys.getKey())), gh[0])).toBe(true);
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

test('a widened or extra grant from the server is never encrypted to the agent', async ({ context, extensionId }) => {
  const page = await setup(context, extensionId);
  const result = await page.evaluate(async () => {
    const a = await fakeAgents.addAgent({ status: 'active' });
    await Agents.pin(a);
    const key = await VaultKeys.getKey();
    const [gh, bank] = await Agents.vaultItems(key).then(items => [items.find(i => i.title === 'GitHub'), items.find(i => i.title === 'Bank')]);
    await Agents.grant(a, gh, { scope: { kind: '2fa' } });
    // The server lies: GitHub widened to its sign-in, Bank added.
    const before = a.grants.get(gh.id).record;
    a.grants.get(gh.id).scope = { kind: 'login' };
    a.grants.set(bank.id, { scope: { kind: 'login' }, commands: [], record: null });
    const written = await Agents.syncCopies(key);
    return { written, same: a.grants.get(gh.id).record === before, bank: a.grants.get(bank.id).record };
  });
  expect(result).toEqual({ written: 0, same: true, bank: null });
});

test('a grant for an item this device never had is left alone', async ({ context, extensionId }) => {
  const page = await setup(context, extensionId);
  const kept = await page.evaluate(async () => {
    const a = await fakeAgents.addAgent({ status: 'active' });
    await Agents.pin(a);
    const other = crypto.randomUUID();
    a.grants.set(other, { scope: { kind: '2fa' }, commands: [] });
    await chrome.storage.local.set({ agentsApproved: { [`${a.id}:${other}`]: { kind: '2fa' } } });
    await Agents.syncCopies(await VaultKeys.getKey());
    return a.grants.has(other);
  });
  expect(kept).toBe(true);
});

test('a server item offered to an agent defaults to its own fields', async ({ context, extensionId }) => {
  const page = await setup(context, extensionId);
  const scope = await page.evaluate(() => {
    const item = Vault.newItem('server', { title: 'Box' });
    item.fields.find(f => f.kind === 'password' || f.id === 'password').value = 'pw';
    return Agents.defaultScope(item);
  });
  expect(scope.kind).toBe('fields');
  expect(scope.parts.length).toBeGreaterThan(0);
});

test('approvals written at the same time are all kept', async ({ context, extensionId }) => {
  const page = await setup(context, extensionId);
  const n = await page.evaluate(async () => {
    const a = await fakeAgents.addAgent({ status: 'active' });
    await Agents.pin(a);
    const items = await Agents.vaultItems(await VaultKeys.getKey());
    await Promise.all(items.map(i => Agents.grant(a, i, { scope: { kind: 'login' } })));
    return Object.keys((await chrome.storage.local.get('agentsApproved')).agentsApproved).length;
  });
  expect(n).toBe(2);
});

test('an expired account is renewed in place, with its settings', async ({ context, extensionId }) => {
  const page = await setup(context, extensionId);
  const agentId = await page.evaluate(async () => {
    const a = await fakeAgents.addAgent({ name: 'Claude Code', status: 'active' });
    await Agents.pin(a);
    const item = (await Agents.vaultItems(await VaultKeys.getKey())).find(i => i.title === 'GitHub');
    await Agents.grant(a, item, { scope: { kind: 'login' }, expiresAt: new Date(Date.now() - 60e3).toISOString(), commands: ['gh'] });
    return a.id;
  });
  await page.click('#nav-agents');
  await page.click(`#agents-list .lc-row[data-kind=agent][data-id="${agentId}"]`);
  const detail = page.locator('#agents-detail');
  await expect(detail).toContainText('expired');
  await detail.getByRole('button', { name: 'Renew' }).first().click();
  await expect(detail.locator('.ag-duration')).toHaveValue('1h');
  await expect(detail.locator('.ag-commands')).toHaveValue('gh');
  await detail.locator('.ag-adding').getByRole('button', { name: 'Renew' }).click();
  await expect(detail).toContainText('1 h left');
  const g = await page.evaluate(id => [...fakeAgents.agents.get(id).grants.values()][0], agentId);
  expect(g.commands).toEqual(['gh']);
  expect(new Date(g.expires_at).getTime()).toBeGreaterThan(Date.now());
});

test('the Agents view picks up a new request on its own, and never redraws over a form opened mid-refresh', async ({ context, extensionId }) => {
  test.setTimeout(60_000); // waits for the 10 s refresh
  const page = await setup(context, extensionId);
  const agentId = await page.evaluate(async () => {
    const a = await fakeAgents.addAgent({ name: 'Claude Code', status: 'active' });
    await Agents.pin(a);
    // Lets the test hold a redraw halfway (after the list is fetched).
    const orig = Agents.vaultItems;
    Agents.vaultItems = async k => {
      if (window.__hold) { window.__paused = true; await new Promise(r => { window.__release = r; }); }
      return orig(k);
    };
    return a.id;
  });
  await page.click('#nav-agents');
  await page.click(`#agents-list .lc-row[data-kind=agent][data-id="${agentId}"]`);
  const detail = page.locator('#agents-detail');
  await page.evaluate(a => { window.__hold = true; fakeAgents.addRequest(a, { query: 'bank' }); }, agentId);
  // The timer's redraw is now held halfway; the user opens a form meanwhile.
  await page.waitForFunction(() => window.__paused, null, { timeout: 15_000 });
  await detail.getByRole('button', { name: '+ Add account' }).click();
  await expect(detail.locator('.ag-adding .ag-picker')).toBeVisible();
  await page.evaluate(() => { window.__hold = false; window.__release(); });
  await page.waitForTimeout(1000);
  await expect(detail.locator('.ag-adding .ag-picker')).toBeVisible(); // the form stayed
  await detail.getByRole('button', { name: 'Cancel' }).click();
  await expect(detail).toContainText('Asks for bank', { timeout: 15_000 });
});
