// The verification code of an AI agent (docs/agents/plan.md): the first 40
// bits of SHA-256 over its raw P-256 public key, base32 (RFC 4648), shown as
// XXXX-XXXX. Computed from the key itself on every side (terminal, web,
// extension), so a server that swapped the key would show a different code.
// Mirrored in extension/agents.js and mcp/src/code.ts — same test vector.
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

export async function agentCode(publicKeyB64: string): Promise<string> {
  const raw = Uint8Array.from(atob(publicKeyB64), c => c.charCodeAt(0))
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', raw))
  let bits = 0
  let value = 0
  let out = ''
  for (const b of hash.subarray(0, 5)) {
    value = (value << 8) | b
    bits += 8
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  return `${out.slice(0, 4)}-${out.slice(4)}`
}
