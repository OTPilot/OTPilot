import { test, expect, seedUnlocked } from './fixtures.js';

// An AI agent waiting for the user opens the Agents view in a window, once per
// agent / request (background.js announceWaitingAgents); closing it leaves the badge.

const popups = context => context.pages().filter(p => p.url().includes('popup.html?view=agents&window=1'));

test('a waiting agent opens the Agents window once; closed without an answer it stays closed; a new request opens it again', async ({ context, extensionId }) => {
  const setup = await context.newPage();
  await setup.goto(`chrome-extension://${extensionId}/popup.html`);
  await setup.evaluate(() => Promise.all([chrome.storage.local.clear(), chrome.storage.session.clear()]));
  await seedUnlocked(setup, { accounts: [] });
  await setup.close();
  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent('serviceworker');
  await worker.evaluate(() => {
    globalThis.__agents = { agents: [{ id: 'ag1', status: 'pending', public_key: '', grants: [] }], requests: [] };
    const realFetch = globalThis.fetch;
    globalThis.fetch = async url => String(url).endsWith('/notifications')
      ? new Response(JSON.stringify({ invites: [], notices: [], agents: { pending: __agents.agents.filter(a => a.status === 'pending').length, requests: __agents.requests.length } }))
      : realFetch(url);
    SupabaseAuth.getAccessToken = async () => 'token';
    Agents.list = async () => structuredClone(__agents);
    return chrome.storage.session.remove('agentsAnnounced');
  });

  const run = () => worker.evaluate(async () => { await refreshNotices(); await navigator.locks.request('otpilot-agents-announce', () => {}); });
  await run();
  await expect.poll(() => popups(context).length).toBe(1);
  const win = popups(context)[0];
  await expect(win.locator('#agents-panel')).toBeVisible();
  expect(await worker.evaluate(() => chrome.action.getBadgeText({}))).toBe('1');

  // Same agent still waiting: no second window.
  await run();
  await win.waitForTimeout(300);
  expect(popups(context)).toHaveLength(1);

  // Closed without an answer: only the badge.
  await win.close();
  await run();
  await worker.evaluate(() => new Promise(r => setTimeout(r, 300)));
  expect(popups(context)).toHaveLength(0);
  expect(await worker.evaluate(() => chrome.action.getBadgeText({}))).toBe('1');

  // A new request: the window opens again.
  await worker.evaluate(() => { __agents.requests.push({ id: 'rq1', agent_id: 'ag1', query: 'github', item_id: null }); });
  await run();
  await expect.poll(() => popups(context).length).toBe(1);
  await worker.evaluate(() => chrome.action.setBadgeText({ text: '' }));
});

test('the Agents window closes itself once nothing waits any more', async ({ context, extensionId }) => {
  const { installFakeAgents } = await import('./fakeAgents.js');
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/popup.html`);
  await page.evaluate(() => Promise.all([chrome.storage.local.clear(), chrome.storage.session.clear()]));
  await seedUnlocked(page, { accounts: [], userPlan: 'personal', cloudSession: { user: { id: 'user-me' }, access_token: 't', expires_at: 4102444800000 } });
  await page.goto(`chrome-extension://${extensionId}/popup.html?view=agents&window=1`);
  await page.evaluate(() => { SupabaseAuth.getSession = async () => ({ user: { id: 'user-me' } }); });
  await installFakeAgents(page);
  await page.evaluate(() => fakeAgents.addAgent({ name: 'Codex' }));
  await page.evaluate(() => renderAgentsPanel());
  await expect(page.locator('#agents-detail')).toContainText('Codex wants to connect');
  // Denying the only agent: nothing waits, the window closes on its own.
  page.evaluate(() => [...document.querySelectorAll('#agents-detail button')].find(b => b.textContent.trim() === 'Deny').click()).catch(() => {});
  await expect.poll(() => page.isClosed(), { timeout: 5000 }).toBe(true);
});

test('approving the only agent in the window keeps it open for the add-account form; signed in without sync it stays on Agents', async ({ context, extensionId }) => {
  const { installFakeAgents } = await import('./fakeAgents.js');
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/popup.html`);
  await page.evaluate(() => Promise.all([chrome.storage.local.clear(), chrome.storage.session.clear()]));
  // Signed in, no sync set up: the popup would normally jump to Sync.
  await seedUnlocked(page, { accounts: [], userPlan: 'free', cloudSession: { user: { id: 'user-me' }, access_token: 't', expires_at: 4102444800000 } });
  await page.goto(`chrome-extension://${extensionId}/popup.html?view=agents&window=1`);
  await page.waitForTimeout(800);
  await expect(page.locator('#agents-panel')).toBeVisible();
  await page.evaluate(() => { SupabaseAuth.getSession = async () => ({ user: { id: 'user-me' } }); });
  await installFakeAgents(page);
  await page.evaluate(() => fakeAgents.addAgent({ name: 'Codex' }));
  await page.evaluate(() => renderAgentsPanel());
  await page.locator('#agents-detail').getByRole('button', { name: 'Codes match · Connect' }).click();
  await expect(page.locator('#agents-detail .ag-pick')).toBeVisible();
  await page.waitForTimeout(2000);
  expect(page.isClosed()).toBe(false);
  await expect(page.locator('#agents-panel')).toBeVisible();
});

test('signed out, a known agent does not keep the one-minute check alive', async ({ context }) => {
  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent('serviceworker');
  const alarm = await worker.evaluate(async () => {
    await chrome.storage.local.set({ agentsKnown: true });
    await chrome.storage.local.remove('cloudSession');
    const realFetch = globalThis.fetch;
    globalThis.fetch = async url => String(url).endsWith('/notifications') ? new Response('{}') : realFetch(url);
    try {
      await chrome.alarms.clear('otpilot-agents-waiting');
      await refreshNotices();
      return await chrome.alarms.get('otpilot-agents-waiting');
    } finally { globalThis.fetch = realFetch; await chrome.storage.local.remove('agentsKnown'); }
  });
  expect(alarm ?? null).toBeNull();
});

test('a window whose first list is already empty (answered elsewhere) closes itself', async ({ context, extensionId }) => {
  const { installFakeAgents } = await import('./fakeAgents.js');
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/popup.html`);
  await page.evaluate(() => Promise.all([chrome.storage.local.clear(), chrome.storage.session.clear()]));
  await seedUnlocked(page, { accounts: [], userPlan: 'personal', cloudSession: { user: { id: 'user-me' }, access_token: 't', expires_at: 4102444800000 } });
  await page.goto(`chrome-extension://${extensionId}/popup.html?view=agents&window=1`);
  await page.evaluate(() => { SupabaseAuth.getSession = async () => ({ user: { id: 'user-me' } }); });
  await installFakeAgents(page);
  page.evaluate(() => renderAgentsPanel()).catch(() => {});
  await expect.poll(() => page.isClosed(), { timeout: 5000 }).toBe(true);
});

test('an account whose agents are not known yet is asked once, then checked every minute', async ({ context }) => {
  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent('serviceworker');
  const r = await worker.evaluate(async () => {
    await chrome.storage.local.set({ cloudSession: { user: { id: 'user-me' }, access_token: 't', expires_at: 4102444800000 } });
    await new Promise(res => setTimeout(res, 100));
    await chrome.storage.local.remove('agentsKnown');
    const realFetch = globalThis.fetch, list = Agents.list, token = SupabaseAuth.getAccessToken, sess = SupabaseAuth.getSession;
    let calls = 0;
    globalThis.fetch = async url => String(url).endsWith('/notifications') ? new Response('{"invites":[],"notices":[],"agents":{"pending":0,"requests":0}}') : realFetch(url);
    SupabaseAuth.getAccessToken = async () => 'token';
    SupabaseAuth.getSession = async () => ({ user: { id: 'user-me' } });
    Agents.list = async () => { calls++; await chrome.storage.local.set({ agentsKnown: true }); return { agents: [{ id: 'a', status: 'active' }], requests: [] }; };
    try {
      await chrome.alarms.clear('otpilot-agents-waiting');
      await refreshNotices();
      await refreshNotices();
      return { calls, alarm: (await chrome.alarms.get('otpilot-agents-waiting'))?.periodInMinutes ?? null };
    } finally {
      Object.assign(globalThis, { fetch: realFetch }); Agents.list = list; SupabaseAuth.getAccessToken = token; SupabaseAuth.getSession = sess;
      await chrome.alarms.clear('otpilot-agents-waiting');
      await chrome.storage.local.remove(['agentsKnown', 'cloudSession']);
    }
  });
  expect(r).toEqual({ calls: 1, alarm: 1 });
});

test('a new request while the window shows another view brings it back to Agents', async ({ context, extensionId }) => {
  const setup = await context.newPage();
  await setup.goto(`chrome-extension://${extensionId}/popup.html`);
  await setup.evaluate(() => Promise.all([chrome.storage.local.clear(), chrome.storage.session.clear()]));
  await seedUnlocked(setup, { accounts: [] });
  await setup.close();
  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent('serviceworker');
  await worker.evaluate(() => {
    globalThis.__agents = { agents: [{ id: 'ag1', status: 'pending', public_key: '', grants: [] }], requests: [] };
    const realFetch = globalThis.fetch;
    globalThis.fetch = async url => String(url).endsWith('/notifications')
      ? new Response(JSON.stringify({ invites: [], notices: [], agents: { pending: 1, requests: __agents.requests.length } }))
      : realFetch(url);
    SupabaseAuth.getAccessToken = async () => 'token';
    Agents.list = async () => structuredClone(__agents);
    return chrome.storage.session.remove('agentsAnnounced');
  });
  const run = () => worker.evaluate(async () => { await refreshNotices(); await navigator.locks.request('otpilot-agents-announce', () => {}); });
  await run();
  await expect.poll(() => popups(context).length).toBe(1);
  const win = popups(context)[0];
  await win.click('#nav-home');
  await expect(win.locator('#agents-panel')).toBeHidden();
  await worker.evaluate(() => { __agents.requests.push({ id: 'rq2', agent_id: 'ag1', query: 'aws', item_id: null }); });
  await run();
  await expect(win.locator('#agents-panel')).toBeVisible();
  expect(popups(context)).toHaveLength(1);
  await worker.evaluate(() => chrome.action.setBadgeText({ text: '' }));
});

test('a new request never takes the window away from the vault editor', async ({ context, extensionId }) => {
  const setup = await context.newPage();
  await setup.goto(`chrome-extension://${extensionId}/popup.html`);
  await setup.evaluate(() => Promise.all([chrome.storage.local.clear(), chrome.storage.session.clear()]));
  await seedUnlocked(setup, { accounts: [] });
  await setup.close();
  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent('serviceworker');
  await worker.evaluate(() => {
    globalThis.__agents = { agents: [{ id: 'ag1', status: 'pending', public_key: '', grants: [] }], requests: [] };
    const realFetch = globalThis.fetch;
    globalThis.fetch = async url => String(url).endsWith('/notifications')
      ? new Response(JSON.stringify({ invites: [], notices: [], agents: { pending: 1, requests: __agents.requests.length } }))
      : realFetch(url);
    SupabaseAuth.getAccessToken = async () => 'token';
    Agents.list = async () => structuredClone(__agents);
    return chrome.storage.session.remove('agentsAnnounced');
  });
  const run = () => worker.evaluate(async () => { await refreshNotices(); await navigator.locks.request('otpilot-agents-announce', () => {}); });
  await run();
  await expect.poll(() => popups(context).length).toBe(1);
  const win = popups(context)[0];
  await win.click('#nav-settings');
  await win.click('#btn-add');
  await win.locator('#add-type-menu [data-add-type="note"]').click();
  await win.fill('#acc-detail .item-title', 'Unsaved note');
  await win.click('#acc-detail .acc-body-head'); // focus off the field
  await worker.evaluate(() => { __agents.requests.push({ id: 'rq3', agent_id: 'ag1', query: 'aws', item_id: null }); });
  await run();
  await win.waitForTimeout(500);
  await expect(win.locator('#settings-panel')).toBeVisible();
  await expect(win.locator('#acc-detail .item-title')).toHaveValue('Unsaved note');
  await worker.evaluate(() => chrome.action.setBadgeText({ text: '' }));
});
