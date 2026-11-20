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

// The view: tabs (Agents / Requests / Activity), an agent's page, sheets.
const openAgent = async (page, id) => {
  await page.click('#nav-agents');
  await page.click(`#agents-detail .ag-row[data-agent="${id}"]`);
};
const sheetOf = page => page.locator('#agents-layer .ag-sheet');
const waitingCount = page => page.locator('.ag-tab[data-tab=requests] .ag-count');
const openMenuItem = async (page, name) => {
  await page.locator('#agents-detail [data-act=menu]').click();
  await page.getByRole('menuitem', { name }).click();
};

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
  // Nothing connected yet: the view opens on the agent waiting.
  await page.click('#nav-agents');
  const detail = page.locator('#agents-detail');
  await expect(detail).toContainText('Codex wants to connect');
  await expect(detail.locator('.code')).toHaveText(agent.code);
  await detail.getByRole('button', { name: 'Codes match · Connect' }).click();

  // Connected: its page, with the add-account sheet open. A login defaults
  // to everything it needs to sign in; here, its 2FA code only.
  await expect(detail).toContainText('What it can use');
  const sheet = sheetOf(page);
  await sheet.locator('.ag-pick button', { hasText: 'GitHub' }).click();
  await expect(sheet.locator('input.ag-scope[value=login]')).toBeChecked();
  await expect(sheet.locator('.ag-opt', { hasText: 'Everything to sign in' })).toContainText('Username, password & 2FA');
  await sheet.locator('input.ag-scope[value="2fa"]').check();
  await sheet.getByRole('button', { name: 'Allow GitHub' }).click();
  await expect(sheetOf(page)).toHaveCount(0);
  await expect(detail.locator('.ag-row[data-item]', { hasText: 'GitHub' })).toContainText('2FA code only');

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
  await page.locator('#agents-detail').getByRole('button', { name: "Codes don't match" }).click();
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
  // An agent connected: the Agents tab says something waits.
  await page.click('#nav-agents');
  const detail = page.locator('#agents-detail');
  await expect(detail.locator('.ag-banner')).toContainText('Something is waiting for you');
  await expect(waitingCount(page)).toHaveText('1');
  await detail.getByRole('button', { name: 'Review' }).click();
  await expect(detail).toContainText('Asks for bank');
  await expect(detail).toContainText('Claude Code');
  await expect(detail).toContainText('check the transfer');
  await detail.locator('.ag-pick button', { hasText: 'Bank' }).click();
  await expect(detail.locator('input.ag-scope[value=login]')).toBeChecked();
  await expect(detail.locator('input.ag-scope[value="2fa"]')).toBeDisabled(); // no 2FA on this one
  await expect(detail.locator('.ag-opt', { hasText: 'Everything to sign in' })).toContainText('Username & password');
  await detail.getByRole('button', { name: /Allow Bank for Claude Code/ }).click();
  // Answered: back on the agent's page, with Bank.
  await expect(waitingCount(page)).toHaveCount(0);
  await expect(detail.locator('.ag-row[data-item]', { hasText: 'Bank' })).toBeVisible();

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
  await openAgent(page, agentId);
  const detail = page.locator('#agents-detail');
  await expect(detail.locator('.ag-banner[data-req]')).toContainText('Asks for an account to test with');
  await detail.getByRole('button', { name: 'Add account' }).click();
  const sheet = sheetOf(page);
  await sheet.locator('.ag-pick button', { hasText: 'Bank' }).click();
  await expect(sheet.locator('.ag-answers')).toBeChecked();
  await sheet.locator('[data-act=allow]').click();
  await expect(waitingCount(page)).toHaveCount(0);
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
  await openAgent(page, agentId);
  const detail = page.locator('#agents-detail');
  await detail.getByRole('button', { name: 'Add account' }).click();
  const sheet = sheetOf(page);
  await sheet.locator('.ag-pick button', { hasText: 'Bank' }).click();
  await sheet.locator('.ag-answers').uncheck();
  await sheet.locator('[data-act=allow]').click();
  await expect(detail.locator('.ag-row[data-item]')).toContainText('Bank');
  expect(await page.evaluate(() => [...fakeAgents.requests.values()][0].status)).toBe('pending');
  await expect(waitingCount(page)).toHaveText('1');
  await expect(detail.locator('.ag-banner[data-req]')).toContainText('Asks for github');
});

test('a request answered elsewhere meanwhile still leaves the account added', async ({ context, extensionId }) => {
  const page = await setup(context, extensionId);
  const agentId = await page.evaluate(async () => {
    const a = await fakeAgents.addAgent({ name: 'Claude Code', status: 'active' });
    await Agents.pin({ id: a.id, public_key: a.public_key });
    fakeAgents.addRequest(a.id, { query: 'bank' });
    return a.id;
  });
  await openAgent(page, agentId);
  const detail = page.locator('#agents-detail');
  await detail.getByRole('button', { name: 'Add account' }).click();
  const sheet = sheetOf(page);
  await sheet.locator('.ag-pick button', { hasText: 'Bank' }).click();
  await page.evaluate(() => { [...fakeAgents.requests.values()][0].status = 'denied'; }); // answered on another device
  await sheet.locator('[data-act=allow]').click();
  await expect(detail.locator('.ag-row[data-item]')).toContainText('Bank');
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
  await openAgent(page, agentId);
  const detail = page.locator('#agents-detail');
  await detail.getByRole('button', { name: 'Add account' }).click();
  const sheet = sheetOf(page);
  await sheet.locator('.ag-pick button', { hasText: 'Bank' }).click();
  await page.evaluate(() => { const real = Agents.answer; Agents.answer = async () => { Agents.answer = real; throw Object.assign(new Error('agents 503'), { status: 503 }); }; });
  await sheet.locator('[data-act=allow]').click();
  await expect(detail.locator('.ag-row[data-item]')).toContainText('Bank');
  await expect(detail.locator('.ag-err')).toContainText("Bank is added, but its request couldn't be answered");
  await expect(waitingCount(page)).toHaveText('1');
});

test('Review on the agent page opens its request', async ({ context, extensionId }) => {
  const page = await setup(context, extensionId);
  const agentId = await page.evaluate(async () => {
    const a = await fakeAgents.addAgent({ name: 'Claude Code', status: 'active' });
    await Agents.pin({ id: a.id, public_key: a.public_key });
    fakeAgents.addRequest(a.id, { query: 'bank' });
    return a.id;
  });
  await openAgent(page, agentId);
  await page.locator('#agents-detail .ag-banner[data-req]').getByRole('button', { name: 'Review' }).click();
  await expect(page.locator('#agents-detail')).toContainText('Asks for bank');
  await expect(page.locator('.ag-tab[data-tab=requests]')).toHaveAttribute('aria-selected', 'true');
});

test('an agent approved on another device has to be checked here before writing copies', async ({ context, extensionId }) => {
  const page = await setup(context, extensionId);
  const agentId = await page.evaluate(async () => (await fakeAgents.addAgent({ name: 'Cursor', status: 'active' })).id);
  await page.click('#nav-agents');
  await expect(page.locator('#agents-detail .ag-row[data-agent]')).toContainText('Check its code');
  await page.click(`#agents-detail .ag-row[data-agent="${agentId}"]`);
  const detail = page.locator('#agents-detail');
  await expect(detail).toContainText('Approved on another device');
  await expect(detail.getByRole('button', { name: 'Add account' })).toBeDisabled();
  const refused = await page.evaluate(async () => {
    const a = [...fakeAgents.agents.values()][0];
    const item = (await Agents.vaultItems(await VaultKeys.getKey()))[0];
    return Agents.grant(a, item, {}).then(() => 'granted', e => e.message);
  });
  expect(refused).toContain('Check this agent');
  await detail.getByRole('button', { name: 'Codes match' }).click();
  await expect(detail.getByRole('button', { name: 'Add account' })).toBeEnabled();
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

const setUsage = (page, usage) => page.evaluate(u => { fakeAgents.usage = u; }, usage);
const usage = (used, extra = {}) => ({ used, limit: 10, resets_at: '2026-07-01T00:00:00Z', trial_available: false, ...extra });
// The card shows on the Agents tab: give it an agent.
const withAgent = page => page.evaluate(async () => { const a = await fakeAgents.addAgent({ name: 'Claude Code', status: 'active' }); await Agents.pin(a); });
const pill = page => page.locator('#agents-limit .ag-use');
const limitCard = page => page.locator('#agents-detail .ag-limit');

test('free plan: the uses pill shows even at 0 of 10, with no card', async ({ context, extensionId }) => {
  const page = await setup(context, extensionId, { free: true });
  await setUsage(page, usage(0));
  await withAgent(page);
  await page.click('#nav-agents');
  await expect(pill(page)).toHaveText('0/10 uses');
  await expect(pill(page)).toHaveAttribute('role', 'meter');
  await expect(pill(page)).toHaveAttribute('aria-valuenow', '0');
  await expect(pill(page)).toHaveAttribute('aria-valuetext', '0 of 10 uses this month');
  await expect(pill(page)).toHaveAttribute('title', 'Free plan · 0 of 10 uses this month · renews Jul 1');
  await expect(limitCard(page)).toHaveCount(0);
});

test('free plan: 7 of 10 has no warning, 9 of 10 does, and the 10 s refresh redraws it', async ({ context, extensionId }) => {
  const page = await setup(context, extensionId, { free: true });
  await setUsage(page, usage(7));
  await page.click('#nav-agents');
  await expect(pill(page)).toHaveText('7/10 uses');
  await expect(page.locator('#agents-limit .ag-use.warn')).toHaveCount(0);
  await setUsage(page, usage(9));
  await page.evaluate(async () => renderAgentsPanel(await Agents.list()));
  await expect(page.locator('#agents-limit .ag-use.warn')).toHaveCount(1);
  await expect(pill(page)).toHaveText('9/10 uses');
});

test('free plan: agentsShape changes with usage', async ({ context, extensionId }) => {
  const page = await setup(context, extensionId, { free: true });
  const same = await page.evaluate(() => {
    const d = { agents: [], usage: { used: 1, limit: 10, trial_available: false } };
    return agentsShape(d) === agentsShape({ ...d, usage: { ...d.usage, used: 2 } });
  });
  expect(same).toBe(false);
});

test('free plan: a new renewal date alone changes agentsShape and redraws the pill', async ({ context, extensionId }) => {
  const page = await setup(context, extensionId, { free: true });
  await setUsage(page, usage(0));
  await page.click('#nav-agents');
  await expect(pill(page)).toHaveAttribute('title', /renews Jul 1/);
  const same = await page.evaluate(() => {
    const d = { agents: [], usage: { used: 0, limit: 10, trial_available: false, resets_at: '2026-07-01T00:00:00Z' } };
    return agentsShape(d) === agentsShape({ ...d, usage: { ...d.usage, resets_at: '2026-08-01T00:00:00Z' } });
  });
  expect(same).toBe(false);
  await setUsage(page, usage(0, { resets_at: '2026-08-01T00:00:00Z' }));
  await page.evaluate(async () => renderAgentsPanel(await Agents.list()));
  await expect(pill(page)).toHaveAttribute('title', /renews Aug 1/);
});

test('free plan: 10 of 10 offers the trial (never had one), starting it hides the card', async ({ context, extensionId }) => {
  const page = await setup(context, extensionId, { free: true });
  await setUsage(page, usage(10, { trial_available: true }));
  await withAgent(page);
  await page.evaluate(() => {
    window.__trial = 0;
    CloudSync.startTrial = async () => { window.__trial++; fakeAgents.usage = null; };
  });
  await page.click('#nav-agents');
  await expect(page.locator('#agents-limit .ag-use.full')).toHaveAttribute('aria-valuenow', '10');
  const card = limitCard(page);
  await expect(card).toContainText("You've used all 10 agent uses this month");
  await expect(card.locator('[aria-live="polite"]')).toContainText("can't sign in or run commands until Jul 1");
  await card.getByRole('button', { name: 'Start free trial' }).click();
  await expect(limitCard(page)).toHaveCount(0);
  await expect(page.locator('#agents-limit')).toBeEmpty();
  expect(await page.evaluate(() => window.__trial)).toBe(1);
});

test('free plan: a failed trial start says so and offers the upgrade', async ({ context, extensionId }) => {
  const page = await setup(context, extensionId, { free: true });
  await setUsage(page, usage(10, { trial_available: true }));
  await withAgent(page);
  await page.evaluate(() => { CloudSync.startTrial = async () => { throw new Error('nope'); }; });
  await page.click('#nav-agents');
  await page.getByRole('button', { name: 'Start free trial' }).click();
  await expect(limitCard(page)).toContainText('Could not start the trial. Try again, or upgrade to Personal.');
  await expect(page.getByRole('button', { name: 'Start free trial' })).toBeEnabled();
  await expect(limitCard(page).locator('a', { hasText: 'Upgrade to Personal' })).toHaveAttribute('href', /\/dashboard\/billing$/);
});

test('free plan: 10 of 10 after a trial (or without one on offer) links to Personal only', async ({ context, extensionId }) => {
  const page = await setup(context, extensionId, { free: true });
  await setUsage(page, usage(10));
  await withAgent(page);
  await page.click('#nav-agents');
  await expect(limitCard(page).locator('a', { hasText: 'Upgrade to Personal' })).toHaveAttribute('href', /\/dashboard\/billing$/);
  await expect(limitCard(page)).toContainText('until Jul 1');
  await expect(limitCard(page).locator('button')).toHaveCount(0);
});

test('paid plan or no usage: no pill, no card', async ({ context, extensionId }) => {
  const page = await setup(context, extensionId);
  await withAgent(page);
  await page.click('#nav-agents');
  await expect(page.locator('#agents-detail')).toContainText('Your agents');
  await expect(page.locator('#agents-limit')).toBeEmpty();
  await setUsage(page, undefined);
  await page.evaluate(async () => renderAgentsPanel(await Agents.list()));
  await expect(page.locator('#agents-limit')).toBeEmpty();
  await expect(limitCard(page)).toHaveCount(0);
});

test('free plan: a server without usage shows no pill', async ({ context, extensionId }) => {
  const page = await setup(context, extensionId, { free: true });
  await setUsage(page, undefined);
  await page.click('#nav-agents');
  await expect(page.locator('#agents-detail')).toBeVisible();
  await expect(page.locator('#agents-limit')).toBeEmpty();
});

test('free plan: the second-agent error and a fourth grant', async ({ context, extensionId }) => {
  const page = await setup(context, extensionId, { free: true });
  expect(await page.evaluate(() => agentError({ body: { error: 'free plan limit: one agent' } })))
    .toBe('The free plan allows one connected agent. Disconnect it first, or upgrade to Personal.');
  const agentId = await page.evaluate(async () => {
    const a = await fakeAgents.addAgent({ status: 'active' });
    await Agents.pin(a);
    for (let i = 0; i < 3; i++) a.grants.set(crypto.randomUUID(), { scope: { kind: '2fa' }, commands: [] });
    return a.id;
  });
  await openAgent(page, agentId);
  await page.locator('#agents-detail').getByRole('button', { name: 'Add account' }).click();
  const sheet = sheetOf(page);
  await sheet.locator('.ag-pick button', { hasText: 'GitHub' }).click();
  await sheet.getByRole('button', { name: 'Allow GitHub' }).click();
  await expect(page.locator('#agents-detail .ag-err')).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => [...fakeAgents.agents.values()][0].grants.size)).toBe(4);
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
  await section.getByRole('button', { name: 'Allow (Username, password & 2FA)' }).click();
  await expect(section.locator('.ag-card-row')).toContainText('Claude Code');
  await expect(section.locator('.ag-card-row')).toContainText('Username, password & 2FA');
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
  await openAgent(page, agentId);
  const detail = page.locator('#agents-detail');
  const row = detail.locator('.ag-row[data-item]', { hasText: 'GitHub' });
  await expect(row.locator('.ag-pill')).toHaveText('Expired');
  await row.click();
  const sheet = sheetOf(page);
  await expect(sheet).toContainText('Expired. Pick how long to renew it for.');
  await expect(sheet.locator('input[name=ag-dur][value="1h"]')).toBeChecked();
  await expect(sheet.locator('.ag-commands')).toHaveValue('gh');
  await sheet.getByRole('button', { name: 'Renew' }).click();
  await expect(row).toContainText('1 h left');
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
    // Counts redraws in flight, so the hold only catches the timer's.
    window.__renders = 0;
    const render = renderAgentsPanel;
    window.renderAgentsPanel = async (...args) => {
      window.__renders++;
      try { return await render(...args); } finally { window.__renders--; }
    };
    return a.id;
  });
  await openAgent(page, agentId);
  const detail = page.locator('#agents-detail');
  // The click's own redraw finishes first: held, it would look like the
  // timer's, and redraw over the sheet when released (a click's does, on purpose).
  await page.waitForFunction(() => window.__renders === 0);
  await page.evaluate(a => { window.__hold = true; fakeAgents.addRequest(a, { query: 'bank' }); }, agentId);
  // The timer's redraw is now held halfway; the user opens a sheet meanwhile.
  await page.waitForFunction(() => window.__paused, null, { timeout: 15_000 });
  await detail.getByRole('button', { name: 'Add account' }).click();
  await expect(sheetOf(page).locator('.ag-picker')).toBeVisible();
  await page.evaluate(() => { window.__hold = false; window.__release(); });
  await page.waitForTimeout(1000);
  await expect(sheetOf(page).locator('.ag-picker')).toBeVisible(); // the sheet stayed
  await sheetOf(page).getByRole('button', { name: 'Cancel' }).click();
  await expect(detail).toContainText('Asks for bank', { timeout: 15_000 });
});

// Items shared with the user (a teammate's share, a collection's item) can
// be given to an agent too; their copy follows them and goes with access.
async function seedShared(page) {
  return page.evaluate(async () => {
    const share = crypto.randomUUID(), cid = crypto.randomUUID(), colItem = crypto.randomUUID();
    const sk = VaultCrypto.b64e(VaultCrypto.generateKey());
    const ck = VaultCrypto.b64e(VaultCrypto.generateKey());
    const login = (id, title, password, urls) => ({ id, type: 'login', title, urls, tags: [], fields: [{ id: 'username', label: 'Username', kind: 'text', value: 'team@acme.io' }, { id: 'password', label: 'Password', kind: 'password', value: password }], totp: null, notes: '', updatedAt: new Date().toISOString() });
    await chrome.storage.session.set({ shareKeys: { [share]: sk }, collectionKeys: { [cid]: ck } });
    await chrome.storage.local.set({
      [`sr:${share}`]: await VaultCrypto.encryptItem(login(share, 'Acme admin', 'acme-pass', ['acme.io']), sk),
      sharesWithMe: { userId: 'user-me', shares: [{ id: share, owner: { email: 'ana@acme.io' }, role: 'view', whole: true, revision: 1, via: [] }] },
      [`cr:${cid}:${colItem}`]: await VaultCrypto.encryptItem(login(colItem, 'Ops console', 'ops-pass', ['ops.acme.io']), ck),
      collectionsList: { userId: 'user-me', collections: [{ id: cid, encrypted_name: await VaultCrypto.encryptName('Ops', ck, cid), role: 'view' }] },
      [`cs:${cid}`]: { cursor: 5, revs: { [colItem]: 5 } },
    });
    return { share, sk, cid, ck, colItem };
  });
}

test('items shared with me can be given to an agent, and go when my access does', async ({ context, extensionId }) => {
  const page = await setup(context, extensionId);
  const s = await seedShared(page);
  const agentId = await page.evaluate(async () => {
    const a = await fakeAgents.addAgent({ name: 'Claude Code', status: 'active' });
    await Agents.pin({ id: a.id, public_key: a.public_key });
    return a.id;
  });
  await openAgent(page, agentId);
  const detail = page.locator('#agents-detail');
  await detail.getByRole('button', { name: 'Add account' }).click();
  const sheet = sheetOf(page);
  await sheet.locator('.ag-search').fill('acme');
  await expect(sheet.locator('.ag-pick button', { hasText: 'Acme admin' })).toContainText('Shared · ana@acme.io');
  await expect(sheet.locator('.ag-pick button', { hasText: 'Ops console' })).toContainText('Shared · Ops');
  await sheet.locator('.ag-pick button', { hasText: 'Acme admin' }).click();
  await sheet.locator('[data-act=allow]').click();
  await expect(detail.locator('.ag-row[data-item]', { hasText: 'Acme admin' })).toContainText('Shared · ana@acme.io');
  const copy = await page.evaluate(({ a, i }) => fakeAgents.openGrant(a, i), { a: agentId, i: s.share });
  expect(copy.fields.map(f => f.value)).toEqual(['team@acme.io', 'acme-pass']);

  // The collection's item, through the API.
  await page.evaluate(async ({ a, i }) => {
    const agent = (await Agents.list()).agents.find(x => x.id === a);
    const item = (await Agents.vaultItems(await VaultKeys.getKey())).find(x => x.id === i);
    await Agents.grant(agent, item, { scope: { kind: 'login' } });
  }, { a: agentId, i: s.colItem });

  // The owner changes the password: the agent's copy follows.
  await page.evaluate(async ({ share, sk }) => {
    const rec = (await chrome.storage.local.get(`sr:${share}`))[`sr:${share}`];
    const item = await VaultCrypto.decryptItem(rec, sk);
    item.fields[1].value = 'acme-pass-2';
    await chrome.storage.local.set({ [`sr:${share}`]: await VaultCrypto.encryptItem(item, sk) });
  }, s);
  expect(await page.evaluate(async () => Agents.syncCopies(await VaultKeys.getKey()))).toBe(1);
  expect((await page.evaluate(({ a, i }) => fakeAgents.openGrant(a, i), { a: agentId, i: s.share })).fields[1].value).toBe('acme-pass-2');

  // Not knowing isn't losing access: locked keys (session cleared) keep both.
  await page.evaluate(() => chrome.storage.session.remove(['shareKeys', 'collectionKeys']));
  await page.evaluate(async () => Agents.syncCopies(await VaultKeys.getKey()));
  expect(await page.evaluate(a => [...fakeAgents.agents.get(a).grants.keys()].length, agentId)).toBe(2);

  // Unshared, and the item gone from the collection: both copies go.
  await page.evaluate(async ({ share, cid }) => {
    await chrome.storage.local.remove([`sr:${share}`]);
    await chrome.storage.local.set({ sharesWithMe: { userId: 'user-me', shares: [] }, [`cs:${cid}`]: { cursor: 6, revs: {} } });
  }, s);
  await page.evaluate(async () => Agents.syncCopies(await VaultKeys.getKey()));
  expect(await page.evaluate(a => fakeAgents.agents.get(a).grants.size, agentId)).toBe(0);
});

test('a connected agent shows how to add it to Claude Code, Codex, Cursor and Pi', async ({ context, extensionId }) => {
  const page = await setup(context, extensionId);
  const agentId = await page.evaluate(async () => {
    const a = await fakeAgents.addAgent({ name: 'Claude Code', status: 'active' });
    await Agents.pin({ id: a.id, public_key: a.public_key });
    return a.id;
  });
  await openAgent(page, agentId);
  const detail = page.locator('#agents-detail');
  // Nothing used yet: its page points there.
  await expect(detail.locator('.ag-hint')).toContainText('Not used yet');
  await detail.getByRole('button', { name: 'Show me how' }).click();
  await expect(detail).toContainText('Add it to your agent');
  await expect(detail).toContainText('claude mcp add otpilot -- npx -y @otpilot/mcp@latest');
  await expect(detail).toContainText('[mcp_servers.otpilot]');
  await expect(detail).toContainText('~/.cursor/mcp.json');
  await expect(detail).toContainText('pi mcp add otpilot -- npx -y @otpilot/mcp@latest');
  // Also from its ⋯ menu, once it's been used.
  await detail.locator('.ag-back').click();
  await openMenuItem(page, 'Add it to your agent app…');
  await expect(detail.locator('.ag-setup-row')).toHaveCount(4);
});

test('a request with a long account name fits the popup (no sideways scroll)', async ({ context, extensionId }) => {
  const page = await setup(context, extensionId);
  await page.setViewportSize({ width: 600, height: 560 });
  await page.evaluate(async () => {
    const a = await fakeAgents.addAgent({ name: 'AI agent', status: 'active' });
    fakeAgents.addRequest(a.id, { query: 'feature-deploy-sec-618-619-hardening.test-counterpart.com', reason: 'Sign in to the Django admin', tool: 'request_access' });
  });
  await page.click('#nav-agents');
  await page.locator('#agents-detail').getByRole('button', { name: 'Review' }).click();
  await expect(page.locator('#agents-detail')).toContainText('test-counterpart.com');
  expect(await page.evaluate(() => document.body.scrollWidth)).toBeLessThanOrEqual(600);
});

test('a request for a site offers the logins of that domain, else every account', async ({ context, extensionId }) => {
  const page = await setup(context, extensionId);
  await writeAccounts(page, [...ACCOUNTS, { name: 'QA counterpart', email: 'qa@cp.io', password: 'qa-pass', urls: 'qa-counterpart.test-counterpart.com' }]);
  await page.evaluate(async () => reloadFromVault(await VaultKeys.getKey()));
  const ranked = await page.evaluate(async () => Agents.candidates('https://feature-x.test-counterpart.com/admin', await Agents.vaultItems(await VaultKeys.getKey())).map(i => i.title));
  expect(ranked).toEqual(['QA counterpart']);
  expect(await page.evaluate(async () => Agents.candidates('api.github.com', await Agents.vaultItems(await VaultKeys.getKey())).map(i => i.title))).toEqual(['GitHub']);

  await page.evaluate(async () => {
    const a = await fakeAgents.addAgent({ name: 'AI agent', status: 'active' });
    await Agents.pin({ id: a.id, public_key: a.public_key });
    fakeAgents.addRequest(a.id, { query: 'nothing-like-it.example.org' });
  });
  await page.click('#nav-agents');
  const detail = page.locator('#agents-detail');
  await detail.getByRole('button', { name: 'Review' }).click();
  await expect(detail.locator('.ag-picker')).toContainText('No account in your vault matches nothing-like-it.example.org');
  await expect(detail.locator('.ag-picker button, .ag-picker input')).toHaveCount(0); // never the whole vault
  await expect(detail.getByRole('button', { name: 'Allow' })).toBeDisabled();
});

test('a request lists only its matches, says which the agent has and which are saved for another host', async ({ context, extensionId }) => {
  const page = await setup(context, extensionId);
  await writeAccounts(page, [...ACCOUNTS, { name: 'QA counterpart', email: 'qa@cp.io', password: 'qa-pass', urls: 'qa-counterpart.test-counterpart.com' }]);
  await page.evaluate(async () => reloadFromVault(await VaultKeys.getKey()));
  await page.evaluate(async () => {
    const a = await fakeAgents.addAgent({ name: 'AI agent', status: 'active' });
    await Agents.pin({ id: a.id, public_key: a.public_key });
    const qa = (await Agents.vaultItems(await VaultKeys.getKey())).find(i => i.title === 'QA counterpart');
    await Agents.grant(a, qa, { scope: { kind: 'login' } });
    fakeAgents.addRequest(a.id, { query: 'feature-deploy.test-counterpart.com' });
  });
  await page.click('#nav-agents');
  await page.click('.ag-tab[data-tab=requests]');
  await page.click('#agents-detail .ag-row[data-kind=request]');
  const pick = page.locator('#agents-detail .ag-pick');
  await expect(pick.locator('button')).toHaveCount(1);
  await expect(pick).toContainText('Already allowed');
  await expect(pick).toContainText('Saved for qa-counterpart.test-counterpart.com, not feature-deploy.test-counterpart.com');
});

test('a share revoked while the popup was closed: the next copy sync asks the server and removes the grant', async ({ context, extensionId }) => {
  const page = await setup(context, extensionId);
  const s = await seedShared(page);
  const agentId = await page.evaluate(async ({ share }) => {
    const a = await fakeAgents.addAgent({ name: 'Claude Code', status: 'active' });
    await Agents.pin({ id: a.id, public_key: a.public_key });
    const item = (await Agents.vaultItems(await VaultKeys.getKey())).find(x => x.id === share);
    await Agents.grant(a, item, { scope: { kind: 'login' } });
    return a.id;
  }, s);
  // The server now lists no share (the cached list still has it); a failed
  // collections call changes nothing.
  await page.evaluate(() => {
    const prev = CloudSync.api;
    CloudSync.api = async (path, opts) => {
      if (path.startsWith('/shares/with-me')) return { status: 200, ok: true, json: async () => ({ shares: [] }) };
      if (path.startsWith('/collections')) return { status: 503, ok: false, json: async () => ({}) };
      return prev(path, opts);
    };
  });
  await page.evaluate(async () => Agents.syncCopies(await VaultKeys.getKey()));
  expect(await page.evaluate(a => fakeAgents.agents.get(a).grants.size, agentId)).toBe(0);
  expect(await page.evaluate(sh => chrome.storage.local.get(`sr:${sh}`), s.share)).toEqual({});
});

test("an agent's activity shows ten uses and loads the next ten from the API", async ({ context, extensionId }) => {
  const page = await setup(context, extensionId);
  const agentId = await page.evaluate(async () => {
    const a = await fakeAgents.addAgent({ name: 'Claude Code', status: 'active' });
    await Agents.pin({ id: a.id, public_key: a.public_key });
    for (let i = 0; i < 23; i++) fakeAgents.addUse(a.id, { detail: `cmd ${i}` });
    return a.id;
  });
  // One agent: the Activity tab is its own list, ten at a time.
  await page.click('#nav-agents');
  await page.click('.ag-tab[data-tab=activity]');
  const box = page.locator(`#agents-detail .ag-activity[data-agent="${agentId}"]`);
  await expect(box.locator('.ag-day').first()).toHaveText('Today');
  await expect(box.locator('.ag-log')).toHaveCount(10);
  await expect(box.locator('.ag-log').first()).toContainText('cmd 22');
  await box.getByRole('button', { name: 'Show more' }).click();
  await expect(box.locator('.ag-log')).toHaveCount(20);
  await box.getByRole('button', { name: 'Show more' }).click();
  await expect(box.locator('.ag-log')).toHaveCount(23);
  await expect(box.locator('.ag-log').last()).toContainText('cmd 0');
  await expect(box.getByRole('button', { name: 'Show more' })).toHaveCount(0);
  expect(await page.evaluate(id => fakeAgents.calls.filter(c => c === `GET /agents/${id}/activity`).length, agentId)).toBeGreaterThanOrEqual(3);
});

test('more new uses than a page between refreshes: the list restarts from the newest, no gap', async ({ context, extensionId }) => {
  const page = await setup(context, extensionId);
  const agentId = await page.evaluate(async () => {
    const a = await fakeAgents.addAgent({ name: 'Claude Code', status: 'active' });
    await Agents.pin({ id: a.id, public_key: a.public_key });
    for (let i = 1; i <= 20; i++) fakeAgents.addUse(a.id, { detail: `cmd ${i}` });
    return a.id;
  });
  await page.click('#nav-agents');
  await page.click('.ag-tab[data-tab=activity]');
  const box = page.locator(`#agents-detail .ag-activity[data-agent="${agentId}"]`);
  await expect(box.locator('.ag-log')).toHaveCount(10);
  await box.getByRole('button', { name: 'Show more' }).click();
  await expect(box.locator('.ag-log')).toHaveCount(20);
  await page.evaluate(id => { for (let i = 21; i <= 35; i++) fakeAgents.addUse(id, { detail: `cmd ${i}` }); }, agentId);
  await page.evaluate(() => renderAgentsPanel());
  await expect(box.locator('.ag-log').first()).toContainText('cmd 35');
  await expect(box.locator('.ag-log')).toHaveCount(10);
  await box.getByRole('button', { name: 'Show more' }).click();
  await expect(box.locator('.ag-log')).toHaveCount(20);
  const details = await box.locator('.ag-log .ag-t2').allTextContents();
  expect(details.map(t => Number(t.match(/cmd (\d+)/)[1]))).toEqual(Array.from({ length: 20 }, (_, i) => 35 - i));
});

test('an agent shows the client it runs in, and can be renamed', async ({ context, extensionId }) => {
  const page = await setup(context, extensionId);
  const agentId = await page.evaluate(async () => {
    const a = await fakeAgents.addAgent({ name: 'AI agent', machine: 'work', status: 'active' });
    a.client = 'claude-code';
    await Agents.pin({ id: a.id, public_key: a.public_key });
    return a.id;
  });
  await page.click('#nav-agents');
  const detail = page.locator('#agents-detail');
  const row = detail.locator(`.ag-row[data-agent="${agentId}"]`);
  await expect(row).toContainText('via Claude Code · work · not used yet');
  await expect(row).toContainText('0 accounts');
  await row.click();
  await expect(detail.locator('.ag-head .ag-t2')).toContainText('via Claude Code · work');
  await openMenuItem(page, 'Rename');
  await detail.locator('.ag-rename').fill('Claude Code (work)');
  await detail.locator('.ag-rename').press('Enter');
  await expect(detail.locator('.ag-name .ag-t1')).toHaveText('Claude Code (work)');
  await detail.locator('.ag-back').click();
  await expect(detail.locator('.ag-row[data-agent]')).toContainText('Claude Code (work)');
  expect(await page.evaluate(id => fakeAgents.agents.get(id).name, agentId)).toBe('Claude Code (work)');
});

test('renaming: Cancel and Escape send nothing, a refresh never redraws over the typed name', async ({ context, extensionId }) => {
  const page = await setup(context, extensionId);
  const agentId = await page.evaluate(async () => {
    const a = await fakeAgents.addAgent({ name: 'AI agent', status: 'active' });
    a.client = 'constructor'; // an odd client name shows as is
    await Agents.pin({ id: a.id, public_key: a.public_key });
    return a.id;
  });
  await openAgent(page, agentId);
  const detail = page.locator('#agents-detail');
  await expect(detail.locator('.ag-head .ag-t2')).toContainText('via constructor');
  const patches = () => page.evaluate(() => fakeAgents.calls.filter(c => c.startsWith('PATCH')).length);

  await openMenuItem(page, 'Rename');
  await detail.locator('.ag-rename').fill('Nope');
  await detail.getByRole('button', { name: 'Cancel' }).click();
  await expect(detail.locator('.ag-name .ag-t1')).toHaveText('AI agent');
  await openMenuItem(page, 'Rename');
  await detail.locator('.ag-rename').fill('Nope either');
  await detail.locator('.ag-rename').press('Escape');
  await expect(detail.locator('.ag-name .ag-t1')).toHaveText('AI agent');
  expect(await patches()).toBe(0);

  // A refresh with news (a new request) while typing: the field stays.
  await openMenuItem(page, 'Rename');
  await detail.locator('.ag-rename').fill('Half typed');
  await page.evaluate(async id => { fakeAgents.addRequest(id, { query: 'github' }); await renderAgentsPanel(await Agents.list()); }, agentId);
  await expect(detail.locator('.ag-rename')).toHaveValue('Half typed');
  expect(await patches()).toBe(0);
});

test("an account's sheet changes what the agent can use, or removes it", async ({ context, extensionId }) => {
  const page = await setup(context, extensionId);
  const agentId = await page.evaluate(async () => {
    const a = await fakeAgents.addAgent({ name: 'Claude Code', status: 'active' });
    await Agents.pin(a);
    for (const item of await Agents.vaultItems(await VaultKeys.getKey())) await Agents.grant(a, item, { scope: { kind: 'login' } });
    return a.id;
  });
  await openAgent(page, agentId);
  const detail = page.locator('#agents-detail');
  const row = detail.locator('.ag-row[data-item]', { hasText: 'GitHub' });
  await expect(row).toContainText('Username, password & 2FA · until you revoke');
  await row.click();
  const sheet = sheetOf(page);
  await expect(sheet.locator('input.ag-scope[value=login]')).toBeChecked();
  await sheet.locator('input.ag-scope[value="2fa"]').check();
  await sheet.locator('.ag-more summary').click();
  await sheet.locator('.ag-ask').check();
  await sheet.getByRole('button', { name: 'Save' }).click();
  await expect(row).toContainText('2FA code only');
  await expect(row.locator('.ag-pill')).toHaveText('Asks every time');
  const gh = await itemId(page, 'GitHub');
  expect((await page.evaluate(({ a, i }) => fakeAgents.openGrant(a, i), { a: agentId, i: gh })).fields).toEqual([]);

  // Escape closes the sheet without saving; Remove access takes it away.
  await row.click();
  await page.keyboard.press('Escape');
  await expect(sheetOf(page)).toHaveCount(0);
  await detail.locator('.ag-row[data-item]', { hasText: 'Bank' }).click();
  await sheetOf(page).getByRole('button', { name: 'Remove access' }).click();
  await expect(detail.locator('.ag-row[data-item]', { hasText: 'Bank' })).toHaveCount(0);
  expect(await page.evaluate(a => [...fakeAgents.agents.get(a).grants.keys()], agentId)).toEqual([gh]);
});

test('revoking an agent asks first: Cancel keeps it, Revoke agent removes it', async ({ context, extensionId }) => {
  const page = await setup(context, extensionId);
  const agentId = await page.evaluate(async () => {
    const a = await fakeAgents.addAgent({ name: 'Claude Code', status: 'active' });
    await Agents.pin(a);
    return a.id;
  });
  await openAgent(page, agentId);
  await openMenuItem(page, 'Revoke agent…');
  const dialog = page.getByRole('alertdialog');
  await expect(dialog).toContainText('Revoke Claude Code?');
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toHaveCount(0);
  expect(await page.evaluate(() => fakeAgents.agents.size)).toBe(1);
  await openMenuItem(page, 'Revoke agent…');
  await page.getByRole('alertdialog').getByRole('button', { name: 'Revoke agent' }).click();
  await expect(page.locator('#agents-detail')).toContainText('Let your AI agents sign in, safely');
  expect(await page.evaluate(() => fakeAgents.agents.size)).toBe(0);
});

test('a use of an "ask every time" account is answered in its Requests row', async ({ context, extensionId }) => {
  const page = await setup(context, extensionId);
  await page.evaluate(async () => {
    const a = await fakeAgents.addAgent({ name: 'Claude Code', status: 'active' });
    await Agents.pin(a);
    const item = (await Agents.vaultItems(await VaultKeys.getKey())).find(i => i.title === 'GitHub');
    await Agents.grant(a, item, { scope: { kind: 'login' }, askEveryTime: true });
    fakeAgents.addRequest(a.id, { item_id: item.id, tool: 'run' });
    fakeAgents.addRequest(a.id, { query: 'bank' });
  });
  await page.click('#nav-agents');
  await expect(page.locator('#agents-detail .ag-banner')).toContainText('2 things are waiting for you');
  await expect(page.locator('#agents-detail .ag-banner')).toContainText('1 account request and 1 use to approve');
  await page.locator('#agents-detail .ag-banner').getByRole('button', { name: 'Review' }).click();
  const row = page.locator('#agents-detail .ag-row[data-req]');
  await expect(row).toContainText('Use GitHub now');
  await row.getByRole('button', { name: 'Allow once' }).click();
  await expect(waitingCount(page)).toHaveText('1');
  const statuses = await page.evaluate(() => [...fakeAgents.requests.values()].map(r => r.status));
  expect(statuses).toEqual(['allowed', 'pending']);
  await expect(page.locator('#agents-detail .ag-row[data-kind=request]')).toContainText('Claude Code asks for bank');
});

test("the bell's Review opens the only thing waiting", async ({ context, extensionId }) => {
  const page = await setup(context, extensionId);
  await page.evaluate(async () => {
    const a = await fakeAgents.addAgent({ name: 'Claude Code', status: 'active' });
    await Agents.pin(a);
    fakeAgents.addRequest(a.id, { query: 'bank' });
  });
  await page.evaluate(() => renderNotices({ invites: [], notices: [], agents: { pending: 0, requests: 1 } }));
  await page.click('#btn-notices');
  await page.locator('#notices-menu .notice-btn', { hasText: 'Review' }).click();
  await expect(page.locator('#agents-detail')).toContainText('Asks for bank');
});

test('with two agents, Activity shows every use and filters by agent', async ({ context, extensionId }) => {
  const page = await setup(context, extensionId);
  const ids = await page.evaluate(async () => {
    const a = await fakeAgents.addAgent({ name: 'Claude Code', status: 'active' });
    const b = await fakeAgents.addAgent({ name: 'Cursor', status: 'active' });
    for (const x of [a, b]) await Agents.pin(x);
    fakeAgents.addUse(a.id, { detail: 'from claude' });
    fakeAgents.addUse(b.id, { detail: 'from cursor' });
    return { a: a.id, b: b.id };
  });
  await page.click('#nav-agents');
  await page.click('.ag-tab[data-tab=activity]');
  const detail = page.locator('#agents-detail');
  await expect(detail.locator('.ag-log')).toHaveCount(2);
  await expect(detail.locator('.ag-log', { hasText: 'from cursor' })).toContainText('Cursor');
  await detail.locator('.ag-filter', { hasText: 'Claude Code' }).click();
  await expect(detail.locator(`.ag-activity[data-agent="${ids.a}"] .ag-log`)).toHaveCount(1);
  await expect(detail.locator('.ag-log')).toContainText('from claude');
  await expect(detail.locator('.ag-filter[aria-pressed=true]')).toHaveText('Claude Code');
});

test('opened from the page card, the popup goes straight to what waits', async ({ context, extensionId }) => {
  const page = await setup(context, extensionId);
  await page.evaluate(() => chrome.storage.session.set({ agentsOpen: Date.now() }));
  await page.reload();
  await expect(page.locator('#agents-panel')).toBeVisible();
  expect(await page.evaluate(async () => (await chrome.storage.session.get('agentsOpen')).agentsOpen)).toBeUndefined();
  await page.evaluate(() => { SupabaseAuth.getSession = async () => ({ user: { id: 'user-me' } }); });
  await installFakeAgents(page);
  await page.evaluate(async () => {
    const a = await fakeAgents.addAgent({ name: 'Claude Code', status: 'active' });
    await Agents.pin(a);
    fakeAgents.addRequest(a.id, { query: 'bank' });
    await renderAgentsPanel();
  });
  await expect(page.locator('#agents-detail')).toContainText('Asks for bank');
});
