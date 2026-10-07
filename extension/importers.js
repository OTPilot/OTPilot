'use strict';

// Importing logins from other password managers' CSV exports (2.0) — pure
// functions, no storage, no UI (needs vault.js).
//
// One header-alias mapper reads every supported export (Chrome / Edge /
// Brave, Firefox, Bitwarden, 1Password, LastPass, Dashlane, KeePass(XC)) and
// most generic CSVs; the recognized source is only reported to the user.
// Secure notes (Bitwarden type "note", LastPass "http://sn") are counted and
// skipped until the popup can show note items.
const Importers = (() => {
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

  // A TOTP secret from an otpauth:// URI or a bare base32 secret; '' otherwise.
  function totpSecret(value) {
    const v = String(value || '').trim();
    if (!v) return '';
    if (/^otpauth:\/\//i.test(v)) {
      try { return totpSecret(new URL(v).searchParams.get('secret')); } catch { return ''; }
    }
    const s = v.replace(/[\s-]/g, '').toUpperCase();
    return /^[A-Z2-7]{16,}=*$/.test(s) ? s.replace(/=+$/, '') : '';
  }

  // Saved URL patterns are hosts (what matching uses); non-web URIs (an
  // Android app, a note marker) are dropped.
  function urlsOf(value) {
    return String(value || '').split(/[\s,]+/).map(u => u.trim()).filter(Boolean).flatMap(u => {
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

  // → { source, entries: [{ title, urls, username, password, notes, totp, tag }], notes, invalid }
  function parse(text) {
    const rows = parseCsv(text);
    if (rows.length < 2) return { source: 'CSV', entries: [], notes: 0, invalid: 0 };
    const { col, source } = columns(rows[0]);
    if (col.password === undefined && col.totp === undefined) throw new Error('No password column found');
    const get = (row, key) => (col[key] !== undefined ? String(row[col[key]] ?? '').trim() : '');
    const entries = [];
    let notes = 0, invalid = 0;
    for (const row of rows.slice(1)) {
      const rawUrl = get(row, 'url');
      if (get(row, 'type').toLowerCase() === 'note' || rawUrl === 'http://sn') { notes++; continue; }
      const urls = urlsOf(rawUrl);
      const entry = {
        title: get(row, 'title') || urls[0] || '',
        urls,
        username: get(row, 'username'),
        password: col.password !== undefined ? String(row[col.password] ?? '') : '',
        notes: get(row, 'notes'),
        totp: totpSecret(get(row, 'totp')),
        tag: folderTag(get(row, 'folder')),
      };
      if (!entry.password && !entry.totp) { invalid++; continue; }
      if (!entry.title) entry.title = entry.username || 'Imported login';
      entries.push(entry);
    }
    return { source, entries, notes, invalid };
  }

  const sameUser = (a, b) => a.trim().toLowerCase() === b.trim().toLowerCase();
  const hostsOverlap = (item, entry) => entry.urls.some(h => Vault.loginCoversHost(item.urls, h))
    || (item.urls || []).some(h => Vault.loginCoversHost(entry.urls, h));

  // What importing each entry does against the vault's current `items`:
  //   exists — a login for that site + username already holds this password
  //   merge  — adds the password to a login for that site + username that
  //            has none (typically a 2FA-only login): `target` is its id
  //   new    — a new login
  function plan(entries, items) {
    const logins = items.filter(i => i.type === 'login');
    const taken = new Set();
    return entries.map(entry => {
      const match = logins.find(i => !taken.has(i.id) && hostsOverlap(i, entry)
        && sameUser(Vault.getValue(i, 'username'), entry.username));
      if (match && Vault.getValue(match, 'password') === entry.password && entry.password) return { action: 'exists', target: match.id };
      if (match && !Vault.getValue(match, 'password')) { taken.add(match.id); return { action: 'merge', target: match.id }; }
      return { action: 'new' };
    });
  }

  // The items to store for the chosen entries (indexes into `entries`).
  function toItems(entries, plans, items, chosen) {
    const byId = new Map(items.map(i => [i.id, i]));
    let position = items.reduce((m, i) => Math.max(m, (i.position ?? -1) + 1), 0);
    const now = new Date().toISOString();
    const out = [];
    for (const idx of chosen) {
      const entry = entries[idx];
      const p = plans[idx];
      if (p.action === 'exists') continue;
      if (p.action === 'merge') {
        const next = structuredClone(byId.get(p.target));
        Vault.getField(next, 'password').value = entry.password;
        if (!next.urls.length) next.urls = entry.urls;
        if (!next.notes && entry.notes) next.notes = entry.notes;
        if (!next.totp && entry.totp) next.totp = { secret: entry.totp, digits: 6, period: 30, algorithm: 'SHA1' };
        next.updatedAt = now;
        out.push(next);
        continue;
      }
      const item = Vault.newItem('login', {
        title: entry.title, urls: entry.urls, notes: entry.notes,
        tags: entry.tag ? [entry.tag] : [],
        totp: entry.totp ? { secret: entry.totp, digits: 6, period: 30, algorithm: 'SHA1' } : null,
        position: position++,
      });
      Vault.getField(item, 'username').value = entry.username;
      Vault.getField(item, 'password').value = entry.password;
      out.push(item);
    }
    return out;
  }

  return { parseCsv, parse, plan, toItems, totpSecret };
})();
