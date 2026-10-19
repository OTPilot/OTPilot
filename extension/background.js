'use strict';

importScripts(
  'config.js', 'supabase.js', 'emailCodes.js',
  // 2.0 vault lock: the unlocked vault key lives in chrome.storage.session,
  // which content scripts can't read, so they ask this worker (vaultState /
  // vaultUnlock below).
  'vaultCrypto.js', 'vaultKeys.js', 'vaultStore.js', 'vault.js', 'vaultMigration.js',
  'vaultAccounts.js', 'cloudSync.js', 'vaultLock.js', 'vaultSync.js', 'vaultShares.js',
  // 2.1 AI agents: their copies follow what pages save (keys.js wraps them),
  // shared items too (vaultCollections.js re-reads a collection's).
  'keys.js', 'vaultCollections.js', 'agents.js',
);

// Per-item sync (/vault/items) from the worker: after a page saved or changed
// an item, and on the poll alarm — so those changes reach the server (and
// other devices' changes arrive) with the popup closed. Needs a session, sync
// turned on, a plan that syncs and an unlocked vault; otherwise it waits for
// the popup. One run at a time; a request during a run runs it once more.
let _vaultSyncRun = null, _vaultSyncAgain = false;
async function vaultSyncReady() {
  if (!(await SupabaseAuth.getSession())) return false;
  const { syncEnabled, userPlan } = await chrome.storage.local.get(['syncEnabled', 'userPlan']);
  if (!syncEnabled || !['personal', 'team_lite', 'team_pro'].includes(userPlan)) return false;
  return (await VaultLock.state()) === 'unlocked';
}
function queueVaultSync() {
  if (_vaultSyncRun) { _vaultSyncAgain = true; return _vaultSyncRun; }
  _vaultSyncRun = (async () => {
    do {
      _vaultSyncAgain = false;
      try {
        if (!(await vaultSyncReady())) return;
        const key = await VaultKeys.getKey();
        if (!key) return;
        let stats;
        try {
          stats = await VaultSync.sync(key);
          // My shared items' copies follow what a page just saved.
          await VaultShares.syncOwner(key).catch(() => {});
          await Agents.syncCopies(key).catch(() => {});
        } finally {
          // The locked-vault index follows what the pull stored, even when
          // the upload after it failed (the pull's progress is saved, so a
          // retry wouldn't report those changes again).
          await VaultAccounts.rebuildIndex(key).catch(() => {});
        }
        // Something came in: an open popup redraws (its sync reloads the list).
        if (stats.pulled || stats.deleted || Object.keys(stats.remapped).length) {
          chrome.runtime.sendMessage({ action: 'serverDataChanged', remapped: stats.remapped }).catch(() => {});
        }
      } catch { /* offline or signed out: the next save, alarm or popup retries */ }
    } while (_vaultSyncAgain);
  })().finally(() => { _vaultSyncRun = null; });
  return _vaultSyncRun;
}

// A page changed the vault: upload it, and let an open popup redraw. Agents'
// copies follow the change right away even without vault sync (Free, or
// sync off): they're written straight from the local vault.
function vaultChangedByPage() {
  chrome.runtime.sendMessage({ action: 'serverDataChanged' }).catch(() => {});
  queueVaultSync().then(async () => {
    if (await vaultSyncReady().catch(() => false)) return; // the sync just did it
    if ((await VaultLock.state()) !== 'unlocked') return;
    const key = await VaultKeys.getKey();
    if (key) await Agents.syncCopies(key).catch(() => {});
  }).catch(() => {});
}

// Accounts for content scripts. Unlocked: the decrypted list. Locked: only the
// plaintext index (name, URL patterns, autofill — no secrets), or, for a v1
// user not migrated yet, the same fields from the old plaintext list.
async function accountsForContent() {
  const { activeIndex = 0 } = await chrome.storage.local.get('activeIndex');
  if ((await VaultLock.state()) === 'unlocked') {
    // No passwords, notes or custom fields: content scripts only fill 2FA
    // codes from this list, so they don't get them.
    const accounts = (await VaultAccounts.load(await VaultKeys.getKey())).map(({ password, notes, customFields, links, _history, ...acc }) => acc);
    // Logins shared with me (collections, shares) that carry a 2FA code fill
    // it too — after mine, so activeIndex still points at my own list.
    for (const item of await sharedLogins()) {
      if (!item.totp?.secret) continue;
      accounts.push({
        _id: item.id, name: item.title || '', email: Vault.getValue(item, 'username'), secret: item.totp.secret,
        urls: (item.urls || []).join('\n'), autofill: item.autofill !== false, autoLogin: item.autoLogin !== false, shared: true,
      });
    }
    return { locked: false, activeIndex, accounts };
  }
  let index = await VaultAccounts.readIndex();
  if (!(await VaultMigration.isMigrated())) {
    const { accounts = [] } = await chrome.storage.local.get('accounts');
    index = accounts.map(a => ({ name: a.name, urls: a.urls, autofill: a.autofill !== false }));
  }
  return { locked: true, activeIndex, accounts: index };
}

// The host of the page a top-frame content script runs on, or null.
function senderHost(sender) {
  if (!sender?.tab || sender.frameId !== 0 || !sender.url) return null;
  try {
    const url = new URL(sender.url);
    return /^https?:$/.test(url.protocol) ? url.hostname : null;
  } catch { return null; }
}

// Saved logins without a 2FA code for the sender page's site — a URL of
// theirs on this host, a parent or a subdomain (digitalocean.com ⇄
// cloud.digitalocean.com) — that a 2FA code set up on this page can be added
// to instead of a new account. The one whose username is the code's label
// first. Unlocked only; [{ id, name, username }] (nothing secret).
async function attachCandidates(sender, email = '') {
  const host = senderHost(sender);
  if (!host || (await VaultLock.state()) !== 'unlocked') return [];
  const page = host.replace(/^www\./, '');
  const hostOf = u => String(u).trim().toLowerCase()
    .replace(/^[a-z]+:\/\//, '').replace(/^\*\./, '').replace(/^www\./, '').split(/[/:?#]/)[0];
  const { items } = await VaultStore.readAll(await VaultKeys.getKey());
  const label = String(email || '').trim().toLowerCase();
  return items
    .filter(i => i.type === 'login' && !i.totp?.secret
      && (i.urls || []).some(u => { const h = hostOf(u); return h && relatedHost(h, page); }))
    .map(i => ({ id: i.id, name: i.title || '', username: Vault.getValue(i, 'username') }))
    .sort((a, b) => (b.username.toLowerCase() === label) - (a.username.toLowerCase() === label));
}

// Logins that can fill the sender page's sign-in form: unlocked, those with a
// password whose URLs cover the host ({ id, name, username }); locked, the
// same from the plaintext index ({ id, name }), to offer an unlock.
// Logins of the team collections unlocked this session (vaultCollections.js:
// keys in chrome.storage.session `collectionKeys`, cleared on lock; records
// under cr:<cid>:<id>). Only read here, for filling.
async function sharedLogins() {
  // Only for a signed-in account (what's shared is the account's, not the device's).
  if (!(await SupabaseAuth.getSession().catch(() => null))) return [];
  const { collectionKeys: keys = {}, shareKeys = {} } = await chrome.storage.session.get(['collectionKeys', 'shareKeys']);
  if (!Object.keys(keys).length && !Object.keys(shareKeys).length) return [];
  const out = [];
  for (const [k, rec] of Object.entries(await chrome.storage.local.get(null))) {
    // A collection's item (cr:<cid>:<id>) or a copy shared with me (sr:<id>).
    const m = /^cr:([0-9a-f-]{36}):/.exec(k);
    const key = m ? keys[m[1]] : (k.startsWith('sr:') ? shareKeys[k.slice(3)] : null);
    if (!key) continue;
    try {
      const item = await VaultCrypto.decryptItem(rec, key);
      if (item.type === 'login') out.push(item);
    } catch { /* unreadable: skipped */ }
  }
  return out;
}

// One shared login by id: only that record is decrypted (a direct lookup in
// each unlocked collection), not every record.
async function sharedLogin(id) {
  if (!(await SupabaseAuth.getSession().catch(() => null))) return null;
  const { collectionKeys: keys = {}, shareKeys = {} } = await chrome.storage.session.get(['collectionKeys', 'shareKeys']);
  // A copy shared with me: its record is stored under the share's id.
  if (shareKeys[id]) {
    const rec = (await chrome.storage.local.get(`sr:${id}`))[`sr:${id}`];
    if (rec) {
      try {
        const item = await VaultCrypto.decryptItem(rec, shareKeys[id]);
        return item.type === 'login' ? item : null;
      } catch { return null; }
    }
  }
  for (const [cid, key] of Object.entries(keys)) {
    const k = `cr:${cid}:${id}`;
    const rec = (await chrome.storage.local.get(k))[k];
    if (!rec) continue;
    try {
      const item = await VaultCrypto.decryptItem(rec, key);
      return item.type === 'login' ? item : null;
    } catch { return null; }
  }
  return null;
}

async function loginsForPage(sender) {
  const host = senderHost(sender);
  const state = await VaultLock.state();
  if (!host || state === 'setup') return { state, logins: [] };
  if (state === 'unlocked') {
    const { items } = await VaultStore.readAll(await VaultKeys.getKey());
    const logins = [...items, ...(await sharedLogins())]
      .filter(i => i.type === 'login' && Vault.getValue(i, 'password') && Vault.loginCoversHost(i.urls, host))
      .sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
      .map(i => ({
        id: i.id, name: i.title || host, username: Vault.getValue(i, 'username'),
        autofill: i.autofill !== false, autoLogin: i.autoLogin !== false,
      }));
    return { state, logins };
  }
  const logins = (await VaultAccounts.readIndex())
    .filter(e => e.hasPassword && Vault.loginCoversHost(e.urls, host))
    .map(e => ({ id: e.id, name: e.name || host, autofill: e.autofill !== false, autoLogin: e.autoLogin !== false }));
  return { state, logins };
}

// `usernameOnly`: the first page of a two-step sign-in, which asks for the
// username alone — the password stays here until its own page asks.
async function fillLogin(sender, id, usernameOnly = false) {
  const host = senderHost(sender);
  if (!host || typeof id !== 'string' || (await VaultLock.state()) !== 'unlocked') return { ok: false };
  const item = (await VaultStore.get(id, await VaultKeys.getKey()).catch(() => null))
    || (await sharedLogin(id));
  const password = item && Vault.getValue(item, 'password');
  if (!item || item.type !== 'login' || !password || !Vault.loginCoversHost(item.urls, host)) return { ok: false };
  await VaultLock.touch();
  if (usernameOnly) return { ok: true, username: Vault.getValue(item, 'username') };
  return { ok: true, username: Vault.getValue(item, 'username'), password };
}

// ── Launch: open a login's site and sign in ─────────────────────────────────
// The popup's "Open & sign in" opens the login's first website in a new tab
// and leaves a launch for that tab (session storage: never a page's to set).
// Pages in that tab ask for it (vaultLaunchFill): on a host the login covers
// (loginCoversHost, as for every fill) they get the username, then the
// password once — a launch is gone as soon as the password is released, so a
// rejected password never loops. The 2FA code is filled by the usual OTP
// auto-fill. The user's click in the popup is what starts it.
const LAUNCH_TTL = 2 * 60 * 1000;
const launchKey = tabId => `launch:${tabId}`;

// Plain http is only for the user's own machine / network.
const isLocalHost = host => host === 'localhost' || /^\d{1,3}(\.\d{1,3}){3}$/.test(host);

// The URL to open for a saved website pattern ("site.com/login",
// "*.site.com", "https://…"), or null. A public site is always opened over
// https (a saved http:// address too), so a launch never sends a password
// over plain http; a local host keeps a saved https:// and defaults to http.
function launchUrlOf(urls) {
  for (const raw of urls || []) {
    const saved = String(raw || '').trim();
    const scheme = /^(https?):\/\//i.exec(saved)?.[1]?.toLowerCase();
    const u = saved.replace(/^https?:\/\//i, '').replace(/^\*\./, '');
    if (!u || /^[a-z][a-z0-9+.-]*:/i.test(u.split(/[/?#]/)[0].replace(/:\d+$/, ''))) continue;
    const host = u.split(/[/?#]/)[0].replace(/:\d+$/, '').toLowerCase();
    const proto = !isLocalHost(host) ? 'https' : (scheme || 'http');
    try {
      const url = new URL(`${proto}://${u}`);
      if (url.hostname && !url.hostname.includes('*')) return url.href;
    } catch { /* not a URL: try the next one */ }
  }
  return null;
}

// Only the extension's own pages (the popup) start a launch: a content
// script's sender URL is the web page's.
const fromExtensionPage = sender => sender?.id === chrome.runtime.id
  && String(sender.url || '').startsWith(chrome.runtime.getURL(''));

async function launchLogin(sender, id) {
  if (!fromExtensionPage(sender) || typeof id !== 'string') return { ok: false };
  if ((await VaultLock.state()) !== 'unlocked') return { ok: false, error: 'locked' };
  const item = (await VaultStore.get(id, await VaultKeys.getKey()).catch(() => null)) || (await sharedLogin(id));
  if (!item || item.type !== 'login') return { ok: false };
  const url = launchUrlOf(item.urls);
  if (!url) return { ok: false, error: 'no-url' };
  // The launch is stored before the site starts loading (a blank tab
  // first), so the site's first page always finds it.
  const tab = await chrome.tabs.create({ url: 'about:blank', active: true });
  // Only to sign in when there's something to sign in with.
  if (Vault.getValue(item, 'username') || Vault.getValue(item, 'password')) {
    await chrome.storage.session.set({ [launchKey(tab.id)]: { id, at: Date.now() } });
  }
  await chrome.tabs.update(tab.id, { url });
  await VaultLock.touch();
  return { ok: true };
}

// What a page in a launched tab may fill: `step` 'username' (a page asking
// only for the username) or 'password' (the sign-in form: username +
// password, which ends the launch). `probe` just says whether one is on.
async function launchFill(sender, step) {
  const host = senderHost(sender);
  if (!host) return { ok: false };
  // Never into a plain-http page of a public site (a redirect can land there).
  if (new URL(sender.url).protocol !== 'https:' && !isLocalHost(host)) return { ok: false };
  const key = launchKey(sender.tab.id);
  const launch = (await chrome.storage.session.get(key))[key];
  if (!launch) return { ok: false };
  if (Date.now() - launch.at > LAUNCH_TTL) { await chrome.storage.session.remove(key); return { ok: false }; }
  if (step === 'probe') return { ok: true };
  if ((await VaultLock.state()) !== 'unlocked') return { ok: false };
  const item = (await VaultStore.get(launch.id, await VaultKeys.getKey()).catch(() => null)) || (await sharedLogin(launch.id));
  if (!item || item.type !== 'login' || !Vault.loginCoversHost(item.urls, host)) return { ok: false };
  const username = Vault.getValue(item, 'username');
  if (step === 'username') return username ? { ok: true, username } : { ok: false };
  const password = Vault.getValue(item, 'password');
  if (step !== 'password' || !password) return { ok: false };
  await chrome.storage.session.remove(key);
  await VaultLock.touch();
  return { ok: true, username, password };
}

// ── Saving sign-ins ──────────────────────────────────────────────────────────
// A submitted sign-in form's credentials wait in chrome.storage.session
// (memory-only, unreadable by content scripts) for the next page in the same
// tab to offer saving them. The password never goes back to a page: the
// offer only names the host, the username and the login it would update.
const PENDING_LOGIN_TTL = 3 * 60 * 1000;
const NEVER_SAVE = 'loginNeverSave';
const pendingLoginKey = tabId => `pendingLogin:${tabId}`;

// The offer shows on the signed-in host, or a parent or subdomain of it
// (login.site.com → site.com). Not on a sibling host: without the Public
// Suffix List, "same site" can't be told apart from two unrelated sites under
// one public suffix (a.co.uk / b.co.uk, x.github.io / y.github.io).
const relatedHost = (a, b) => a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`);

// The website a login saved from a page gets: the page its sign-in was
// typed on (the username step's, in a two-step sign-in), so "Open & sign in"
// goes straight there — host + path, e.g. "app.site.com/sign-in/id". The
// path is kept only when it reads like a sign-in page (not a change-password
// or sign-up one) and holds plain words: no query or fragment (redirect
// targets, tokens), nothing that looks like an id. Else the host alone.
const SIGN_IN_SEGMENT = /^(sign[-_]?in|log[-_]?in|logon|sign[-_]?on|sso|auth|authenticate|session|identifier)(\.[a-z]+)?$/i;
function signInUrlOf(url) {
  try {
    const u = new URL(url);
    if (!/^https?:$/.test(u.protocol) || !u.hostname) return null;
    const segments = u.pathname.split('/').filter(Boolean);
    const plain = segments.length <= 4 && segments.some(x => SIGN_IN_SEGMENT.test(x))
      && segments.every(x => /^[a-z][a-z0-9._~-]{0,31}$/i.test(x) && !/\d{4,}|[0-9a-f]{12,}/i.test(x));
    return `${u.host.toLowerCase()}${plain ? `/${segments.join('/')}` : ''}`;
  } catch { return null; }
}

// A capture still being stored, per tab: the next page's offer request can
// arrive while it is (the sign-in navigated right away), and waits for it.
const _capturesInFlight = new Map();

function captureLogin(sender, msg) {
  const tabId = sender?.tab?.id;
  const run = storeCapture(sender, msg);
  if (tabId === undefined) return run;
  const tracked = run.catch(() => {}).finally(() => {
    if (_capturesInFlight.get(tabId) === tracked) _capturesInFlight.delete(tabId);
  });
  _capturesInFlight.set(tabId, tracked);
  return run;
}

async function storeCapture(sender, msg) {
  const host = senderHost(sender);
  const password = typeof msg.password === 'string' ? msg.password : '';
  if (!host || !password || password.length > 1024) return;
  if ((await chrome.storage.local.get(NEVER_SAVE))[NEVER_SAVE]?.includes(host)) return;
  let username = typeof msg.username === 'string' ? msg.username.trim().slice(0, 512) : '';
  // A form with its own username ends any two-step flow in this tab; one
  // without takes the username step's (kept for a retried password).
  // `step`: the username step this capture took its username from, the only
  // one settling it may end.
  // `url`: where the sign-in started (the username step's page, if any).
  // A password page that repeats the username step's username (a read-only
  // or hidden copy of it) is still that sign-in: it keeps its start.
  let step = null;
  let url = signInUrlOf(sender.url);
  const pending = await pendingUsernameFor(sender.tab.id, host);
  if (username) {
    if (pending?.url && pending.username.toLowerCase() === username.toLowerCase()) url = pending.url;
    await chrome.storage.session.remove(pendingUsernameKey(sender.tab.id));
  } else if (pending) {
    ({ username, id: step } = pending);
    if (pending.url) url = pending.url;
  }
  const id = crypto.randomUUID(); // offers and choices name the capture they're about
  await chrome.storage.session.set({ [pendingLoginKey(sender.tab.id)]: { id, host, username, password, at: Date.now(), ...(url ? { url } : {}), ...(step ? { step } : {}) } });
}

// Two-step sign-ins (username page, then password page): the username step's
// value waits here for the password step in the same tab, on a related host.
const PENDING_USERNAME_TTL = 5 * 60 * 1000;
const pendingUsernameKey = tabId => `pendingUsername:${tabId}`;

async function captureUsername(sender, msg) {
  const host = senderHost(sender);
  const username = typeof msg.username === 'string' ? msg.username.trim().slice(0, 512) : '';
  if (!host || !username || sender.tab?.id === undefined) return;
  const url = signInUrlOf(sender.url);
  await chrome.storage.session.set({ [pendingUsernameKey(sender.tab.id)]: { id: crypto.randomUUID(), host, username, at: Date.now(), ...(url ? { url } : {}) } });
}

// Kept until it expires, a new username step or a form with its own username
// replaces it, or the sign-in's save offer is settled: a rejected password
// retried on the same page needs it again.
async function pendingUsernameFor(tabId, host) {
  const key = pendingUsernameKey(tabId);
  const pending = (await chrome.storage.session.get(key))[key];
  if (!pending) return null;
  if (Date.now() - pending.at > PENDING_USERNAME_TTL) { await chrome.storage.session.remove(key); return null; }
  return relatedHost(pending.host, host) ? pending : null;
}

// Ends the username step a settled capture used — not a newer one the user
// started since (back on the username page, another account).
async function endUsernameStep(tabId, pending) {
  if (!pending.step) return;
  const key = pendingUsernameKey(tabId);
  if ((await chrome.storage.session.get(key))[key]?.id === pending.step) await chrome.storage.session.remove(key);
}

// Removes the tab's capture only if it is still `id` (a newer sign-in may
// have replaced it meanwhile).
async function dropPendingLogin(key, id) {
  const current = (await chrome.storage.session.get(key))[key];
  if (current?.id === id) await chrome.storage.session.remove(key);
}

async function readPendingLogin(sender) {
  const host = senderHost(sender);
  if (!host) return null;
  await _capturesInFlight.get(sender.tab.id);
  const key = pendingLoginKey(sender.tab.id);
  const pending = (await chrome.storage.session.get(key))[key];
  if (!pending) return null;
  if (Date.now() - pending.at > PENDING_LOGIN_TTL) { await dropPendingLogin(key, pending.id); return null; }
  return relatedHost(pending.host, host) ? { key, pending } : null;
}

// What saving the pending sign-in would do:
// - `update` a saved login of this site: the one with that username; or,
//   signing in with a username, one saved without a username (e.g. from a
//   change-password form that had no username field) — it gets the username
//   too; or, with no username captured, one of the site's logins (the user
//   picks among `candidates`, the most recently changed first);
// - a `new` login otherwise;
// - nothing when it's already saved as is.
// `limit` / `newLimit`: the Free plan refuses that update / a new login.
async function planPendingLogin({ host, username, password }) {
  const key = await VaultKeys.getKey();
  const { items } = await VaultStore.readAll(key);
  const covering = items.filter(i => i.type === 'login' && Vault.loginCoversHost(i.urls, host));
  const userOf = i => Vault.getValue(i, 'username').trim();
  const newest = (x, y) => (y.updatedAt || '').localeCompare(x.updatedAt || '');
  const { userPlan = 'free' } = await chrome.storage.local.get('userPlan');
  const candidate = Vault.newItem('login', { urls: [host] });
  Vault.getField(candidate, 'password').value = password;
  const newLimit = !Vault.canSaveItem(items, userPlan, candidate);

  // The exact username first. Usernames can be case-sensitive: a match
  // ignoring case is used only when it is the only one.
  // With no username captured, nothing is matched by it: the site's logins
  // are all candidates (below).
  const loose = username ? covering.filter(i => userOf(i).toLowerCase() === username.toLowerCase()) : [];
  const match = username ? (covering.find(i => userOf(i) === username) || (loose.length === 1 ? loose[0] : null)) : null;
  if (match && Vault.getValue(match, 'password') === password) return { kind: 'none' };

  // A team collection already has this login: never offer a personal copy.
  // (A changed password there is updated from the popup, which writes to the
  // collection; the background doesn't.)
  // Compared by username only when one was captured: without one, the
  // personal logins below are still offered.
  const shared = match ? [] : (await sharedLogins()).filter(i => Vault.loginCoversHost(i.urls, host));
  if (!match && username) {
    const sharedLoose = shared.filter(i => userOf(i).toLowerCase() === username.toLowerCase());
    if (shared.some(i => userOf(i) === username) || sharedLoose.length === 1) return { kind: 'none' };
  }

  let candidates;
  if (match) candidates = [match];
  else if (username) candidates = covering.filter(i => !userOf(i)).sort(newest);
  else candidates = covering.filter(i => Vault.getValue(i, 'password') !== password).sort(newest);
  if (!candidates.length) {
    // No username and nothing personal to update: already saved on one of
    // the site's logins, or the site's login is a shared one.
    if (!username && (covering.length || shared.length)) return { kind: 'none' };
    return { kind: 'new', limit: newLimit, newLimit };
  }
  const withLimit = candidates.map(item => {
    // A 2FA-only login that gains a password starts counting toward the limit.
    const updated = structuredClone(item);
    Vault.getField(updated, 'password').value = password;
    return { item, limit: !Vault.canSaveItem(items, userPlan, updated) };
  });
  return { kind: 'update', item: withLimit[0].item, limit: withLimit[0].limit, candidates: withLimit, newLimit };
}

async function pendingLoginOffer(sender) {
  const found = await readPendingLogin(sender);
  if (!found) return null;
  const { key, pending } = found;
  const offer = { id: pending.id, host: pending.host, username: pending.username };
  const state = await VaultLock.state();
  if (state === 'setup') { await dropPendingLogin(key, pending.id); return null; }
  if (state === 'locked') return { ...offer, kind: 'locked' };
  const plan = await planPendingLogin(pending);
  if (plan.kind === 'none') {
    // Already saved as is: the sign-in went through, its flow is over.
    await dropPendingLogin(key, pending.id);
    await endUsernameStep(sender.tab.id, pending);
    return null;
  }
  return {
    ...offer, kind: plan.kind, name: plan.item?.title || '', limit: !!plan.limit, newLimit: !!plan.newLimit,
    // What an update could apply to (names and usernames only), so the page
    // can let the user pick, or save a new login instead.
    candidates: (plan.candidates || []).map(c => ({
      id: c.item.id, name: c.item.title || '', username: Vault.getValue(c.item, 'username'), limit: c.limit,
    })),
  };
}

// `id` is the capture the offer showed: a choice never applies to another.
// `choice`: 'save' (what the offer proposed: the update of `target`, one of
// its candidates, or a new login), 'new' (a new login even where an update
// was offered), 'never', or anything else to dismiss.
// Counting toward the Free limit and writing happen under one lock, so two
// tabs saving at once can't both pass the check.
async function resolvePendingLogin(sender, id, choice, target) {
  const found = await readPendingLogin(sender);
  if (!found || typeof id !== 'string' || found.pending.id !== id) return { ok: false };
  const { key, pending } = found;
  // The sign-in is settled (saved, dismissed or never): its username step
  // ends with it, so a later password-only form doesn't inherit it.
  await endUsernameStep(sender.tab.id, pending);
  if (choice === 'never') {
    const never = (await chrome.storage.local.get(NEVER_SAVE))[NEVER_SAVE] || [];
    await chrome.storage.local.set({ [NEVER_SAVE]: [...new Set([...never, pending.host])] });
  }
  if (choice !== 'save' && choice !== 'new') { await dropPendingLogin(key, id); return { ok: true }; }

  if ((await VaultLock.state()) !== 'unlocked') return { ok: false };
  return navigator.locks.request('otpilot-item-limit', async () => {
    const plan = await planPendingLogin(pending);
    if (plan.kind === 'none') { await dropPendingLogin(key, id); return { ok: true, kind: 'none' }; }
    const vk = await VaultKeys.getKey();
    let kind;
    if (choice === 'new' || plan.kind === 'new') {
      if (plan.newLimit) return { ok: false, limit: true };
      // The sign-in's start, plus the password page's host when the start
      // doesn't cover it (login.site.com, then site.com): the login must
      // still be offered where its password is typed.
      const urls = [pending.url || pending.host];
      if (!Vault.loginCoversHost(urls, pending.host)) urls.push(pending.host);
      await VaultAccounts.add({
        name: pending.host.replace(/^www\./, ''), email: pending.username, secret: '',
        urls: urls.join('\n'), password: pending.password,
      }, vk);
      kind = 'new';
    } else {
      // Only one of the offer's candidates, re-checked now.
      const chosen = plan.candidates.find(c => c.item.id === (target ?? plan.item.id));
      if (!chosen) return { ok: false };
      if (chosen.limit) return { ok: false, limit: true };
      const current = VaultAccounts.toAccount(chosen.item);
      // A login saved without a username gets the one signed in with.
      const patch = { password: pending.password, ...(!current.email && pending.username ? { email: pending.username } : {}) };
      if (!(await VaultAccounts.update(chosen.item.id, current, patch, vk))) return { ok: false };
      kind = 'update';
    }
    await dropPendingLogin(key, id);
    vaultChangedByPage();
    return { ok: true, kind };
  });
}

chrome.tabs.onRemoved.addListener(tabId => { chrome.storage.session.remove([pendingLoginKey(tabId), pendingUsernameKey(tabId), launchKey(tabId)]); });

// The custom properties of the active theme, from theme.css (the single
// definition of every theme): ":root" is the default, the rest are
// body[data-theme="x"] blocks that override it.
let _themeCss = null;
async function themeVars() {
  _themeCss ??= await (await fetch(chrome.runtime.getURL('theme.css'))).text();
  const { theme } = await chrome.storage.local.get('theme');
  const block = selector => {
    const at = _themeCss.indexOf(`${selector} {`);
    if (at === -1) return {};
    const body = _themeCss.slice(_themeCss.indexOf('{', at) + 1, _themeCss.indexOf('}', at));
    return Object.fromEntries([...body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map(m => [m[1], m[2].trim()]));
  };
  return { ...block(':root'), ...(theme ? block(`body[data-theme="${theme}"]`) : {}) };
}

// Latest email OTP detected by email-reader.js (expires after 10 min).
let _emailOtp = null;

// ── Email codes from Gmail, without opening it ──
// Gmail's Atom feed (/mail/u/N/feed/atom) lists the inbox's unread messages
// with their subject, a snippet and the sender, read with the browser's Gmail
// session (the extension's host permission sends its cookies): no OAuth scope,
// no Gmail tab. Only recent emails from the site asking (EmailCodes.fromSite)
// count; when the snippet doesn't hold the code, the message's print view is
// read (best effort). Nothing is stored: feed answers live 4 s in memory, and
// emails whose code was handed out are remembered (not reused) for 15 min in
// session storage.
const GMAIL_MAX_ACCOUNTS = 4;          // /u/0 … /u/3, the browser's signed-in Gmail accounts
const EMAIL_CODE_MAX_AGE_MS = 10 * 60 * 1000;
const GMAIL_FEED_TTL_MS = 4000;        // pages poll every few seconds: one read for all of them
const GMAIL_TIMEOUT_MS = 3000;         // per request, body included: a slow Gmail never holds up the other sources
let _gmailFeed = null;                 // { at, entries: [{ …entry, u }] }
let _gmailFeedLoading = null;
const _gmailBodies = new Map();        // `${u}:${messageId}` → { text, at } (print view; a failed read is retried after 20 s)
const USED_EMAIL_MS = 15 * 60 * 1000;
let _emailCodeQueue = Promise.resolve(); // one gmailFeedCode at a time: picking + recording an email is one step

const gmailFetchOptions = () => ({ credentials: 'include', cache: 'no-store', signal: AbortSignal.timeout(GMAIL_TIMEOUT_MS) });

// Emails whose code was handed out, { "<account>|<message id>": at } in
// chrome.storage.session (the worker can be stopped between two sign-ins, and
// the old email is still unread). By email, not by digits: another email with
// the same digits is a new code.
async function usedEmails() {
  const { usedEmails = {} } = await chrome.storage.session.get('usedEmails');
  const now = Date.now();
  return Object.fromEntries(Object.entries(usedEmails).filter(([, at]) => now - at <= USED_EMAIL_MS));
}
const emailKey = e => `${e.account}|${e.messageId || `${e.issued}:${e.title}`}`;

async function gmailFeedEntries() {
  if (_gmailFeed && Date.now() - _gmailFeed.at < GMAIL_FEED_TTL_MS) return _gmailFeed.entries;
  _gmailFeedLoading ??= (async () => {
    const entries = [];
    const accounts = new Set();
    for (let u = 0; u < GMAIL_MAX_ACCOUNTS; u++) {
      let xml;
      try {
        const res = await fetch(`https://mail.google.com/mail/u/${u}/feed/atom`, gmailFetchOptions());
        if (!res.ok || !/xml/i.test(res.headers.get('content-type') || '')) break; // signed out / no such account
        xml = await res.text();
      } catch { break; }
      const feed = EmailCodes.parseFeed(xml);
      // An index past the last account answers as /u/0: stop at a repeat.
      if (accounts.has(feed.account)) break;
      accounts.add(feed.account);
      for (const e of feed.entries) entries.push({ ...e, u, account: feed.account });
    }
    _gmailFeed = { at: Date.now(), entries };
    return entries;
  })().finally(() => { _gmailFeedLoading = null; });
  return _gmailFeedLoading;
}

// A message's text from Gmail's print view; null when Gmail doesn't serve it
// (it sends a sign-in page or the inbox instead).
async function gmailMessageText(u, messageId) {
  const key = `${u}:${messageId}`;
  const cached = _gmailBodies.get(key);
  if (cached && (cached.text !== null || Date.now() - cached.at < 20_000)) return cached.text;
  let text = null;
  try {
    const res = await fetch(`https://mail.google.com/mail/u/${u}/?view=pt&search=all&th=${encodeURIComponent(messageId)}`,
      gmailFetchOptions());
    if (res.ok && new URL(res.url).hostname === 'mail.google.com') text = EmailCodes.htmlText(await res.text());
  } catch { /* best effort */ }
  if (_gmailBodies.size > 50) _gmailBodies.clear();
  _gmailBodies.set(key, { text, at: Date.now() });
  return text;
}

function gmailFeedCode(pageHost, expectedLength) {
  const run = _emailCodeQueue.then(() => pickGmailCode(pageHost, expectedLength));
  _emailCodeQueue = run.catch(() => {});
  return run;
}

async function pickGmailCode(pageHost, expectedLength) {
  const now = Date.now();
  const used = await usedEmails();
  const recent = (await gmailFeedEntries())
    .filter(e => now - e.issued <= EMAIL_CODE_MAX_AGE_MS && EmailCodes.fromSite(e, pageHost) && !(emailKey(e) in used))
    .sort((a, b) => b.issued - a.issued);
  // Newest email first, its snippet then (for the newest 3) the whole message:
  // the snippet is the email's first ~100 characters. An older email's code
  // never wins over a newer one that holds its code further down.
  for (const [i, e] of recent.entries()) {
    let code = EmailCodes.pickBestCode(`${e.title}\n${e.summary}`, expectedLength);
    if (!code && i < 3 && e.messageId) code = EmailCodes.pickBestCode(await gmailMessageText(e.u, e.messageId), expectedLength);
    if (code) {
      await chrome.storage.session.set({ usedEmails: { ...used, [emailKey(e)]: now } });
      return code;
    }
  }
  return null;
}

// Asks an open webmail tab's email-reader.js to scan what it shows; a tab
// opened before the extension loaded (MV3 doesn't inject into existing tabs)
// gets the reader injected first.
async function scanWebmailTab(expectedLength) {
  const tabs = await chrome.tabs.query({});
  const emailTab = tabs.find(t => WEBMAIL_RE.test(t.url ?? ''));
  if (!emailTab) return null;
  const ask = () => chrome.tabs.sendMessage(emailTab.id, { action: 'scanEmailOtp', expectedLength });
  try {
    return (await ask())?.code ?? null;
  } catch { /* no reader in the tab */ }
  try {
    await chrome.scripting.executeScript({ target: { tabId: emailTab.id }, files: ['emailCodes.js', 'email-reader.js'] });
    return (await ask())?.code ?? null;
  } catch {
    return null;
  }
}

// Recognised webmail origins. localhost/127.0.0.1 are included for the
// localhost-gated test override (?otpilot_test_provider) in email-reader.js.
const WEBMAIL_RE = /^https?:\/\/(mail\.google\.com|outlook\.live\.com|outlook\.office\.com|mail\.yahoo\.com|mail\.proton\.me|app\.fastmail\.com|mail\.zoho\.com|localhost|127\.0\.0\.1)(?::\d+)?\//;

// Handles OAuth from the background so the popup closing doesn't kill the flow.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.action === 'signInWithGoogle') {
    SupabaseAuth.signInWithGoogle()
      .then(session => sendResponse({ ok: true, session }))
      .catch(err => sendResponse({ ok: false, error: err.message }));
    return true;
  }
  // Email sign-in (a code from the email), from the popup only: the session
  // is written here, like Google's, so only this worker ever refreshes it.
  if (msg.action === 'sendEmailCode' || msg.action === 'verifyEmailCode') {
    if (!fromExtensionPage(_sender)) { sendResponse({ ok: false, error: 'Not allowed' }); return true; }
    const email = String(msg.email || '').trim();
    // The address waiting for its code is stored here, not by the popup: the
    // popup may close before this answer reaches it.
    const run = msg.action === 'sendEmailCode'
      ? SupabaseAuth.sendEmailCode(email)
          .then(() => chrome.storage.session.set({ emailSignIn: { email, at: Date.now() } }))
          .then(() => ({ ok: true }))
      : SupabaseAuth.verifyEmailCode(email, String(msg.code || '').replace(/\D/g, ''))
          .then(session => ({ ok: true, session }));
    run.then(sendResponse).catch(err => sendResponse({ ok: false, error: err.message }));
    return true;
  }
  // Passive push from email-reader.js when a new OTP email arrives.
  if (msg.action === 'emailOtpDetected') {
    // Defense-in-depth: only accept pushes from a real webmail tab, so a
    // malicious page can't poison _emailOtp with an attacker-controlled code.
    if (!WEBMAIL_RE.test(_sender?.tab?.url ?? '')) {
      console.debug('[OTPilot] emailOtpDetected: rejecting push from non-webmail sender', _sender?.tab?.url);
      sendResponse({ ok: false });
      return true;
    }
    // Only cache a valid 4-8 digit code, so a code-less/garbage message can't
    // poison the cache (and later throw on _emailOtp.code.length).
    if (!/^\d{4,8}$/.test(msg.code ?? '')) {
      sendResponse({ ok: false });
      return true;
    }
    _emailOtp = { code: msg.code, expiresAt: Date.now() + 10 * 60 * 1000 };
    sendResponse({ ok: true });
    return true;
  }

  // Active request from content.js when an OTP field needs a code: Gmail's
  // feed first (no Gmail tab needed), then a code an open webmail tab pushed,
  // then a scan of that tab.
  if (msg.action === 'getEmailOtp') {
    // expectedLength = number of digits the login page asks for (or undefined).
    const expectedLength = msg.expectedLength;
    // The page asking, from the sender (never from the message): a feed code
    // is only given to the site that sent the email.
    let pageHost = null;
    try { if (_sender?.frameId === 0) pageHost = new URL(_sender.tab.url).hostname; } catch { /* no tab */ }
    (async () => {
      const fromFeed = pageHost ? await gmailFeedCode(pageHost, expectedLength).catch(() => null) : null;
      if (fromFeed) return fromFeed;
      // Use the cache only if fresh AND its length matches what the page expects.
      if (_emailOtp && Date.now() < _emailOtp.expiresAt &&
          (!expectedLength || _emailOtp.code?.length === expectedLength)) return _emailOtp.code;
      const code = await scanWebmailTab(expectedLength);
      if (code) _emailOtp = { code, expiresAt: Date.now() + 10 * 60 * 1000 };
      return code;
    })().then(code => sendResponse({ code: code ?? null }), () => sendResponse({ code: null }));
    return true;
  }

  // Single point for token refresh — prevents popup + background from refreshing
  // concurrently and triggering Supabase's refresh-token-reuse revocation.
  if (msg.action === 'getAccessToken') {
    SupabaseAuth.getAccessToken()
      .then(token => sendResponse({ token }))
      .catch(() => sendResponse({ token: null }));
    return true;
  }
  if (msg.action === 'fetchImageBuffer') {
    let parsed;
    try { parsed = new URL(msg.url); } catch { sendResponse({ ok: false, error: 'Invalid URL' }); return true; }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      sendResponse({ ok: false, error: 'Invalid URL scheme' });
      return true;
    }
    fetch(msg.url)
      .then(r => r.arrayBuffer())
      .then(buf => sendResponse({ ok: true, data: Array.from(new Uint8Array(buf)) }))
      .catch(err => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  // Resolve domain favicons: ask the backend (when signed in) or the public CDN
  // for each domain, download the PNG once, and cache it locally as a data URL.
  if (msg.action === 'resolveIcons') {
    handleResolveIcons(msg.domains || [], msg.hints || {}, msg.prune === true)
      .then(updated => sendResponse({ updated }))
      .catch(() => sendResponse({ updated: {} }));
    return true;
  }

  // A content script (on some tab) thinks its auto-submitted OTP form didn't
  // go through — see content.js's recordAutoSubmitFailure for the "why".
  if (msg.action === 'recordAutoSubmitFailure') {
    recordAutoSubmitFailure(msg.hostname)
      .then(flagged => sendResponse({ flagged }))
      .catch(() => sendResponse({ flagged: false }));
    return true;
  }

  // Vault lock for content scripts: 'setup' | 'locked' | 'unlocked'.
  if (msg.action === 'vaultState') {
    VaultLock.state()
      .then(state => sendResponse({ state }))
      .catch(() => sendResponse({ state: 'locked' }));
    return true;
  }

  if (msg.action === 'vaultUnlock') {
    VaultLock.unlock(String(msg.password ?? ''))
      .then(ok => sendResponse({ ok }))
      .catch(() => sendResponse({ ok: false }));
    return true;
  }

  if (msg.action === 'vaultAccounts') {
    accountsForContent()
      .then(sendResponse)
      .catch(() => sendResponse({ locked: true, activeIndex: 0, accounts: [] }));
    return true;
  }

  // "Add to OTPilot" from a 2FA setup page (after any in-page unlock).
  if (msg.action === 'vaultAttachCandidates') {
    attachCandidates(_sender, msg.email).then(logins => sendResponse({ logins })).catch(() => sendResponse({ logins: [] }));
    return true;
  }

  if (msg.action === 'vaultAddAccount') {
    (async () => {
      if ((await VaultLock.state()) !== 'unlocked') return { ok: false };
      const vk = await VaultKeys.getKey();
      // The code goes to an existing login of this site: only one of the
      // candidates for this sender, re-checked now (still without a code).
      if (typeof msg.attachTo === 'string') {
        if (!(await attachCandidates(_sender)).some(c => c.id === msg.attachTo)) return { ok: false };
        const accounts = await VaultAccounts.load(vk);
        const index = accounts.findIndex(a => a._id === msg.attachTo);
        const current = accounts[index];
        const secret = String(msg.account?.secret || '');
        // Another tab may have added a code meanwhile: never replace one (the
        // write itself also re-checks the login is still as loaded).
        if (!current || !secret || current.secret) return { ok: false };
        // The page's host joins the login's URLs, so the code auto-fills here
        // (the OTP matcher doesn't treat a saved www. host as its subdomains').
        const host = senderHost(_sender);
        const urls = String(current.urls || '').split('\n').map(u => u.trim()).filter(Boolean);
        const patch = {
          secret,
          ...(!current.email && msg.account.email ? { email: String(msg.account.email) } : {}),
          ...(host && !urls.some(u => u.toLowerCase() === host) ? { urls: [...urls, host].join('\n') } : {}),
        };
        if (!(await VaultAccounts.update(current._id, current, patch, vk))) return { ok: false };
        await chrome.storage.local.set({ activeIndex: index });
        vaultChangedByPage();
        return { ok: true, index, attached: true, name: current.name };
      }
      const index = await VaultAccounts.add(msg.account, vk);
      await chrome.storage.local.set({ activeIndex: index });
      vaultChangedByPage();
      return { ok: true, index };
    })().then(sendResponse).catch(() => sendResponse({ ok: false }));
    return true;
  }

  // "Save this site to <account>?" — only if the account is still what the
  // page saw (`expected`).
  if (msg.action === 'vaultUpdateAccount') {
    (async () => {
      if ((await VaultLock.state()) !== 'unlocked') return { ok: false };
      const ok = await VaultAccounts.update(msg.id, msg.expected, msg.patch, await VaultKeys.getKey());
      if (ok) vaultChangedByPage();
      return { ok };
    })().then(sendResponse).catch(() => sendResponse({ ok: false }));
    return true;
  }

  // Sign-in forms (forms.js). The page's host comes from the sender (the
  // browser), never from the message, and only the top frame is served. The
  // list carries no passwords; one is released only for a login the user
  // picked whose saved URLs cover that host.
  if (msg.action === 'vaultLoginsForPage') {
    loginsForPage(_sender).then(sendResponse).catch(() => sendResponse({ state: 'locked', logins: [] }));
    return true;
  }

  if (msg.action === 'vaultLaunch') {
    launchLogin(_sender, msg.id).then(sendResponse).catch(() => sendResponse({ ok: false }));
    return true;
  }

  if (msg.action === 'vaultLaunchFill') {
    launchFill(_sender, msg.step).then(sendResponse).catch(() => sendResponse({ ok: false }));
    return true;
  }

  if (msg.action === 'vaultFillLogin') {
    fillLogin(_sender, msg.id, msg.usernameOnly === true).then(sendResponse).catch(() => sendResponse({ ok: false }));
    return true;
  }

  // Saving a submitted sign-in (forms.js): capture, then ask on the next page.
  if (msg.action === 'vaultCaptureLogin') {
    captureLogin(_sender, msg).finally(() => sendResponse({}));
    return true;
  }

  if (msg.action === 'vaultCaptureUsername') {
    captureUsername(_sender, msg).finally(() => sendResponse({}));
    return true;
  }

  if (msg.action === 'vaultPendingLogin') {
    pendingLoginOffer(_sender).then(sendResponse).catch(() => sendResponse(null));
    return true;
  }

  if (msg.action === 'vaultResolvePendingLogin') {
    resolvePendingLogin(_sender, msg.id, msg.choice, typeof msg.target === 'string' ? msg.target : undefined).then(sendResponse).catch(() => sendResponse({ ok: false }));
    return true;
  }

  // The user's theme for in-page UI (content scripts can't load theme.css).
  if (msg.action === 'themeVars') {
    themeVars().then(sendResponse).catch(() => sendResponse({}));
    return true;
  }

  // A content script filled a code: counts as activity for the auto-lock.
  if (msg.action === 'vaultTouch') {
    VaultLock.touch().finally(() => sendResponse({}));
    return true;
  }
});

// ── OTP auto-submit failure tracking ────────────────────────────────────────

// Per-hostname promise chain so that two tabs reporting a failure on the same
// host around the same time serialize through this one JS context instead of
// each doing an independent chrome.storage read-modify-write and racing.
const _autoSubmitFailureLocks = new Map();

function withHostnameLock(hostname, fn) {
  const prev = _autoSubmitFailureLocks.get(hostname) || Promise.resolve();
  const next = prev.then(fn, fn);
  _autoSubmitFailureLocks.set(hostname, next.catch(() => {}));
  return next;
}

// Two separate strikes (i.e. two different page loads reporting a failure —
// content.js only calls this once per minute per host) before the host gets
// flagged; see content.js's recordAutoSubmitFailure for why one apparent
// failure isn't enough on its own. Returns whether this call flagged it.
async function recordAutoSubmitFailure(hostname) {
  return withHostnameLock(hostname, async () => {
    const strikesKey = `noAutoSubmitStrikes:${hostname}`;
    const d = await new Promise(r => chrome.storage.local.get(strikesKey, r));
    const strikes = (d[strikesKey] || 0) + 1;
    if (strikes < 2) {
      await new Promise(r => chrome.storage.local.set({ [strikesKey]: strikes }, r));
      return false;
    }
    // Key format must match noAutoSubmitKey() in content.js.
    await new Promise(r => chrome.storage.local.set({ [`noAutoSubmit:${hostname}`]: true }, r));
    return true;
  });
}

// ── Background sync polling ───────────────────────────────────────────────────

const API_URL            = CONFIG.API_URL;
const S3_PUBLIC_BASE_URL = (CONFIG.S3_PUBLIC_BASE_URL || '').replace(/\/+$/, '');
const ALARM_NAME         = 'otpilot-sync-poll';
const POLL_MINUTES       = 5;

// ── Domain favicon resolution + local cache ───────────────────────────────────

const ICON_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const ICON_NONE_TTL_MS = 24 * 60 * 60 * 1000;

// Mirror of the backend's domain normalization (api/src/routes/icons.rs).
function normalizeIconDomain(input) {
  if (!input) return null;
  let d = String(input).trim().toLowerCase()
    .replace(/^\*\./, '').replace(/^https?:\/\//, '').replace(/^www\./, '');
  d = d.split('/')[0].split(':')[0].replace(/\.+$/, '');
  if (!d || d.length > 253 || !d.includes('.')) return null;
  if (!/^[a-z0-9.-]+$/.test(d)) return null;
  return d;
}

// ArrayBuffer → data URL, without FileReader (unavailable in service workers).
function bytesToDataUrl(buf, contentType) {
  const bytes = new Uint8Array(buf);
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return `data:${contentType || 'image/png'};base64,${btoa(bin)}`;
}

// Per domain returns one of:
//   { url }     → download these bytes
//   { none:true}→ authoritative "no icon" (safe to negative-cache)
//   {}          → unknown/pending → retry next time (do NOT negative-cache)
// /icons/resolve is public, so we always call it (icons work for free /
// not-signed-in users too); the Bearer token is attached only when present.
// On network failure we fall back to a deterministic CDN guess (a 404 there is
// only "unknown", so it must not be cached as authoritative "none").
async function resolveIconUrls(domains, hints) {
  const out = {};
  let token = null;
  try { token = await SupabaseAuth.getAccessToken(); } catch { /* not signed in */ }

  try {
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(`${API_URL}/icons/resolve`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ domains, hints }),
    });
    if (res.ok) {
      const data = await res.json();
      for (const d of domains) {
        const r = data[d];
        if (r && r.status === 'ok' && r.url) out[d] = { url: r.url };
        else if (r && r.status === 'none') out[d] = { none: true };
        else out[d] = {}; // pending / missing → retry later
      }
      return out;
    }
  } catch { /* offline / API down → CDN guess below */ }

  for (const d of domains) {
    out[d] = S3_PUBLIC_BASE_URL ? { url: `${S3_PUBLIC_BASE_URL}/icons/${d}.png` } : {};
  }
  return out;
}

// `prune` is set when `rawDomains` is the full current account set (popup), so
// stale iconCache entries for deleted accounts can be evicted. It must NOT be set
// for single-domain calls (e.g. enrollment) or they'd wipe the rest of the cache.
// Every change to `iconCache` is a read-modify-write of the whole object, run
// one at a time here (`fn(cache)` edits it, returns true to save), so one
// writer never puts back entries another just removed.
let _iconCacheQueue = Promise.resolve();
function updateIconCache(fn) {
  const run = _iconCacheQueue.then(async () => {
    const { iconCache = {} } = await chrome.storage.local.get('iconCache');
    if (fn(iconCache)) await chrome.storage.local.set({ iconCache });
  });
  _iconCacheQueue = run.catch(() => {});
  return run;
}

async function handleResolveIcons(rawDomains, hints, prune) {
  const domains = [...new Set(rawDomains.map(normalizeIconDomain).filter(Boolean))];
  if (!domains.length) return {};

  const { iconCache = {} } = await chrome.storage.local.get('iconCache');

  // Remap hints onto normalized domains.
  const normHints = {};
  for (const [k, v] of Object.entries(hints || {})) {
    const nd = normalizeIconDomain(k);
    if (nd && v) normHints[nd] = v;
  }

  // A "no icon" answer is kept for less time than an icon, and asked again
  // right away when the page itself says where its icon is (a hint): the
  // server's blind fetch may have been blocked where the page's link works.
  const now = Date.now();
  const need = domains.filter(d => {
    const e = iconCache[d];
    if (!e) return true;
    if (!e.dataUrl) return !!normHints[d] || (now - e.fetchedAt) > ICON_NONE_TTL_MS;
    return (now - e.fetchedAt) > ICON_TTL_MS;
  });

  const updated = {};
  if (need.length) {
    const resolved = await resolveIconUrls(need, normHints);
    for (const d of need) {
      const info = resolved[d] || {};
      if (info.none) { updated[d] = { dataUrl: null, fetchedAt: now }; continue; }
      if (!info.url) continue; // unknown/pending → retry later, don't cache
      try {
        const r = await fetch(info.url);
        if (r.ok) {
          const buf = await r.arrayBuffer();
          const ct  = r.headers.get('content-type') || 'image/png';
          updated[d] = { dataUrl: bytesToDataUrl(buf, ct), fetchedAt: now };
        }
        // non-ok (e.g. 404 on a CDN guess) → leave uncached so it retries later
      } catch { /* transient — leave uncached to retry */ }
    }
  }

  // Written against the cache as it is now (not the copy read above, which a
  // download may have outlived): this call's results, and the eviction of
  // domains no longer in the account set.
  await updateIconCache(cache => {
    let changed = false;
    if (prune) {
      const keep = new Set(domains);
      for (const d of Object.keys(cache)) {
        if (!keep.has(d)) { delete cache[d]; changed = true; }
      }
    }
    for (const [d, e] of Object.entries(updated)) { cache[d] = e; changed = true; }
    return changed;
  });
  return updated;
}


// ── Notices: team invitations, "added to a collection", "shared with you" ──
// Counted on the toolbar badge (no system notifications); the popup lists
// them under the header's bell. Refreshed on the poll alarm, at startup, on
// sign-in and whenever the popup asks (it opens, or acted on one).
// The signed-in account (read from storage, so it's current whatever order
// the storage events arrive in): an answer for an account that's no longer
// signed in is dropped instead of showing its count.
const noticesAccount = async () => (await SupabaseAuth.getSession().catch(() => null))?.user?.id ?? null;

async function refreshNotices() {
  const account = await noticesAccount();
  let data = { invites: [], notices: [] };
  try {
    const token = await SupabaseAuth.getAccessToken();
    if (token) {
      const res = await fetch(`${API_URL}/notifications`, { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) return null; // keep the badge as it was
      data = await res.json();
    }
  } catch { return null; } // offline
  if ((await noticesAccount()) !== account) return null;
  const agentsWaiting = (data.agents?.pending || 0) + (data.agents?.requests || 0);
  const n = (data.invites?.length || 0) + (data.notices?.length || 0) + agentsWaiting;
  await chrome.action.setBadgeText({ text: n ? String(Math.min(n, 99)) : '' });
  if (n) await chrome.action.setBadgeBackgroundColor({ color: '#0284c7' });
  // An AI agent is waiting for an answer: check every 30 s (the shortest
  // alarm) instead of every poll, until nothing waits.
  if (agentsWaiting) chrome.alarms.create(AGENTS_ALARM, { periodInMinutes: 0.5 });
  else chrome.alarms.clear(AGENTS_ALARM);
  return data;
}

const AGENTS_ALARM = 'otpilot-agents-waiting';
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === AGENTS_ALARM) refreshNotices();
});

// AI agents' copies follow the vault on the poll alarm too — also for Free
// vaults, which don't sync (needs a session and an unlocked vault).
async function refreshAgentCopies() {
  try {
    if (!(await SupabaseAuth.getSession())) return;
    if ((await VaultLock.state()) !== 'unlocked') return;
    const key = await VaultKeys.getKey();
    if (key) await Agents.syncCopies(key);
  } catch { /* offline */ }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action !== 'refreshNotices') return;
  if (!fromExtensionPage(sender)) { sendResponse(null); return; }
  refreshNotices().then(sendResponse);
  return true;
});

// Signing in shows the count; signing out clears it. A token refresh also
// rewrites the session, so only its appearing or going away counts.
chrome.storage.onChanged.addListener((changes, area) => {
  const c = changes.cloudSession;
  if (area !== 'local' || !c || !!c.oldValue === !!c.newValue) return;
  if (c.newValue) refreshNotices();
  else chrome.action.setBadgeText({ text: '' });
});

// ── Unlocking the web dashboard ──────────────────────────────────────────────
// The dashboard (CONFIG.DASHBOARD_URL, and only it: manifest
// externally_connectable plus the origin check below) can ask for the vault
// key and the team private key, so the user doesn't paste their recovery key
// there. Nothing is handed over without a click in an extension window that
// names the account (dashboardUnlock.html, which can unlock the vault too),
// only to a dashboard showing the account this extension is signed in to, and
// only with sync on (the dashboard reads the synced vault). One request at a
// time; a new one replaces it.
const DASHBOARD_ORIGIN = (() => { try { return new URL(CONFIG.DASHBOARD_URL).origin; } catch { return null; } })();
const DASHBOARD_UNLOCK_TTL = 2 * 60 * 1000;
let _dashboardUnlock = null; // { id, userId, email, windowId, resolve, timer }

// Ends `req` with `answer` — only while it's still the open request, so an
// answer can never reach a request that replaced it.
function endDashboardUnlock(req, answer) {
  if (!req || _dashboardUnlock !== req) return false;
  _dashboardUnlock = null;
  clearTimeout(req.timer);
  req.resolve(answer);
  if (req.windowId != null) chrome.windows.remove(req.windowId).catch(() => {});
  return true;
}

async function syncOn() {
  const { syncEnabled, syncKey } = await chrome.storage.local.get(['syncEnabled', 'syncKey']);
  return !!(syncEnabled || syncKey);
}

// 'same' | 'other' | 'signed-out': the account the dashboard shows vs this one's.
// Read from storage, not SupabaseAuth's cache: this worker's copy outlives a
// sign-out done in the popup.
async function dashboardAccount(userId) {
  const { cloudSession: session } = await chrome.storage.local.get('cloudSession');
  if (!session?.user?.id) return { account: 'signed-out' };
  return { account: typeof userId === 'string' && session.user.id === userId ? 'same' : 'other', session };
}

async function requestDashboardUnlock(userId) {
  const { account, session } = await dashboardAccount(userId);
  if (account !== 'same') return { ok: false, error: account };
  if (!(await syncOn())) return { ok: false, error: 'no-sync' };
  endDashboardUnlock(_dashboardUnlock, { ok: false, error: 'superseded' });
  const req = { id: crypto.randomUUID(), userId, email: session.user.email || '', windowId: null };
  const answer = new Promise(resolve => { req.resolve = resolve; });
  req.timer = setTimeout(() => endDashboardUnlock(req, { ok: false, error: 'expired' }), DASHBOARD_UNLOCK_TTL);
  _dashboardUnlock = req;
  const { id } = req;
  try {
    const win = await chrome.windows.create({
      url: chrome.runtime.getURL(`dashboardUnlock.html?id=${id}`), type: 'popup', width: 400, height: 360, focused: true,
    });
    // Answered or replaced while the window was opening: it has nothing to ask.
    if (_dashboardUnlock === req) req.windowId = win.id;
    else chrome.windows.remove(win.id).catch(() => {});
  } catch {
    endDashboardUnlock(req, { ok: false, error: 'failed' });
  }
  return answer;
}

// The approval window: what to show (null once the request is gone). Also its
// keepalive: it asks every 20 s, so the worker isn't stopped while it waits.
async function dashboardUnlockInfo(id) {
  const req = _dashboardUnlock;
  if (!req || req.id !== id) return null;
  return { email: req.email, site: new URL(DASHBOARD_ORIGIN).host, state: await VaultLock.state() };
}

async function answerDashboardUnlock(id, allow) {
  const req = _dashboardUnlock;
  if (!req || req.id !== id) return { ok: false, error: 'gone' };
  if (!allow) { endDashboardUnlock(req, { ok: false, error: 'denied' }); return { ok: true }; }
  if ((await VaultLock.state()) !== 'unlocked') return { ok: false, error: 'locked' };
  // Signed out, switched account or sync turned off (a remote disconnect)
  // while the window was open.
  const account = (await dashboardAccount(req.userId)).account;
  if (account !== 'same') return endDashboardUnlock(req, { ok: false, error: account }) ? { ok: true } : { ok: false, error: 'gone' };
  if (!(await syncOn())) return endDashboardUnlock(req, { ok: false, error: 'no-sync' }) ? { ok: true } : { ok: false, error: 'gone' };
  const vaultKey = await VaultKeys.getKey();
  if (!vaultKey) return { ok: false, error: 'locked' };
  const teamKey = await TeamKeys.exportPrivJwk().catch(() => null);
  const answer = teamKey ? { ok: true, vaultKey, teamKey } : { ok: false, error: 'no-team-key' };
  // The keys go to this request only; one that replaced it meanwhile gets nothing.
  if (!endDashboardUnlock(req, answer)) return { ok: false, error: 'gone' };
  if (teamKey) await VaultLock.touch();
  return { ok: true };
}

chrome.runtime.onMessageExternal.addListener((msg, sender, sendResponse) => {
  // The dashboard's own top-level page only.
  if (!DASHBOARD_ORIGIN || sender.origin !== DASHBOARD_ORIGIN || !sender.tab || sender.frameId !== 0) return;
  if (msg?.action === 'hello') {
    dashboardAccount(msg.userId).then(({ account }) => sendResponse({ ok: true, account }));
    return true;
  }
  if (msg?.action === 'unlockVault') {
    requestDashboardUnlock(msg.userId).then(sendResponse, () => sendResponse({ ok: false, error: 'failed' }));
    return true;
  }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action !== 'dashboardUnlockInfo' && msg.action !== 'dashboardUnlockAnswer') return;
  if (!fromExtensionPage(sender)) { sendResponse(null); return; }
  const run = msg.action === 'dashboardUnlockInfo'
    ? dashboardUnlockInfo(msg.id)
    : answerDashboardUnlock(msg.id, msg.allow === true);
  run.then(sendResponse, () => sendResponse(null));
  return true;
});

// Closing the window says no.
chrome.windows.onRemoved.addListener(windowId => {
  if (_dashboardUnlock?.windowId === windowId) endDashboardUnlock(_dashboardUnlock, { ok: false, error: 'denied' });
});

// Inactivity auto-lock: VaultLock.state() locks the vault once its deadline
// passes. It also runs on every read of the state, so this alarm only covers
// the case where nothing asks for a while.
const AUTOLOCK_ALARM = 'otpilot-autolock';

// ── Uninstall survey ──────────────────────────────────────────────────────────
// Chrome opens this page right after the extension is removed (nothing of the
// extension runs then): the web's short, anonymous "why did you leave?" form.
// Only the version, the plan and when it was installed go along — nothing
// that identifies the user: the install date (the day only — the page turns
// it into days installed, so it's right whenever the removal happens). Kept
// current at install, startup and plan changes.
async function setUninstallSurvey() {
  try {
    const { installedAt, userPlan = 'free' } = await chrome.storage.local.get(['installedAt', 'userPlan']);
    const q = new URLSearchParams({ v: chrome.runtime.getManifest().version, p: userPlan });
    // Unknown for installs from before this was recorded.
    if (installedAt) q.set('i', new Date(installedAt).toISOString().slice(0, 10));
    await chrome.runtime.setUninstallURL(`${CONFIG.DASHBOARD_URL}/goodbye?${q}`);
  } catch { /* best effort */ }
}

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  if (reason === 'install') await chrome.storage.local.set({ installedAt: Date.now() });
  if (reason === 'update') await forgetMissingIcons();
  setUninstallSurvey();
});

// A new version may come with a server that finds more icons: drop the cached
// "no icon" answers so they're asked again now, not after ICON_NONE_TTL_MS.
function forgetMissingIcons() {
  return updateIconCache(cache => {
    let changed = false;
    for (const [d, e] of Object.entries(cache)) {
      if (!e || !e.dataUrl) { delete cache[d]; changed = true; }
    }
    return changed;
  });
}
chrome.runtime.onStartup.addListener(setUninstallSurvey);
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.userPlan) setUninstallSurvey();
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(ALARM_NAME, { periodInMinutes: POLL_MINUTES });
  chrome.alarms.create(AUTOLOCK_ALARM, { periodInMinutes: 1 });
});

chrome.runtime.onStartup.addListener(() => {
  refreshNotices();
  chrome.alarms.get(ALARM_NAME, alarm => {
    if (!alarm) chrome.alarms.create(ALARM_NAME, { periodInMinutes: POLL_MINUTES });
  });
  chrome.alarms.get(AUTOLOCK_ALARM, alarm => {
    if (!alarm) chrome.alarms.create(AUTOLOCK_ALARM, { periodInMinutes: 1 });
  });
});

chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === AUTOLOCK_ALARM) VaultLock.state().catch(() => {});
});

chrome.alarms.onAlarm.addListener(async alarm => {
  if (alarm.name !== ALARM_NAME) return;

  const session = await SupabaseAuth.getSession();
  if (!session) return;
  refreshNotices(); // every signed-in user, sync or not (invitees are often on Free)
  refreshAgentCopies();

  // syncEnabled is the 2.0 flag; a v1 plaintext syncKey means the same until
  // CloudSync converts it into the vault key on the next popup open.
  const stored = await new Promise(r =>
    chrome.storage.local.get(['syncEnabled', 'syncKey', 'lastSyncedAt'], r)
  );
  if (!stored.syncEnabled && !stored.syncKey) return;
  queueVaultSync(); // items: pushed and pulled here (unlocked vault only)

  try {
    const token = await SupabaseAuth.getAccessToken();
    if (!token) return;

    const res = await fetch(`${API_URL}/accounts`, {
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
    });
    if (!res.ok) return;
    const body = await res.json();
    if (!body) return;

    const serverUpdatedAt = body.updated_at;
    const lastSyncedAt    = stored.lastSyncedAt ?? null;
    if (lastSyncedAt !== null && serverUpdatedAt <= lastSyncedAt) return;

    chrome.runtime.sendMessage({ action: 'serverDataChanged' }).catch(() => {
      chrome.storage.local.set({ pendingServerSync: true });
    });
  } catch { /* offline */ }
});
