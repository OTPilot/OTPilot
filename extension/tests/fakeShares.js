// An in-memory stand-in for the API's /shares, /teams and /vault/items
// endpoints (same contract as api/src/routes/shares.rs), installed in an
// extension page on top of whatever CloudSync.api was (collections keep
// their fake). `window.fakeShares` exposes its state; `bob` is a teammate
// with his own ECDH keypair (`bob.jwk` opens what's wrapped to him).
export function installFakeShares(page) {
  return page.evaluate(async () => {
    const kp = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveKey']);
    const bob = {
      user_id: 'user-bob', email: 'bob@team.test',
      public_key: VaultCrypto.b64e(await crypto.subtle.exportKey('raw', kp.publicKey)),
      jwk: await crypto.subtle.exportKey('jwk', kp.privateKey),
    };
    const S = window.fakeShares = { rev: 100, shares: new Map(), me: 'user-me', bob, calls: [] };
    const reply = (status, body) => ({ status, ok: status === 200, json: async () => body });
    const prev = CloudSync.api;
    CloudSync.api = async (path, opts = {}) => {
      const url = new URL(path, 'https://api.test');
      const method = opts.method || 'GET';
      const body = opts.body ? JSON.parse(opts.body) : null;
      const parts = url.pathname.split('/').filter(Boolean);
      if (parts[0] === 'vault') {
        if (method === 'GET') return reply(200, { items: [], revision: 0, more: false });
        if (parts[2] === 'batch') return reply(200, { created: body.items.map(i => ({ id: i.id, revision: ++S.rev })), conflicts: [] });
        return reply(200, { id: parts[2], revision: ++S.rev });
      }
      if (parts[0] === 'teams') {
        if (parts.length === 1) return reply(200, { id: 'team-1', name: 'T' });
        return reply(200, { members: [
          { user_id: S.me, email: 'me@team.test', public_key: await TeamKeys.getPublicKeyB64() },
          { user_id: bob.user_id, email: bob.email, public_key: bob.public_key },
          { user_id: 'user-new', email: 'new@team.test', public_key: null },
        ] });
      }
      if (parts[0] !== 'shares') return prev ? prev(path, opts) : reply(404, {});
      S.calls.push(`${method} ${url.pathname}`);
      if (parts[1] === 'mine') {
        return reply(200, { shares: [...S.shares.values()].filter(s => s.owner === S.me).map(s => ({
          id: s.id, item_id: s.item_id, whole: s.whole, record: s.record, revision: s.revision,
          grants: s.grants.map(({ wrapped_key, ...g }) => g),
        })) });
      }
      if (parts[1] === 'with-me') {
        return reply(200, { shares: [...S.shares.values()].filter(s => s.owner !== S.me && s.grants.some(g => g.user_id === S.me)).map(s => ({
          id: s.id, owner: { id: s.owner, email: s.ownerEmail }, whole: s.whole, record: s.record, revision: s.revision,
          role: s.grants.find(g => g.user_id === S.me).role, via: s.grants.filter(g => g.user_id === S.me).map(g => ({ user_id: g.user_id, wrapped_key: g.wrapped_key })),
        })) });
      }
      if (parts.length === 1 && method === 'POST') {
        S.shares.set(body.id, { id: body.id, owner: S.me, item_id: body.item_id, whole: body.whole, record: body.record, revision: ++S.rev, grants: body.grants });
        return reply(200, { id: body.id, revision: S.rev });
      }
      const s = S.shares.get(parts[1]);
      if (!s) return reply(404, {});
      if (parts[2] === 'grants') {
        if (method === 'PUT') {
          s.grants = [...s.grants.filter(g => (body.user_id ? g.user_id !== body.user_id : g.collection_id !== body.collection_id)), body];
          return reply(200, { ok: true });
        }
        const uid = url.searchParams.get('user_id'), cid = url.searchParams.get('collection_id');
        s.grants = s.grants.filter(g => (uid ? g.user_id !== uid : g.collection_id !== cid));
        if (!s.grants.length) S.shares.delete(s.id);
        return reply(200, { ok: true, share_deleted: !s.grants.length });
      }
      if (method === 'PUT') {
        if (body.base_revision !== s.revision) return reply(409, { share: { id: s.id, record: s.record, revision: s.revision } });
        s.record = body.record;
        s.revision = ++S.rev;
        return reply(200, { id: s.id, revision: s.revision });
      }
      if (method === 'DELETE') { S.shares.delete(s.id); return reply(200, { ok: true }); }
      return reply(400, {});
    };
    // The popup's team lookups (sharing.js has its own fetch) use the fake too.
    if (typeof Sharing !== 'undefined') {
      Sharing.getMyTeam = async () => (await CloudSync.api('/teams')).json();
      Sharing.getMembers = async id => (await (await CloudSync.api(`/teams/${id}`)).json()).members;
    }
    // Opens a share's copy as Bob would: his private key unwraps the SK.
    S.openAsBob = async shareId => {
      const s = S.shares.get(shareId);
      const g = s.grants.find(x => x.user_id === bob.user_id);
      const mine = await TeamKeys.exportPrivJwk();
      await TeamKeys.adoptPrivJwk(bob.jwk);
      try {
        const sk = VaultCrypto.b64e(await TeamKeys.unwrapUserShare(g.wrapped_key));
        return { sk, item: await VaultCrypto.decryptItem(s.record, sk) };
      } finally { await TeamKeys.adoptPrivJwk(mine); }
    };
    // A share Bob owns, granted to me.
    S.shareFromBob = async (item, role = 'view') => {
      const id = crypto.randomUUID();
      const sk = VaultCrypto.b64e(VaultCrypto.generateKey());
      const record = await VaultCrypto.encryptItem({ ...item, id }, sk);
      const wrapped = await TeamKeys.wrapUserShare(VaultCrypto.b64d(sk), await TeamKeys.getPublicKeyB64());
      S.shares.set(id, { id, owner: bob.user_id, ownerEmail: bob.email, item_id: item.id, whole: true, record, revision: ++S.rev, grants: [{ user_id: S.me, role, wrapped_key: wrapped }] });
      return { id, sk };
    };
  });
}
