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

  const base32 = v => {
    const s = String(v || '').replace(/[\s-]/g, '').toUpperCase();
    return /^[A-Z2-7]{16,}=*$/.test(s) ? s.replace(/=+$/, '') : '';
  };

  // A TOTP secret from an otpauth:// URI or a bare base32 secret: { secret }
  // ('' when there is none), or { unsupported: true } for settings OTPilot
  // can't generate (HOTP, not 6 digits / 30 s / SHA1) — those would give
  // codes the site rejects, so they're reported instead of imported.
  function parseTotp(value) {
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
      const secret = base32(p.get('secret'));
      if (!secret) return { secret: '' };
      return supported ? { secret } : { unsupported: true };
    }
    return { secret: base32(v) };
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
    if (rows.length < 2) return { source: 'CSV', entries: [], invalid: 0, unsupportedTotp: 0 };
    const { col, source } = columns(rows[0]);
    if (col.password === undefined && col.totp === undefined) throw new Error('No password column found');
    const get = (row, key) => (col[key] !== undefined ? String(row[col[key]] ?? '').trim() : '');
    const entries = [];
    let invalid = 0, unsupportedTotp = 0;
    for (const row of rows.slice(1)) {
      const rawUrl = get(row, 'url');
      if (get(row, 'type').toLowerCase() === 'note' || rawUrl === 'http://sn') {
        const note = { type: 'note', title: get(row, 'title') || 'Imported note', urls: [], username: '', password: '', notes: get(row, 'notes'), totp: '', tag: folderTag(get(row, 'folder')) };
        if (note.notes || get(row, 'title')) entries.push(note); else invalid++;
        continue;
      }
      const urls = urlsOf(rawUrl, source);
      const totp = parseTotp(get(row, 'totp'));
      if (totp.unsupported) unsupportedTotp++;
      const entry = {
        type: 'login',
        title: get(row, 'title') || urls[0] || '',
        urls,
        username: get(row, 'username'),
        password: col.password !== undefined ? String(row[col.password] ?? '') : '',
        notes: get(row, 'notes'),
        totp: totp.secret || '',
        tag: folderTag(get(row, 'folder')),
      };
      if (!entry.password && !entry.totp) { invalid++; continue; }
      if (!entry.title) entry.title = entry.username || 'Imported login';
      entries.push(entry);
    }
    return { source, entries, invalid, unsupportedTotp };
  }

  const hostsOverlap = (item, entry) => entry.urls.some(h => Vault.loginCoversHost(item.urls, h))
    || (item.urls || []).some(h => Vault.loginCoversHost(entry.urls, h));

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
    return entries.map(entry => {
      if (entry.type === 'note') {
        // The same note (title and text) already saved: nothing to add.
        const same = items.find(i => i.type === 'note' && i.title === entry.title && (i.notes || '') === entry.notes);
        return same ? { action: 'exists', target: same.id } : { action: 'new' };
      }
      const onSite = logins.filter(i => hostsOverlap(i, entry));
      const userOf = i => Vault.getValue(i, 'username').trim();
      const exact = onSite.filter(i => userOf(i) === entry.username.trim());
      const loose = onSite.filter(i => userOf(i).toLowerCase() === entry.username.trim().toLowerCase());
      const matches = exact.length ? exact : (loose.length === 1 ? loose : []);
      const pwOk = i => !entry.password || [entry.password, ''].includes(Vault.getValue(i, 'password'));
      const totpOk = i => !entry.totp || !i.totp?.secret || i.totp.secret === entry.totp;
      const holdsAll = i => (!entry.password || Vault.getValue(i, 'password') === entry.password)
        && (!entry.totp || i.totp?.secret === entry.totp);
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
        if (!next.totp && entry.totp) next.totp = { secret: entry.totp, digits: 6, period: 30, algorithm: 'SHA1' };
        if (entry.tag && !(next.tags || []).includes(entry.tag)) next.tags = [...(next.tags || []), entry.tag];
        next.updatedAt = now;
        out.push(next);
        continue;
      }
      if (entry.type === 'note') {
        out.push(Vault.newItem('note', { title: entry.title, notes: entry.notes, tags: entry.tag ? [entry.tag] : [] }));
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

  return { parseCsv, parse, plan, toItems, totpSecret, parseTotp };
})();
