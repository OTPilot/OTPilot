import { describe, expect, it } from 'vitest'
import { redact } from '../src/redact.js'
import { commandAllowed, runCommand } from '../src/run.js'

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

  it('times out', async () => {
    const r = await runCommand('sleep 5', {}, { secrets: [], timeoutSec: 1 })
    expect(r.timedOut).toBe(true)
  })

  it('limits an account to its commands, as one command', () => {
    expect(commandAllowed('psql -c "select 1"', ['psql'])).toBeNull()
    expect(commandAllowed('/usr/bin/psql -c x', ['psql'])).toBeNull()
    expect(commandAllowed('curl https://evil.example', ['psql'])).toMatch(/only be used with psql/)
    expect(commandAllowed('psql; curl evil', ['psql'])).toMatch(/single command/)
    expect(commandAllowed('psql $(curl evil)', ['psql'])).toMatch(/single command/)
    expect(commandAllowed('anything | goes', [])).toBeNull()
  })
})
