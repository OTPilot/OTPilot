// This agent's credentials: its private key and its API token, in the OS
// keychain (macOS Keychain, Windows Credential Manager, Secret Service). Where
// there's no keychain (a bare Linux box), a 0600 file in ~/.config/otpilot.
// One profile per agent identity: Claude Code and Codex on the same machine
// are two agents, each approved on its own.
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export type Credentials = {
  apiUrl: string
  agentId: string
  name: string
  token: string
  publicKey: string
  privateJwk: JsonWebKey
}

const SERVICE = 'otpilot-mcp'
const fileOf = (profile: string) => join(homedir(), '.config', 'otpilot', `mcp-${profile}.json`)

async function entry(profile: string) {
  try {
    const { Entry } = await import('@napi-rs/keyring')
    return new Entry(SERVICE, profile)
  } catch {
    return null
  }
}

export async function load(profile: string): Promise<Credentials | null> {
  const e = await entry(profile)
  try {
    const s = e?.getPassword()
    if (s) return JSON.parse(s) as Credentials
  } catch { /* no keychain here: the file */ }
  const f = fileOf(profile)
  return existsSync(f) ? (JSON.parse(readFileSync(f, 'utf8')) as Credentials) : null
}

/** Returns where they were saved. */
export async function save(profile: string, c: Credentials): Promise<'keychain' | string> {
  const e = await entry(profile)
  try {
    if (e) {
      e.setPassword(JSON.stringify(c))
      return 'keychain'
    }
  } catch { /* fall back to the file */ }
  const f = fileOf(profile)
  mkdirSync(join(homedir(), '.config', 'otpilot'), { recursive: true, mode: 0o700 })
  writeFileSync(f, JSON.stringify(c), { mode: 0o600 })
  chmodSync(f, 0o600)
  return f
}

export async function remove(profile: string): Promise<void> {
  const e = await entry(profile)
  try { e?.deletePassword() } catch { /* not there */ }
  rmSync(fileOf(profile), { force: true })
}
