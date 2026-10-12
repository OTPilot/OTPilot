import { test, expect, seedUnlocked, waitForVault } from './fixtures.js';

// Notices: team invitations (accept / decline) and "added to a collection" /
// "shared an item with you", listed under the header's bell and counted on
// the toolbar badge.

const INVITE = {
  token: 'tok-1', team_id: 'team-1', team_name: 'Acme Ops', inviter: 'laura@acme.io',
  expires_at: new Date(Date.now() + 47 * 3600e3).toISOString(),
};
const ADDED = {
  id: 'n-1', kind: 'collection_added', team_name: 'Acme Ops', actor: 'laura@acme.io',
  target_id: 'c-1', role: 'edit', created_at: new Date(Date.now() - 5 * 60e3).toISOString(),
};

// A popup whose background answers `refreshNotices` with `window.__notices`
// and whose API calls are recorded in `window.__calls` (answered from
// `window.__answers[path]`, 200 otherwise).
async function popupWith(context, extensionId, notices) {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/popup.html`);
  await page.evaluate(() => Promise.all([chrome.storage.local.clear(), chrome.storage.session.clear()]));
  await seedUnlocked(page, { accounts: [] });
  await page.reload();
  await waitForVault(page);
  await page.evaluate(async notices => {
    window.__notices = notices;
    window.__calls = [];
    window.__answers = {};
    const send = chrome.runtime.sendMessage.bind(chrome.runtime);
    chrome.runtime.sendMessage = (msg, ...rest) =>
      msg?.action === 'refreshNotices' ? Promise.resolve(structuredClone(window.__notices)) : send(msg, ...rest);
    CloudSync.api = async (path, opts = {}) => {
      window.__calls.push(`${opts.method || 'GET'} ${path}`);
      const [status, body] = window.__answers[path] || [200, { ok: true }];
      return new Response(JSON.stringify(body), { status });
    };
    CloudSync.syncUser = async () => { window.__calls.push('syncUser'); return { plan: 'team_lite' }; };
    Sharing.getMyTeam = async () => null;
    await renderNotices();
  }, notices);
  return page;
}

test('the bell shows only with something to see, and lists invitations and notices', async ({ context, extensionId }) => {
  const empty = await popupWith(context, extensionId, { invites: [], notices: [] });
  await expect(empty.locator('#notices-wrap')).toBeHidden();
  await empty.close();

  const page = await popupWith(context, extensionId, { invites: [INVITE], notices: [ADDED] });
  await expect(page.locator('#notices-wrap')).toBeVisible();
  await expect(page.locator('#notices-count')).toHaveText('2');
  await page.click('#btn-notices');
  const rows = page.locator('#notices-menu .notice');
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toContainText('laura@acme.io invited you to join the team Acme Ops');
  await expect(rows.nth(0)).toContainText('expires in 47 h');
  await expect(rows.nth(1)).toContainText('added you to a shared collection in Acme Ops');
  await expect(rows.nth(1)).toContainText('Can edit · 5 min ago');
  // A click elsewhere closes it.
  await page.locator('.header h1').click();
  await expect(page.locator('#notices-menu')).toBeHidden();
});

test('declining an invitation removes it; dismissing a notice clears it', async ({ context, extensionId }) => {
  const page = await popupWith(context, extensionId, { invites: [INVITE], notices: [ADDED] });
  await page.click('#btn-notices');
  await page.evaluate(() => { window.__notices = { invites: [], notices: [window.__notices.notices[0]] }; });
  await page.locator('.notice', { hasText: 'invited you' }).getByRole('button', { name: 'Decline' }).click();
  await expect(page.locator('#notices-count')).toHaveText('1');

  await page.click('#btn-notices');
  await page.evaluate(() => { window.__notices = { invites: [], notices: [] }; });
  await page.locator('.notice').getByRole('button', { name: 'Dismiss' }).click();
  await expect(page.locator('#notices-wrap')).toBeHidden();
  expect(await page.evaluate(() => window.__calls)).toEqual([
    'POST /teams/decline/tok-1',
    'POST /notifications/n-1/read',
  ]);
});

test('accepting an invitation joins the team and opens the Team tab; a refusal says why', async ({ context, extensionId }) => {
  const page = await popupWith(context, extensionId, { invites: [INVITE], notices: [] });
  await page.evaluate(() => { window.__answers['/teams/accept/tok-1'] = [400, { error: 'already_in_team' }]; });
  await page.click('#btn-notices');
  const accept = page.locator('.notice').getByRole('button', { name: 'Accept' });
  await accept.click();
  await expect(page.locator('.notice-err')).toHaveText('You already belong to a team. Leave it first to join this one.');
  await expect(accept).toBeEnabled();

  await page.evaluate(() => {
    delete window.__answers['/teams/accept/tok-1'];
    window.__notices = { invites: [], notices: [] };
  });
  await accept.click();
  await expect(page.locator('#notices-wrap')).toBeHidden();
  await expect(page.locator('#team-panel')).toBeVisible();
  expect(await page.evaluate(() => window.__calls)).toEqual([
    'POST /teams/accept/tok-1',
    'POST /teams/accept/tok-1',
    'syncUser',
  ]);
});

test('the toolbar badge counts invitations and notices, and clears when there are none', async ({ context }) => {
  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent('serviceworker');
  const badge = await worker.evaluate(async ([invite, added]) => {
    const realFetch = globalThis.fetch;
    const getToken = SupabaseAuth.getAccessToken;
    let answer = { invites: [invite], notices: [added] };
    globalThis.fetch = async url => String(url).endsWith('/notifications')
      ? new Response(JSON.stringify(answer)) : realFetch(url);
    SupabaseAuth.getAccessToken = async () => 'token';
    try {
      await refreshNotices();
      const two = await chrome.action.getBadgeText({});
      answer = { invites: [], notices: [] };
      await refreshNotices();
      const none = await chrome.action.getBadgeText({});
      // Offline: the count stays as it was.
      answer = { invites: [invite], notices: [] };
      await refreshNotices();
      globalThis.fetch = async () => { throw new TypeError('offline'); };
      await refreshNotices();
      const offline = await chrome.action.getBadgeText({});
      return { two, none, offline };
    } finally {
      globalThis.fetch = realFetch;
      SupabaseAuth.getAccessToken = getToken;
      await chrome.action.setBadgeText({ text: '' });
    }
  }, [INVITE, ADDED]);
  expect(badge).toEqual({ two: '2', none: '', offline: '1' });
});

test('signing out hides the previous account\'s notices; signing in shows the new one\'s', async ({ context, extensionId }) => {
  const page = await popupWith(context, extensionId, { invites: [INVITE], notices: [] });
  await page.evaluate(() => chrome.storage.local.set({ cloudSession: { user: { id: 'a' } } }));
  await expect(page.locator('#notices-count')).toHaveText('1');
  // An answer still on its way for account a when it signs out is dropped.
  await page.evaluate(() => {
    const send = chrome.runtime.sendMessage;
    chrome.runtime.sendMessage = msg => msg?.action === 'refreshNotices'
      ? new Promise(r => setTimeout(() => r({ invites: [window.__notices.invites[0]], notices: [] }), 300))
      : send(msg);
    renderNotices();
    chrome.runtime.sendMessage = send;
    return chrome.storage.local.remove('cloudSession');
  });
  await expect(page.locator('#notices-wrap')).toBeHidden();
  await page.waitForTimeout(500);
  await expect(page.locator('#notices-wrap')).toBeHidden();

  await page.evaluate(added => {
    window.__notices = { invites: [], notices: [added] };
    return chrome.storage.local.set({ cloudSession: { user: { id: 'b' } } });
  }, ADDED);
  await expect(page.locator('#notices-count')).toHaveText('1');
  await page.click('#btn-notices');
  await expect(page.locator('.notice')).toContainText('added you to a shared collection');
});

test('the badge ignores an answer that arrives after the account changed', async ({ context }) => {
  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent('serviceworker');
  const badge = await worker.evaluate(async invite => {
    const realFetch = globalThis.fetch;
    const [getToken, getSession] = [SupabaseAuth.getAccessToken, SupabaseAuth.getSession];
    let account = 'a';
    SupabaseAuth.getSession = async () => ({ user: { id: account } });
    SupabaseAuth.getAccessToken = async () => 'token';
    globalThis.fetch = async url => {
      if (!String(url).endsWith('/notifications')) return realFetch(url);
      account = 'b'; // signed out and in as someone else meanwhile
      return new Response(JSON.stringify({ invites: [invite], notices: [] }));
    };
    try {
      await chrome.action.setBadgeText({ text: '' });
      const answer = await refreshNotices();
      return { answer, text: await chrome.action.getBadgeText({}) };
    } finally {
      globalThis.fetch = realFetch;
      SupabaseAuth.getAccessToken = getToken;
      SupabaseAuth.getSession = getSession;
    }
  }, INVITE);
  expect(badge).toEqual({ answer: null, text: '' });
});
