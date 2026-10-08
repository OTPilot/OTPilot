'use strict';

importScripts(
  'config.js', 'supabase.js',
  // 2.0 vault lock: the unlocked vault key lives in chrome.storage.session,
  // which content scripts can't read, so they ask this worker (vaultState /
  // vaultUnlock below).
  'vaultCrypto.js', 'vaultKeys.js', 'vaultStore.js', 'vault.js', 'vaultMigration.js',
  'vaultAccounts.js', 'cloudSync.js', 'vaultLock.js', 'vaultSync.js',
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

// A page changed the vault: upload it, and let an open popup redraw.
function vaultChangedByPage() {
  chrome.runtime.sendMessage({ action: 'serverDataChanged' }).catch(() => {});
  queueVaultSync();
}

// Accounts for content scripts. Unlocked: the decrypted list. Locked: only the
// plaintext index (name, URL patterns, autofill — no secrets), or, for a v1
// user not migrated yet, the same fields from the old plaintext list.
async function accountsForContent() {
  const { activeIndex = 0 } = await chrome.storage.local.get('activeIndex');
  if ((await VaultLock.state()) === 'unlocked') {
    // No passwords: content scripts don't fill them yet, so they don't get them.
    const accounts = (await VaultAccounts.load(await VaultKeys.getKey())).map(({ password, ...acc }) => acc);
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

// Logins that can fill the sender page's sign-in form: unlocked, those with a
// password whose URLs cover the host ({ id, name, username }); locked, the
// same from the plaintext index ({ id, name }), to offer an unlock.
// Logins of the team collections unlocked this session (vaultCollections.js:
// keys in chrome.storage.session `collectionKeys`, cleared on lock; records
// under cr:<cid>:<id>). Only read here, for filling.
async function sharedLogins() {
  const keys = (await chrome.storage.session.get('collectionKeys')).collectionKeys || {};
  if (!Object.keys(keys).length) return [];
  const out = [];
  for (const [k, rec] of Object.entries(await chrome.storage.local.get(null))) {
    const m = /^cr:([0-9a-f-]{36}):/.exec(k);
    if (!m || !keys[m[1]]) continue;
    try {
      const item = await VaultCrypto.decryptItem(rec, keys[m[1]]);
      if (item.type === 'login') out.push(item);
    } catch { /* unreadable: skipped */ }
  }
  return out;
}

// One shared login by id: only that record is decrypted (a direct lookup in
// each unlocked collection), not every record.
async function sharedLogin(id) {
  const keys = (await chrome.storage.session.get('collectionKeys')).collectionKeys || {};
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
      .map(i => ({ id: i.id, name: i.title || host, username: Vault.getValue(i, 'username') }));
    return { state, logins };
  }
  const logins = (await VaultAccounts.readIndex())
    .filter(e => e.hasPassword && Vault.loginCoversHost(e.urls, host))
    .map(e => ({ id: e.id, name: e.name || host }));
  return { state, logins };
}

async function fillLogin(sender, id) {
  const host = senderHost(sender);
  if (!host || typeof id !== 'string' || (await VaultLock.state()) !== 'unlocked') return { ok: false };
  const item = (await VaultStore.get(id, await VaultKeys.getKey()).catch(() => null))
    || (await sharedLogin(id));
  const password = item && Vault.getValue(item, 'password');
  if (!item || item.type !== 'login' || !password || !Vault.loginCoversHost(item.urls, host)) return { ok: false };
  await VaultLock.touch();
  return { ok: true, username: Vault.getValue(item, 'username'), password };
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
  const username = typeof msg.username === 'string' ? msg.username.trim().slice(0, 512) : '';
  const id = crypto.randomUUID(); // offers and choices name the capture they're about
  await chrome.storage.session.set({ [pendingLoginKey(sender.tab.id)]: { id, host, username, password, at: Date.now() } });
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
  const loose = covering.filter(i => userOf(i).toLowerCase() === username.toLowerCase());
  const match = covering.find(i => userOf(i) === username) || (loose.length === 1 ? loose[0] : null);
  if (match && Vault.getValue(match, 'password') === password) return { kind: 'none' };

  // A team collection already has this login: never offer a personal copy.
  // (A changed password there is updated from the popup, which writes to the
  // collection; the background doesn't.)
  if (!match) {
    const shared = (await sharedLogins()).filter(i => Vault.loginCoversHost(i.urls, host));
    const sharedLoose = shared.filter(i => userOf(i).toLowerCase() === username.toLowerCase());
    if (shared.some(i => userOf(i) === username) || sharedLoose.length === 1) return { kind: 'none' };
  }

  let candidates;
  if (match) candidates = [match];
  else if (username) candidates = covering.filter(i => !userOf(i)).sort(newest);
  else candidates = covering.filter(i => Vault.getValue(i, 'password') !== password).sort(newest);
  if (!candidates.length) {
    if (!username && covering.length) return { kind: 'none' }; // already saved on one of them
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
  if (plan.kind === 'none') { await dropPendingLogin(key, pending.id); return null; }
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
      await VaultAccounts.add({
        name: pending.host.replace(/^www\./, ''), email: pending.username, secret: '',
        urls: pending.host, password: pending.password,
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

chrome.tabs.onRemoved.addListener(tabId => { chrome.storage.session.remove(pendingLoginKey(tabId)); });

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

  // Active request from content.js when an OTP field needs a code.
  if (msg.action === 'getEmailOtp') {
    // expectedLength = number of digits the login page asks for (or undefined).
    const expectedLength = msg.expectedLength;
    // Use the cache only if fresh AND its length matches what the page expects.
    if (_emailOtp && Date.now() < _emailOtp.expiresAt &&
        (!expectedLength || _emailOtp.code?.length === expectedLength)) {
      sendResponse({ code: _emailOtp.code });
      return true;
    }
    chrome.tabs.query({}, tabs => {
      const emailTab = tabs.find(t => WEBMAIL_RE.test(t.url ?? ''));
      if (!emailTab) {
        console.debug('[OTPilot] getEmailOtp: no webmail tab found');
        sendResponse({ code: null }); return;
      }

      function handleCode(code) {
        if (code) _emailOtp = { code, expiresAt: Date.now() + 10 * 60 * 1000 };
        sendResponse({ code: code ?? null });
      }

      // Try messaging the pre-injected content script first.
      // If the tab was open before the extension loaded (MV3 doesn't re-inject into
      // existing tabs), sendMessage fails → fall back to scripting.executeScript.
      chrome.tabs.sendMessage(emailTab.id, { action: 'scanEmailOtp', expectedLength }, r => {
        if (!chrome.runtime.lastError && r?.code != null) { handleCode(r.code); return; }
        console.debug('[OTPilot] getEmailOtp: content script not responding, falling back to scripting.executeScript');
        // Fallback: inline scan via scripting API (no pre-injected script needed).
        chrome.scripting.executeScript({
          target: { tabId: emailTab.id },
          // ⚠️ INVARIANT: this duplicates the scan logic in email-reader.js
          // (getOpenEmailBodies + getRows + pickBestCode). Keep both in sync.
          // Must be fully self-contained — no references to outer scope.
          func: (provider, expectedLength) => {
            const CODE_RE = /\b\d{4,8}\b/g;
            const OTP_KEYWORDS = /(c[oó]digo|code|verificaci[oó]n|verification|passcode|one[- ]?time|2fa|otp|pin|security|seguridad|c[oó]d\.?|auth)/i;
            const bodySelectors = {
              gmail:    '.a3s',
              outlook:  '[role="document"], div[aria-label*="essage body"]',
              yahoo:    '[data-test-id="message-view-body"], .msg-body',
              proton:   '.message-content',
              fastmail: '.v-Message-body, [class*="MessageView"]',
              zoho:     '.zmail-msg-content, .msgBodyDiv',
            };
            const rowSelectors = {
              gmail:    'tr[jsmodel]',
              outlook:  '[role="option"][data-convid]',
              yahoo:    '[data-item-id]',
              proton:   '[data-element-id]',
              fastmail: '[data-msg-id]',
              zoho:     '.maillist-item[data-id]',
            };
            // Requires an OTP keyword near the digits; honours expectedLength.
            // Signature kept identical to email-reader.js pickBestCode (invariant).
            function pickBestCode(text, expectedLength) {
              if (!text) return null;
              const matches = [];
              for (const m of text.matchAll(CODE_RE)) matches.push({ code: m[0], idx: m.index });
              if (!matches.length) return null;
              let best = null, bestScore = -Infinity;
              for (let i = 0; i < matches.length; i++) {
                const { code, idx } = matches[i];
                if (expectedLength && code.length !== expectedLength) continue;
                const ctx = text.slice(Math.max(0, idx - 80), idx + code.length + 80);
                if (!OTP_KEYWORDS.test(ctx)) continue;
                let score = 100;
                if (code.length === 6) score += 10;
                if (code.length === 4 && /^(19|20)\d\d$/.test(code)) score -= 50;
                score -= i;
                if (score > bestScore) { bestScore = score; best = code; }
              }
              return best;
            }
            const MAX_AGE_MS = 30 * 60 * 1000;
            function rowIsRecent(row) {
              const cands = [];
              for (const t of row.querySelectorAll('time[datetime]')) cands.push(t.getAttribute('datetime'));
              for (const el of row.querySelectorAll('[title], [aria-label]')) {
                cands.push(el.getAttribute('title'), el.getAttribute('aria-label'));
              }
              let sawValid = false;
              for (const c of cands) {
                if (!c) continue;
                const ms = Date.parse(c);
                if (Number.isNaN(ms)) continue;
                sawValid = true;
                if (Date.now() - ms <= MAX_AGE_MS) return true;
              }
              return !sawValid;
            }
            const bodies = Array.from(document.querySelectorAll(bodySelectors[provider] || '.a3s')).slice(0, 5);
            for (const body of bodies) {
              const code = pickBestCode(body.innerText || '', expectedLength);
              if (code) return code;
            }
            const rows = Array.from(document.querySelectorAll(rowSelectors[provider] || 'tr[jsmodel]')).slice(0, 5);
            for (const row of rows) {
              if (!rowIsRecent(row)) continue;
              const code = pickBestCode(row.innerText || '', expectedLength);
              if (code) return code;
            }
            return null;
          },
          args: [
            /mail\.google\.com/.test(emailTab.url)     ? 'gmail'    :
            /outlook\.(live|office)\.com/.test(emailTab.url) ? 'outlook' :
            /mail\.yahoo\.com/.test(emailTab.url)      ? 'yahoo'    :
            /mail\.proton\.me/.test(emailTab.url)      ? 'proton'   :
            /app\.fastmail\.com/.test(emailTab.url)    ? 'fastmail' :
            'zoho',
            expectedLength ?? null,
          ],
        }, results => {
          if (chrome.runtime.lastError) { sendResponse({ code: null }); return; }
          handleCode(results?.[0]?.result ?? null);
        });
      });
    });
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
  if (msg.action === 'vaultAddAccount') {
    (async () => {
      if ((await VaultLock.state()) !== 'unlocked') return { ok: false };
      const index = await VaultAccounts.add(msg.account, await VaultKeys.getKey());
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

  if (msg.action === 'vaultFillLogin') {
    fillLogin(_sender, msg.id).then(sendResponse).catch(() => sendResponse({ ok: false }));
    return true;
  }

  // Saving a submitted sign-in (forms.js): capture, then ask on the next page.
  if (msg.action === 'vaultCaptureLogin') {
    captureLogin(_sender, msg).finally(() => sendResponse({}));
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
async function handleResolveIcons(rawDomains, hints, prune) {
  const domains = [...new Set(rawDomains.map(normalizeIconDomain).filter(Boolean))];
  if (!domains.length) return {};

  const { iconCache = {} } = await new Promise(r => chrome.storage.local.get('iconCache', r));
  let changed = false;

  // Evict cached icons for domains no longer present in the account set.
  if (prune) {
    const keep = new Set(domains);
    for (const d of Object.keys(iconCache)) {
      if (!keep.has(d)) { delete iconCache[d]; changed = true; }
    }
  }

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
      if (info.none) { iconCache[d] = updated[d] = { dataUrl: null, fetchedAt: now }; continue; }
      if (!info.url) continue; // unknown/pending → retry later, don't cache
      try {
        const r = await fetch(info.url);
        if (r.ok) {
          const buf = await r.arrayBuffer();
          const ct  = r.headers.get('content-type') || 'image/png';
          iconCache[d] = updated[d] = { dataUrl: bytesToDataUrl(buf, ct), fetchedAt: now };
        }
        // non-ok (e.g. 404 on a CDN guess) → leave uncached so it retries later
      } catch { /* transient — leave uncached to retry */ }
    }
    if (Object.keys(updated).length) changed = true;
  }

  if (changed) await new Promise(r => chrome.storage.local.set({ iconCache }, r));
  return updated;
}


// Inactivity auto-lock: VaultLock.state() locks the vault once its deadline
// passes. It also runs on every read of the state, so this alarm only covers
// the case where nothing asks for a while.
const AUTOLOCK_ALARM = 'otpilot-autolock';

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(ALARM_NAME, { periodInMinutes: POLL_MINUTES });
  chrome.alarms.create(AUTOLOCK_ALARM, { periodInMinutes: 1 });
});

chrome.runtime.onStartup.addListener(() => {
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
