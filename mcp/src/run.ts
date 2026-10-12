// `run`: a command with secrets in its environment, for that process only;
// what it prints comes back with the secrets scrubbed.
import { spawn } from 'node:child_process'
import { basename } from 'node:path'
import { redact } from './redact.js'

const MAX_OUTPUT = 200_000

/**
 * Whether `command` may use a grant limited to `allowed` commands: its
 * program must be one of them, and it can't chain or substitute another one.
 */
export function commandAllowed(command: string, allowed: string[]): string | null {
  if (!allowed.length) return null
  if (/[;&|`\n<>]|\$\(/.test(command)) {
    return `This account may only be used with ${allowed.join(', ')}, as a single command (no ; & | \` $( or redirections).`
  }
  const program = basename(command.trim().split(/\s+/)[0] || '')
  return allowed.includes(program) ? null : `This account may only be used with ${allowed.join(', ')}, not ${program || 'this command'}.`
}

export type RunResult = { exitCode: number | null; stdout: string; stderr: string; timedOut: boolean }

export function runCommand(command: string, env: Record<string, string>, opts: { cwd?: string; timeoutSec?: number; secrets: string[] }): Promise<RunResult> {
  return new Promise(resolve => {
    const child = spawn(command, { shell: true, cwd: opts.cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    const take = (cur: string, chunk: Buffer) => (cur.length < MAX_OUTPUT ? cur + chunk.toString('utf8') : cur)
    child.stdout.on('data', c => { stdout = take(stdout, c) })
    child.stderr.on('data', c => { stderr = take(stderr, c) })
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL') }, Math.min(opts.timeoutSec ?? 120, 600) * 1000)
    child.on('close', code => {
      clearTimeout(timer)
      const cut = (s: string) => (s.length > MAX_OUTPUT ? `${s.slice(0, MAX_OUTPUT)}\n[output truncated]` : s)
      resolve({ exitCode: code, stdout: redact(cut(stdout), opts.secrets), stderr: redact(cut(stderr), opts.secrets), timedOut })
    })
    child.on('error', err => {
      clearTimeout(timer)
      resolve({ exitCode: null, stdout: '', stderr: redact(String(err), opts.secrets), timedOut })
    })
  })
}
