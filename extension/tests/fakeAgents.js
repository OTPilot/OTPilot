// An in-memory stand-in for the API's AI-agent endpoints (same contract as
// api/src/routes/agents.rs), installed in an extension page on top of
// whatever CloudSync.api was. `window.fakeAgents` exposes its state and
// `addAgent()` (an MCP server with its own ECDH keypair) / `openGrant()` (what
// that agent would decrypt).
export function installFakeAgents(page, { free = false } = {}) {
  return page.evaluate(async ({ free }) => {
    const S = window.fakeAgents = { agents: new Map(), requests: new Map(), uses: [], rev: 0, free, calls: [] };
    const reply = (status, body) => ({ status, ok: status >= 200 && status < 300, json: async () => body });
    const LIMITS = free ? { agents: 1, items: 3 } : { agents: null, items: null };

    S.addAgent = async ({ name = 'Claude Code', machine = 'mac', status = 'pending' } = {}) => {
      const kp = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveKey']);
      const a = {
        id: crypto.randomUUID(), name, machine, status, created_at: new Date().toISOString(),
        approved_at: status === 'active' ? new Date().toISOString() : null, last_used_at: null,
        public_key: VaultCrypto.b64e(await crypto.subtle.exportKey('raw', kp.publicKey)),
        jwk: await crypto.subtle.exportKey('jwk', kp.privateKey), grants: new Map(),
      };
      S.agents.set(a.id, a);
      return a;
    };
    S.addRequest = (agentId, { query = '', reason = '', tool = '', item_id = null } = {}) => {
      const r = { id: crypto.randomUUID(), agent_id: agentId, query, reason, tool, item_id, status: 'pending', created_at: new Date().toISOString() };
      S.requests.set(r.id, r);
      return r;
    };
    // What the agent opens: its private key unwraps the copy's key (ECIES, keys.js).
    S.openGrant = async (agentId, itemId) => {
      const a = S.agents.get(agentId);
      const g = a.grants.get(itemId);
      const priv = await crypto.subtle.importKey('jwk', a.jwk, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveKey']);
      const { epk, iv, ct } = JSON.parse(g.wrapped_key);
      const pub = await crypto.subtle.importKey('raw', VaultCrypto.b64d(epk), { name: 'ECDH', namedCurve: 'P-256' }, false, []);
      const aes = await crypto.subtle.deriveKey({ name: 'ECDH', public: pub }, priv, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
      const sk = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: VaultCrypto.b64d(iv) }, aes, VaultCrypto.b64d(ct)));
      return VaultCrypto.decryptItem(g.record, VaultCrypto.b64e(sk));
    };
    S.openLabel = async (agentId, itemId) => {
      const g = S.agents.get(agentId).grants.get(itemId);
      const rec = g.record;
      g.record = g.label;
      try { return await S.openGrant(agentId, itemId); } finally { g.record = rec; }
    };

    const prev = CloudSync.api;
    CloudSync.api = async (path, opts = {}) => {
      const url = new URL(path, 'https://api.test');
      const method = opts.method || 'GET';
      const body = opts.body ? JSON.parse(opts.body) : null;
      const parts = url.pathname.split('/').filter(Boolean);
      if (parts[0] !== 'agents') return prev ? prev(path, opts) : reply(404, {});
      S.calls.push(`${method} ${url.pathname}`);
      const grantsOf = a => [...a.grants.entries()].map(([item_id, g]) => ({
        item_id, scope: g.scope, expires_at: g.expires_at, ask_every_time: g.ask_every_time, commands: g.commands, revision: g.revision,
      }));
      if (parts.length === 1 && method === 'GET') {
        return reply(200, {
          agents: [...S.agents.values()].map(({ jwk, grants, ...a }) => ({ ...a, grants: grantsOf({ grants }) })),
          requests: [...S.requests.values()].filter(r => r.status === 'pending'),
          activity: S.uses,
          limits: LIMITS,
        });
      }
      if (parts[1] === 'requests') {
        const r = S.requests.get(parts[2]);
        if (!r) return reply(404, {});
        if (r.status !== 'pending') return reply(400, { error: 'already answered' });
        if (body.decision === 'deny') { r.status = 'denied'; return reply(200, { ok: true }); }
        const item = r.item_id || body.item_id;
        if (!S.agents.get(r.agent_id).grants.has(item)) return reply(400, { error: 'write the grant first' });
        Object.assign(r, { status: 'allowed', item_id: item });
        return reply(200, { ok: true });
      }
      const a = S.agents.get(parts[1]);
      if (!a) return reply(404, {});
      if (parts.length === 2 && method === 'DELETE') { S.agents.delete(a.id); return reply(200, { ok: true }); }
      if (parts[2] === 'approve') {
        if (a.status !== 'pending') return reply(404, {});
        a.status = 'active';
        a.approved_at = new Date().toISOString();
        return reply(200, { id: a.id, status: 'active' });
      }
      if (parts[2] === 'grants') {
        const itemId = parts[3];
        if (method === 'DELETE') return reply(a.grants.delete(itemId) ? 200 : 404, { ok: true });
        if (a.status !== 'active') return reply(404, {});
        const total = [...S.agents.values()].reduce((n, x) => n + x.grants.size, 0);
        if (free && !a.grants.has(itemId) && total >= 3) return reply(400, { error: 'free plan limit: three accounts for agents' });
        a.grants.set(itemId, { ...body, revision: ++S.rev });
        return reply(200, { item_id: itemId, revision: S.rev });
      }
      return reply(404, {});
    };
  }, { free });
}
