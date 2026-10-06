'use strict';

// Vault item model for 2.0 — pure functions, no storage, no UI.
//
// Every item has the same shape regardless of type; a type is only a template
// that decides which fields a new item starts with and how it's shown. Adding a
// type later (SSH key, database, Wi-Fi…) is a new TYPES entry — the stored
// format, encryption and sync don't change.
//
// Forward compatibility: an item whose `type`, or a field whose `kind`, this
// version doesn't know is kept as-is (never dropped or rewritten), so an older
// extension can't destroy data written by a newer one.
const Vault = (() => {
  const FREE_ITEM_LIMIT = 50;
  // Anything else (free, missing, unknown) gets the Free limit.
  const PAID_PLANS = ['personal', 'team_lite', 'team_pro'];

  const FIELD_KINDS = ['text', 'password', 'hidden', 'email', 'url', 'date', 'phone', 'multiline'];
  // Kinds whose value is masked by default and offered by the generator.
  const SECRET_KINDS = ['password', 'hidden'];

  const TYPES = {
    login: {
      label: 'Login',
      fields: [
        { id: 'username', label: 'Username', kind: 'text' },
        { id: 'password', label: 'Password', kind: 'password' },
      ],
      urls: true, totp: true, autofill: true,
    },
    note: {
      label: 'Secure note',
      fields: [],
    },
    server: {
      label: 'Server',
      fields: [
        { id: 'host', label: 'Host', kind: 'text' },
        { id: 'port', label: 'Port', kind: 'text' },
        { id: 'username', label: 'Username', kind: 'text' },
        { id: 'password', label: 'Password', kind: 'password' },
      ],
    },
    api: {
      label: 'API credential',
      fields: [
        { id: 'clientId', label: 'Client ID', kind: 'text' },
        { id: 'clientSecret', label: 'Client secret', kind: 'password' },
        { id: 'apiKey', label: 'API key', kind: 'password' },
        { id: 'environment', label: 'Environment', kind: 'text' },
        { id: 'expires', label: 'Expires', kind: 'date' },
      ],
    },
  };

  // Shown as "Coming soon" in the new-item picker.
  const UPCOMING_TYPES = [
    { id: 'ssh', label: 'SSH key' },
    { id: 'database', label: 'Database' },
    { id: 'wifi', label: 'Wi-Fi' },
    { id: 'card', label: 'Payment card' },
    { id: 'bank', label: 'Bank account' },
    { id: 'address', label: 'Address' },
    { id: 'identity', label: 'ID document' },
    { id: 'custom', label: 'Custom type' },
  ];

  const DEFAULT_TOTP = { digits: 6, period: 30, algorithm: 'SHA1' };

  const isKnownType = type => Object.prototype.hasOwnProperty.call(TYPES, type);
  const nowIso = () => new Date().toISOString();

  function newItem(type, overrides = {}) {
    if (!isKnownType(type)) throw new Error(`unknown item type: ${type}`);
    const t = TYPES[type];
    const ts = nowIso();
    return {
      id: crypto.randomUUID(),
      type,
      title: '',
      tags: [],
      favorite: false,
      urls: [],
      autofill: !!t.autofill,
      fields: t.fields.map(f => ({ ...f, value: '' })),
      totp: null,
      notes: '',
      passwordHistory: [],
      createdAt: ts,
      updatedAt: ts,
      ...overrides,
    };
  }

  function getField(item, id) {
    return item.fields?.find(f => f.id === id) ?? null;
  }

  function getValue(item, id) {
    return getField(item, id)?.value ?? '';
  }

  // Free plan counts every item except logins that hold a 2FA secret and
  // nothing else besides a username (no other field, notes or password
  // history) — 2FA stays unlimited on Free.
  function countsForLimit(item) {
    if (item.type !== 'login' || !item.totp?.secret) return true;
    if (String(item.notes ?? '').trim() !== '') return true;
    if ((item.passwordHistory || []).length) return true;
    return (item.fields || []).some(f => f.id !== 'username' && String(f.value ?? '').trim() !== '');
  }

  function countedItems(items) {
    return items.filter(countsForLimit).length;
  }

  // Whether saving `candidate` (new or edited) is allowed. Over the limit, items
  // that already counted stay editable; only adding a counted item is blocked —
  // a new one, or a 2FA-only login that gains a password.
  function canSaveItem(items, plan, candidate) {
    if (PAID_PLANS.includes(plan)) return true;
    if (!countsForLimit(candidate)) return true;
    const existing = items.find(i => i.id === candidate.id);
    if (existing && countsForLimit(existing)) return true;
    return countedItems(items.filter(i => i.id !== candidate.id)) < FREE_ITEM_LIMIT;
  }

  // ── v1 ⇄ v2 ─────────────────────────────────────────────────────────────
  // v1 account: { name, email, secret, urls ("a.com\nb.com"), autofill,
  //               category, domain, _updatedAt }

  // `position` keeps the v1 list order (the UI sorts by it).
  function fromV1Account(acc, position = 0) {
    const urls = String(acc.urls || '').split('\n').map(s => s.trim()).filter(Boolean);
    const ts = acc._updatedAt || nowIso();
    const item = newItem('login', {
      title: acc.name || '',
      tags: acc.category ? [String(acc.category).trim()].filter(Boolean) : [],
      urls,
      autofill: acc.autofill !== false,
      totp: acc.secret ? { secret: acc.secret, ...DEFAULT_TOTP } : null,
      createdAt: ts,
      updatedAt: ts,
      position,
    });
    getField(item, 'username').value = acc.email || '';
    if (acc.domain) item.iconDomain = acc.domain;
    return item;
  }

  // For the transition blob old extensions still read: only logins with a 2FA
  // secret, mapped back to the v1 shape. Passwords and other types never go here.
  function toV1Account(item) {
    if (item.type !== 'login' || !item.totp?.secret) return null;
    const acc = {
      name: item.title,
      email: getValue(item, 'username'),
      secret: item.totp.secret,
      urls: (item.urls || []).join('\n'),
      autofill: item.autofill !== false,
      category: item.tags?.[0] || '',
      _updatedAt: item.updatedAt,
    };
    if (item.iconDomain) acc.domain = item.iconDomain;
    return acc;
  }

  return {
    FREE_ITEM_LIMIT, PAID_PLANS, FIELD_KINDS, SECRET_KINDS, TYPES, UPCOMING_TYPES,
    isKnownType, newItem, getField, getValue,
    countsForLimit, countedItems, canSaveItem,
    fromV1Account, toV1Account,
  };
})();
