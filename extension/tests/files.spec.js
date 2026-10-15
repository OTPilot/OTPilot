import { test, expect } from './fixtures.js';
import { execFileSync } from 'child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

// Files in the vault (pure parts): the file field's value, SSH keys read and
// generated (checked against the real ssh-keygen), and what an added file
// becomes (FileKinds).

let hasSshKeygen = true;
try { execFileSync('ssh-keygen', ['-?'], { stdio: 'ignore' }); } catch (e) { hasSshKeygen = e.status !== undefined && e.code !== 'ENOENT'; }

async function pure(context, extensionId) {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/test/blank.html`);
  for (const f of ['vault.js', 'sshKeys.js', 'fileKinds.js']) await page.addScriptTag({ url: `chrome-extension://${extensionId}/${f}` });
  return page;
}

// ssh-keygen in a temp dir: `files` maps a name to { type, bits?, comment, passphrase? }.
function keygen(specs) {
  const dir = mkdtempSync(path.join(tmpdir(), 'otpilot-ssh-'));
  const out = {};
  try {
    for (const [name, s] of Object.entries(specs)) {
      const file = path.join(dir, name);
      execFileSync('ssh-keygen', ['-q', '-t', s.type, ...(s.bits ? ['-b', String(s.bits)] : []), '-C', s.comment || '', '-N', s.passphrase || '', ...(s.format ? ['-m', s.format] : []), '-f', file]);
      out[name] = {
        privateKey: readFileSync(file, 'utf8'),
        publicKey: readFileSync(`${file}.pub`, 'utf8').trim(),
        fingerprint: execFileSync('ssh-keygen', ['-lf', `${file}.pub`], { encoding: 'utf8' }).split(' ')[1],
      };
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
  return out;
}

test('a file value round-trips its name, type and bytes, and reads as text only when it is', async ({ context, extensionId }) => {
  const page = await pure(context, extensionId);
  const r = await page.evaluate(() => {
    const bin = new Uint8Array([0, 1, 2, 250, 255, 0]);
    const textValue = Vault.fileValue('AuthKey;x,1.p8', 'application/pkcs8', new TextEncoder().encode('-----BEGIN PRIVATE KEY-----\nabc\n'));
    const binValue = Vault.fileValue('cert.p12', 'not a mime', bin);
    const t = Vault.fileOf(textValue);
    const b = Vault.fileOf(binValue);
    const item = Vault.newItem('file');
    Vault.getField(item, 'file').value = binValue;
    item.fields.push({ id: 'c1', label: 'More', kind: 'file', custom: true, value: textValue }, { id: 'c2', label: 'Text', kind: 'text', custom: true, value: binValue });
    return {
      t: { name: t.name, mime: t.mime, size: t.size, text: Vault.fileText(t) },
      b: { name: b.name, mime: b.mime, bytes: [...b.bytes], text: Vault.fileText(b) },
      notFiles: [Vault.fileOf(''), Vault.fileOf('hello'), Vault.fileOf('data:text/plain,hi')],
      total: Vault.fileBytes(item),
      types: { ssh: Vault.TYPES.ssh.fields.map(f => `${f.id}:${f.kind}`), file: Vault.TYPES.file.fields.map(f => `${f.id}:${f.kind}`) },
    };
  });
  expect(r.t).toEqual({ name: 'AuthKey;x,1.p8', mime: 'application/pkcs8', size: 32, text: '-----BEGIN PRIVATE KEY-----\nabc\n' });
  expect(r.b).toEqual({ name: 'cert.p12', mime: 'application/octet-stream', bytes: [0, 1, 2, 250, 255, 0], text: null });
  expect(r.notFiles).toEqual([null, null, null]);
  expect(r.total).toBe(38); // file kinds only: a data: URL in a text field isn't a file
  expect(r.types.ssh).toEqual(['privateKey:file', 'publicKey:text', 'fingerprint:text', 'passphrase:password']);
  expect(r.types.file).toEqual(['file:file']);
});

test('SSH keys from ssh-keygen: public key, fingerprint and comment, passphrase-protected ones too', async ({ context, extensionId }) => {
  test.skip(!hasSshKeygen, 'needs ssh-keygen');
  const keys = keygen({
    ed: { type: 'ed25519', comment: 'alberto@mac' },
    rsa: { type: 'rsa', bits: 3072, comment: 'deploy key' },
    ec: { type: 'ecdsa', bits: 256, comment: 'ec@host' },
    locked: { type: 'ed25519', comment: 'locked', passphrase: 'correct horse' },
    pem: { type: 'rsa', bits: 2048, comment: 'old', format: 'PEM' },
    pkcs8: { type: 'ecdsa', bits: 256, comment: 'p8', format: 'PKCS8' },
  });
  const page = await pure(context, extensionId);
  const parsed = await page.evaluate(async keys => {
    const out = {};
    for (const [name, k] of Object.entries(keys)) out[name] = await SshKeys.parse(k.privateKey);
    return out;
  }, keys);
  for (const name of ['ed', 'rsa', 'ec']) {
    expect(parsed[name].publicKey).toBe(keys[name].publicKey);
    expect(parsed[name].fingerprint).toBe(keys[name].fingerprint);
    expect(parsed[name].encrypted).toBe(false);
  }
  expect(parsed.ed.label).toBe('Ed25519');
  expect(parsed.rsa.label).toBe('RSA 3072');
  expect(parsed.ec.label).toBe('ECDSA 256');
  // Encrypted: the public key is still readable; the comment isn't (it's inside).
  expect(parsed.locked.encrypted).toBe(true);
  expect(parsed.locked.publicKey).toBe(keys.locked.publicKey.replace(/ locked$/, ''));
  expect(parsed.locked.fingerprint).toBe(keys.locked.fingerprint);
  // PEM formats have no comment.
  expect(parsed.pem.publicKey).toBe(keys.pem.publicKey.replace(/ old$/, ''));
  expect(parsed.pem.fingerprint).toBe(keys.pem.fingerprint);
  expect(parsed.pkcs8.fingerprint).toBe(keys.pkcs8.fingerprint);
  // Not a private key.
  expect(await page.evaluate(() => SshKeys.parse('ssh-ed25519 AAAA… just a public key'))).toBeNull();
});

test('generated SSH keys are what ssh-keygen reads: same public key and fingerprint', async ({ context, extensionId }) => {
  test.skip(!hasSshKeygen, 'needs ssh-keygen');
  const page = await pure(context, extensionId);
  const made = await page.evaluate(async () => ({
    ed: await SshKeys.generate('ed25519', 'deploy@acme-api'),
    rsa: await SshKeys.generate('rsa', 'old-server'),
  }));
  expect(made.ed.fileName).toBe('id_ed25519');
  expect(made.rsa.label).toBe('RSA 4096');
  const dir = mkdtempSync(path.join(tmpdir(), 'otpilot-ssh-'));
  try {
    for (const k of [made.ed, made.rsa]) {
      const file = path.join(dir, k.fileName);
      writeFileSync(file, k.privateKey, { mode: 0o600 });
      // -y derives the public key from the private file: ssh-keygen accepts it.
      const pub = execFileSync('ssh-keygen', ['-y', '-f', file], { encoding: 'utf8' }).trim();
      expect(k.publicKey.startsWith(pub)).toBe(true);
      expect(execFileSync('ssh-keygen', ['-lf', file], { encoding: 'utf8' })).toContain(k.fingerprint);
      // And it reads back the same here, comment included.
      const back = await page.evaluate(text => SshKeys.parse(text), k.privateKey);
      expect(back.publicKey).toBe(k.publicKey);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
  expect(await page.evaluate(k => SshKeys.describe(k), made.ed.publicKey)).toEqual({ type: 'ssh-ed25519', label: 'Ed25519', comment: 'deploy@acme-api' });
});

test('an added file becomes the right item: SSH key, Apple .p8, service account, .p12, .env, anything else', async ({ context, extensionId }) => {
  const page = await pure(context, extensionId);
  const r = await page.evaluate(async () => {
    const enc = s => new TextEncoder().encode(s);
    const gen = await SshKeys.generate('ed25519', 'me@laptop');
    const summary = d => d.error ? d : {
      kind: d.kind, label: d.label, type: d.item.type, title: d.item.title, alts: d.alternatives.map(a => a.id),
      fields: d.item.fields.filter(f => f.value || f.custom).map(f => [f.label, f.kind, f.kind === 'file' ? Vault.fileOf(f.value).name : f.value]),
    };
    const env = 'export API_URL=https://api.acme.io\n# comment\n\nTOKEN="abc def"\nPLAIN=x # trailing\nnot a line\n';
    return {
      ssh: summary(await FileKinds.fromFile('id_ed25519', '', enc(gen.privateKey))),
      sshFingerprint: gen.fingerprint,
      p8: summary(await FileKinds.fromFile('AuthKey_2X9R4HXF34.p8', '', enc('-----BEGIN PRIVATE KEY-----\nMIGT\n-----END PRIVATE KEY-----\n'))),
      sa: summary(await FileKinds.fromFile('acme-prod-1234.json', 'application/json', enc(JSON.stringify({ type: 'service_account', project_id: 'acme-prod', private_key: 'k', client_email: 'ci@acme-prod.iam.gserviceaccount.com', client_id: '1099' })))),
      p12: summary(await FileKinds.fromFile('dist.p12', 'application/x-pkcs12', new Uint8Array([48, 130, 0, 1]))),
      env: summary(await FileKinds.fromFile('.env.production', '', enc(env))),
      envSplit: (() => { const i = FileKinds.alternative('env-fields', '.env.production', '', enc(env)); return { type: i.type, fields: i.fields.map(f => [f.label, f.kind, f.value]) }; })(),
      other: summary(await FileKinds.fromFile('notes.txt', 'text/plain', enc('hello'))),
      tooLarge: await FileKinds.fromFile('big.bin', '', new Uint8Array(Vault.FILE_BYTES_LIMIT + 1)),
      empty: await FileKinds.fromFile('empty', '', new Uint8Array(0)),
    };
  });
  expect(r.ssh).toMatchObject({ kind: 'ssh', label: 'SSH key (Ed25519)', type: 'ssh', title: 'me@laptop', alts: ['file'] });
  expect(r.ssh.fields).toEqual([
    ['Private key', 'file', 'id_ed25519'],
    ['Public key', 'text', expect.stringMatching(/^ssh-ed25519 \S+ me@laptop$/)],
    ['Fingerprint', 'text', r.sshFingerprint],
  ]);
  expect(r.p8).toMatchObject({ kind: 'apple-p8', type: 'api', title: 'Apple API key 2X9R4HXF34' });
  expect(r.p8.fields).toEqual([['Key ID', 'text', '2X9R4HXF34'], ['Issuer ID', 'text', ''], ['Private key (.p8)', 'file', 'AuthKey_2X9R4HXF34.p8']]);
  expect(r.sa).toMatchObject({ kind: 'google-sa', type: 'api', title: 'acme-prod service account' });
  expect(r.sa.fields).toEqual([
    ['Client ID', 'text', '1099'], ['Environment', 'text', 'acme-prod'],
    ['Client email', 'email', 'ci@acme-prod.iam.gserviceaccount.com'], ['Key file (.json)', 'file', 'acme-prod-1234.json'],
  ]);
  expect(r.p12).toMatchObject({ kind: 'p12', type: 'file', title: 'dist' });
  expect(r.p12.fields).toEqual([['File', 'file', 'dist.p12'], ['Certificate password', 'password', '']]);
  expect(r.env).toMatchObject({ kind: 'env', label: '.env file (3 variables)', type: 'file', alts: ['env-fields'] });
  expect(r.envSplit).toEqual({ type: 'note', fields: [
    ['API_URL', 'password', 'https://api.acme.io'], ['TOKEN', 'password', 'abc def'], ['PLAIN', 'password', 'x'],
  ] });
  expect(r.other).toMatchObject({ kind: 'file', type: 'file', title: 'notes', fields: [['File', 'file', 'notes.txt']] });
  expect(r.tooLarge).toEqual({ error: 'too-large' });
  expect(r.empty).toEqual({ error: 'empty' });
});

test('SSH keys and files round-trip through the CSV export', async ({ context, extensionId }) => {
  const page = await pure(context, extensionId);
  await page.addScriptTag({ url: `chrome-extension://${extensionId}/importers.js` });
  const r = await page.evaluate(async () => {
    const key = await SshKeys.generate('ed25519', 'ci@acme');
    const ssh = Vault.newItem('ssh', { title: 'CI key' });
    Vault.getField(ssh, 'privateKey').value = Vault.fileValue('id_ed25519', 'text/plain', new TextEncoder().encode(key.privateKey));
    Vault.getField(ssh, 'publicKey').value = key.publicKey;
    Vault.getField(ssh, 'fingerprint').value = key.fingerprint;
    const file = Vault.newItem('file', { title: 'Cert' });
    Vault.getField(file, 'file').value = Vault.fileValue('dist.p12', 'application/x-pkcs12', new Uint8Array([48, 130, 0, 1, 0]));
    file.fields.push({ id: 'c1', label: 'Profile', kind: 'file', custom: true, value: Vault.fileValue('a.mobileprovision', '', new Uint8Array([1, 2])) });
    const parsed = Importers.parse(Importers.toCsv([ssh, file]));
    const back = Importers.toItems(parsed.entries, Importers.plan(parsed.entries, []), []);
    const view = i => ({ type: i.type, title: i.title, fields: i.fields.filter(f => f.value).map(f => [f.label, f.kind, f.value]) });
    const byType = (a, b) => a.type.localeCompare(b.type);
    return { before: [ssh, file].map(view).sort(byType), after: back.map(view).sort(byType) };
  });
  expect(r.after).toEqual(r.before);
});
