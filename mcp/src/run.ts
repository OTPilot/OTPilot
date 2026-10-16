// `run`: a command with secrets in its environment, for that process only;
// what it prints comes back with the secrets scrubbed.
import { execFileSync, spawn } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'
import { accessSync, chmodSync, constants, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, isAbsolute, join, resolve, sep } from 'node:path'
import { redact } from './redact.js'

/** What comes back to the agent, per stream. */
const MAX_OUTPUT = 200_000
/** What's read before scrubbing: twice that, so a secret straddling the cut is still whole when scrubbed. */
const MAX_CAPTURE = 2 * MAX_OUTPUT

/**
 * The program a command limited to `allowed` may run, resolved to the
 * absolute path it runs from — the caller runs that path, not the name.
 * The program must be a bare name found on this server's PATH (absolute
 * entries only), outside the working directory and the temp directory, and
 * the command can't chain, substitute or redirect: a grant for `psql` can't
 * be used by `./psql`, `/tmp/psql` or `psql; curl …`.
 *
 * This keeps an agent from using a secret with another program by mistake or
 * by a simple trick; an agent that can run arbitrary commands could still
 * plant a binary somewhere on PATH it can write to (the honest limit).
 */
export function resolveAllowed(command: string, allowed: string[], cwd = process.cwd()): { error: string } | { program: string; path: string; rest: string } | null {
  if (!allowed.length) return null
  const only = `This account may only be used with ${allowed.join(', ')}`
  if (/[;&|`\n<>]|\$\(/.test(command)) return { error: `${only}, as a single command (no ; & | \` $( or redirections).` }
  const trimmed = command.trim()
  const program = trimmed.split(/\s+/)[0] || ''
  if (program.includes('/') || program.includes('\\')) return { error: `${only}, called by name (not a path like ${program}).` }
  if (!allowed.includes(program)) return { error: `${only}, not ${program || 'this command'}.` }
  const avoid = [resolve(cwd), resolve(tmpdir()), '/tmp', '/var/tmp'].map(d => { try { return realpathSync(d) } catch { return d } })
  // Windows finds `psql` as psql.exe / .cmd / … (PATHEXT).
  const exts = process.platform === 'win32' ? ['', ...(process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';')] : ['']
  for (const dir of (process.env.PATH || '').split(delimiter)) {
    if (!dir || !isAbsolute(dir)) continue
    for (const ext of exts) {
      const candidate = join(dir, program + ext.toLowerCase())
      try {
        accessSync(candidate, process.platform === 'win32' ? constants.F_OK : constants.X_OK)
        if (!statSync(candidate).isFile()) continue
        const real = realpathSync(candidate)
        if (avoid.some(d => real === d || real.startsWith(d + sep))) continue
        return { program, path: real, rest: trimmed.slice(program.length) }
      } catch { /* not here */ }
    }
  }
  return { error: `${program} isn't installed here (not found on PATH).` }
}

/**
 * Files a command gets by path (an SSH key, a .p8): written to a fresh temp
 * directory only this user can read (0700, files 0600), each under its own
 * name, for that one command; `cleanup` deletes them all.
 */
export function writeTempFiles(files: { name: string; bytes: Uint8Array }[]): { paths: string[]; cleanup: () => void } {
  if (!files.length) return { paths: [], cleanup: () => {} }
  const dir = mkdtempSync(join(tmpdir(), 'otpilot-'))
  const cleanup = () => rmSync(dir, { recursive: true, force: true })
  try {
    chmodSync(dir, 0o700)
    const paths = files.map((f, i) => {
      const sub = join(dir, String(i))
      mkdirSync(sub, { mode: 0o700 })
      const path = join(sub, f.name.replace(/[^\w.@+-]/g, '_').replace(/^\.+$/, '_') || 'file')
      writeFileSync(path, f.bytes, { mode: 0o600 })
      return path
    })
    return { paths, cleanup }
  } catch (e) {
    // A write that failed halfway (a full disk) leaves none of the others behind.
    cleanup()
    throw e
  }
}

/**
 * What to scrub for a file a command got: its bytes in base64, its text, every
 * line of it (a command can print one: `head -n 1 .env`) and the value of a
 * KEY=VALUE / "key": "value" line. Bits under 4 characters (`}`, `{`) stay:
 * scrubbing them would garble every output.
 */
export function fileSecrets(bytes: Uint8Array, text: string | null): string[] {
  const out = [Buffer.from(bytes).toString('base64')]
  if (!text) return out
  out.push(text)
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (line.length < 4) continue
    out.push(line)
    const value = /^(?:export\s+)?["']?[\w.-]+["']?\s*[=:]\s*(.+?),?$/.exec(line)?.[1].replace(/^(['"`])(.*)\1$/, '$2')
    if (value && value.length >= 4) out.push(value)
  }
  return out
}

export type RunResult = { exitCode: number | null; stdout: string; stderr: string; timedOut: boolean }

// cmd.exe takes double quotes (a path can't contain one there); sh single quotes.
const shellQuote = (s: string) => (process.platform === 'win32' ? `"${s}"` : `'${s.replace(/'/g, `'\\''`)}'`)

export function runCommand(command: string, env: Record<string, string>, opts: { cwd?: string; timeoutSec?: number; secrets: string[]; program?: { path: string; rest: string } }): Promise<RunResult> {
  // A limited command runs the resolved program by its absolute path.
  const line = opts.program ? `${shellQuote(opts.program.path)}${opts.program.rest}` : command
  return new Promise(done => {
    // Its own process group, so a timeout kills the command and everything it started.
    const child = spawn(line, { shell: true, cwd: opts.cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let finished = false
    // A streaming decoder per stream: a character split between two chunks
    // stays whole, so a secret holding it is still found and scrubbed.
    const decOut = new StringDecoder('utf8')
    const decErr = new StringDecoder('utf8')
    const take = (cur: string, chunk: Buffer, dec: StringDecoder) => (cur.length < MAX_CAPTURE ? cur + dec.write(chunk) : cur)
    child.stdout.on('data', c => { stdout = take(stdout, c, decOut) })
    child.stderr.on('data', c => { stderr = take(stderr, c, decErr) })
    const out = (s: string) => {
      // Scrub first, then cut: a secret is never left half-removed.
      const clean = redact(s, opts.secrets)
      return clean.length > MAX_OUTPUT ? `${clean.slice(0, MAX_OUTPUT)}\n[output truncated]` : clean
    }
    const finish = (code: number | null) => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      stdout += decOut.end()
      stderr += decErr.end()
      done({ exitCode: code, stdout: out(stdout), stderr: out(stderr), timedOut })
    }
    const timer = setTimeout(() => {
      timedOut = true
      if (process.platform === 'win32') {
        // No process groups on Windows: taskkill /T takes the shell's whole tree.
        try { execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' }) } catch { child.kill('SIGKILL') }
      } else {
        try { process.kill(-child.pid!, 'SIGKILL') } catch { child.kill('SIGKILL') }
      }
      // Don't wait on pipes a stray process might still hold.
      setTimeout(() => { child.stdout.destroy(); child.stderr.destroy(); finish(null) }, 1000)
    }, Math.min(opts.timeoutSec ?? 120, 600) * 1000)
    child.on('close', code => finish(code))
    child.on('error', err => { stderr += String(err); finish(null) })
  })
}
