// Copies the extension's vault code the MCP server reuses as-is (same
// encryption, same TOTP, same "does this login cover this host" check) into
// vendor/, which is shipped in the npm package. Never edit vendor/: change
// extension/ and run this again (build and test do).
import { copyFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const ext = join(root, '..', 'extension')
mkdirSync(join(root, 'vendor'), { recursive: true })
for (const f of ['vaultCrypto.js', 'vault.js', 'totp.js']) copyFileSync(join(ext, f), join(root, 'vendor', f))
