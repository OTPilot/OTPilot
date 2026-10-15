'use strict';

// SSH keys (pure, WebCrypto, no storage): reads a private key file to show its
// public key and fingerprint, and generates new keys in the OpenSSH format
// ssh-keygen writes. Loaded by the popup.
//
// Read: the OpenSSH format (what ssh-keygen has written since 7.8; its public
// key is outside the encrypted part, so a passphrase-protected key still
// shows it) and unencrypted PKCS#8 / PKCS#1 RSA PEM keys. Generated keys have
// no passphrase: the vault encrypts them (`ssh-keygen -p` adds one).
const SshKeys = (() => {
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  const MAGIC = 'openssh-key-v1\0';

  // ── RFC 4251 wire format ──
  function reader(bytes) {
    let p = 0;
    const take = n => {
      if (n < 0 || p + n > bytes.length) throw new Error('truncated key');
      const out = bytes.subarray(p, p + n);
      p += n;
      return out;
    };
    const u32 = () => { const b = take(4); return ((b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3]) >>> 0; };
    const string = () => take(u32());
    return { take, u32, string, text: () => dec.decode(string()) };
  }

  const concat = (...parts) => {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let o = 0;
    for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
  };
  const u32 = n => new Uint8Array([n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
  const string = b => {
    const bytes = typeof b === 'string' ? enc.encode(b) : b;
    return concat(u32(bytes.length), bytes);
  };
  // An unsigned big-endian integer as an SSH mpint.
  function mpint(bytes) {
    let i = 0;
    while (i < bytes.length && bytes[i] === 0) i++;
    let b = bytes.subarray(i);
    if (b.length && b[0] & 0x80) b = concat(new Uint8Array([0]), b);
    return string(b);
  }

  const b64 = bytes => Vault.bytesToB64(bytes);
  const b64urlBytes = s => Vault.b64ToBytes(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4));

  function bitLength(bytes) {
    let i = 0;
    while (i < bytes.length && bytes[i] === 0) i++;
    if (i === bytes.length) return 0;
    return (bytes.length - i - 1) * 8 + (32 - Math.clz32(bytes[i]));
  }

  // "Ed25519", "RSA 4096", "ECDSA 256" from a public key blob.
  function describeBlob(blob) {
    const r = reader(blob);
    const type = r.text();
    if (type === 'ssh-ed25519') return { type, label: 'Ed25519' };
    if (type === 'ssh-rsa') { r.string(); return { type, label: `RSA ${bitLength(r.string())}` }; }
    const ec = /^ecdsa-sha2-nistp(\d+)$/.exec(type);
    if (ec) return { type, label: `ECDSA ${ec[1]}` };
    if (type === 'ssh-dss') return { type, label: 'DSA' };
    return { type, label: type.replace(/^ssh-/, '').replace(/@.*$/, '') };
  }

  // A public key line ("ssh-ed25519 AAAA… comment") → its kind, or null.
  function describe(publicKey) {
    const parts = String(publicKey || '').trim().split(/\s+/);
    if (parts.length < 2) return null;
    try {
      const d = describeBlob(Vault.b64ToBytes(parts[1]));
      return d.type === parts[0] ? { ...d, comment: parts.slice(2).join(' ') } : null;
    } catch { return null; }
  }

  async function fingerprint(blob) {
    const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', blob));
    return `SHA256:${b64(hash).replace(/=+$/, '')}`;
  }

  async function summary(blob, comment, extra = {}) {
    const d = describeBlob(blob);
    return {
      type: d.type, label: d.label, comment: comment || '',
      publicKey: `${d.type} ${b64(blob)}${comment ? ` ${comment}` : ''}`,
      fingerprint: await fingerprint(blob),
      ...extra,
    };
  }

  function pemBlock(text, label) {
    const m = new RegExp(`-----BEGIN ${label}-----([\\s\\S]*?)-----END ${label}-----`).exec(text);
    if (!m) return null;
    const lines = m[1].trim().split(/\r?\n/).map(l => l.trim());
    // A legacy encrypted PEM ("Proc-Type: 4,ENCRYPTED" headers).
    if (lines.some(l => l.includes(':'))) return { encrypted: true };
    try { return { bytes: Vault.b64ToBytes(lines.join('')) }; } catch { return null; }
  }

  // ── Reading a private key file ──
  // → { type, label, publicKey, fingerprint, comment, encrypted }, or
  // { encrypted: true } when nothing can be read without the passphrase, or
  // null when the text isn't a private key this can read.
  async function parse(text) {
    text = String(text || '');
    const open = pemBlock(text, 'OPENSSH PRIVATE KEY');
    if (open) return open.bytes ? parseOpenSsh(open.bytes) : { encrypted: true };
    const pkcs8 = pemBlock(text, 'PRIVATE KEY');
    if (pkcs8?.bytes) return parsePkcs8(pkcs8.bytes);
    const rsa = pemBlock(text, 'RSA PRIVATE KEY');
    if (rsa) return rsa.bytes ? parsePkcs1(rsa.bytes) : { encrypted: true, type: 'ssh-rsa', label: 'RSA' };
    if (/-----BEGIN (ENCRYPTED PRIVATE KEY|EC PRIVATE KEY|DSA PRIVATE KEY)-----/.test(text)) return { encrypted: /ENCRYPTED/.test(text) };
    return null;
  }

  async function parseOpenSsh(bytes) {
    try {
      if (dec.decode(bytes.subarray(0, MAGIC.length)) !== MAGIC) return null;
      const r = reader(bytes.subarray(MAGIC.length));
      const cipher = r.text();
      r.text(); // kdf
      r.string(); // kdf options
      if (r.u32() < 1) return null;
      const pub = r.string();
      const priv = r.string();
      const encrypted = cipher !== 'none';
      return summary(pub, encrypted ? '' : commentOf(priv), { encrypted });
    } catch { return null; }
  }

  // The comment of an unencrypted OpenSSH private section ('' if unknown).
  function commentOf(priv) {
    try {
      const r = reader(priv);
      if (r.u32() !== r.u32()) return '';
      const type = r.text();
      const skip = { 'ssh-ed25519': 2, 'ssh-rsa': 6, 'ssh-dss': 5 }[type] ?? (type.startsWith('ecdsa-sha2-') ? 3 : -1);
      if (skip < 0) return '';
      for (let i = 0; i < skip; i++) r.string();
      return r.text();
    } catch { return ''; }
  }

  // An unencrypted PKCS#8 key (ssh-keygen -m PKCS8, openssl): WebCrypto reads
  // it and gives its public half.
  async function parsePkcs8(der) {
    const tries = [
      [{ name: 'Ed25519' }, ['sign'], jwk => concat(string('ssh-ed25519'), string(b64urlBytes(jwk.x)))],
      [{ name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, ['sign'], jwk => concat(string('ssh-rsa'), mpint(b64urlBytes(jwk.e)), mpint(b64urlBytes(jwk.n)))],
      ...[['P-256', 'nistp256'], ['P-384', 'nistp384'], ['P-521', 'nistp521']].map(([curve, name]) => [
        { name: 'ECDSA', namedCurve: curve }, ['sign'],
        jwk => concat(string(`ecdsa-sha2-${name}`), string(name), string(concat(new Uint8Array([4]), b64urlBytes(jwk.x), b64urlBytes(jwk.y)))),
      ]),
    ];
    for (const [algo, usages, blobOf] of tries) {
      try {
        const key = await crypto.subtle.importKey('pkcs8', der, algo, true, usages);
        return summary(blobOf(await crypto.subtle.exportKey('jwk', key)), '', { encrypted: false });
      } catch { /* not this kind */ }
    }
    return null;
  }

  // A PKCS#1 RSA key: SEQUENCE { version, n, e, … }.
  async function parsePkcs1(der) {
    try {
      let p = 0;
      const tlv = () => {
        const tag = der[p++];
        let len = der[p++];
        if (len & 0x80) { const n = len & 0x7f; len = 0; for (let i = 0; i < n; i++) len = len * 256 + der[p++]; }
        return { tag, start: p, len };
      };
      if (tlv().tag !== 0x30) return null;
      const version = tlv(); p = version.start + version.len;
      const n = tlv(); const nBytes = der.subarray(n.start, n.start + n.len); p = n.start + n.len;
      const e = tlv(); const eBytes = der.subarray(e.start, e.start + e.len);
      if (n.tag !== 2 || e.tag !== 2) return null;
      return summary(concat(string('ssh-rsa'), mpint(eBytes), mpint(nBytes)), '', { encrypted: false });
    } catch { return null; }
  }

  // ── Generating ──
  function armor(bytes) {
    const body = b64(bytes).match(/.{1,70}/g).join('\n');
    return `-----BEGIN OPENSSH PRIVATE KEY-----\n${body}\n-----END OPENSSH PRIVATE KEY-----\n`;
  }

  // kind: 'ed25519' | 'rsa' (4096 bits). → { privateKey (file text), fileName,
  // publicKey, fingerprint, type, label, comment }.
  async function generate(kind, comment = '') {
    let pub;
    let privPart;
    if (kind === 'rsa') {
      const pair = await crypto.subtle.generateKey(
        { name: 'RSASSA-PKCS1-v1_5', modulusLength: 4096, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
      const k = await crypto.subtle.exportKey('jwk', pair.privateKey);
      const [n, e, d, p, q, qi] = [k.n, k.e, k.d, k.p, k.q, k.qi].map(b64urlBytes);
      pub = concat(string('ssh-rsa'), mpint(e), mpint(n));
      privPart = concat(string('ssh-rsa'), mpint(n), mpint(e), mpint(d), mpint(qi), mpint(p), mpint(q));
    } else {
      const pair = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
      const k = await crypto.subtle.exportKey('jwk', pair.privateKey);
      const x = b64urlBytes(k.x);
      pub = concat(string('ssh-ed25519'), string(x));
      privPart = concat(string('ssh-ed25519'), string(x), string(concat(b64urlBytes(k.d), x)));
    }
    const check = crypto.getRandomValues(new Uint32Array(1))[0];
    let section = concat(u32(check), u32(check), privPart, string(comment));
    const pad = [];
    for (let i = 1; (section.length + pad.length) % 8 !== 0; i++) pad.push(i);
    section = concat(section, new Uint8Array(pad));
    const file = concat(enc.encode(MAGIC), string('none'), string('none'), string(''), u32(1), string(pub), string(section));
    return {
      privateKey: armor(file),
      fileName: kind === 'rsa' ? 'id_rsa' : 'id_ed25519',
      ...await summary(pub, comment),
    };
  }

  return { parse, describe, generate };
})();
