'use strict';

// What a file added to the vault is (pure, no storage): an SSH key, an Apple
// .p8 key, a Google service-account key, a .p12 certificate, an .env, or just
// a file, and the vault item it becomes, filled in. Loaded by the popup after
// vault.js and sshKeys.js.
const FileKinds = (() => {
  const extOf = name => (/\.([A-Za-z0-9]{1,8})$/.exec(name)?.[1] || '').toLowerCase();
  const baseName = name => String(name || '').split(/[\\/]/).pop() || 'file';
  const stem = name => baseName(name).replace(/\.[A-Za-z0-9]{1,8}$/, '') || baseName(name);
  const isEnvName = name => /^\.env(\.[\w.-]+)?$/i.test(name) || extOf(name) === 'env';

  const custom = (label, value, kind = 'text') => ({ id: `c-${crypto.randomUUID()}`, label, value, kind, custom: true });

  // The vault item a file becomes as a plain "Secure file".
  function plainFile(name, mime, bytes) {
    const item = Vault.newItem('file', { title: stem(name) });
    Vault.getField(item, 'file').value = Vault.fileValue(baseName(name), mime, bytes);
    return item;
  }

  // Where a quoted value's closing quote is in `s` (after the opening one),
  // or -1. In double quotes a backslash escapes the next character.
  function closingQuote(s, quote) {
    for (let i = 0; i < s.length; i++) {
      if (quote === '"' && s[i] === '\\') { i++; continue; }
      if (s[i] === quote) return i;
    }
    return -1;
  }

  // An .env's variables, in order ({ key, value }); comments, blank lines and
  // anything that isn't KEY=VALUE are skipped. Quotes around a value go, and
  // a quoted value may span lines (a PEM key). null when a quoted value is
  // never closed: splitting it would lose the rest.
  function parseEnv(text) {
    const lines = String(text || '').split(/\r?\n/);
    const out = [];
    for (let i = 0; i < lines.length; i++) {
      const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s*(.*)$/.exec(lines[i]);
      if (!m) continue;
      const rest = m[2];
      const quote = /^['"`]/.exec(rest)?.[0];
      if (!quote) {
        out.push({ key: m[1], value: rest.replace(/\s+#.*$/, '').trim() });
        continue;
      }
      let body = rest.slice(1);
      let end = closingQuote(body, quote);
      while (end < 0 && i + 1 < lines.length) {
        body += `\n${lines[++i]}`;
        end = closingQuote(body, quote);
      }
      if (end < 0) return null;
      let value = body.slice(0, end);
      if (quote === '"') value = value.replace(/\\n/g, '\n').replace(/\\(["\\])/g, '$1');
      out.push({ key: m[1], value });
    }
    return out;
  }

  // The .env as a secure note with one hidden field per variable.
  function envAsFields(name, text) {
    const item = Vault.newItem('note', { title: baseName(name) });
    item.fields = (parseEnv(text) || []).map(v => custom(v.key, v.value, 'password'));
    return item;
  }

  // → { kind, label, item, note?, alternatives: [{ id, label }] } for a file
  // the user added, or { error: 'too-large' | 'empty' }. `kind`: 'ssh',
  // 'apple-p8', 'google-sa', 'p12', 'env', 'file'.
  async function fromFile(name, mime, bytes) {
    name = baseName(name);
    if (!bytes.length) return { error: 'empty' };
    if (bytes.length > Vault.FILE_BYTES_LIMIT) return { error: 'too-large' };
    const value = Vault.fileValue(name, mime, bytes);
    const text = Vault.fileText({ bytes });
    const ext = extOf(name);
    const asFile = { id: 'file', label: 'Save as a plain file' };

    // Apple's AuthKey_<KEY ID>.p8 (App Store Connect, APNs, Sign in with Apple…).
    const p8 = /^AuthKey_([A-Z0-9]{10})\.p8$/i.exec(name);
    if (text && (p8 || ext === 'p8') && /-----BEGIN PRIVATE KEY-----/.test(text)) {
      const keyId = p8 ? p8[1].toUpperCase() : '';
      const item = Vault.newItem('api', { title: keyId ? `Apple API key ${keyId}` : `Apple API key ${stem(name)}` });
      item.fields.push(
        custom('Key ID', keyId),
        custom('Issuer ID', ''),
        { ...custom('Private key (.p8)', value), kind: 'file' },
      );
      return { kind: 'apple-p8', label: 'Apple .p8 key', item, note: 'Add its Issuer ID (App Store Connect → Users and Access → Integrations).', alternatives: [asFile] };
    }

    if (text) {
      const ssh = (/-----BEGIN OPENSSH PRIVATE KEY-----/.test(text)
        || (/^id_/.test(name) && /-----BEGIN (RSA |EC |DSA |ENCRYPTED )?PRIVATE KEY-----/.test(text)))
        ? await SshKeys.parse(text) : null;
      if (ssh) {
        const item = Vault.newItem('ssh', { title: ssh.comment || name });
        Vault.getField(item, 'privateKey').value = value;
        Vault.getField(item, 'publicKey').value = ssh.publicKey || '';
        Vault.getField(item, 'fingerprint').value = ssh.fingerprint || '';
        const label = ssh.label ? `SSH key (${ssh.label})` : 'SSH key';
        return { kind: 'ssh', label, item, note: ssh.encrypted ? 'It\'s protected by a passphrase: save the passphrase with it.' : '', alternatives: [asFile] };
      }

      if (ext === 'json' || text.trimStart().startsWith('{')) {
        let json = null;
        try { json = JSON.parse(text); } catch { /* not JSON */ }
        if (json?.type === 'service_account' && json.private_key) {
          const item = Vault.newItem('api', { title: `${json.project_id || stem(name)} service account` });
          Vault.getField(item, 'clientId').value = String(json.client_id || '');
          Vault.getField(item, 'environment').value = String(json.project_id || '');
          item.fields.push(custom('Client email', String(json.client_email || ''), 'email'), { ...custom('Key file (.json)', value), kind: 'file' });
          return { kind: 'google-sa', label: 'Google service-account key', item, alternatives: [asFile] };
        }
      }

      const vars = isEnvName(name) ? parseEnv(text) : [];
      if (vars === null) {
        return { kind: 'env', label: '.env file', item: plainFile(name, mime, bytes), note: 'A quoted value in it never closes, so it stays one file.', alternatives: [] };
      }
      if (vars.length) {
        return {
          kind: 'env', label: `.env file (${vars.length} variable${vars.length === 1 ? '' : 's'})`, item: plainFile(name, mime, bytes),
          alternatives: [{ id: 'env-fields', label: 'Split into fields' }],
        };
      }
    }

    if (ext === 'p12' || ext === 'pfx') {
      const item = plainFile(name, mime, bytes);
      item.fields.push(custom('Certificate password', '', 'password'));
      return { kind: 'p12', label: 'Certificate (.p12)', item, note: 'Add the certificate\'s password.', alternatives: [] };
    }

    return { kind: 'file', label: 'File', item: plainFile(name, mime, bytes), alternatives: [] };
  }

  // The item for one of fromFile()'s alternatives.
  function alternative(id, name, mime, bytes) {
    if (id === 'env-fields') return envAsFields(name, Vault.fileText({ bytes }) || '');
    return plainFile(name, mime, bytes);
  }

  return { fromFile, alternative, parseEnv };
})();
