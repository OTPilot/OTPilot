'use strict';

// Importing logins from other password managers' CSV exports (2.0) — pure
// functions, no storage, no UI (needs vault.js).
//
// One header-alias mapper reads every supported export (Chrome / Edge /
// Brave, Firefox, Bitwarden, 1Password, LastPass, Dashlane, KeePass(XC)) and
// most generic CSVs; the recognized source is only reported to the user.
// Secure notes (Bitwarden type "note", LastPass "http://sn") become note
// items.
const Importers = (() => {
  // Tags in OTPilot's `folder` column: ';' separates, '\;' and '\\' escape.
  const joinTags = tags => tags.map(t => String(t).replace(/\\/g, '\\\\').replace(/;/g, '\\;')).join(';');
  function splitTags(text) {
    const out = [];
    let cur = '';
    for (let i = 0; i < text.length; i++) {
      if (text[i] === '\\' && i + 1 < text.length) { cur += text[++i]; continue; }
      if (text[i] === ';') { out.push(cur); cur = ''; continue; }
      cur += text[i];
    }
    out.push(cur);
    return out;
  }

  // How OTPilot stores an imported base32 secret: as is, unless it also
  // looks like hex (only 0-9/A-F, even length) — totp.js decodeSecret would
  // read those as hex, so they're stored as the hex of their bytes.
  function storableSecret(b32) {
    if (!b32 || !/^[0-9a-fA-F]+$/.test(b32) || b32.length % 2) return b32;
    let bits = 0, val = 0, hex = '';
    for (const ch of b32.toUpperCase()) {
      val = (val << 5) | B32.indexOf(ch);
      bits += 5;
      if (bits >= 8) { hex += ((val >>> (bits - 8)) & 0xff).toString(16).padStart(2, '0'); bits -= 8; }
    }
    return hex;
  }

  // OTPilot reads a secret of hex digits (even length) as hex (totp.js
  // decodeSecret); an otpauth URI needs base32.
  const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  function otpauthSecret(secret) {
    const s = String(secret).replace(/\s/g, '');
    if (!/^[0-9a-fA-F]+$/.test(s) || s.length % 2) return s.toUpperCase();
    let bits = 0, val = 0, out = '';
    for (let i = 0; i < s.length; i += 2) {
      val = (val << 8) | parseInt(s.slice(i, i + 2), 16);
      bits += 8;
      while (bits >= 5) { out += B32[(val >>> (bits - 5)) & 31]; bits -= 5; }
    }
    if (bits > 0) out += B32[(val << (5 - bits)) & 31];
    return out;
  }

  const uniqueTags = tags => [...new Set(tags.map(t => String(t || '').trim()).filter(Boolean))];

  // RFC 4180: quoted fields, "" escapes, newlines inside quotes, CRLF or LF.
  function parseCsv(text) {
    const rows = [];
    let row = [], field = '', quoted = false;
    const src = String(text).replace(/^﻿/, '');
    for (let i = 0; i < src.length; i++) {
      const c = src[i];
      if (quoted) {
        if (c === '"') {
          if (src[i + 1] === '"') { field += '"'; i++; } else quoted = false;
        } else field += c;
      } else if (c === '"' && field === '') quoted = true;
      else if (c === ',') { row.push(field); field = ''; }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && src[i + 1] === '\n') i++;
        row.push(field); field = '';
        if (row.some(f => f !== '')) rows.push(row);
        row = [];
      } else field += c;
    }
    row.push(field);
    if (row.some(f => f !== '')) rows.push(row);
    return rows;
  }

  const SOURCES = [
    { name: 'OTPilot', has: ['type', 'name', 'url', 'username', 'password', 'totp', 'notes', 'folder', 'fields'] },
    { name: 'Bitwarden', has: ['login_uri', 'login_username', 'login_password'] },
    { name: '1Password', has: ['title', 'url', 'username', 'password', 'otpauth'] },
    { name: 'LastPass', has: ['url', 'username', 'password', 'extra', 'name', 'grouping'] },
    { name: 'Dashlane', has: ['username', 'title', 'password', 'note', 'url', 'category'] },
    { name: 'KeePass', has: ['group', 'title', 'username', 'password', 'url', 'notes'] },
    { name: 'Firefox', has: ['url', 'username', 'password', 'httprealm'] },
    { name: 'Chrome', has: ['name', 'url', 'username', 'password'] },
  ];

  // First matching header wins, in this order.
  const ALIASES = {
    title: ['title', 'name'],
    url: ['login_uri', 'url', 'uri', 'website', 'web site', 'login url'],
    username: ['login_username', 'username', 'user name', 'login', 'email', 'user'],
    password: ['login_password', 'password', 'pass'],
    notes: ['notes', 'note', 'extra', 'comments', 'comment'],
    totp: ['login_totp', 'otpauth', 'totp', 'otpsecret', 'otp', 'one-time password'],
    folder: ['folder', 'grouping', 'group', 'category', 'tags'],
    type: ['type'],
  };

  function columns(header) {
    const h = header.map(x => x.trim().toLowerCase());
    const col = {};
    for (const [key, names] of Object.entries(ALIASES)) {
      for (const n of names) {
        const i = h.indexOf(n);
        if (i !== -1) { col[key] = i; break; }
      }
    }
    const source = SOURCES.find(s => s.has.every(x => h.includes(x)))?.name || 'CSV';
    return { col, source };
  }

  // Other managers' secrets: at least 16 characters (anything shorter is
  // more likely a stray value). OTPilot's own export: any length OTPilot
  // generates codes for.
  const base32 = (v, min = 16) => {
    const s = String(v || '').replace(/[\s-]/g, '').toUpperCase();
    return new RegExp(`^[A-Z2-7]{${min},}=*$`).test(s) ? s.replace(/=+$/, '') : '';
  };

  // A TOTP secret from an otpauth:// URI or a bare base32 secret: { secret }
  // ('' when there is none), or { unsupported: true } for settings OTPilot
  // can't generate (HOTP, not 6 digits / 30 s / SHA1) — those would give
  // codes the site rejects, so they're reported instead of imported.
  function parseTotp(value, min = 16) {
    const v = String(value || '').trim();
    if (!v) return { secret: '' };
    if (/^otpauth:\/\//i.test(v)) {
      let url;
      try { url = new URL(v); } catch { return { secret: '' }; }
      const p = url.searchParams;
      const supported = url.host.toLowerCase() === 'totp'
        && (p.get('digits') ?? '6') === '6'
        && (p.get('period') ?? '30') === '30'
        && (p.get('algorithm') ?? 'SHA1').toUpperCase() === 'SHA1';
      const secret = base32(p.get('secret'), min);
      if (!secret) return { secret: '' };
      return supported ? { secret } : { unsupported: true };
    }
    return { secret: base32(v, min) };
  }

  const totpSecret = value => parseTotp(value).secret || '';

  // Saved URL patterns are hosts (what matching uses); non-web URIs (an
  // Android app, a note marker) are dropped.
  // One URL per cell, except where the source lists several: newlines, and
  // commas in a Bitwarden export. Never split elsewhere: a comma inside a URL
  // (`?next=,other.example`) must not become a saved host.
  function urlsOf(value, source) {
    const sep = source === 'Bitwarden' ? /[\n,]+/ : /\n+/;
    return String(value || '').split(sep).map(u => u.trim()).filter(Boolean).flatMap(u => {
      const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(u) ? u : `https://${u}`;
      try {
        const url = new URL(withScheme);
        if (!/^https?:$/.test(url.protocol) || !url.hostname.includes('.') && url.hostname !== 'localhost') return [];
        return [url.hostname.toLowerCase()];
      } catch { return []; }
    }).filter((h, i, all) => all.indexOf(h) === i);
  }

  function folderTag(value) {
    const parts = String(value || '').split(/[/\\;]/).map(s => s.trim()).filter(s => s && s.toLowerCase() !== 'root');
    return parts[parts.length - 1] || '';
  }

  // → { source, entries: [{ type: 'login' | 'note', title, urls, username,
  //       password, notes, totp, tag }], invalid, unsupportedTotp }
  function parse(text) {
    const rows = parseCsv(text);
    if (rows.length < 2) return { source: 'CSV', entries: [], invalid: 0, unsupportedTotp: 0, otherTypes: 0 };
    const { col, source } = columns(rows[0]);
    if (col.password === undefined && col.totp === undefined) throw new Error('No password column found');
    const get = (row, key) => (col[key] !== undefined ? String(row[col[key]] ?? '').trim() : '');
    // OTPilot's own export round-trips exactly: notes untrimmed, URL
    // patterns as saved (one per line), logins without a password kept.
    const own = source === 'OTPilot';
    const raw = (row, key) => (col[key] !== undefined ? String(row[col[key]] ?? '') : '');
    const notesOf = row => (own ? raw(row, 'notes') : get(row, 'notes'));
    // OTPilot's own export lists every tag in `folder` (a;b;c, with \; and
    // \\ escaping); other managers have one folder, possibly a path
    // (Root/Email → Email).
    const tagsOf = row => (own
      ? uniqueTags(splitTags(raw(row, 'folder')))
      : [folderTag(get(row, 'folder'))].filter(Boolean));
    const withTags = (entry, row) => {
      const [tag = '', ...more] = tagsOf(row);
      entry.tag = tag;
      if (more.length) entry.moreTags = more;
      return entry;
    };
    const entries = [];
    let invalid = 0, unsupportedTotp = 0, otherTypes = 0;
    for (const row of rows.slice(1)) {
      const rawUrl = get(row, 'url');
      // OTPilot's export also lists servers, API credentials…: not rebuilt
      // from CSV yet, reported instead of turned into logins.
      if (own && !['login', 'note'].includes(get(row, 'type').toLowerCase())) { otherTypes++; continue; }
      // LastPass marks notes with the URL http://sn; OTPilot's export says so
      // in `type` (a login may well be saved with that URL).
      if (get(row, 'type').toLowerCase() === 'note' || (!own && rawUrl === 'http://sn')) {
        const note = withTags({ type: 'note', title: get(row, 'title') || 'Imported note', urls: [], username: '', password: '', notes: notesOf(row), totp: '', tag: '' }, row);
        if (note.notes || get(row, 'title')) entries.push(note); else invalid++;
        continue;
      }
      const urls = own ? raw(row, 'url').split('\n').map(u => u.trim()).filter(Boolean) : urlsOf(rawUrl, source);
      const totp = parseTotp(get(row, 'totp'), own ? 1 : 16);
      if (totp.unsupported) unsupportedTotp++;
      const entry = {
        type: 'login',
        title: get(row, 'title') || urls[0] || '',
        urls,
        username: get(row, 'username'),
        password: col.password !== undefined ? String(row[col.password] ?? '') : '',
        notes: notesOf(row),
        totp: totp.secret || '',
        tag: '',
      };
      withTags(entry, row);
      if (!own && !entry.password && !entry.totp) { invalid++; continue; }
      if (!entry.title) entry.title = entry.username || 'Imported login';
      entries.push(entry);
    }
    return { source, entries, invalid, unsupportedTotp, otherTypes };
  }

  // Saved URL patterns can carry a scheme, path or port (and OTPilot's own
  // export keeps them as saved): compare by their host part.
  const hostOf = pattern => String(pattern).trim().replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
    .split(/[/?#]/)[0].replace(/:\d+$/, '').replace(/^\*\./, '').toLowerCase();
  const hostsOverlap = (item, entry) => entry.urls.some(u => Vault.loginCoversHost(item.urls, hostOf(u)))
    || (item.urls || []).some(u => Vault.loginCoversHost(entry.urls, hostOf(u)));
  // Whether a saved secret (`stored`: base32, or hex the way OTPilot reads it)
  // is the imported one (`incoming`: always base32 here — parseTotp — so it is
  // never read as hex, even when it looks like it).
  const sameSecret = (stored, incoming) => !!stored && !!incoming
    && otpauthSecret(stored).replace(/=+$/, '') === String(incoming).replace(/[\s=]/g, '').toUpperCase();

  // What importing each entry does against the vault's current `items`:
  //   exists — a login for that site + username already holds everything the
  //            row has (its password and its 2FA secret)
  //   merge  — adds what's missing to a login for that site + username whose
  //            password and 2FA secret are each empty or the same as the
  //            row's (typically a 2FA-only login gaining its password):
  //            `target` is its id
  //   new    — a new login (never overwrites a different password or secret)
  // A secure note is `exists` when the same title and text are saved, else new.
  // Usernames can be case-sensitive: the exact username first, a match
  // ignoring case only when it's the only one. Pass only the entries being
  // imported: an entry left out must not take a merge target.
  function plan(entries, items) {
    const logins = items.filter(i => i.type === 'login');
    const taken = new Set();
    const notesPlanned = new Set(); // a note repeated in the same file is added once
    return entries.map(entry => {
      if (entry.type === 'note') {
        // The same note (title and text) already saved: nothing to add.
        const same = items.find(i => i.type === 'note' && i.title === entry.title && (i.notes || '') === entry.notes);
        if (same) return { action: 'exists', target: same.id };
        const key = `${entry.title}\u0000${entry.notes}`;
        if (notesPlanned.has(key)) return { action: 'exists' };
        notesPlanned.add(key);
        return { action: 'new' };
      }
      const onSite = logins.filter(i => hostsOverlap(i, entry));
      const userOf = i => Vault.getValue(i, 'username').trim();
      const exact = onSite.filter(i => userOf(i) === entry.username.trim());
      const loose = onSite.filter(i => userOf(i).toLowerCase() === entry.username.trim().toLowerCase());
      const matches = exact.length ? exact : (loose.length === 1 ? loose : []);
      const pwOk = i => !entry.password || [entry.password, ''].includes(Vault.getValue(i, 'password'));
      const totpOk = i => !entry.totp || !i.totp?.secret || sameSecret(i.totp.secret, entry.totp);
      const holdsAll = i => (!entry.password || Vault.getValue(i, 'password') === entry.password)
        && (!entry.totp || sameSecret(i.totp?.secret, entry.totp));
      const same = matches.find(holdsAll);
      if (same) return { action: 'exists', target: same.id };
      const target = matches.find(i => !taken.has(i.id) && pwOk(i) && totpOk(i));
      if (target) { taken.add(target.id); return { action: 'merge', target: target.id }; }
      return { action: 'new' };
    });
  }

  // The items to store for `entries` (planned together by plan()).
  function toItems(entries, plans, items) {
    const byId = new Map(items.map(i => [i.id, i]));
    let position = items.reduce((m, i) => Math.max(m, (i.position ?? -1) + 1), 0);
    const now = new Date().toISOString();
    const out = [];
    for (const [idx, entry] of entries.entries()) {
      const p = plans[idx];
      if (p.action === 'exists') continue;
      if (p.action === 'merge') {
        const next = structuredClone(byId.get(p.target));
        if (entry.password) Vault.getField(next, 'password').value = entry.password;
        if (!next.urls.length) next.urls = entry.urls;
        if (!next.notes && entry.notes) next.notes = entry.notes;
        if (!next.totp && entry.totp) next.totp = { secret: storableSecret(entry.totp), digits: 6, period: 30, algorithm: 'SHA1' };
        next.tags = uniqueTags([...(next.tags || []), entry.tag, ...(entry.moreTags || [])]);
        next.updatedAt = now;
        out.push(next);
        continue;
      }
      if (entry.type === 'note') {
        out.push(Vault.newItem('note', { title: entry.title, notes: entry.notes, tags: uniqueTags([entry.tag, ...(entry.moreTags || [])]) }));
        continue;
      }
      const item = Vault.newItem('login', {
        title: entry.title, urls: entry.urls, notes: entry.notes,
        tags: uniqueTags([entry.tag, ...(entry.moreTags || [])]),
        totp: entry.totp ? { secret: storableSecret(entry.totp), digits: 6, period: 30, algorithm: 'SHA1' } : null,
        position: position++,
      });
      Vault.getField(item, 'username').value = entry.username;
      Vault.getField(item, 'password').value = entry.password;
      out.push(item);
    }
    return out;
  }

  // ── Export ────────────────────────────────────────────────────────────────
  // The vault as CSV, in columns this importer (and most managers' generic
  // CSV import) reads back: logins and secure notes round-trip; other types
  // carry their fields as "Label: value" lines in `fields`.
  const CSV_COLUMNS = ['type', 'name', 'url', 'username', 'password', 'totp', 'notes', 'folder', 'fields'];

  const csvCell = v => {
    const s = String(v ?? '');
    return /[",\r\n]/.test(s) || /^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };

  function toCsv(items) {
    const rows = items
      .slice()
      .sort((a, b) => (a.type === b.type ? (a.title || '').localeCompare(b.title || '') : a.type.localeCompare(b.type)))
      .map(item => {
        const value = id => Vault.getValue(item, id);
        const known = new Set(['username', 'password']);
        const extra = (item.fields || [])
          .filter(f => !(item.type === 'login' && known.has(f.id)) && String(f.value ?? '') !== '')
          .map(f => `${f.label || f.id}: ${f.value}`);
        return [
          item.type,
          item.title || '',
          (item.urls || []).join('\n'),
          item.type === 'login' ? value('username') : '',
          item.type === 'login' ? value('password') : '',
          item.totp?.secret ? `otpauth://totp/${encodeURIComponent(item.title || 'OTPilot')}?secret=${otpauthSecret(item.totp.secret)}` : '',
          item.notes || '',
          joinTags(item.tags || []),
          extra.join('\n'),
        ];
      });
    return [CSV_COLUMNS, ...rows].map(r => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
  }

  return { parseCsv, parse, plan, toItems, totpSecret, parseTotp, toCsv, storableSecret };
})();
