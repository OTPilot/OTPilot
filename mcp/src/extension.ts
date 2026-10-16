// The extension's own vault code, reused as-is (copied to vendor/ by
// scripts/vendor.mjs): item encryption, the TOTP generator and the check that
// a login covers a host. Plain browser scripts, loaded in a function scope.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export type VaultField = { id: string; label?: string; value?: string; kind?: string; custom?: boolean; section?: string; format?: string }
export type VaultItem = {
  id: string
  type: string
  title: string
  urls: string[]
  fields: VaultField[]
  totp: { secret: string; digits?: number; period?: number; algorithm?: string } | null
  notes: string
  updatedAt?: string
}
export type EncryptedRecord = { v: number; key: { iv: string; ct: string }; data: { iv: string; ct: string } }

const vendor = join(dirname(fileURLToPath(import.meta.url)), '..', 'vendor')

function load<T>(file: string, expr: string): T {
  const src = readFileSync(join(vendor, file), 'utf8')
  return new Function(`${src}\nreturn (${expr});`)() as T
}

export const VaultCrypto = load<{
  b64e(bytes: Uint8Array | ArrayBuffer): string
  b64d(s: string): Uint8Array
  generateKey(): Uint8Array
  encryptItem(item: object, key: string): Promise<EncryptedRecord>
  decryptItem(record: EncryptedRecord, key: string): Promise<VaultItem>
}>('vaultCrypto.js', 'VaultCrypto')

export type VaultFile = { name: string; mime: string; size: number; bytes: Uint8Array }

export const Vault = load<{
  getValue(item: VaultItem, id: string): string
  loginCoversHost(urls: string[] | string, hostname: string): boolean
  fileOf(value: string | undefined): VaultFile | null
  fileText(file: VaultFile | null): string | null
  isWalletSecret(item: VaultItem, field: VaultField): boolean
}>('vault.js', 'Vault')

export const generateTOTP = load<(secret: string, period?: number, digits?: number) => Promise<string>>('totp.js', 'generateTOTP')
