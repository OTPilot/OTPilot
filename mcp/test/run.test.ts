import { chmodSync, existsSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { redact } from '../src/redact.js'
import { fileSecrets, resolveAllowed, runCommand, writeTempFiles } from '../src/run.js'

describe('redact', () => {
  it('scrubs a secret and its encodings', () => {
    const s = 'hunter2-secret'
    const text = `${s} ${Buffer.from(s).toString('base64')} ${encodeURIComponent('a b' + s)} ${Buffer.from(s).toString('hex')}`
    expect(redact(text, [s])).not.toMatch(/hunter2|aHVudGVyMi1zZWNyZXQ|68756e74657232/)
  })
})

describe('run', () => {
  it('passes secrets in the environment and scrubs them from the output', async () => {
    const r = await runCommand(`echo "pw=$PGPASSWORD" && printf '%s' "$PGPASSWORD" | base64 >&2`, { PGPASSWORD: 'hunter2-secret' }, { secrets: ['hunter2-secret'] })
    expect(r.exitCode).toBe(0)
    expect(r.stdout.trim()).toBe('pw=[REDACTED]')
    expect(r.stderr.trim()).toBe('[REDACTED]')
  })

  it('times out, killing what the command started too', async () => {
    const marker = join(mkdtempSync(join(tmpdir(), 'otp-')), 'alive')
    const started = Date.now()
    // A child that keeps the pipes open and would write the marker later.
    const r = await runCommand(`(sleep 3; touch ${marker}) & sleep 30`, {}, { secrets: [], timeoutSec: 1 })
    expect(r.timedOut).toBe(true)
    expect(Date.now() - started).toBeLessThan(5000)
    await new Promise(res => setTimeout(res, 3000))
    const { existsSync } = await import('node:fs')
    expect(existsSync(marker)).toBe(false)
  })

  it('never leaves part of a secret that crosses the output limit', async () => {
    const secret = 'S3cr3t-crossing-the-limit'
    // 199,995 characters, then the secret: it straddles the 200,000 cut.
    const r = await runCommand(`head -c 199995 /dev/zero | tr '\\0' a; printf '%s' "$S"`, { S: secret }, { secrets: [secret] })
    expect(r.stdout).not.toContain('S3cr3t')
    expect(r.stdout).toContain('[output truncated]')
  })
})

describe('utf-8 split across chunks', () => {
  it('a secret with a multibyte character is scrubbed even when the bytes arrive apart', async () => {
    const secret = 'pässwörd-ñandú'
    // Two writes, the first ending in the middle of "ä".
    const cmd = `node -e "const b=Buffer.from(process.env.S); process.stdout.write(b.subarray(0,2)); setTimeout(()=>process.stdout.write(b.subarray(2)),50)"`
    const r = await runCommand(cmd, { S: secret }, { secrets: [secret] })
    expect(r.stdout).toBe('[REDACTED]')
  })
})

describe('command limits', () => {
  it('a limited account runs only its program, by name, from PATH', () => {
    const ok = resolveAllowed('sh -c "echo hi"', ['sh'])
    expect(ok && 'path' in ok && ok.path.startsWith('/')).toBe(true) // e.g. /bin/sh → /usr/bin/dash
    expect(resolveAllowed('curl https://evil.example', ['psql'])).toEqual({ error: expect.stringMatching(/only be used with psql, not curl/) })
    expect(resolveAllowed('/tmp/psql -c x', ['psql'])).toEqual({ error: expect.stringMatching(/called by name/) })
    expect(resolveAllowed('./psql', ['psql'])).toEqual({ error: expect.stringMatching(/called by name/) })
    expect(resolveAllowed('psql; curl evil', ['psql'])).toEqual({ error: expect.stringMatching(/single command/) })
    expect(resolveAllowed('psql $(curl evil)', ['psql'])).toEqual({ error: expect.stringMatching(/single command/) })
    expect(resolveAllowed('anything | goes', [])).toBeNull()
  })

  it('a program planted in the working or temp directory is not used, even on PATH', () => {
    const dir = mkdtempSync(join(tmpdir(), 'otp-plant-'))
    writeFileSync(join(dir, 'fakepsql'), '#!/bin/sh\necho got "$P"\n')
    chmodSync(join(dir, 'fakepsql'), 0o755)
    const before = process.env.PATH
    process.env.PATH = `${dir}:${before}`
    try {
      expect(resolveAllowed('fakepsql', ['fakepsql'], dir)).toEqual({ error: expect.stringMatching(/isn't installed/) })
    } finally { process.env.PATH = before }
  })
})

describe('files', () => {
  it('scrubs every line of a file a command prints, short ones and their values too', async () => {
    const text = 'TOKEN=abc123\nOTHER="xyz789"\n{\n  "key": "k-7f3a",\n}\n'
    const bytes = new TextEncoder().encode(text)
    const temp = writeTempFiles([{ name: '.env', bytes }])
    try {
      const r = await runCommand('head -n 1 "$K"; cut -d= -f2 "$K" | head -n 2; grep key "$K"', { K: temp.paths[0] }, { secrets: fileSecrets(bytes, text) })
      expect(r.exitCode).toBe(0)
      expect(r.stdout).not.toMatch(/abc123|xyz789|k-7f3a/)
      expect(r.stdout).toContain('[REDACTED]')
    } finally { temp.cleanup() }
    expect(existsSync(temp.paths[0])).toBe(false)
  })

  it('a write that fails halfway leaves no file behind', () => {
    const before = new Set(readdirSync(tmpdir()).filter(n => n.startsWith('otpilot-')))
    expect(() => writeTempFiles([
      { name: 'id_ed25519', bytes: new TextEncoder().encode('secret key') },
      { name: 'broken', bytes: 42 as unknown as Uint8Array },
    ])).toThrow()
    expect(readdirSync(tmpdir()).filter(n => n.startsWith('otpilot-') && !before.has(n))).toEqual([])
  })
})
