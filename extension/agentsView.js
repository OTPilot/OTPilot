'use strict';

// The popup's Agents view (2.1, docs/agents/mockups.html): AI agents waiting
// to connect and their requests, connected agents with the accounts each can
// use, and the editor's "AI agents" section. The logic is in agents.js; this
// file only renders. Loaded after popup.js (uses esc, setStatus, showView,
// noticeAgo, renderNotices).

const AGENT_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="8" width="16" height="12" rx="3"/><path d="M12 8V4"/><circle cx="9" cy="14" r="1.2" fill="currentColor"/><circle cx="15" cy="14" r="1.2" fill="currentColor"/></svg>';
const AGENT_CONNECT_CMD = 'npx -y @otpilot/mcp connect';
// How to add the MCP server to each agent (what `connect` prints, mcp/src/cli.ts).
const AGENT_SETUP = [
  ['Claude Code', 'In a terminal', 'claude mcp add otpilot -- npx -y @otpilot/mcp'],
  ['Codex', 'In ~/.codex/config.toml', '[mcp_servers.otpilot]\ncommand = "npx"\nargs = ["-y", "@otpilot/mcp"]'],
  ['Cursor', 'In ~/.cursor/mcp.json', '{ "mcpServers": { "otpilot": { "command": "npx", "args": ["-y", "@otpilot/mcp"] } } }'],
];
const AGENT_DURATIONS = [
  ['', 'Until I revoke'],
  ['1h', '1 hour'],
  ['1d', '1 day'],
  ['7d', '1 week'],
];
const AGENT_ACTIONS = { browser_login: 'signed in to', login_attempt: 'tried to sign in to', run: 'ran a command with', totp: 'got a 2FA code for' };

let _agentsData = null;     // last Agents.list()
let _agentsItems = [];      // vault items (decrypted) for names and pickers
let _agentsSel = null;      // { kind: 'agent' | 'request' | 'connect', id }

const agentAv = (pending, lg) => `<span class="ag-av${pending ? ' pending' : ''}${lg ? ' lg' : ''}">${AGENT_ICON}</span>`;
const agentById = id => _agentsData?.agents.find(a => a.id === id);
const itemById = id => _agentsItems.find(i => i.id === id);
const itemTitle = id => itemById(id)?.title || 'An item not on this device';

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
  if (/free plan limit/.test(msg)) return 'The free plan lets one agent use up to 3 accounts. Personal removes the limit.';
  if (e?.status === 404) return 'This is no longer there. It may have expired, or been answered elsewhere.';
  if (/expired/.test(msg)) return 'This request has expired. Ask the agent to try again.';
  return msg || 'Could not reach OTPilot. Try again.';
}

function updateAgentsDot(n) {
  document.getElementById('nav-agents-dot').hidden = !n;
}

// `fresh`: the list already fetched (the timer's), so nothing changes between
// its last check and the redraw.
async function renderAgentsPanel(fresh = null) {
  const list = document.getElementById('agents-list');
  const detail = document.getElementById('agents-detail');
  const session = await SupabaseAuth.getSession().catch(() => null);
  document.getElementById('agents-connect').style.display = session ? '' : 'none';
  if (!session) {
    list.innerHTML = '';
    document.getElementById('agents-limit').innerHTML = '';
    detail.innerHTML = `<div class="ag-empty" style="max-width:380px;margin:20px auto 0">
      ${agentAv(false, true)}
      <div style="font-size:15px;font-weight:700;color:var(--ink-0);margin:10px 0 4px">Let your AI agents sign in, safely</div>
      Claude Code, Codex, Cursor or any MCP agent can use the accounts you allow — passwords and 2FA codes — <b style="color:var(--ink-1)">without ever seeing them</b>.
      <div style="margin-top:14px">Sign in to OTPilot to connect one. A free account works.</div>
      <div class="ag-btns" style="justify-content:center;margin-top:14px"><button class="ag-btn primary" id="agents-signin">Sign in</button></div>
    </div>`;
    detail.querySelector('#agents-signin').addEventListener('click', () => showView('sync'));
    return;
  }
  try {
    const key = await VaultKeys.getKey();
    const [data, items] = await Promise.all([fresh || Agents.list(), key ? Agents.vaultItems(key) : []]);
    // A timer redraw: a form opened during those waits stays as it is.
    const panel = document.getElementById('agents-panel');
    if (fresh && panel && agentsBusy(panel)) return;
    [_agentsData, _agentsItems] = [data, items];
  } catch (e) {
    detail.innerHTML = `<div class="ag-empty">${esc(agentError(e))}</div>`;
    return;
  }
  const { agents, requests } = _agentsData;
  const pending = agents.filter(a => a.status === 'pending');
  const active = agents.filter(a => a.status === 'active');
  updateAgentsDot(pending.length + requests.length);

  // Keep the selection while it exists; else the first thing to answer.
  const exists = s => s && (s.kind === 'connect' || (s.kind === 'agent' ? agentById(s.id) : requests.some(r => r.id === s.id)));
  if (!exists(_agentsSel)) {
    _agentsSel = pending[0] ? { kind: 'agent', id: pending[0].id }
      : requests[0] ? { kind: 'request', id: requests[0].id }
      : active[0] ? { kind: 'agent', id: active[0].id }
      : { kind: 'connect' };
  }

  const row = (sel, pendingAv, name, sub, dot) => `
    <button class="lc-row${_agentsSel.kind === sel.kind && _agentsSel.id === sel.id ? ' sel' : ''}" data-kind="${sel.kind}" data-id="${esc(sel.id)}">
      ${agentAv(pendingAv)}
      <span class="lc-row-text"><span class="lc-row-name">${esc(name)}</span><span class="lc-row-sub">${esc(sub)}</span></span>
      ${dot ? '<i class="ag-row-dot"></i>' : ''}
    </button>`;
  let html = '';
  if (pending.length || requests.length) {
    html += `<div class="lc-section">Pending <span class="ag-pill warn">${pending.length + requests.length}</span></div>`;
    html += pending.map(a => row({ kind: 'agent', id: a.id }, true, a.name, 'wants to connect', true)).join('');
    html += requests.map(r => {
      const a = agentById(r.agent_id);
      const what = r.item_id ? `wants to use ${itemTitle(r.item_id)}` : `asks for ${r.query || 'an account'}`;
      return row({ kind: 'request', id: r.id }, true, a?.name || 'Agent', what, true);
    }).join('');
  }
  if (active.length) {
    html += '<div class="lc-section">Connected</div>';
    html += active.map(a => row({ kind: 'agent', id: a.id }, false, a.name,
      `${a.machine ? `${a.machine} · ` : ''}${a.grants.length} account${a.grants.length === 1 ? '' : 's'}`, false)).join('');
  }
  list.innerHTML = html || '<div class="lc-empty">No agents yet</div>';
  list.querySelectorAll('.lc-row').forEach(b => b.addEventListener('click', () => {
    _agentsSel = { kind: b.dataset.kind, id: b.dataset.id };
    renderAgentsPanel();
  }));

  renderAgentsLimit();
  if (_agentsSel.kind === 'connect') renderAgentConnectHelp(detail);
  else if (_agentsSel.kind === 'request') renderAgentRequest(detail, requests.find(r => r.id === _agentsSel.id));
  else {
    const a = agentById(_agentsSel.id);
    if (a.status === 'pending') renderPendingAgent(detail, a);
    else renderActiveAgent(detail, a);
  }
}

function renderAgentsLimit() {
  const el = document.getElementById('agents-limit');
  const lim = _agentsData.limits;
  if (!lim?.items) { el.innerHTML = ''; return; }
  const used = _agentsData.agents.reduce((n, a) => n + a.grants.length, 0);
  el.innerHTML = `<div class="ag-limit">
    <span><b>Free plan</b> · ${lim.agents} agent · ${lim.items} accounts</span>
    <div class="ag-meter"><i style="width:${Math.min(100, Math.round((used / lim.items) * 100))}%"></i></div>
    <span style="color:var(--ink-4)">${used} of ${lim.items} accounts used</span>
    <a class="ag-btn sm primary" style="text-align:center;text-decoration:none" target="_blank" href="${esc(CONFIG.DASHBOARD_URL)}/dashboard/billing">Unlimited with Personal</a>
  </div>`;
}

function renderAgentConnectHelp(detail) {
  detail.innerHTML = `<div class="ag-empty" style="max-width:400px;margin:6px auto 0">
    ${agentAv(false, true)}
    <div style="font-size:15px;font-weight:700;color:var(--ink-0);margin:10px 0 4px">Let your AI agents sign in, safely</div>
    Claude Code, Codex, Cursor or any MCP agent can use the accounts you allow — passwords and 2FA codes — <b style="color:var(--ink-1)">without ever seeing them</b>.
    <ol class="ag-steps">
      <li><span>In your terminal: <span class="ag-mono">${esc(AGENT_CONNECT_CMD)}</span></span></li>
      <li><span>It shows a code and opens a page to sign in. Then approve it here, if the codes match.</span></li>
      <li><span>Choose the accounts it can use. Revoke anytime.</span></li>
    </ol>
    <div class="ag-btns" style="justify-content:center;margin-top:16px">
      <a class="ag-btn" target="_blank" href="${esc(CONFIG.DASHBOARD_URL)}/ai-agents" style="text-decoration:none">How it works</a>
      <button class="ag-btn primary" id="agents-copy-cmd">Copy the command</button>
    </div>
  </div>`;
  detail.querySelector('#agents-copy-cmd').addEventListener('click', async () => {
    await navigator.clipboard.writeText(AGENT_CONNECT_CMD).catch(() => {});
    setStatus('Command copied');
  });
}

// Runs `fn` with the buttons of `box` disabled; shows its error in `box`.
async function agentAct(box, fn) {
  box.querySelectorAll('button, select, input').forEach(b => { b.disabled = true; });
  box.querySelector('.ag-err')?.remove();
  try {
    await fn();
    await renderAgentsPanel();
    renderNotices();
  } catch (e) {
    box.querySelectorAll('button, select, input').forEach(b => { b.disabled = false; });
    box.insertAdjacentHTML('beforeend', `<div class="ag-err">${esc(agentError(e))}</div>`);
  }
}

function renderPendingAgent(detail, a) {
  detail.innerHTML = `<div class="ag-request">
    <div class="ag-head">${agentAv(true, true)}
      <div class="ag-grow"><div class="ag-t1">${esc(a.name)} wants to connect</div><div class="ag-t2">${esc(a.machine || 'Unknown computer')} · ${esc(noticeAgo(a.created_at))}</div></div>
      <span class="ag-pill warn">New agent</span>
    </div>
    <div class="ag-code"><span class="code">${esc(a.code)}</span>
      <span class="hint">Approve only if your terminal shows <b style="color:var(--ink-1)">this same code</b>. If it doesn't, deny: someone else is asking.</span></div>
    <div class="ag-text">Connecting gives it <b>no accounts</b>. You choose which ones next, or approve them one by one when it asks.</div>
    <div class="ag-btns"><button class="ag-btn danger" data-act="deny">Deny</button><span class="ag-grow"></span><button class="ag-btn primary" data-act="approve">Codes match · Connect</button></div>
  </div>`;
  const box = detail.querySelector('.ag-request');
  box.querySelector('[data-act=deny]').addEventListener('click', () => agentAct(box, () => Agents.remove(a.id)));
  box.querySelector('[data-act=approve]').addEventListener('click', () => agentAct(box, async () => {
    await Agents.approve(a);
    _agentsSel = { kind: 'agent', id: a.id, adding: true };
  }));
}

// Scope / duration / ask-every-time / commands for `item`.
function agentGrantFormHTML(item, current) {
  const scope = current?.scope || Agents.defaultScope(item);
  const isLogin = item.type === 'login';
  const hasTotp = !!item.totp?.secret;
  const opt = (v, label, on, dis) => `<option value="${v}"${on ? ' selected' : ''}${dis ? ' disabled' : ''}>${label}</option>`;
  const parts = VaultShares.parts(item);
  const chosen = new Set(scope.kind === 'fields' ? scope.parts : []);
  // An expired grant being renewed has no time left to keep: an hour by default.
  // The same rule the list shows "expired" by (its last half minute counts).
  const expired = current?.expires_at && agentExpiry(current.expires_at) === 'expired';
  const keep = current?.expires_at && !expired;
  return `<div class="ag-form">
    <label>It can use
      <select class="ag-scope">
        ${opt('2fa', '2FA code only', scope.kind === '2fa', !hasTotp)}
        ${opt('login', 'Sign-in: username, password, 2FA', scope.kind === 'login', !isLogin)}
        ${opt('fields', 'Chosen fields…', scope.kind === 'fields')}
      </select>
    </label>
    <div class="ag-fields"${scope.kind === 'fields' ? '' : ' hidden'}>
      ${parts.map(p => `<label><input type="checkbox" value="${esc(p.key)}"${chosen.has(p.key) ? ' checked' : ''}> ${esc(p.label)}</label>`).join('') || '<span class="ag-note">This item has no fields to share.</span>'}
    </div>
    <label>For
      <select class="ag-duration">
        ${keep ? opt('keep', `As now (${esc(agentExpiry(current.expires_at))})`, true) : ''}
        ${AGENT_DURATIONS.map(([v, l]) => opt(v, l, expired ? v === '1h' : !v && !current?.expires_at)).join('')}
      </select>
      <span style="margin-left:8px"><input type="checkbox" class="ag-ask"${current?.ask_every_time ? ' checked' : ''}> Ask me every time</span>
    </label>
    <label style="flex-direction:column;align-items:stretch;gap:3px">Only with these commands (optional, comma-separated)
      <input type="text" class="ag-commands" placeholder="e.g. psql, curl" value="${esc((current?.commands || []).join(', '))}">
    </label>
  </div>`;
}

function mountGrantForm(box) {
  const scope = box.querySelector('.ag-scope');
  scope?.addEventListener('change', () => { box.querySelector('.ag-fields').hidden = scope.value !== 'fields'; });
}

function readGrantForm(box, current) {
  const kind = box.querySelector('.ag-scope').value;
  const scope = kind === 'fields'
    ? { kind, parts: [...box.querySelectorAll('.ag-fields input:checked')].map(i => i.value) }
    : { kind };
  if (kind === 'fields' && !scope.parts.length) throw new Error('Pick at least one field');
  return {
    scope,
    expiresAt: box.querySelector('.ag-duration').value === 'keep' ? current?.expires_at ?? null : durationToIso(box.querySelector('.ag-duration').value),
    askEveryTime: box.querySelector('.ag-ask').checked,
    commands: box.querySelector('.ag-commands').value.split(',').map(s => s.trim()).filter(Boolean),
  };
}

// A searchable list of vault items (and items shared with the user); `onPick(item)`.
function mountItemPicker(container, initial, onPick) {
  container.innerHTML = `<input type="text" class="ag-search" placeholder="Search the vault…"><div class="ag-pick" style="margin-top:6px"></div>`;
  const input = container.querySelector('.ag-search');
  const pick = container.querySelector('.ag-pick');
  const show = () => {
    const found = input.value.trim() ? Agents.candidates(input.value, _agentsItems) : initial;
    pick.innerHTML = found.map(i => `<button type="button" data-id="${esc(i.id)}"><span class="ag-grow">${esc(i.title || 'Untitled')}</span>
      <span class="ag-note">${i._shared ? `Shared · ${esc(i._sharedBy)}${(i.urls || [])[0] ? ' · ' : ''}` : ''}${esc((i.urls || [])[0] || (i._shared ? '' : Vault.TYPES[i.type]?.label || ''))}</span></button>`).join('')
      || '<div class="ag-note">Nothing matches.</div>';
    pick.querySelectorAll('button').forEach(b => b.addEventListener('click', () => {
      pick.querySelectorAll('button').forEach(x => x.classList.toggle('sel', x === b));
      onPick(itemById(b.dataset.id));
    }));
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
  const found = Agents.candidates(r.query, _agentsItems);
  const host = Agents.hostOfQuery(r.query);
  if (!found.length) {
    container.innerHTML = `<div class="ag-note">No account in your vault matches <b>${esc(r.query || 'this')}</b>. Deny it, or save the login${host ? ` for ${esc(host)}` : ''} first: it shows here.</div>`;
    return;
  }
  const has = new Set((agent?.grants || []).map(g => g.item_id));
  container.innerHTML = `<div class="ag-pick">${found.map(i => {
    const elsewhere = host && i.type === 'login' && !Vault.loginCoversHost(i.urls || [], host);
    return `<button type="button" data-id="${esc(i.id)}"><span class="ag-grow">${esc(i.title || 'Untitled')}
      ${has.has(i.id) ? '<span class="ag-pill muted">Already allowed</span>' : ''}
      ${elsewhere ? `<span class="ag-note" style="display:block">Saved for ${esc(Agents.hostOfQuery((i.urls || [])[0]) || 'another site')}, not ${esc(host)}: add the site to it to sign in there</span>` : ''}</span>
      <span class="ag-note">${i._shared ? `Shared · ${esc(i._sharedBy)}` : esc((i.urls || [])[0] || Vault.TYPES[i.type]?.label || '')}</span></button>`;
  }).join('')}</div>`;
  const pick = container.querySelector('.ag-pick');
  pick.querySelectorAll('button').forEach(b => b.addEventListener('click', () => {
    pick.querySelectorAll('button').forEach(x => x.classList.toggle('sel', x === b));
    onPick(itemById(b.dataset.id));
  }));
}

function renderAgentRequest(detail, r) {
  const a = agentById(r.agent_id);
  const header = `<div class="ag-head">${agentAv(true, true)}
    <div class="ag-grow"><div class="ag-t1">${esc(a?.name || 'Agent')} ${r.item_id ? `wants to use <b>${esc(itemTitle(r.item_id))}</b> now` : `asks for <b>${esc(r.query || 'an account')}</b>`}</div>
    <div class="ag-t2">${r.tool ? `for <b>${esc(r.tool)}</b> · ` : ''}${esc(noticeAgo(r.created_at))}</div></div></div>
    ${r.reason ? `<div class="ag-text">Reason given by the agent: <i>“${esc(r.reason)}”</i></div>` : ''}`;
  if (r.item_id) {
    // One use of an "ask every time" grant.
    detail.innerHTML = `<div class="ag-request">${header}
      <div class="ag-note">You asked to approve every use of this account.</div>
      <div class="ag-btns"><button class="ag-btn danger" data-act="deny">Deny</button><span class="ag-grow"></span><button class="ag-btn primary" data-act="allow">Allow this time</button></div></div>`;
    const box = detail.querySelector('.ag-request');
    box.querySelector('[data-act=deny]').addEventListener('click', () => agentAct(box, () => Agents.decide(r, 'deny')));
    box.querySelector('[data-act=allow]').addEventListener('click', () => agentAct(box, () => Agents.decide(r, 'allow')));
    return;
  }
  detail.innerHTML = `<div class="ag-request">${header}
    <div><div class="ag-sec-head">Which account?</div><div class="ag-picker"></div></div>
    <div class="ag-grant"></div>
    <div class="ag-btns"><button class="ag-btn danger" data-act="deny">Deny</button><span class="ag-grow"></span><button class="ag-btn primary" data-act="allow" disabled>Allow</button></div>
  </div>
  <p class="ag-note">The agent never receives these values: OTPilot uses them on its side (signs in, runs the command) and only returns the result.</p>`;
  const box = detail.querySelector('.ag-request');
  let chosen = null;
  const allow = box.querySelector('[data-act=allow]');
  mountRequestPicker(box.querySelector('.ag-picker'), r, a, item => {
    chosen = item;
    box.querySelector('.ag-grant').innerHTML = agentGrantFormHTML(item);
    mountGrantForm(box);
    allow.disabled = false;
    allow.textContent = `Allow ${item.title || 'it'} for ${a?.name || 'the agent'}`;
  });
  box.querySelector('[data-act=deny]').addEventListener('click', () => agentAct(box, () => Agents.decide(r, 'deny')));
  allow.addEventListener('click', () => agentAct(box, () => Agents.decide(r, 'allow', { agent: a, item: chosen, opts: readGrantForm(box) })));
}

// A message for an agent's page, shown once after it re-renders.
let _agentsNote = null;

function renderActiveAgent(detail, a) {
  // Shown on its own agent's page only (another agent may be open meanwhile).
  const note = _agentsNote?.agentId === a.id ? _agentsNote.text : null;
  if (note) _agentsNote = null;
  const activity = (_agentsData.activity || []).filter(u => u.agent_id === a.id).slice(0, 8);
  // Its requests for an account still waiting: an account added here can answer one.
  const asks = (_agentsData.requests || []).filter(r => r.agent_id === a.id && !r.item_id);
  const time = iso => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const grantRow = g => {
    const item = itemById(g.item_id);
    const exp = agentExpiry(g.expires_at);
    return `<div class="ag-card-row" data-item="${esc(g.item_id)}">
      <div class="ag-grow"><div class="ag-t1">${esc(itemTitle(g.item_id))}</div>
        <div class="ag-btns" style="margin-top:3px">
          <span class="ag-pill">${esc(item ? Agents.scopeSummary(item, g.scope) : Agents.SCOPE_LABELS[g.scope.kind])}</span>
          ${g.ask_every_time ? '<span class="ag-pill warn">Asks every time</span>' : ''}
          ${item?._shared ? `<span class="ag-pill muted">Shared · ${esc(item._sharedBy)}</span>` : ''}
          ${exp ? `<span class="ag-pill muted">${esc(exp)}</span>` : ''}
          ${exp === 'expired' && item && a.pinned ? '<button class="ag-btn link sm" data-act="renew">Renew</button>' : ''}
          ${g.commands.length ? `<span class="ag-pill muted">only ${esc(g.commands.join(', '))}</span>` : ''}
        </div></div>
      <button class="ag-x" title="Stop letting ${esc(a.name)} use this">✕</button>
    </div>`;
  };
  detail.innerHTML = `
    <div class="ag-head">${agentAv(false, true)}
      <div class="ag-grow"><div class="ag-t1 lg">${esc(a.name)}</div>
        <div class="ag-t2">${esc(a.machine || 'Unknown computer')} · connected ${esc(new Date(a.approved_at || a.created_at).toLocaleDateString())}${a.last_used_at ? ` · last used ${esc(noticeAgo(a.last_used_at))}` : ''}</div></div>
      <button class="ag-btn danger sm" data-act="revoke">Revoke agent</button>
    </div>
    ${a.keyChanged ? `<div class="ag-request" style="border-color:rgba(var(--danger-rgb),.5)"><div class="ag-text"><b>This agent's key changed</b> since you approved it on this device. Revoke it and connect it again.</div></div>`
      : !a.pinned ? `<div class="ag-request"><div class="ag-text">Approved on another device. Before this device updates what it can use, check its code: run <span class="ag-mono">npx -y @otpilot/mcp status</span>.</div>
        <div class="ag-code"><span class="code">${esc(a.code)}</span><span class="hint">Same code in the terminal?</span></div>
        <div class="ag-btns"><span class="ag-grow"></span><button class="ag-btn primary" data-act="pin">Codes match</button></div></div>` : ''}
    ${note ? `<div class="ag-err">${esc(note)}</div>` : ''}
    ${asks.map(r => `<div class="ag-request" data-req="${esc(r.id)}"><div class="ag-btns"><div class="ag-text ag-grow">Asks for <b>${esc(r.query || 'an account')}</b> · ${esc(noticeAgo(r.created_at))}</div>
      <button class="ag-btn primary sm" data-act="review">Review</button></div></div>`).join('')}
    <div>
      <div class="ag-sec-head">Accounts it can use <button class="ag-btn link sm" data-act="add"${a.pinned ? '' : ' disabled'}>+ Add account</button></div>
      <div class="ag-adding"></div>
      ${a.grants.length ? `<div class="ag-card">${a.grants.map(grantRow).join('')}</div>` : '<div class="ag-note">None yet. Add one, or approve it when the agent asks.</div>'}
    </div>
    <details class="ag-setup"${activity.length ? '' : ' open'}>
      <summary class="ag-sec-head">Add it to your agent</summary>
      <div class="ag-card">${AGENT_SETUP.map(([name, where, cmd], i) => `<div class="ag-card-row" style="align-items:flex-start">
        <div class="ag-grow" style="min-width:0"><div class="ag-t1">${esc(name)} <span class="ag-note">${esc(where)}</span></div>
          <pre class="ag-mono" style="margin:4px 0 0;white-space:pre-wrap;word-break:break-all">${esc(cmd)}</pre></div>
        <button type="button" class="ag-btn link sm" data-copy="${i}">Copy</button></div>`).join('')}</div>
      <div class="ag-note" style="margin-top:4px">Connected it with <span class="ag-mono">--name</span> or <span class="ag-mono">--profile</span>? Add <span class="ag-mono">--profile &lt;name&gt;</span> after <span class="ag-mono">@otpilot/mcp</span>.</div>
    </details>
    <div>
      <div class="ag-sec-head">Activity</div>
      ${activity.length ? `<div class="ag-card">${activity.map(u => `<div class="ag-log"><time>${esc(time(u.created_at))}</time>
        <span>${esc(AGENT_ACTIONS[u.action] || u.action)} <b>${esc(u.item_id ? itemTitle(u.item_id) : '')}</b>${u.detail ? ` · ${esc(u.detail)}` : ''}</span></div>`).join('')}</div>`
        : '<div class="ag-note">Nothing yet.</div>'}
    </div>`;
  detail.querySelector('[data-act=revoke]').addEventListener('click', () => {
    if (!confirm(`Revoke ${a.name}? It loses every account you allowed. What it already used can't be taken back: change those passwords if you no longer trust it.`)) return;
    agentAct(detail, async () => { await Agents.remove(a.id); _agentsSel = null; });
  });
  detail.querySelectorAll('.ag-request[data-req] [data-act=review]').forEach(b => b.addEventListener('click', () => {
    _agentsSel = { kind: 'request', id: b.closest('[data-req]').dataset.req };
    renderAgentsPanel();
  }));
  detail.querySelectorAll('.ag-setup [data-copy]').forEach(b => b.addEventListener('click', async () => {
    await navigator.clipboard.writeText(AGENT_SETUP[b.dataset.copy][2]).catch(() => {});
    setStatus('Copied');
  }));
  detail.querySelector('[data-act=pin]')?.addEventListener('click', () => agentAct(detail, () => Agents.pin(a)));
  detail.querySelectorAll('.ag-card-row[data-item]').forEach(row => {
    row.querySelector('.ag-x').addEventListener('click', () => agentAct(row, () => Agents.ungrant(a.id, row.dataset.item)));
    row.querySelector('[data-act=renew]')?.addEventListener('click', () => openAdd(itemById(row.dataset.item)));
  });
  // `renew`: an account it already has (an expired one), its form open with its settings.
  const openAdd = renew => {
    const box = detail.querySelector('.ag-adding');
    const have = new Set(a.grants.map(g => g.item_id));
    const ask = renew ? null : asks[asks.length - 1];
    box.innerHTML = `<div class="ag-request" style="margin-bottom:8px"><div class="ag-picker"></div><div class="ag-grant"></div>
      ${ask ? `<label class="ag-text"><input type="checkbox" class="ag-answers" checked> Answers its request for <b>${esc(ask.query || 'an account')}</b></label>` : ''}
      <div class="ag-btns"><button class="ag-btn" data-act="cancel">Cancel</button><span class="ag-grow"></span><button class="ag-btn primary" data-act="allow" disabled>${renew ? 'Renew' : 'Allow'}</button></div></div>`;
    const card = box.firstElementChild;
    let chosen = null;
    const allow = card.querySelector('[data-act=allow]');
    const pick = item => {
      chosen = item;
      card.querySelector('.ag-grant').innerHTML = agentGrantFormHTML(item, a.grants.find(g => g.item_id === item.id));
      mountGrantForm(card);
      allow.disabled = false;
    };
    if (renew) {
      card.querySelector('.ag-picker').innerHTML = `<div class="ag-t1">${esc(renew.title || 'Untitled')}</div>`;
      pick(renew);
    } else mountItemPicker(card.querySelector('.ag-picker'), _agentsItems.filter(i => i.type === 'login' && !have.has(i.id)).slice(0, 8), pick);
    card.querySelector('[data-act=cancel]').addEventListener('click', () => { box.innerHTML = ''; });
    allow.addEventListener('click', () => agentAct(card, async () => {
      const answers = ask && card.querySelector('.ag-answers')?.checked;
      await Agents.grant(a, chosen, readGrantForm(card, a.grants.find(g => g.item_id === chosen.id)));
      if (!answers) return;
      // The account is added either way. A request that expired or was
      // answered elsewhere meanwhile has nothing left to answer; any other
      // failure leaves it waiting, and the page says so.
      await Agents.answer(ask, 'allow', chosen.id).catch(e => {
        const gone = e.status === 404 || (e.status === 400 && /already answered|expired/.test(e.message));
        if (!gone) _agentsNote = { agentId: a.id, text: `${chosen.title || 'The account'} is added, but its request couldn't be answered (${agentError(e)}). Answer it from Pending.` };
      });
    }));
  };
  detail.querySelector('[data-act=add]').addEventListener('click', () => openAdd());
  if (_agentsSel.adding && a.pinned) { _agentsSel.adding = false; openAdd(); }
}

document.getElementById('nav-agents').addEventListener('click', () => showView('agents'));

// While the Agents view is open, new requests and agents waiting show up on
// their own (every 10 s): redrawn only when that changed, and never under a
// form the user is filling in.
const agentsShape = d => JSON.stringify([
  (d?.agents || []).map(a => [a.id, a.status, a.grants.map(g => [g.item_id, g.revision, g.expires_at, g.ask_every_time])]),
  (d?.requests || []).map(r => r.id),
  (d?.activity || []).slice(0, 8).map(u => u.id ?? u.created_at),
]);
const agentsBusy = panel => panel.querySelector('.ag-adding:not(:empty), .ag-grant:not(:empty)')
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
document.getElementById('agents-connect').addEventListener('click', () => {
  _agentsSel = { kind: 'connect' };
  renderAgentsPanel();
});

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
          <button type="button" class="ag-btn sm" data-act="allow">Allow (${esc(Agents.SCOPE_LABELS[Agents.defaultScope(item).kind])})</button>` : ''}
        <button type="button" class="ag-btn link sm" data-act="manage">Manage in Agents</button>
      </div>
      <div class="ag-note">Agents never see these values. Changes here apply now.</div>`;
    box.hidden = false;
    const act = async fn => {
      box.querySelectorAll('button, select').forEach(b => { b.disabled = true; });
      box.querySelector('.ag-err')?.remove();
      try { await fn(); data = await Agents.list(); active.splice(0, active.length, ...data.agents.filter(a => a.status === 'active')); draw(); } catch (e) {
        box.querySelectorAll('button, select').forEach(b => { b.disabled = false; });
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
