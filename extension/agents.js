'use strict';

// 2.1 OTPilot for AI agents (docs/agents/plan.md). An agent is an OTPilot MCP
// server on the user's computer, with its own ECDH P-256 key; it never uses
// the extension. Here the user approves it (after checking its verification
// code) and lets it use some items: per agent and item, a copy projected to
// the allowed scope, encrypted under a fresh key wrapped to the agent's
// public key (keys.js, the same ECIES as team shares). The server only sees
// ciphertext; expiry, "ask every time" and revocation are enforced there.
//
// Trust: a public key is only encrypted to once the user checked its code on
// this device (`agentPins`), and only what the user allowed on this device is
// ever encrypted to it (`agentsApproved`: item + scope): a compromised server
// can't widen a grant (2FA → sign-in) or add an item by editing its list.
// Another device that didn't pin an agent or approve a grant leaves those
// copies alone (the device that did keeps them current).
//
// Items shared with the user (a teammate's share, `sr:<shareId>`, or a team
// collection's item, `cr:<cid>:<id>`) can be given to an agent too: a viewer
// can already read them. Their copy follows the shared item, and goes once
// the user loses access to it (`from` in `agentsApproved`).
//
// Needs vault.js, vaultCrypto.js, vaultStore.js, vaultKeys.js, keys.js,
// cloudSync.js, vaultShares.js (project()).
const Agents = (() => {
  const local = chrome.storage.local;
  const PINS = 'agentPins';           // { [agentId]: { key, code } } keys checked on this device
  const PUBLISHED = 'agentsPublished'; // { [agentId:itemId]: fingerprint } what this device last uploaded
  const APPROVED = 'agentsApproved';   // { [agentId:itemId]: scope (+ from) } what the user allowed on this device

  // ── Verification code ──────────────────────────────────────────────────
  // First 40 bits of SHA-256 over the raw public key, base32, XXXX-XXXX.
  // Mirrored in web/src/lib/agentCode.ts and mcp/src/code.ts (same vector).
  const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  async function code(publicKeyB64) {
    const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', VaultCrypto.b64d(publicKeyB64)));
    let bits = 0, value = 0, out = '';
    for (const b of hash.subarray(0, 5)) {
      value = (value << 8) | b;
      bits += 8;
      while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
    }
    return `${out.slice(0, 4)}-${out.slice(4)}`;
  }

  // ── API ────────────────────────────────────────────────────────────────
  async function ok(path, opts) {
    const res = await CloudSync.api(path, opts);
    const body = await res.json().catch(() => null);
    if (!res.ok) throw Object.assign(new Error(body?.error || `agents ${res.status}`), { status: res.status, body });
    return body;
  }

  const pins = async () => (await local.get(PINS))[PINS] || {};
  // The popup and the background both write these maps: every
  // read-modify-write takes one lock, so neither drops the other's entry.
  const locked = fn => navigator.locks.request('otpilot-agents', fn);

  function setPin(id, pin) {
    return locked(async () => {
      const all = await pins();
      if (pin) all[id] = pin; else delete all[id];
      await local.set({ [PINS]: all });
    });
  }

  async function published() { return (await local.get(PUBLISHED))[PUBLISHED] || {}; }
  async function approved() { return (await local.get(APPROVED))[APPROVED] || {}; }
  function noteApproved(key, scope) {
    return locked(async () => {
      const all = await approved();
      if (scope) all[key] = scope; else delete all[key];
      await local.set({ [APPROVED]: all });
    });
  }
  const sameScope = (a, b) => JSON.stringify({ kind: a?.kind, parts: [...(a?.parts || [])].sort() })
    === JSON.stringify({ kind: b?.kind, parts: [...(b?.parts || [])].sort() });
  function notePublished(entries) {
    return locked(async () => {
      const all = await published();
      for (const [k, fp] of entries) { if (fp) all[k] = fp; else delete all[k]; }
      await local.set({ [PUBLISHED]: all });
    });
  }

  // Everything the Agents view shows, each agent with its code and whether
  // its key was checked on this device (`pinned`; false when the server
  // reports a key other than the pinned one).
  async function list() {
    const data = await ok('/agents');
    const p = await pins();
    for (const a of data.agents) {
      a.code = await code(a.public_key);
      a.pinned = !!p[a.id] && p[a.id].key === a.public_key;
      a.keyChanged = !!p[a.id] && p[a.id].key !== a.public_key;
    }
    return data;
  }

  // Approves a pending agent whose code the user checked (shown from its own
  // key, never from the server's word).
  async function approve(agent) {
    await setPin(agent.id, { key: agent.public_key, code: await code(agent.public_key) });
    await ok(`/agents/${agent.id}/approve`, { method: 'POST' });
  }

  // Trusts an active agent's key on this device (the user compared its code).
  async function pin(agent) {
    await setPin(agent.id, { key: agent.public_key, code: await code(agent.public_key) });
  }

  // One agent's activity, newest first, ten at a time ({ items, more });
  // `before`: the id of the last use already shown.
  function activity(agentId, before = null) {
    return ok(`/agents/${agentId}/activity?limit=10${before != null ? `&before=${before}` : ''}`);
  }

  // Denies a pending agent or revokes an active one.
  async function remove(agentId) {
    await ok(`/agents/${agentId}`, { method: 'DELETE' });
    await setPin(agentId, null);
    const keep = all => Object.fromEntries(Object.entries(all).filter(([k]) => !k.startsWith(`${agentId}:`)));
    await locked(async () => local.set({ [PUBLISHED]: keep(await published()), [APPROVED]: keep(await approved()) }));
  }

  // ── Scopes ─────────────────────────────────────────────────────────────
  // { kind: '2fa' } the 2FA secret (+ sites); { kind: 'login' } username,
  // password, 2FA and sites; { kind: 'fields', parts: [...] } chosen parts
  // (VaultShares.parts keys). The title always goes.
  const SCOPE_LABELS = { '2fa': '2FA code', login: 'Sign-in', fields: 'Chosen fields' };

  function partsOf(scope) {
    if (scope.kind === '2fa') return ['totp', 'urls'];
    if (scope.kind === 'login') return ['f:username', 'f:password', 'totp', 'urls'];
    return [...(scope.parts || [])];
  }

  // The scope that suits an item by default: its 2FA code when it has one
  // (the least it can give), else a login's sign-in, else the other item
  // types' own fields (a server, an API key…).
  function defaultScope(item) {
    if (item.totp?.secret) return { kind: '2fa' };
    if (item.type === 'login') return { kind: 'login' };
    return { kind: 'fields', parts: VaultShares.parts(item).map(p => p.key) };
  }

  // What a scope gives of this item, for the UI ("2FA code · Password").
  function scopeSummary(item, scope) {
    if (scope.kind !== 'fields') return SCOPE_LABELS[scope.kind];
    const labels = new Map(VaultShares.parts(item).map(p => [p.key, p.label]));
    return (scope.parts || []).map(k => labels.get(k) || k).join(' · ') || 'Nothing';
  }

  function copyOf(item, scope) {
    return VaultShares.project(item, { id: item.id, whole: false, parts: partsOf(scope) });
  }

  async function fingerprint(copy, grant) {
    const bytes = new TextEncoder().encode(JSON.stringify({ copy: { ...copy, updatedAt: null }, grant }));
    return VaultCrypto.b64e(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)));
  }

  // ── Grants ─────────────────────────────────────────────────────────────

  // Lets `agent` use `item` (as stored in the vault): writes its copy.
  // opts: { scope, expiresAt (ISO | null), askEveryTime, commands, baseRevision }
  // (baseRevision: rewrite only the grant read at that revision — 404 once
  // the user removed or changed it meanwhile).
  async function grant(agent, item, opts) {
    const p = (await pins())[agent.id];
    if (!p || p.key !== agent.public_key) throw new Error('Check this agent\'s code on this device first');
    const scope = opts.scope || defaultScope(item);
    const meta = {
      scope,
      expires_at: opts.expiresAt || null,
      ask_every_time: !!opts.askEveryTime,
      commands: (opts.commands || []).map(c => c.trim()).filter(Boolean),
    };
    const copy = copyOf(item, scope);
    const sk = VaultCrypto.generateKey();
    // The label (title + sites) is always readable by the agent, so it can
    // name an "ask every time" account before its copy is released.
    const label = { id: item.id, type: item.type, title: item.title || '', urls: [...(item.urls || [])], fields: [], totp: null, notes: '', tags: [] };
    const body = {
      ...meta,
      record: await VaultCrypto.encryptItem(copy, VaultCrypto.b64e(sk)),
      label: await VaultCrypto.encryptItem(label, VaultCrypto.b64e(sk)),
      wrapped_key: await TeamKeys.wrapUserShare(sk, p.key),
      ...(opts.baseRevision != null ? { base_revision: opts.baseRevision } : {}),
      ...(opts.moveFrom ? { move_from: opts.moveFrom } : {}),
    };
    await ok(`/agents/${agent.id}/grants/${item.id}`, { method: 'PUT', body: JSON.stringify(body) });
    await noteApproved(`${agent.id}:${item.id}`, item._shared ? { ...scope, from: item._shared } : scope);
    await notePublished([[`${agent.id}:${item.id}`, await fingerprint(copy, meta)]]);
    if (opts.moveFrom) {
      await notePublished([[`${agent.id}:${opts.moveFrom}`, null]]);
      await noteApproved(`${agent.id}:${opts.moveFrom}`, null);
    }
  }

  async function ungrant(agentId, itemId) {
    try {
      await ok(`/agents/${agentId}/grants/${itemId}`, { method: 'DELETE' });
    } catch (e) { if (e.status !== 404) throw e; }
    await notePublished([[`${agentId}:${itemId}`, null]]);
    await noteApproved(`${agentId}:${itemId}`, null);
  }

  // Answers a request: allow (writing the grant first when it's for a new
  // account) or deny.
  async function decide(request, decision, grantArgs) {
    if (decision === 'allow' && grantArgs) await grant(grantArgs.agent, grantArgs.item, grantArgs.opts);
    await answer(request, decision, grantArgs?.item?.id);
  }

  // Only the answer (the grant, when one is needed, is already written).
  async function answer(request, decision, itemId) {
    await ok(`/agents/requests/${request.id}`, {
      method: 'POST',
      body: JSON.stringify({ decision, item_id: itemId ?? request.item_id ?? null }),
    });
  }

  // Vault items that may answer a request's free text ("github", or a site
  // like "admin.staging.acme.io"), best first: a login for that very site,
  // then one for the same domain (another subdomain), then a title, site or
  // username containing one of its words; logins before other items.
  const hostOf = u => String(u || '').trim().toLowerCase().replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
    .replace(/[/?#].*$/, '').replace(/:\d+$/, '').replace(/^\*\./, '').replace(/^www\./, '');
  // The last two labels (acme.io); not for a public suffix like co.uk.
  const domainOf = h => {
    const d = h.split('.').slice(-2);
    return d.length === 2 && !['co', 'com', 'net', 'org', 'gov', 'edu', 'ac'].includes(d[0]) ? d.join('.') : null;
  };
  function candidates(query, items, limit = 8) {
    const q = String(query || '').trim().toLowerCase();
    const usable = items.filter(i => i.type === 'login' || (i.fields || []).some(f => f.value));
    if (!q) return usable;
    const host = /^[a-z0-9.-]+\.[a-z]{2,}$/.test(hostOf(q)) ? hostOf(q) : null;
    // A site asks for its own logins: words then only count when nothing
    // matches the site or its domain.
    const words = q.split(/\s+/).filter(Boolean);
    const text = i => [i.title, ...(i.urls || []), Vault.getValue(i, 'username')].join(' ').toLowerCase();
    const score = i => {
      if (host && Vault.loginCoversHost(i.urls || [], host)) return 3;
      if (host && domainOf(host) && (i.urls || []).some(u => domainOf(hostOf(u)) === domainOf(host))) return 2;
      return words.some(w => text(i).includes(w)) ? 1 : 0;
    };
    return usable
      .map(i => [i, score(i)])
      .filter(([, n], _, all) => n && (!host || n > 1 || !all.some(([, m]) => m > 1)))
      .sort(([a, x], [b, y]) => (y - x) || ((a.type === 'login' ? 0 : 1) - (b.type === 'login' ? 0 : 1)))
      .map(([i]) => i)
      .slice(0, limit);
  }

  // ── Keeping copies current ─────────────────────────────────────────────
  // Rewrites the copies whose item changed since this device uploaded them,
  // and removes the grants of items deleted here (a Free vault doesn't sync,
  // so the server can't know). Only for agents pinned here, and only grants
  // the user approved here with the same scope: what the server lists is
  // never taken as permission to encrypt more. Returns how many copies were
  // written.
  async function syncCopies(key) {
    if (!(await SupabaseAuth.getSession().catch(() => null))) return 0;
    const p = await pins();
    if (!Object.keys(p).length) return 0;
    const ok_ = await approved();
    // Copies of shared items: what's shared is re-read from the server first
    // (the background may run long after the popup last did), so a revoked
    // share or a changed password is seen here. A failed refresh changes no
    // list, so it never reads as lost access.
    if (Object.values(ok_).some(s => s?.from)) await refreshShared();
    const { agents } = await ok('/agents');
    const { items } = await VaultStore.readAll(key);
    const byId = new Map([...items, ...await sharedItems()].map(i => [i.id, i]));
    const deleted = new Set(Object.keys(await VaultStore.listTombstones()));
    // Items sync gave a new id (their old one belonged to another account):
    // the grant moves to the new id.
    const moved = (await chrome.storage.local.get('vaultRemapped')).vaultRemapped || {};
    // Followed to the last move (A → B → C).
    const finalId = id => { const seen = new Set(); while (moved[id] && !seen.has(id)) { seen.add(id); id = moved[id]; } return id; };
    const pub = await published();
    let written = 0;
    for (const agent of agents) {
      if (agent.status !== 'active' || p[agent.id]?.key !== agent.public_key) continue;
      for (const g of agent.grants) {
        const mine = ok_[`${agent.id}:${g.item_id}`];
        if (!mine || !sameScope(mine, g.scope)) continue;
        const item = byId.get(g.item_id);
        const now = !item && moved[g.item_id] && byId.get(finalId(g.item_id));
        if (now) {
          if (agent.grants.some(x => x.item_id === now.id)) { await ungrant(agent.id, g.item_id).catch(() => {}); continue; }
          // One step on the server: only the grant as read, and no new slot.
          try {
            await grant(agent, now, { scope: g.scope, expiresAt: g.expires_at, askEveryTime: g.ask_every_time, commands: g.commands, baseRevision: g.revision, moveFrom: g.item_id });
            written++;
          } catch (e) { if (e.status !== 404) throw e; }
          continue;
        }
        if (!item) {
          // Only a deletion this device knows of (an unreadable record, or an
          // item this device never had, isn't one), or a shared item the
          // user can no longer open.
          if (deleted.has(g.item_id) || (mine.from && await sharedGone(mine.from, g.item_id))) {
            await ungrant(agent.id, g.item_id).catch(() => {});
          }
          continue;
        }
        const meta = { scope: g.scope, expires_at: g.expires_at, ask_every_time: g.ask_every_time, commands: g.commands };
        if (pub[`${agent.id}:${item.id}`] === await fingerprint(copyOf(item, g.scope), meta)) continue;
        // Only the grant as read: one removed or narrowed meanwhile stays so.
        try {
          await grant(agent, item, { scope: g.scope, expiresAt: g.expires_at, askEveryTime: g.ask_every_time, commands: g.commands, baseRevision: g.revision });
        } catch (e) { if (e.status === 404) continue; throw e; }
        written++;
      }
    }
    return written;
  }

  // ── Items shared with the user ─────────────────────────────────────────
  // The ones this session can open (their keys are in chrome.storage.session
  // once the popup refreshed them), each with `_shared`: { share } or
  // { collection } — where it comes from — and `_sharedBy` for the UI.
  async function sharedItems() {
    if (!(await SupabaseAuth.getSession().catch(() => null))) return [];
    const { collectionKeys = {}, shareKeys = {} } = await chrome.storage.session.get(['collectionKeys', 'shareKeys']);
    if (!Object.keys(collectionKeys).length && !Object.keys(shareKeys).length) return [];
    const all = await local.get(null);
    const owners = new Map((all.sharesWithMe?.shares || []).map(s => [s.id, s.owner?.email]));
    const names = new Map();
    for (const c of all.collectionsList?.collections || []) {
      if (!collectionKeys[c.id]) continue;
      try { names.set(c.id, await VaultCrypto.decryptName(c.encrypted_name, collectionKeys[c.id], c.id)); } catch { /* unnamed */ }
    }
    const out = [];
    for (const [k, rec] of Object.entries(all)) {
      const m = /^cr:([0-9a-f-]{36}):/.exec(k);
      const sk = m ? collectionKeys[m[1]] : (k.startsWith('sr:') ? shareKeys[k.slice(3)] : null);
      if (!sk) continue;
      try {
        const item = await VaultCrypto.decryptItem(rec, sk);
        if (item.deleted) continue;
        out.push(m
          ? { ...item, _shared: { collection: m[1] }, _sharedBy: names.get(m[1]) || 'a collection' }
          : { ...item, _shared: { share: k.slice(3) }, _sharedBy: owners.get(k.slice(3)) || 'a teammate' });
      } catch { /* unreadable: left out */ }
    }
    return out;
  }

  // Pulls the collections (their keys, items, the list) and the shares with
  // the user, as the popup does when it opens. Each failure is skipped.
  async function refreshShared() {
    if (typeof VaultCollections !== 'undefined') {
      try {
        for (const c of await VaultCollections.list()) {
          if (c.key && !c.offline) await VaultCollections.pull(c).catch(() => {});
        }
      } catch { /* offline or not on a team: the last lists stay */ }
    }
    await VaultShares.refresh().catch(() => {});
  }

  // Whether the user can no longer open a shared item, by the last lists the
  // server gave this user (not knowing is never "gone").
  async function sharedGone(from, itemId) {
    const userId = (await SupabaseAuth.getSession().catch(() => null))?.user?.id;
    if (!userId) return false;
    if (from.share) {
      const list = (await local.get('sharesWithMe')).sharesWithMe;
      return list?.userId === userId && !list.shares.some(s => s.id === from.share);
    }
    const cid = from.collection;
    const list = (await local.get('collectionsList')).collectionsList;
    if (list?.userId !== userId) return false;
    if (!list.collections.some(c => c.id === cid)) return true;
    // Still a member: gone once a pull of the collection no longer has it.
    const state = (await local.get(`cs:${cid}`))[`cs:${cid}`];
    return !!state?.cursor && !(state.revs && itemId in state.revs);
  }

  // The vault items, decrypted, then the items shared with the user (for
  // the pickers and the editor).
  async function vaultItems(key) {
    const { items } = await VaultStore.readAll(key);
    return [...items.filter(i => !i.deleted), ...await sharedItems()];
  }

  return {
    code, list, approve, pin, remove, activity, grant, ungrant, decide, answer, candidates, syncCopies,
    hostOfQuery: q => { const h = hostOf(q); return /^[a-z0-9.-]+\.[a-z]{2,}$/.test(h) ? h : null; },
    defaultScope, scopeSummary, partsOf, copyOf, vaultItems, SCOPE_LABELS,
  };
})();
