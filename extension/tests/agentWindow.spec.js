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
