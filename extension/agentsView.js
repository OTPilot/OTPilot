'use strict';

// The popup's Agents view (2.1, docs/agents/plan.md; layout: option D of
// docs/agents/agents-ux-a-d.html). Three tabs:
// - Agents: the connected agents (a notice when something waits) → an agent
//   (what it can use; tapping an account opens its permissions in a sheet,
//   "+ Add account" another sheet) → its ⋯ menu (rename, add it to Claude
//   Code / Codex / Cursor / Pi, its activity, revoke).
// - Requests: what waits for an answer: a new agent (check its code), an
//   account request (which account, then what it can use), a use of an "ask
//   every time" account (answered in its row).
// - Activity: every agent's uses, or one agent's, ten at a time.
// Plus the editor's "AI agents" section. The logic is in agents.js; this
// file only renders. Loaded after popup.js (uses esc, setStatus, showView,
// noticeAgo, renderNotices, avatarHTML, copyText, clipboardWrite).

const AGENT_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="8" width="16" height="12" rx="3"/><path d="M12 8V4"/><circle cx="9" cy="14" r="1.2" fill="currentColor"/><circle cx="15" cy="14" r="1.2" fill="currentColor"/></svg>';
const AGENT_CONNECT_CMD = 'npx -y @otpilot/mcp@latest connect';
// How to add the MCP server to each agent (what `connect` prints, mcp/src/cli.ts).
const AGENT_SETUP = [
  ['Claude Code', 'In a terminal', 'claude mcp add otpilot -- npx -y @otpilot/mcp@latest'],
  ['Codex', 'In ~/.codex/config.toml', '[mcp_servers.otpilot]\ncommand = "npx"\nargs = ["-y", "@otpilot/mcp@latest"]'],
  ['Cursor', 'In ~/.cursor/mcp.json', '{ "mcpServers": { "otpilot": { "command": "npx", "args": ["-y", "@otpilot/mcp@latest"] } } }'],
  ['Pi', 'In a terminal', 'pi mcp add otpilot -- npx -y @otpilot/mcp@latest'],
];
const AGENT_DURATIONS = [
  ['', 'Until I revoke'],
  ['1h', '1 hour'],
  ['1d', '1 day'],
  ['7d', '1 week'],
];
const AGENT_ACTIONS = { browser_login: 'Signed in to', login_attempt: 'Tried to sign in to', run: 'Ran a command with', totp: 'Got a 2FA code for' };

const AG_SVG = p => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p}</svg>`;
const AG_I = {
  chev: AG_SVG('<path d="M9 18l6-6-6-6"/>'),
  back: AG_SVG('<path d="M15 18l-6-6 6-6"/>'),
  dots: AG_SVG('<circle cx="5" cy="12" r="1.3" fill="currentColor"/><circle cx="12" cy="12" r="1.3" fill="currentColor"/><circle cx="19" cy="12" r="1.3" fill="currentColor"/>'),
  plus: AG_SVG('<path d="M12 5v14M5 12h14"/>'),
  x: AG_SVG('<path d="M18 6L6 18M6 6l12 12"/>'),
  check: AG_SVG('<path d="M20 6L9 17l-5-5"/>'),
  copy: AG_SVG('<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/>'),
  trash: AG_SVG('<path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/>'),
  edit: AG_SVG('<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>'),
  terminal: AG_SVG('<rect x="2" y="4" width="20" height="16" rx="2"/><path d="M6 9l3 3-3 3M12 15h5"/>'),
  pulse: AG_SVG('<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>'),
  shield: AG_SVG('<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>'),
  signin: AG_SVG('<path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/><path d="M10 17l5-5-5-5"/><path d="M15 12H3"/>'),
  run: AG_SVG('<path d="M4 17l6-6-6-6"/><path d="M12 19h8"/>'),
  lock: AG_SVG('<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>'),
  warn: AG_SVG('<path d="M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/>'),
};
const ACTION_STYLE = { browser_login: ['in', AG_I.signin], login_attempt: ['bad', AG_I.warn], run: ['run', AG_I.run], totp: ['k2', AG_I.lock] };

let _agentsData = null;     // last Agents.list()
let _agentsItems = [];      // vault items (decrypted) for names and pickers
// Where the view is: { kind: 'agents' | 'agent' | 'setup' | 'requests' |
// 'request' | 'activity' | 'connect' | 'waiting', id?, agent? }. 'waiting'
// (the bell's Review) opens the only thing waiting, else Requests.
let _agentsSel = null;

const agentAv = (pending, lg) => `<span class="ag-av${pending ? ' pending' : ''}${lg ? ' lg' : ''}">${AGENT_ICON}</span>`;
const agentById = id => _agentsData?.agents.find(a => a.id === id);
const itemById = id => _agentsItems.find(i => i.id === id);
const itemTitle = id => itemById(id)?.title || 'An item not on this device';
const itemAvatar = item => avatarHTML({ name: item?.title || '?', urls: (item?.urls || []).join('\n') }, 'ag-fav');
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const joinAnd = parts => parts.length < 2 ? parts.join('') : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;

function agentExpiry(iso) {
  if (!iso) return '';
  const min = Math.round((new Date(iso).getTime() - Date.now()) / 60000);
  if (min <= 0) return 'expired';
  if (min < 60) return `${min} min left`;
  const h = Math.round(min / 60);
  return h < 48 ? `${h} h left` : `${Math.round(h / 24)} days left`;
}

function durationToIso(v) {
  const ms = { '1h': 3600e3, '1d': 86400e3, '7d': 7 * 86400e3 }[v];
  return ms ? new Date(Date.now() + ms).toISOString() : null;
}

// The agent's error, said plainly (the Free limit, mostly).
function agentError(e) {
  const msg = e?.body?.error || e?.message || '';
  if (/free plan limit/.test(msg)) return 'The free plan allows one connected agent. Disconnect it first, or upgrade to Personal.';
  if (e?.status === 404) return 'This is no longer there. It may have expired, or been answered elsewhere.';
  if (/expired/.test(msg)) return 'This request has expired. Ask the agent to try again.';
  return msg || 'Could not reach OTPilot. Try again.';
}

function updateAgentsDot(n) {
  document.getElementById('nav-agents-dot').hidden = !n;
}

// What waits for an answer: new agents first, then requests (oldest first).
function agentsWaiting() {
  const { agents = [], requests = [] } = _agentsData || {};
  return [
    ...agents.filter(a => a.status === 'pending').map(a => ({ kind: 'agent', id: a.id })),
    ...requests.map(r => ({ kind: 'request', id: r.id, agent: r.agent_id })),
  ];
}

const tabOf = s => (['requests', 'request'].includes(s.kind) || (s.kind === 'agent' && agentById(s.id)?.status === 'pending') ? 'requests'
  : s.kind === 'activity' ? 'activity' : 'agents');

// The view to show when the current one is gone (answered, revoked) or
// there's none yet. With nothing connected yet, or in the window opened for
// something waiting, straight to what waits.
function agentsDefaultRoute(prev) {
  const { agents } = _agentsData;
  const waiting = agentsWaiting();
  const active = agents.filter(a => a.status === 'active');
  if (!agents.length) return { kind: 'connect' };
  if (prev?.kind === 'request' || prev?.kind === 'agent') {
    if (waiting.length && (AGENTS_WINDOW || !active.length)) return waiting[0];
    if (waiting.length) return { kind: 'requests' };
    if (prev.agent && agentById(prev.agent)?.status === 'active') return { kind: 'agent', id: prev.agent };
  }
  if (waiting.length && (AGENTS_WINDOW || !active.length)) return waiting[0];
  return { kind: 'agents' };
}

function agentsRouteValid(s) {
  if (!s) return false;
  const a = s.id && agentById(s.id);
  return ({
    // With no agent at all, the Agents tab is how to connect one.
    agents: _agentsData.agents.length > 0, requests: true, connect: true,
    activity: !s.agent || !!agentById(s.agent),
    agent: !!a,
    setup: a?.status === 'active',
    request: (_agentsData.requests || []).some(r => r.id === s.id),
  })[s.kind] || false;
}

// ── overlays: the ⋯ menu, sheets, the revoke dialog ──
const agentsLayer = () => document.getElementById('agents-layer');
// What opened the overlay (a row, the ⋯ button): focus goes back to it on
// close. One overlay replacing another (the menu → the revoke dialog) keeps
// the first opener.
let _agentsOpener = null;
const AG_FOCUSABLE = 'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])';
function setAgentsLayer(html) {
  const layer = agentsLayer();
  if (!layer.firstChild) _agentsOpener = document.activeElement instanceof HTMLElement && !layer.contains(document.activeElement) ? document.activeElement : null;
  layer.innerHTML = html;
  return layer;
}
function closeAgentsOverlays() {
  const l = agentsLayer();
  if (!l?.firstChild) return;
  const back = l.contains(document.activeElement) && _agentsOpener;
  l.innerHTML = '';
  _agentsOpener = null;
  if (back?.isConnected) back.focus();
}
// Focus into an overlay: its `first` control, else its first focusable one.
function focusAgentsOverlay(box, first) {
  (first || box.querySelector(AG_FOCUSABLE))?.focus();
}
function openAgentsSheet(label, html) {
  const layer = setAgentsLayer(`<div class="ag-dim"></div><div class="ag-sheet" role="dialog" aria-modal="true" aria-label="${esc(label)}">${html}</div>`);
  layer.querySelector('.ag-dim').addEventListener('click', closeAgentsOverlays);
  return layer.querySelector('.ag-sheet');
}
document.addEventListener('keydown', e => {
  const layer = agentsLayer();
  if (!layer?.firstChild || document.getElementById('agents-panel')?.style.display === 'none') return;
  if (e.key === 'Escape') { closeAgentsOverlays(); return; }
  // Tab stays inside the open sheet / dialog / menu: the controls under it
  // could navigate away and lose what's being chosen.
  if (e.key !== 'Tab') return;
  const box = layer.querySelector('.ag-sheet, .ag-modal, .ag-menu');
  const all = box ? [...box.querySelectorAll(AG_FOCUSABLE)].filter(el => el.offsetParent !== null) : [];
  if (!all.length) { e.preventDefault(); return; }
  const first = all[0], last = all[all.length - 1];
  if (!box.contains(document.activeElement)) { e.preventDefault(); (e.shiftKey ? last : first).focus(); }
  else if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
});

// `fresh`: the list already fetched (the timer's), so nothing changes between
// its last check and the redraw.
const AGENTS_WINDOW = new URLSearchParams(location.search).get('window') === '1';

async function renderAgentsPanel(fresh = null) {
  const detail = document.getElementById('agents-detail');
  const bar = document.querySelector('#agents-panel .ag-bar');
  const session = await SupabaseAuth.getSession().catch(() => null);
  if (!session) {
    bar.hidden = true;
    closeAgentsOverlays();
    detail.innerHTML = `<div class="ag-empty">${agentAv(false, true)}
      <div class="ag-empty-t">Let your AI agents sign in, safely</div>
      <p>Claude Code, Codex, Cursor or any MCP agent can use the accounts you allow, passwords and 2FA codes included, <b>without ever seeing them</b>.</p>
      <p>Sign in to OTPilot to connect one. A free account works.</p>
      <button class="ag-btn primary" id="agents-signin">Sign in</button></div>`;
    detail.querySelector('#agents-signin').addEventListener('click', () => showView('sync'));
    return;
  }
  bar.hidden = false;
  try {
    const key = await VaultKeys.getKey();
    const [data, items] = await Promise.all([fresh || Agents.list(), key ? Agents.vaultItems(key) : []]);
    // A timer redraw: a form opened during those waits stays as it is.
    const panel = document.getElementById('agents-panel');
    if (fresh && panel && agentsBusy(panel)) return;
    [_agentsData, _agentsItems] = [data, items];
  } catch (e) {
    detail.innerHTML = `<div class="ag-empty"><p>${esc(agentError(e))}</p></div>`;
    return;
  }
  closeAgentsOverlays();
  const { agents, requests } = _agentsData;
  const waiting = agentsWaiting();
  // The window the background opened for an agent waiting closes itself
  // once nothing waits: everything answered, or already nothing on its first
  // list (answered elsewhere, or expired behind the unlock screen). Checked
  // again when the time comes: approving opens the add-account sheet, and a
  // new request may have come in.
  // (window.close() only closes windows a script opened: remove its tab.)
  if (AGENTS_WINDOW && !waiting.length) setTimeout(() => {
    const panel = document.getElementById('agents-panel');
    const d = _agentsData || {};
    const waits = (d.agents || []).some(a => a.status === 'pending') || (d.requests || []).length;
    if (waits || _agentsSel?.adding || (panel && agentsBusy(panel))) return;
    chrome.tabs.getCurrent(t => (t ? chrome.tabs.remove(t.id) : window.close()));
  }, 1200);
  updateAgentsDot(waiting.length);

  if (_agentsSel?.kind === 'waiting') _agentsSel = waiting.length === 1 ? waiting[0] : { kind: 'requests' };
  if (!agentsRouteValid(_agentsSel)) _agentsSel = agentsDefaultRoute(_agentsSel);

  const tab = tabOf(_agentsSel);
  const active = agents.filter(a => a.status === 'active');
  const count = (n, warn) => n ? `<span class="ag-count${warn ? ' warn' : ''}">${n}</span>` : '';
  const tabs = document.getElementById('agents-tabs');
  tabs.innerHTML = [['agents', 'Agents', count(active.length)], ['requests', 'Requests', count(waiting.length, true)], ['activity', 'Activity', '']]
    .map(([k, label, c]) => `<button type="button" role="tab" class="ag-tab" data-tab="${k}" aria-selected="${tab === k}">${label}${c}</button>`).join('');
  tabs.querySelectorAll('.ag-tab').forEach(b => b.addEventListener('click', () => {
    _agentsSel = { kind: b.dataset.tab };
    renderAgentsPanel();
  }));
  renderAgentsLimit();

  detail.scrollTop = 0;
  const s = _agentsSel;
  if (s.kind === 'connect') renderAgentConnectHelp(detail);
  else if (s.kind === 'agents') renderAgentsList(detail);
  else if (s.kind === 'requests') renderAgentsRequests(detail);
  else if (s.kind === 'request') renderAgentRequest(detail, requests.find(r => r.id === s.id));
  else if (s.kind === 'activity') renderAgentsActivity(detail);
  else if (s.kind === 'setup') renderAgentSetup(detail, agentById(s.id));
  else {
    const a = agentById(s.id);
    if (a.status === 'pending') renderPendingAgent(detail, a);
    else renderActiveAgent(detail, a);
  }
}

const goAgents = route => { _agentsSel = route; renderAgentsPanel(); };
const backLink = (label, route) => {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'ag-back';
  b.innerHTML = `${AG_I.back}${esc(label)}`;
  b.addEventListener('click', () => goAgents(route));
  return b;
};
const SAFE_NOTE = `<div class="ag-safe">${AG_I.shield}<span>Agents never see these values: OTPilot signs in or runs the command and only returns the result.</span></div>`;

// ── Free plan: the monthly agent uses ──
// A pill in the tab bar ("7/10 uses", amber from 8); once they're all used,
// a card too (on Agents and on an agent's page) with the trial, when this
// account never had one, or the upgrade. Usage is null / missing on paid
// plans, the trial and old servers: nothing shows.
function agentsUsage() {
  const u = _agentsData?.usage;
  if (!u || !Number.isFinite(u.limit) || u.limit <= 0) return null;
  const used = Math.max(0, Math.min(Number(u.used) || 0, u.limit));
  const d = new Date(u.resets_at);
  const renews = isNaN(d) ? 'next month' : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
  return { ...u, used, renews, full: used >= u.limit };
}

function renderAgentsLimit() {
  const el = document.getElementById('agents-limit');
  const u = agentsUsage();
  if (!u) { el.innerHTML = ''; return; }
  const text = `${u.used} of ${u.limit} uses this month`;
  el.innerHTML = `<span class="ag-use${u.full ? ' full' : u.used >= 8 ? ' warn' : ''}" role="meter" aria-label="Agent uses this month"
    aria-valuemin="0" aria-valuemax="${u.limit}" aria-valuenow="${u.used}" aria-valuetext="${esc(text)}"
    title="${esc(`Free plan · ${text} · renews ${u.renews}`)}"><i style="--p:${Math.round((u.used / u.limit) * 100)}%"></i>${u.used}/${u.limit} uses</span>`;
}

function agentsLimitCardHTML() {
  const u = agentsUsage();
  if (!u?.full) return '';
  return `<div class="ag-limit" role="group" aria-label="Agent uses">
    <div class="ag-t1">You've used all ${u.limit} agent uses this month</div>
    <div class="ag-meter"><i></i></div>
    <div class="ag-t2 ag-limit-msg" aria-live="polite">Your agents can still list accounts and ask for access, but can't sign in or run commands until ${esc(u.renews)}.</div>
    <div class="ag-btns">${u.trial_available ? '<button type="button" class="ag-btn primary" id="agents-trial">Start free trial</button>' : agentsUpgradeLink(' primary')}</div>
  </div>`;
}
const agentsUpgradeLink = cls => `<a class="ag-btn${cls}" target="_blank" rel="noopener" href="${esc(`${CONFIG.DASHBOARD_URL}/dashboard/billing`)}">Upgrade to Personal</a>`;

function mountAgentsLimitCard(root) {
  const btn = root.querySelector('#agents-trial');
  if (!btn) return;
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    btn.textContent = 'Starting…';
    try {
      await CloudSync.startTrial();
      renderAgentsPanel();
    } catch {
      btn.disabled = false;
      btn.textContent = 'Start free trial';
      const card = root.querySelector('.ag-limit');
      if (card && !card.querySelector('.ag-trial-err')) {
        card.querySelector('.ag-btns').insertAdjacentHTML('beforebegin', '<div class="ag-err ag-trial-err" role="alert">Could not start the trial. Try again, or upgrade to Personal.</div>');
        card.querySelector('.ag-btns').insertAdjacentHTML('beforeend', agentsUpgradeLink(''));
      }
    }
  });
}

// ── No agents yet ──
function renderAgentConnectHelp(detail) {
  detail.innerHTML = `<div class="ag-empty">${agentAv(false, true)}
    <div class="ag-empty-t">Let your AI agents sign in, safely</div>
    <p>Claude Code, Codex, Cursor or any MCP agent can use the accounts you allow, passwords and 2FA codes included, <b>without ever seeing them</b>.</p>
    <div class="ag-steps">
      <div class="ag-step"><i>1</i><span>Run this in your terminal:</span></div>
      <div class="ag-cmd"><code>${esc(AGENT_CONNECT_CMD)}</code><button type="button" class="ag-btn sm" id="agents-copy-cmd">${AG_I.copy}Copy</button></div>
      <div class="ag-step"><i>2</i><span>Check the code it shows matches the one here, and connect.</span></div>
      <div class="ag-step"><i>3</i><span>Pick the accounts it can use. Revoke anytime.</span></div>
    </div>
    <div class="ag-works">Works with Claude Code · Codex · Cursor · Pi · any MCP client · <a target="_blank" rel="noopener" href="${esc(CONFIG.DASHBOARD_URL)}/ai-agents">How it works</a></div>
  </div>`;
  detail.querySelector('#agents-copy-cmd').addEventListener('click', async () => {
    await clipboardWrite(AGENT_CONNECT_CMD).catch(() => {});
    setStatus('Command copied');
  });
}

// ── Agents tab ──
function agentSubline(a) {
  return [Agents.clientLabel(a) && `via <b>${esc(Agents.clientLabel(a))}</b>`, esc(a.machine || 'Unknown computer'),
    a.last_used_at ? `used ${esc(noticeAgo(a.last_used_at))}` : 'not used yet'].filter(Boolean).join(' · ');
}

function renderAgentsList(detail) {
  const waiting = agentsWaiting();
  const active = _agentsData.agents.filter(a => a.status === 'active');
  const reqs = _agentsData.requests || [];
  const what = joinAnd([
    waiting.filter(w => w.kind === 'agent').length && plural(waiting.filter(w => w.kind === 'agent').length, 'new agent', 'new agents'),
    reqs.filter(r => !r.item_id).length && plural(reqs.filter(r => !r.item_id).length, 'account request', 'account requests'),
    reqs.filter(r => r.item_id).length && plural(reqs.filter(r => r.item_id).length, 'use to approve', 'uses to approve'),
  ].filter(Boolean));
  detail.innerHTML = `${agentsLimitCardHTML()}
    ${waiting.length ? `<div class="ag-banner"><i class="ag-dot"></i><div class="ag-grow"><div class="ag-t1">${waiting.length === 1 ? 'Something is waiting for you' : `${waiting.length} things are waiting for you`}</div>
      <div class="ag-t2">${esc(what[0].toUpperCase() + what.slice(1))}</div></div><button type="button" class="ag-btn sm primary" data-act="review-waiting">Review</button></div>` : ''}
    <div class="ag-sec">Your agents</div>
    ${active.length ? `<div class="ag-card">${active.map(a => `<button type="button" class="ag-row" data-agent="${esc(a.id)}">${agentAv(false, true)}
      <span class="ag-grow"><span class="ag-t1 ag-lg">${esc(a.name)}</span><span class="ag-t2">${agentSubline(a)}</span></span>
      ${a.keyChanged || !a.pinned ? '<span class="ag-pill warn">Check its code</span>' : ''}
      <span class="ag-pill muted">${plural(a.grants.length, 'account', 'accounts')}</span><span class="ag-chev">${AG_I.chev}</span></button>`).join('')}</div>`
      : '<div class="ag-note">No agent connected yet. Waiting ones are in Requests.</div>'}
    ${SAFE_NOTE}`;
  mountAgentsLimitCard(detail);
  detail.querySelector('[data-act=review-waiting]')?.addEventListener('click', () => goAgents({ kind: 'waiting' }));
  detail.querySelectorAll('.ag-row[data-agent]').forEach(b => b.addEventListener('click', () => goAgents({ kind: 'agent', id: b.dataset.agent })));
}

// Runs `fn` with the buttons of `box` disabled; shows its error in `box`.
// Disables a box's controls while an action runs; the returned function puts
// back only those it disabled (a scope the item can't have stays disabled).
function lockControls(box, selector = 'button, select, input') {
  const was = [...box.querySelectorAll(selector)].filter(b => !b.disabled);
  was.forEach(b => { b.disabled = true; });
  return () => was.forEach(b => { b.disabled = false; });
}

async function agentAct(box, fn) {
  const unlock = lockControls(box);
  box.querySelector('.ag-err')?.remove();
  try {
    await fn();
    await renderAgentsPanel();
    renderNotices();
  } catch (e) {
    unlock();
    (box.querySelector('.ag-foot') || box).insertAdjacentHTML(box.querySelector('.ag-foot') ? 'beforebegin' : 'beforeend', `<div class="ag-err">${esc(agentError(e))}</div>`);
  }
}

// ── Requests tab ──
function renderAgentsRequests(detail) {
  const reqs = _agentsData.requests || [];
  const pending = _agentsData.agents.filter(a => a.status === 'pending');
  const rows = [
    ...pending.map(a => `<button type="button" class="ag-row" data-kind="agent" data-id="${esc(a.id)}">${agentAv(true)}
      <span class="ag-grow"><span class="ag-t1">New agent</span><span class="ag-t2">${esc(a.name)} on ${esc(a.machine || 'an unknown computer')} wants to connect · ${esc(noticeAgo(a.created_at))}</span></span><span class="ag-chev">${AG_I.chev}</span></button>`),
    ...reqs.map(r => {
      const who = esc(agentById(r.agent_id)?.name || 'An agent');
      return r.item_id
        ? `<div class="ag-row" data-req="${esc(r.id)}">${agentAv(true)}<span class="ag-grow"><span class="ag-t1">Use ${esc(itemTitle(r.item_id))} now</span>
            <span class="ag-t2">${who}${r.tool ? ` · for <code>${esc(r.tool)}</code>` : ''} · ${esc(noticeAgo(r.created_at))}</span></span>
            <button type="button" class="ag-btn sm" data-act="deny">Deny</button><button type="button" class="ag-btn sm primary" data-act="allow">Allow once</button></div>`
        : `<button type="button" class="ag-row" data-kind="request" data-id="${esc(r.id)}">${agentAv(true)}<span class="ag-grow"><span class="ag-t1">Account request</span>
            <span class="ag-t2">${who} asks for ${esc(r.query || 'an account')} · ${esc(noticeAgo(r.created_at))}</span></span><span class="ag-chev">${AG_I.chev}</span></button>`;
    }),
  ];
  detail.innerHTML = `<div class="ag-sec">Waiting for you</div>
    ${rows.length ? `<div class="ag-card">${rows.join('')}</div>
      <div class="ag-safe">${AG_I.pulse}<span>Requests nobody answers expire after 10 minutes, and the agent is told so.</span></div>`
      : '<div class="ag-note">Nothing is waiting for you.</div>'}`;
  detail.querySelectorAll('button.ag-row[data-kind]').forEach(b => b.addEventListener('click', () => goAgents({ kind: b.dataset.kind, id: b.dataset.id })));
  detail.querySelectorAll('.ag-row[data-req]').forEach(row => {
    const r = reqs.find(x => x.id === row.dataset.req);
    row.querySelector('[data-act=deny]').addEventListener('click', () => agentAct(row, () => Agents.decide(r, 'deny')));
    row.querySelector('[data-act=allow]').addEventListener('click', () => agentAct(row, () => Agents.decide(r, 'allow')));
  });
}

// A new agent: its code, checked against the terminal's.
function renderPendingAgent(detail, a) {
  detail.innerHTML = `<div class="ag-head">${agentAv(true, true)}
      <div class="ag-grow"><div class="ag-t1 ag-lg">${esc(a.name)} wants to connect</div><div class="ag-t2">from <b>${esc(a.machine || 'an unknown computer')}</b> · ${esc(noticeAgo(a.created_at))}</div></div></div>
    <div class="ag-codetile"><span class="code">${esc(a.code)}</span><span class="hint">Your terminal shows a code too</span></div>
    <div class="ag-check">${AG_I.check}<span><b>Same code in your terminal?</b> Connect. If not, deny: someone else is asking.</span></div>
    <div class="ag-check">${AG_I.check}<span>Connecting gives it <b>no accounts</b>. You pick them next, or approve each one when it asks.</span></div>
    <div class="ag-check">${AG_I.check}<span>Revoke it anytime from its ⋯ menu.</span></div>
    <div class="ag-foot"><button type="button" class="ag-btn danger" data-act="deny">Codes don't match</button><span class="ag-grow"></span>
      <button type="button" class="ag-btn primary" data-act="approve">${AG_I.check}Codes match · Connect</button></div>`;
  detail.prepend(backLink('Requests', { kind: 'requests' }));
  detail.querySelector('[data-act=deny]').addEventListener('click', () => agentAct(detail, () => Agents.remove(a.id)));
  detail.querySelector('[data-act=approve]').addEventListener('click', () => agentAct(detail, async () => {
    await Agents.approve(a);
    _agentsSel = { kind: 'agent', id: a.id, adding: true };
  }));
}

// ── The permissions form: what it can use, for how long, more options ──
function agentGrantFormHTML(item, current, label = 'What it can use') {
  const scope = current?.scope || Agents.defaultScope(item);
  const isLogin = item.type === 'login';
  const hasTotp = !!item.totp?.secret;
  const parts = Agents.partsFor(item);
  const withheld = VaultShares.parts(item).some(p => p.walletSecret);
  const chosen = new Set(scope.kind === 'fields' ? scope.parts : []);
  // An expired grant being renewed has no time left to keep: an hour by default.
  // The same rule the list shows "expired" by (its last half minute counts).
  const expired = current?.expires_at && agentExpiry(current.expires_at) === 'expired';
  const keep = current?.expires_at && !expired;
  const dur = keep ? 'keep' : expired ? '1h' : '';
  const def = !current && Agents.defaultScope(item).kind;
  const opts = [
    ['login', 'Everything to sign in', isLogin ? Agents.scopeSummary(item, { kind: 'login' }) : 'Only for logins', !isLogin],
    ['2fa', '2FA code only', hasTotp ? 'Just the code, nothing else' : 'No 2FA code saved', !hasTotp],
    ['fields', 'Choose fields', 'Pick exactly what it can use', !parts.length],
  ];
  return `<div class="ag-form">
    ${label ? `<div class="ag-lbl">${label}</div>` : ''}
    <div class="ag-opts" role="radiogroup">${opts.map(([v, b, s, dis]) => `<label class="ag-opt${dis ? ' dis' : ''}">
      <input type="radio" name="ag-scope" class="ag-scope" value="${v}"${scope.kind === v ? ' checked' : ''}${dis ? ' disabled' : ''}>
      <span class="ag-grow"><b>${b}</b><span>${esc(s)}</span></span>${def === v ? '<em class="ag-def">Default</em>' : ''}</label>`).join('')}</div>
    <div class="ag-fields"${scope.kind === 'fields' ? '' : ' hidden'}>
      ${parts.map(p => `<label><input type="checkbox" value="${esc(p.key)}"${chosen.has(p.key) ? ' checked' : ''}> ${esc(p.label)}</label>`).join('')}
      ${withheld ? '<span class="ag-note">A wallet\'s recovery phrase and keys are never given to AI agents.</span>' : ''}
    </div>
    <div class="ag-lbl">For how long</div>
    <div class="ag-durs" role="radiogroup">
      ${keep ? `<label class="ag-dur"><input type="radio" name="ag-dur" value="keep" checked>As now (${esc(agentExpiry(current.expires_at))})</label>` : ''}
      ${AGENT_DURATIONS.map(([v, l]) => `<label class="ag-dur"><input type="radio" name="ag-dur" value="${v}"${dur === v ? ' checked' : ''}>${l}</label>`).join('')}
    </div>
    <details class="ag-more"${current?.ask_every_time || current?.commands?.length ? ' open' : ''}><summary>More options</summary>
      <label class="ag-checkline"><input type="checkbox" class="ag-ask"${current?.ask_every_time ? ' checked' : ''}> Ask me every time it uses it</label>
      <label class="ag-cmds"><span>Only these commands</span><input type="text" class="ag-commands" placeholder="e.g. psql, curl" value="${esc((current?.commands || []).join(', '))}"></label>
    </details>
  </div>`;
}

function mountGrantForm(box) {
  box.querySelectorAll('input.ag-scope').forEach(r => r.addEventListener('change', () => {
    box.querySelector('.ag-fields').hidden = box.querySelector('input.ag-scope:checked')?.value !== 'fields';
  }));
}

function readGrantForm(box, current) {
  const kind = box.querySelector('input.ag-scope:checked')?.value;
  if (!kind) throw new Error('Pick what it can use');
  const scope = kind === 'fields'
    ? { kind, parts: [...box.querySelectorAll('.ag-fields input:checked')].map(i => i.value) }
    : { kind };
  if (kind === 'fields' && !scope.parts.length) throw new Error('Pick at least one field');
  const dur = box.querySelector('input[name=ag-dur]:checked')?.value ?? '';
  return {
    scope,
    expiresAt: dur === 'keep' ? current?.expires_at ?? null : durationToIso(dur),
    askEveryTime: box.querySelector('.ag-ask').checked,
    commands: box.querySelector('.ag-commands').value.split(',').map(s => s.trim()).filter(Boolean),
  };
}

const pickRowHTML = (i, extra = '') => `<button type="button" data-id="${esc(i.id)}"><span class="ag-radio"></span>${itemAvatar(i)}
  <span class="ag-grow"><span class="ag-t1">${esc(i.title || 'Untitled')}</span>${extra}
  <span class="ag-t2">${i._shared ? `Shared · ${esc(i._sharedBy)}${(i.urls || [])[0] ? ' · ' : ''}` : ''}${esc((i.urls || [])[0] || (i._shared ? '' : Vault.TYPES[i.type]?.label || ''))}</span></span></button>`;

function mountPick(pick, onPick) {
  pick.querySelectorAll('button').forEach(b => b.addEventListener('click', () => {
    pick.querySelectorAll('button').forEach(x => x.classList.toggle('sel', x === b));
    onPick(itemById(b.dataset.id));
  }));
}

// A searchable list of vault items (and items shared with the user); `onPick(item)`.
function mountItemPicker(container, initial, onPick) {
  container.innerHTML = `<input type="text" class="ag-search" placeholder="Search the vault…" aria-label="Search the vault"><div class="ag-pick"></div>`;
  const input = container.querySelector('.ag-search');
  const pick = container.querySelector('.ag-pick');
  const show = () => {
    const found = input.value.trim() ? Agents.candidates(input.value, _agentsItems) : initial;
    pick.innerHTML = found.map(i => pickRowHTML(i)).join('') || '<div class="ag-note">Nothing matches.</div>';
    mountPick(pick, onPick);
  };
  input.addEventListener('input', show);
  show();
}

// The accounts that match what an agent asked for — only those: a request
// never opens the whole vault (adding any other account is the agent page's
// "+ Add account", the user's own choice). Each says when the agent already
// has it, and when a login is saved for another host than the one asked
// (a sign-in there would be refused: add the site to the login first).
function mountRequestPicker(container, r, agent, onPick) {
  const found = Agents.candidates(r.query, _agentsItems, Infinity); // no search here: every match
  const host = Agents.hostOfQuery(r.query);
  if (!found.length) {
    container.innerHTML = `<div class="ag-note">No account in your vault matches <b>${esc(r.query || 'this')}</b>. Deny it, or save the login${host ? ` for ${esc(host)}` : ''} first: it shows here.</div>`;
    return;
  }
  const has = new Set((agent?.grants || []).map(g => g.item_id));
  container.innerHTML = `<div class="ag-pick">${found.map(i => {
    const elsewhere = host && i.type === 'login' && !Vault.loginCoversHost(i.urls || [], host);
    return pickRowHTML(i, `${has.has(i.id) ? '<span class="ag-pill muted">Already allowed</span>' : ''}
      ${elsewhere ? `<span class="ag-t2 ag-warn">Saved for ${esc(Agents.hostOfQuery((i.urls || [])[0]) || 'another site')}, not ${esc(host)}: add the site to it to sign in there</span>` : ''}`);
  }).join('')}</div>`;
  mountPick(container.querySelector('.ag-pick'), onPick);
}

function renderAgentRequest(detail, r) {
  const a = agentById(r.agent_id);
  const who = esc(a?.name || 'An agent');
  const head = `<div class="ag-head">${agentAv(true, true)}
    <div class="ag-grow"><div class="ag-t2">${who} · ${esc(noticeAgo(r.created_at))}</div>
    <div class="ag-t1 ag-lg ag-wrap">${r.item_id ? `Wants to use <b>${esc(itemTitle(r.item_id))}</b> now` : `Asks for <b>${esc(r.query || 'an account')}</b>`}</div></div></div>
    ${r.reason ? `<div class="ag-quote">“${esc(r.reason)}”<span>Reason the agent gave${r.tool ? ` · for <code>${esc(r.tool)}</code>` : ''}</span></div>` : ''}`;
  if (r.item_id) {
    // One use of an "ask every time" grant.
    detail.innerHTML = `${head}<div class="ag-note">You asked to approve every use of this account.</div>
      <div class="ag-foot"><button type="button" class="ag-btn danger" data-act="deny">Deny</button><span class="ag-grow"></span>
        <button type="button" class="ag-btn primary" data-act="allow">Allow this time</button></div>`;
    detail.prepend(backLink('Requests', { kind: 'requests' }));
    detail.querySelector('[data-act=deny]').addEventListener('click', () => agentAct(detail, () => Agents.decide(r, 'deny')));
    detail.querySelector('[data-act=allow]').addEventListener('click', () => agentAct(detail, () => Agents.decide(r, 'allow')));
    return;
  }
  detail.innerHTML = `${head}
    <div class="ag-lbl">1 · Which account</div><div class="ag-picker"></div>
    <div class="ag-grant"></div>
    ${SAFE_NOTE}
    <div class="ag-foot"><button type="button" class="ag-btn danger" data-act="deny">Deny</button><span class="ag-grow"></span>
      <button type="button" class="ag-btn primary" data-act="allow" disabled>Allow</button></div>`;
  detail.prepend(backLink('Requests', { kind: 'requests' }));
  let chosen = null;
  const allow = detail.querySelector('[data-act=allow]');
  mountRequestPicker(detail.querySelector('.ag-picker'), r, a, item => {
    chosen = item;
    detail.querySelector('.ag-grant').innerHTML = agentGrantFormHTML(item, null, '2 · What it can use');
    mountGrantForm(detail);
    allow.disabled = false;
    allow.textContent = `Allow ${item.title || 'it'} for ${a?.name || 'the agent'}`;
  });
  detail.querySelector('[data-act=deny]').addEventListener('click', () => agentAct(detail, () => Agents.decide(r, 'deny')));
  allow.addEventListener('click', () => agentAct(detail, () => Agents.decide(r, 'allow', { agent: a, item: chosen, opts: readGrantForm(detail) })));
}

// ── Activity: grouped by day; one agent's ten at a time ──
// Kept per agent while the popup is open, so a redraw (every 10 s) shows what
// was loaded and only refreshes the newest page.
const _agentActivity = new Map(); // agentId → { items, more }

function activityDay(d) {
  if (d.toDateString() === new Date().toDateString()) return 'Today';
  if (d.toDateString() === new Date(Date.now() - 864e5).toDateString()) return 'Yesterday';
  return d.toLocaleDateString([], { day: 'numeric', month: 'short' });
}

function activityRowsHTML(items, withAgent) {
  let day = '';
  return items.map(u => {
    const d = new Date(u.created_at);
    const label = activityDay(d);
    const head = label !== day ? `<div class="ag-day">${esc(label)}</div>` : '';
    day = label;
    const [cls, icon] = ACTION_STYLE[u.action] || ['', AG_I.pulse];
    const sub = [withAgent && (agentById(u.agent_id)?.name || 'An agent'), u.detail].filter(Boolean);
    return `${head}<div class="ag-log"><span class="ag-ai ${cls}">${icon}</span>
      <span class="ag-grow"><span class="ag-t1">${esc(AGENT_ACTIONS[u.action] || u.action)}${u.item_id ? ` <b>${esc(itemTitle(u.item_id))}</b>` : ''}</span>
      ${sub.length ? `<span class="ag-t2">${sub.map(esc).join(' · ')}</span>` : ''}</span>
      <time>${esc(d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }))}</time></div>`;
  }).join('');
}

function drawAgentActivity(box, agentId) {
  const st = _agentActivity.get(agentId);
  if (!box?.isConnected) return;
  if (!st) { box.innerHTML = '<div class="ag-note">Loading…</div>'; return; }
  if (st.error && !st.items.length) { box.innerHTML = `<div class="ag-note">${esc(st.error)}</div>`; return; }
  box.innerHTML = st.items.length
    ? `<div class="ag-card">${activityRowsHTML(st.items, false)}
      ${st.more ? `<button type="button" class="ag-more-row" data-act="more-activity"${st.loading ? ' disabled' : ''}>${st.loading ? 'Loading…' : 'Show more'}</button>` : ''}</div>
      ${st.error ? `<div class="ag-err">${esc(st.error)}</div>` : ''}`
    : '<div class="ag-note">Nothing yet.</div>';
  box.querySelector('[data-act=more-activity]')?.addEventListener('click', async () => {
    // The pending state lives in the cache, so a redraw meanwhile keeps the
    // button disabled; the answer is applied to whatever the cache holds then.
    const from = st.items[st.items.length - 1].id;
    _agentActivity.set(agentId, { ...st, loading: true, error: null });
    drawAgentActivity(box, agentId);
    let page = null, error = null;
    try { page = await Agents.activity(agentId, from); } catch (err) { error = agentError(err); }
    const cur = _agentActivity.get(agentId);
    if (page && cur.items[cur.items.length - 1]?.id === from) {
      const seen = new Set(cur.items.map(u => u.id));
      _agentActivity.set(agentId, { items: [...cur.items, ...page.items.filter(u => !seen.has(u.id))], more: page.more });
    } else {
      _agentActivity.set(agentId, { ...cur, loading: false, error }); // the list changed meanwhile: just stop
    }
    drawAgentActivity(document.querySelector(`.ag-activity[data-agent="${CSS.escape(agentId)}"]`), agentId);
  });
}

// The newest page, then what was loaded beyond it — only when the two
// overlap (or meet): with more new uses than a page in between, older pages
// are dropped and "Show more" goes on from the new page, no gap.
async function loadAgentActivity(agentId) {
  try {
    const page = await Agents.activity(agentId);
    const cur = _agentActivity.get(agentId);
    const oldest = page.items.length ? page.items[page.items.length - 1].id : Infinity;
    const older = (cur?.items || []).filter(u => u.id < oldest);
    const joins = !page.more || (cur?.items || []).some(u => u.id >= oldest);
    _agentActivity.set(agentId, joins && older.length
      ? { items: [...page.items, ...older], more: cur.more, loading: cur.loading }
      : { items: page.items, more: page.more });
  } catch (e) {
    if (!_agentActivity.has(agentId)) _agentActivity.set(agentId, { items: [], more: false, error: agentError(e) });
  }
}

async function mountAgentActivity(box, agentId) {
  drawAgentActivity(box, agentId);
  await loadAgentActivity(agentId);
  drawAgentActivity(document.querySelector(`.ag-activity[data-agent="${CSS.escape(agentId)}"]`), agentId);
}

// Every agent's latest uses (the 50 GET /agents returns), or one agent's,
// paged. With a single agent, its own list is the whole activity.
function renderAgentsActivity(detail) {
  const agents = _agentsData.agents.filter(a => a.status === 'active');
  const only = _agentsSel.agent || (agents.length === 1 ? agents[0].id : null);
  const all = _agentsData.activity || [];
  detail.innerHTML = `${agents.length > 1 ? `<div class="ag-filters" role="group" aria-label="Show the activity of">
      <button type="button" class="ag-filter"${only ? '' : ' aria-pressed="true"'} data-agent="">All agents</button>
      ${agents.map(a => `<button type="button" class="ag-filter" data-agent="${esc(a.id)}"${only === a.id ? ' aria-pressed="true"' : ''}>${esc(a.name)}</button>`).join('')}</div>` : ''}
    ${only ? `<div class="ag-activity" data-agent="${esc(only)}"></div>`
      : all.length ? `<div class="ag-card">${activityRowsHTML(all, true)}</div>${all.length >= 50 ? '<div class="ag-note">The latest 50. Pick an agent to see all of its activity.</div>' : ''}`
        : '<div class="ag-note">No agent has used an account yet.</div>'}`;
  detail.querySelectorAll('.ag-filter').forEach(b => b.addEventListener('click', () => goAgents({ kind: 'activity', ...(b.dataset.agent ? { agent: b.dataset.agent } : {}) })));
  if (only) mountAgentActivity(detail.querySelector('.ag-activity'), only);
}

// ── An agent ──
// A message for an agent's page, shown once after it re-renders.
let _agentsNote = null;

function renderActiveAgent(detail, a) {
  // Shown on its own agent's page only (another agent may be open meanwhile).
  const note = _agentsNote?.agentId === a.id ? _agentsNote.text : null;
  if (note) _agentsNote = null;
  // Its requests for an account still waiting: an account added here can answer one.
  const asks = (_agentsData.requests || []).filter(r => r.agent_id === a.id && !r.item_id);
  const grantRow = g => {
    const item = itemById(g.item_id);
    const exp = agentExpiry(g.expires_at);
    const what = [item ? Agents.scopeSummary(item, g.scope) : Agents.SCOPE_LABELS[g.scope.kind],
      exp === 'expired' ? '' : exp || 'until you revoke', g.commands.length && `only ${g.commands.join(', ')}`].filter(Boolean).join(' · ');
    return `<button type="button" class="ag-row" data-item="${esc(g.item_id)}">${itemAvatar(item || { title: itemTitle(g.item_id) })}
      <span class="ag-grow"><span class="ag-t1">${esc(itemTitle(g.item_id))}</span><span class="ag-t2">${esc(what)}</span></span>
      ${exp === 'expired' ? '<span class="ag-pill bad">Expired</span>' : ''}
      ${g.ask_every_time ? '<span class="ag-pill warn">Asks every time</span>' : ''}
      ${item?._shared ? `<span class="ag-pill muted">Shared · ${esc(item._sharedBy)}</span>` : ''}
      <span class="ag-chev">${AG_I.chev}</span></button>`;
  };
  detail.innerHTML = `
    <div class="ag-head">${agentAv(false, true)}
      <div class="ag-grow"><div class="ag-name"><span class="ag-t1 ag-lg">${esc(a.name)}</span></div>
        <div class="ag-t2">${Agents.clientLabel(a) ? `via <b>${esc(Agents.clientLabel(a))}</b> · ` : ''}${esc(a.machine || 'Unknown computer')} · connected ${esc(new Date(a.approved_at || a.created_at).toLocaleDateString([], { day: 'numeric', month: 'short' }))}${a.last_used_at ? ` · last used ${esc(noticeAgo(a.last_used_at))}` : ''}</div></div>
      <button type="button" class="ag-icbtn" data-act="menu" aria-label="Agent options" aria-haspopup="menu">${AG_I.dots}</button>
    </div>
    ${a.keyChanged ? `<div class="ag-banner bad"><div class="ag-grow ag-t2"><b>This agent's key changed</b> since you approved it on this device. Revoke it and connect it again.</div></div>`
      : !a.pinned ? `<div class="ag-banner ag-pin"><div class="ag-grow"><div class="ag-t2">Approved on another device. Before this device updates what it can use, check its code: run <code>npx -y @otpilot/mcp@latest status</code>.</div>
        <div class="ag-code"><span class="code">${esc(a.code)}</span><span class="ag-t2">Same code in the terminal?</span></div></div>
        <button type="button" class="ag-btn sm primary" data-act="pin">Codes match</button></div>` : ''}
    ${note ? `<div class="ag-err">${esc(note)}</div>` : ''}
    ${agentsLimitCardHTML()}
    ${asks.map(r => `<div class="ag-banner" data-req="${esc(r.id)}"><i class="ag-dot"></i><div class="ag-grow"><div class="ag-t1">Asks for <b>${esc(r.query || 'an account')}</b></div>
      <div class="ag-t2">${r.reason ? `“${esc(r.reason)}” · ` : ''}${esc(noticeAgo(r.created_at))}</div></div>
      <button type="button" class="ag-btn sm primary" data-act="review">Review</button></div>`).join('')}
    <div class="ag-sec">What it can use${a.grants.length ? ` <span class="ag-count">${a.grants.length}</span>` : ''}
      <button type="button" class="ag-btn link sm" data-act="add"${a.pinned ? '' : ' disabled'}>${AG_I.plus}Add account</button></div>
    ${a.grants.length ? `<div class="ag-card">${a.grants.map(grantRow).join('')}</div>` : '<div class="ag-note">Nothing yet. Add an account, or approve one when the agent asks.</div>'}
    ${a.last_used_at ? `<div class="ag-card ag-lastuse" data-agent="${esc(a.id)}"></div>`
      : `<div class="ag-card ag-hint"><span class="ag-ai run">${AG_I.terminal}</span><span class="ag-grow"><span class="ag-t1">Not used yet</span>
        <span class="ag-t2">Add it to Claude Code, Codex, Cursor or Pi to start.</span></span><button type="button" class="ag-btn sm" data-act="setup">Show me how</button></div>`}
    ${SAFE_NOTE}`;
  detail.prepend(backLink('Agents', { kind: 'agents' }));
  mountAgentsLimitCard(detail);
  if (a.last_used_at) mountLastUse(detail.querySelector('.ag-lastuse'), a);
  detail.querySelector('[data-act=menu]').addEventListener('click', e => openAgentMenu(e.currentTarget, a));
  detail.querySelector('[data-act=setup]')?.addEventListener('click', () => goAgents({ kind: 'setup', id: a.id }));
  detail.querySelector('[data-act=pin]')?.addEventListener('click', () => agentAct(detail, () => Agents.pin(a)));
  detail.querySelectorAll('.ag-banner[data-req] [data-act=review]').forEach(b => b.addEventListener('click', () => {
    goAgents({ kind: 'request', id: b.closest('[data-req]').dataset.req, agent: a.id });
  }));
  detail.querySelectorAll('.ag-row[data-item]').forEach(row => row.addEventListener('click', () => {
    openGrantSheet(a, a.grants.find(g => g.item_id === row.dataset.item));
  }));
  detail.querySelector('[data-act=add]').addEventListener('click', () => openAddSheet(a, asks));
  if (_agentsSel.adding && a.pinned) { _agentsSel.adding = false; openAddSheet(a, asks); }
}

// Its newest use, with a way to the rest.
async function mountLastUse(box, a) {
  const draw = () => {
    const box2 = document.querySelector(`.ag-lastuse[data-agent="${CSS.escape(a.id)}"]`);
    if (!box2) return;
    const u = _agentActivity.get(a.id)?.items?.[0];
    const [cls, icon] = (u && ACTION_STYLE[u.action]) || ['', AG_I.pulse];
    box2.innerHTML = `<span class="ag-ai ${cls}">${icon}</span><span class="ag-grow"><span class="ag-t2">Last used ${esc(noticeAgo(a.last_used_at))}</span>
      ${u ? `<span class="ag-t1">${esc(AGENT_ACTIONS[u.action] || u.action)}${u.item_id ? ` <b>${esc(itemTitle(u.item_id))}</b>` : ''}${u.detail ? ` · ${esc(u.detail)}` : ''}</span>` : ''}</span>
      <button type="button" class="ag-btn link sm" data-act="activity">All activity ›</button>`;
    box2.querySelector('[data-act=activity]').addEventListener('click', () => goAgents({ kind: 'activity', agent: a.id }));
  };
  draw();
  await loadAgentActivity(a.id);
  draw();
}

function openAgentMenu(btn, a) {
  const panel = document.getElementById('agents-panel').getBoundingClientRect();
  const r = btn.getBoundingClientRect();
  setAgentsLayer(`<div class="ag-catch"></div><div class="ag-menu" role="menu" style="top:${Math.round(r.bottom - panel.top + 6)}px;right:${Math.round(panel.right - r.right)}px">
    <button type="button" role="menuitem" data-act="rename">${AG_I.edit}Rename</button>
    <button type="button" role="menuitem" data-act="setup">${AG_I.terminal}Add it to your agent app…</button>
    <button type="button" role="menuitem" data-act="activity">${AG_I.pulse}See its activity</button>
    <hr>
    <button type="button" role="menuitem" class="red" data-act="revoke">${AG_I.trash}Revoke agent…</button></div>`);
  const layer = agentsLayer();
  layer.querySelector('.ag-catch').addEventListener('click', closeAgentsOverlays);
  layer.querySelector('[data-act=rename]').addEventListener('click', () => { closeAgentsOverlays(); startRename(a); });
  layer.querySelector('[data-act=setup]').addEventListener('click', () => goAgents({ kind: 'setup', id: a.id }));
  layer.querySelector('[data-act=activity]').addEventListener('click', () => goAgents({ kind: 'activity', agent: a.id }));
  layer.querySelector('[data-act=revoke]').addEventListener('click', () => openRevokeDialog(a));
  layer.querySelector('[data-act=rename]').focus();
}

function startRename(a) {
  const wrap = document.querySelector('#agents-detail .ag-name');
  wrap.innerHTML = `<input type="text" class="ag-search ag-rename" maxlength="60" value="${esc(a.name)}" aria-label="Agent name">
    <button type="button" class="ag-btn primary sm" data-act="save-name">Save</button>
    <button type="button" class="ag-btn link sm" data-act="cancel-name">Cancel</button>`;
  const input = wrap.querySelector('input');
  input.focus();
  input.select();
  const save = () => {
    const name = input.value.trim();
    if (!name || name === a.name) { renderAgentsPanel(); return; }
    agentAct(wrap, () => Agents.rename(a.id, name));
  };
  wrap.querySelector('[data-act=save-name]').addEventListener('click', save);
  wrap.querySelector('[data-act=cancel-name]').addEventListener('click', () => renderAgentsPanel());
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') save();
    if (e.key === 'Escape') { e.stopPropagation(); renderAgentsPanel(); }
  });
}

function openRevokeDialog(a) {
  setAgentsLayer(`<div class="ag-dim"></div><div class="ag-modal" role="alertdialog" aria-modal="true" aria-label="Revoke ${esc(a.name)}">
    <span class="ag-av lg bad">${AG_I.trash}</span>
    <div class="ag-t1 ag-lg">Revoke ${esc(a.name)}?</div>
    <p>It loses ${a.grants.length ? `its ${plural(a.grants.length, 'account', 'accounts')}` : 'its access'} right away. What it already used can't be taken back: change those passwords if you no longer trust it.</p>
    <div class="ag-btns"><span class="ag-grow"></span><button type="button" class="ag-btn" data-act="cancel">Cancel</button>
      <button type="button" class="ag-btn dangerfill" data-act="revoke">Revoke agent</button></div></div>`);
  const modal = agentsLayer().querySelector('.ag-modal');
  agentsLayer().querySelector('.ag-dim').addEventListener('click', closeAgentsOverlays);
  modal.querySelector('[data-act=cancel]').addEventListener('click', closeAgentsOverlays);
  modal.querySelector('[data-act=revoke]').addEventListener('click', () => agentAct(modal, async () => {
    await Agents.remove(a.id);
    _agentsSel = { kind: 'agents' };
  }));
  modal.querySelector('[data-act=cancel]').focus();
}

// Adding an account: search the vault, then what it can use. `asks`: its
// account requests still waiting; the newest is answered by what's added
// (unless unticked).
function openAddSheet(a, asks = []) {
  const have = new Set(a.grants.map(g => g.item_id));
  const ask = asks[asks.length - 1];
  const sheet = openAgentsSheet('Add an account', `
    <div class="ag-sheet-h"><div class="ag-grow"><div class="ag-t1 ag-lg">Add an account</div><div class="ag-t2">${esc(a.name)} can use it without ever seeing the values.</div></div>
      <button type="button" class="ag-icbtn plain" data-act="close" aria-label="Close">${AG_I.x}</button></div>
    <div class="ag-sheet-b"><div class="ag-picker"></div><div class="ag-grant"></div>
      ${ask ? `<label class="ag-checkline"><input type="checkbox" class="ag-answers" checked> Answers its request for <b>${esc(ask.query || 'an account')}</b></label>` : ''}</div>
    <div class="ag-foot"><button type="button" class="ag-btn" data-act="cancel">Cancel</button><span class="ag-grow"></span>
      <button type="button" class="ag-btn primary" data-act="allow" disabled>Allow</button></div>`);
  let chosen = null;
  const allow = sheet.querySelector('[data-act=allow]');
  mountItemPicker(sheet.querySelector('.ag-picker'), _agentsItems.filter(i => i.type === 'login' && !have.has(i.id)).slice(0, 8), item => {
    chosen = item;
    sheet.querySelector('.ag-grant').innerHTML = agentGrantFormHTML(item, a.grants.find(g => g.item_id === item.id));
    mountGrantForm(sheet);
    allow.disabled = false;
    allow.textContent = `Allow ${item.title || 'it'}`;
  });
  sheet.querySelector('[data-act=close]').addEventListener('click', closeAgentsOverlays);
  sheet.querySelector('[data-act=cancel]').addEventListener('click', closeAgentsOverlays);
  allow.addEventListener('click', () => agentAct(sheet, async () => {
    const answers = ask && sheet.querySelector('.ag-answers')?.checked;
    await Agents.grant(a, chosen, readGrantForm(sheet, a.grants.find(g => g.item_id === chosen.id)));
    if (!answers) return;
    // The account is added either way. A request that expired or was
    // answered elsewhere meanwhile has nothing left to answer; any other
    // failure leaves it waiting, and the page says so.
    await Agents.answer(ask, 'allow', chosen.id).catch(e => {
      const gone = e.status === 404 || (e.status === 400 && /already answered|expired/.test(e.message));
      if (!gone) _agentsNote = { agentId: a.id, text: `${chosen.title || 'The account'} is added, but its request couldn't be answered (${agentError(e)}). Answer it from Requests.` };
    });
  }));
  sheet.querySelector('.ag-search').focus();
}

// An account the agent can use: its permissions, changed or removed here.
// One that's expired opens to be renewed (an hour by default).
function openGrantSheet(a, g) {
  const item = itemById(g.item_id);
  const expired = agentExpiry(g.expires_at) === 'expired';
  const editable = item && a.pinned;
  const sheet = openAgentsSheet(itemTitle(g.item_id), `
    <div class="ag-sheet-h">${itemAvatar(item || { title: itemTitle(g.item_id) })}<div class="ag-grow"><div class="ag-t1 ag-lg">${esc(itemTitle(g.item_id))}</div>
      <div class="ag-t2">${esc(a.name)} can use it${g.updated_at ? ` since ${esc(new Date(g.updated_at).toLocaleDateString())}` : ''}</div></div>
      <button type="button" class="ag-icbtn plain" data-act="close" aria-label="Close">${AG_I.x}</button></div>
    <div class="ag-sheet-b">
      ${expired ? '<div class="ag-banner"><i class="ag-dot"></i><div class="ag-grow ag-t2">Expired. Pick how long to renew it for.</div></div>' : ''}
      ${editable ? `<div class="ag-grant">${agentGrantFormHTML(item, g)}</div>`
        : `<div class="ag-note">${item ? 'Check this agent\'s code on this device to change what it can use.' : 'This account isn\'t on this device: you can only remove it here.'}</div>`}
    </div>
    <div class="ag-foot"><button type="button" class="ag-btn danger" data-act="remove">${AG_I.trash}Remove access</button><span class="ag-grow"></span>
      <button type="button" class="ag-btn" data-act="cancel">Cancel</button>
      ${editable ? `<button type="button" class="ag-btn primary" data-act="save">${expired ? 'Renew' : 'Save'}</button>` : ''}</div>`);
  if (editable) mountGrantForm(sheet);
  sheet.querySelector('[data-act=close]').addEventListener('click', closeAgentsOverlays);
  sheet.querySelector('[data-act=cancel]').addEventListener('click', closeAgentsOverlays);
  sheet.querySelector('[data-act=remove]').addEventListener('click', () => agentAct(sheet, () => Agents.ungrant(a.id, g.item_id)));
  sheet.querySelector('[data-act=save]')?.addEventListener('click', () => agentAct(sheet, () => Agents.grant(a, item, readGrantForm(sheet, g))));
  focusAgentsOverlay(sheet, sheet.querySelector('input.ag-scope:checked'));
}

// ── Adding it to the agent app ──
function renderAgentSetup(detail, a) {
  detail.innerHTML = `<div><div class="ag-t1 ag-lg">Add it to your agent</div>
      <div class="ag-t2 ag-wrap">${esc(a.name)} is connected on <b>${esc(a.machine || 'its computer')}</b>. Add OTPilot to the app you use there:</div></div>
    <div class="ag-card">${AGENT_SETUP.map(([name, where, cmd], i) => `<div class="ag-setup-row">
      <div class="ag-grow"><div class="ag-t1">${esc(name)} <span class="ag-t2 ag-inline">${esc(where)}</span></div><pre class="ag-mono">${esc(cmd)}</pre></div>
      <button type="button" class="ag-btn sm" data-copy="${i}">${AG_I.copy}Copy</button></div>`).join('')}</div>
    <div class="ag-safe">${AG_I.terminal}<span>Connected it with <code>--name</code> or <code>--profile</code>? Add <code>--profile &lt;name&gt;</code> after <code>@otpilot/mcp@latest</code>.</span></div>`;
  detail.prepend(backLink(a.name, { kind: 'agent', id: a.id }));
  detail.querySelectorAll('[data-copy]').forEach(b => b.addEventListener('click', async () => {
    if (await copyText(AGENT_SETUP[b.dataset.copy][2])) setStatus('Copied');
  }));
}

document.getElementById('nav-agents').addEventListener('click', () => showView('agents'));
document.getElementById('agents-connect').addEventListener('click', () => goAgents({ kind: 'connect' }));

// The window opened for agents waiting, asked to show a new one (the
// background focused it): back to the Agents view only from Home or Generate
// (the vault editor, Settings, Sync or Team may hold unsaved input — the dot
// on Agents says it then), or its list redrawn like the timer's: checked
// again after the request, so a form opened meanwhile stays.
if (AGENTS_WINDOW) chrome.runtime.onMessage.addListener(msg => {
  if (msg?.action !== 'agentsShow') return;
  const panel = document.getElementById('agents-panel');
  if (panel.style.display === 'none') {
    const shown = id => document.getElementById(id)?.style.display !== 'none';
    if (shown('home-view') || shown('generate-panel')) showView('agents');
    return;
  }
  if (agentsBusy(panel)) return;
  Agents.list().then(fresh => renderAgentsPanel(fresh), () => {});
});

// While the Agents view is open, new requests and agents waiting show up on
// their own (every 10 s): redrawn only when that changed, and never under a
// form, sheet, menu or dialog the user has open.
const agentsShape = d => JSON.stringify([
  (d?.agents || []).map(a => [a.id, a.status, a.name, a.client, a.grants.map(g => [g.item_id, g.revision, g.expires_at, g.ask_every_time])]),
  (d?.requests || []).map(r => r.id),
  d?.usage ? [d.usage.used, d.usage.limit, d.usage.trial_available, d.usage.resets_at] : null,
  d?.limits ? [d.limits.agents, d.limits.uses] : null,
  (d?.activity || []).slice(0, 8).map(u => u.id ?? u.created_at),
]);
const agentsBusy = panel => panel.querySelector('#agents-layer > *, .ag-grant:not(:empty), .ag-rename')
  || (panel.contains(document.activeElement) && /INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName));
setInterval(async () => {
  const panel = document.getElementById('agents-panel');
  if (!panel || panel.style.display === 'none' || document.visibilityState !== 'visible' || !_agentsData) return;
  if (agentsBusy(panel)) return;
  let fresh;
  try { fresh = await Agents.list(); } catch { return; }
  // Checked again: a form may have opened while the list loaded.
  if (agentsShape(fresh) === agentsShape(_agentsData) || agentsBusy(panel) || panel.style.display === 'none') return;
  renderAgentsPanel(fresh);
}, 10_000);

// ── The editor's "AI agents" section (saved logins) ─────────────────────────
// Which agents can use this item, and allowing a connected one (its default
// scope; the Agents view sets the rest). Applies at once, not on Save.

function agentsSectionHTML(acc) {
  return acc?._id ? `<div class="acc-field ag-editor" data-id="${esc(acc._id)}" hidden></div>` : '';
}

async function mountAgentsSection(body) {
  const box = body.querySelector('.ag-editor');
  if (!box) return;
  const itemId = box.dataset.id;
  if (!(await SupabaseAuth.getSession().catch(() => null))) return;
  let data;
  try { data = await Agents.list(); } catch { return; }
  const active = data.agents.filter(a => a.status === 'active');
  if (!active.length || !box.isConnected) return;
  const key = await VaultKeys.getKey();
  const item = key ? (await Agents.vaultItems(key)).find(i => i.id === itemId) : null;
  if (!item) return; // not saved yet
  const draw = () => {
    const withIt = active.filter(a => a.grants.some(g => g.item_id === itemId));
    const without = active.filter(a => a.pinned && !withIt.includes(a));
    box.innerHTML = `<label>AI agents</label>
      ${withIt.length ? `<div class="ag-card">${withIt.map(a => {
        const g = a.grants.find(x => x.item_id === itemId);
        return `<div class="ag-card-row" data-agent="${esc(a.id)}">${agentAv(false)}<div class="ag-grow"><div class="ag-t1">${esc(a.name)}</div>
          <div class="ag-t2">${esc(Agents.scopeSummary(item, g.scope))}${g.ask_every_time ? ' · asks every time' : ''}</div></div>
          <button class="ag-x" title="Stop letting ${esc(a.name)} use this">✕</button></div>`;
      }).join('')}</div>` : '<div class="ag-note">No agent can use this account.</div>'}
      <div class="ag-btns" style="margin-top:6px">
        ${without.length ? `<select class="ag-search" style="width:auto">${without.map(a => `<option value="${esc(a.id)}">${esc(a.name)}</option>`).join('')}</select>
          <button type="button" class="ag-btn sm" data-act="allow">Allow (${esc(Agents.scopeSummary(item, Agents.defaultScope(item)))})</button>` : ''}
        <button type="button" class="ag-btn link sm" data-act="manage">Manage in Agents</button>
      </div>
      <div class="ag-note">Agents never see these values. Changes here apply now.</div>`;
    box.hidden = false;
    const act = async fn => {
      const unlock = lockControls(box, 'button, select');
      box.querySelector('.ag-err')?.remove();
      try { await fn(); data = await Agents.list(); active.splice(0, active.length, ...data.agents.filter(a => a.status === 'active')); draw(); } catch (e) {
        unlock();
        box.insertAdjacentHTML('beforeend', `<div class="ag-err">${esc(agentError(e))}</div>`);
      }
    };
    box.querySelectorAll('.ag-card-row[data-agent]').forEach(row => row.querySelector('.ag-x')
      .addEventListener('click', () => act(() => Agents.ungrant(row.dataset.agent, itemId))));
    box.querySelector('[data-act=allow]')?.addEventListener('click', () => {
      const agent = active.find(a => a.id === box.querySelector('select').value);
      act(() => Agents.grant(agent, item, { scope: Agents.defaultScope(item) }));
    });
    box.querySelector('[data-act=manage]').addEventListener('click', () => {
      const first = withIt[0] || active[0];
      _agentsSel = first ? { kind: 'agent', id: first.id } : null;
      showView('agents');
    });
  };
  draw();
}
