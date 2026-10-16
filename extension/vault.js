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

  const FIELD_KINDS = ['text', 'password', 'hidden', 'email', 'url', 'date', 'phone', 'multiline', 'file'];
  // Kinds whose value is masked by default and offered by the generator.
  const SECRET_KINDS = ['password', 'hidden'];

  // Files ride inside the encrypted item (see fileValue): all of an item's
  // files together stay under this, so the record stays under the server's
  // 128 KiB (bytes grow ~1.78x: base64 in the item, then the encrypted record).
  const FILE_BYTES_LIMIT = 64 * 1024;

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
    ssh: {
      label: 'SSH key',
      fields: [
        { id: 'privateKey', label: 'Private key', kind: 'file' },
        { id: 'publicKey', label: 'Public key', kind: 'text' },
        { id: 'fingerprint', label: 'Fingerprint', kind: 'text' },
        { id: 'passphrase', label: 'Passphrase', kind: 'password' },
      ],
    },
    file: {
      label: 'Secure file',
      fields: [
        { id: 'file', label: 'File', kind: 'file' },
      ],
    },
  };

  // Shown as "Coming soon" in the new-item picker.
  const UPCOMING_TYPES = [
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

  // Whether a login's saved URLs cover the page `hostname`, for filling its
  // password. Stricter than the OTP auto-fill's matchesPattern (content.js /
  // popup.js), which also matches a parent domain: a password only goes to the
  // saved host or one of its subdomains. A leading `www.` on the saved host is
  // ignored (saved www.site.com fills on site.com); `*.base` is a wildcard.
  function urlCoversHost(pattern, hostname) {
    let host = String(pattern).trim().replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').split(/[/?#]/)[0]
      .replace(/:\d+$/, '').toLowerCase();
    hostname = String(hostname || '').toLowerCase();
    if (!host || !hostname) return false;
    if (host.startsWith('*.')) host = host.slice(2);
    else if (host.startsWith('www.')) host = host.slice(4);
    return !!host && (hostname === host || hostname.endsWith('.' + host));
  }

  function loginCoversHost(urls, hostname) {
    const list = Array.isArray(urls) ? urls : String(urls || '').split('\n');
    return list.some(u => urlCoversHost(u, hostname));
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

  // ── Files ───────────────────────────────────────────────────────────────
  // A file field's value is a data: URL carrying its name, so it stays one
  // string: versions that don't know the `file` kind keep it untouched (their
  // editors rebuild custom fields from label / value / kind only).
  //   data:<mime>;name=<encoded name>;base64,<bytes>

  function bytesToB64(bytes) {
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(s);
  }

  function b64ToBytes(b64) {
    const s = atob(b64);
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
  }

  function fileValue(name, mime, bytes) {
    const type = /^[\w.+-]+\/[\w.+-]+$/.test(mime || '') ? mime : 'application/octet-stream';
    return `data:${type};name=${encodeURIComponent(String(name || 'file'))};base64,${bytesToB64(bytes)}`;
  }

  // The file in a value, or null (empty, or not a file value).
  function fileOf(value) {
    const m = /^data:([^;,]*)((?:;[^;,]*)*);base64,([A-Za-z0-9+/=]*)$/.exec(String(value || ''));
    if (!m) return null;
    let name = 'file';
    for (const p of m[2].split(';')) {
      if (!p.startsWith('name=')) continue;
      try { name = decodeURIComponent(p.slice(5)) || name; } catch { /* keep the default */ }
    }
    let bytes;
    try { bytes = b64ToBytes(m[3]); } catch { return null; }
    return { name, mime: m[1] || 'application/octet-stream', size: bytes.length, bytes };
  }

  // The file's text when it reads as text (UTF-8, no NULs), else null.
  function fileText(file) {
    if (!file) return null;
    try {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(file.bytes);
      return text.includes('\0') ? null : text;
    } catch { return null; }
  }

  // Bytes of every file an item carries (its file fields, the type's and custom).
  function fileBytes(item) {
    return (item.fields || []).filter(f => f.kind === 'file').reduce((n, f) => n + (fileOf(f.value)?.size || 0), 0);
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
    FREE_ITEM_LIMIT, PAID_PLANS, FIELD_KINDS, SECRET_KINDS, FILE_BYTES_LIMIT, TYPES, UPCOMING_TYPES,
    isKnownType, newItem, getField, getValue,
    countsForLimit, countedItems, canSaveItem,
    fromV1Account, toV1Account,
    loginCoversHost,
    fileValue, fileOf, fileText, fileBytes, bytesToB64, b64ToBytes,
  };
})();
