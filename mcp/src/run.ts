// `run`: a command with secrets in its environment, for that process only;
// what it prints comes back with the secrets scrubbed.
import { spawn } from 'node:child_process'
import { accessSync, constants, realpathSync, statSync } from 'node:fs'
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
  for (const dir of (process.env.PATH || '').split(delimiter)) {
    if (!dir || !isAbsolute(dir)) continue
    const candidate = join(dir, program)
    try {
      accessSync(candidate, constants.X_OK)
      if (!statSync(candidate).isFile()) continue
      const real = realpathSync(candidate)
      if (avoid.some(d => real === d || real.startsWith(d + sep))) continue
      return { program, path: real, rest: trimmed.slice(program.length) }
    } catch { /* not here */ }
  }
  return { error: `${program} isn't installed here (not found on PATH).` }
}

export type RunResult = { exitCode: number | null; stdout: string; stderr: string; timedOut: boolean }

const shellQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`

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
    const take = (cur: string, chunk: Buffer) => (cur.length < MAX_CAPTURE ? cur + chunk.toString('utf8') : cur)
    child.stdout.on('data', c => { stdout = take(stdout, c) })
    child.stderr.on('data', c => { stderr = take(stderr, c) })
    const out = (s: string) => {
      // Scrub first, then cut: a secret is never left half-removed.
      const clean = redact(s, opts.secrets)
      return clean.length > MAX_OUTPUT ? `${clean.slice(0, MAX_OUTPUT)}\n[output truncated]` : clean
    }
    const finish = (code: number | null) => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      done({ exitCode: code, stdout: out(stdout), stderr: out(stderr), timedOut })
    }
    const timer = setTimeout(() => {
      timedOut = true
      try { process.kill(-child.pid!, 'SIGKILL') } catch { child.kill('SIGKILL') }
      // Don't wait on pipes a stray process might still hold.
      setTimeout(() => { child.stdout.destroy(); child.stderr.destroy(); finish(null) }, 1000)
    }, Math.min(opts.timeoutSec ?? 120, 600) * 1000)
    child.on('close', code => finish(code))
    child.on('error', err => { stderr += String(err); finish(null) })
  })
}
