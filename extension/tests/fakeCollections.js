// An in-memory stand-in for the API's /collections endpoints, installed in an
// extension page by replacing CloudSync.api (same contract as
// api/src/routes/collections.rs). `window.fake` exposes its state.
export function installFakeCollections(page) {
  return page.evaluate(() => {
    const S = window.fake = { rev: 0, collections: new Map(), items: new Map(), me: 'user-me', emails: { 'user-me': 'me@team.test' } };
    const reply = (status, body) => ({ status, json: async () => body });
    CloudSync.api = async (path, opts = {}) => {
      const url = new URL(path, 'https://api.test');
      const method = opts.method || 'GET';
      const body = opts.body ? JSON.parse(opts.body) : null;
      const parts = url.pathname.split('/').filter(Boolean);
      if (parts[0] === 'teams' && parts[2] === 'collections' && method === 'POST') {
        S.collections.set(body.id, { id: body.id, team_id: parts[1], encrypted_name: body.encrypted_name, members: new Map([[S.me, { role: 'manage', wrapped_key: body.wrapped_key }]]) });
        return reply(200, { id: body.id });
      }
      if (parts[0] !== 'collections') return reply(404, {});
      if (parts.length === 1) {
        return reply(200, { collections: [...S.collections.values()].filter(c => c.members.has(S.me)).map(c => ({
          id: c.id, team_id: c.team_id, encrypted_name: c.encrypted_name, role: c.members.get(S.me).role,
          wrapped_key: c.members.get(S.me).wrapped_key, members: c.members.size,
        })) });
      }
      const c = S.collections.get(parts[1]);
      if (!c || !c.members.has(S.me)) return reply(404, {});
      if (parts.length === 2 && method === 'PATCH') { c.encrypted_name = body.encrypted_name; return reply(200, { ok: true }); }
      if (parts.length === 2 && method === 'DELETE') { S.collections.delete(c.id); return reply(200, { ok: true }); }
      if (parts[2] === 'members' && !parts[3]) {
        return reply(200, { members: [...c.members.entries()].map(([user_id, m]) => ({ user_id, email: S.emails[user_id] || user_id, role: m.role })) });
      }
      if (parts[2] === 'members' && parts[3] && method === 'DELETE') {
        c.members.delete(parts[3]);
        return reply(200, { ok: true });
      }
      if (parts[2] === 'members' && parts[3] && method === 'PUT') {
        c.members.set(parts[3], { role: body.role, wrapped_key: body.wrapped_key ?? c.members.get(parts[3])?.wrapped_key });
        return reply(200, { ok: true });
      }
      if (parts[2] === 'items' && !parts[3]) {
        const since = Number(url.searchParams.get('since') || 0);
        const list = [...S.items.values()].filter(i => i.cid === c.id && i.revision > since).sort((a, b) => a.revision - b.revision);
        return reply(200, { items: list.map(i => ({ id: i.id, record: i.deleted ? null : i.record, revision: i.revision, deleted: !!i.deleted })), revision: list.length ? list[list.length - 1].revision : since, more: false });
      }
      // A manager's atomic conversion (collections.rs convert_item).
      if (parts[2] === 'items' && parts[4] === 'convert' && method === 'POST') {
        await S.beforeConvert?.(parts[3]);
        const cur = S.items.get(parts[3]);
        if (!cur || cur.deleted) return reply(404, {});
        if (body.base_revision !== cur.revision) return reply(409, { item: { id: cur.id, record: cur.record, revision: cur.revision } });
        S.items.set(parts[3], { ...cur, record: null, deleted: true, revision: ++S.rev });
        (S.converted ||= []).push(body);
        if (window.fakeShares) {
          // The new personal item is on my server vault now (sync brings it).
          window.fakeShares.vault.push({ id: body.item.id, record: body.item.record, revision: ++window.fakeShares.rev });
          window.fakeShares.shares.set(body.share.id, { id: body.share.id, owner: S.me, item_id: body.item.id, whole: true, record: body.share.record,
            revision: ++window.fakeShares.rev, grants: [{ collection_id: c.id, role: 'edit', wrapped_key: body.share.wrapped_key }] });
        }
        return reply(200, { item_revision: S.rev, share_revision: S.rev });
      }
      if (parts[2] === 'items' && parts[3]) {
        const cur = S.items.get(parts[3]);
        if (method === 'PUT') {
          if (cur && body.base_revision !== cur.revision) return reply(409, { item: { id: cur.id, revision: cur.revision } });
          S.items.set(parts[3], { id: parts[3], cid: c.id, record: body.record, revision: ++S.rev });
          return reply(200, { id: parts[3], revision: S.rev });
        }
        if (method === 'DELETE') {
          if (!cur) return reply(404, {});
          if (Number(url.searchParams.get('base_revision')) !== cur.revision) return reply(409, {});
          S.items.set(parts[3], { ...cur, record: null, deleted: true, revision: ++S.rev });
          return reply(200, { id: parts[3], revision: S.rev });
        }
      }
      return reply(400, {});
    };
    });
}
