// An agent's verification code: the first 40 bits of SHA-256 over its raw
// P-256 public key, base32, XXXX-XXXX. The same in the terminal, on the web
// (web/src/lib/agentCode.ts) and in the extension (agents.js): a server that
// swapped the key would show a different code.
import { createHash } from 'node:crypto'

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

export function agentCode(publicKeyB64: string): string {
  const hash = createHash('sha256').update(Buffer.from(publicKeyB64, 'base64')).digest()
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
