// The agent's ECDH P-256 keypair, and opening what the extension wrapped to
// it: the inverse of TeamKeys.wrapUserShare (extension/keys.js) — an
// ephemeral ECDH key, AES-256-GCM derived directly from the shared secret.
import { webcrypto } from 'node:crypto'

const subtle = webcrypto.subtle
const ECDH = { name: 'ECDH', namedCurve: 'P-256' } as const
const b64 = (s: string) => new Uint8Array(Buffer.from(s, 'base64'))

export type KeyPair = { privateJwk: JsonWebKey; publicKey: string }

export async function generateKeyPair(): Promise<KeyPair> {
  const kp = (await subtle.generateKey(ECDH, true, ['deriveKey'])) as CryptoKeyPair
  return {
    privateJwk: await subtle.exportKey('jwk', kp.privateKey),
    publicKey: Buffer.from(await subtle.exportKey('raw', kp.publicKey)).toString('base64'),
  }
}

export async function unwrap(wrapped: string, privateJwk: JsonWebKey): Promise<Uint8Array> {
  const { epk, iv, ct } = JSON.parse(wrapped) as { epk: string; iv: string; ct: string }
  const priv = await subtle.importKey('jwk', privateJwk, ECDH, false, ['deriveKey'])
  const pub = await subtle.importKey('raw', b64(epk), ECDH, false, [])
  const aes = await subtle.deriveKey({ name: 'ECDH', public: pub }, priv, { name: 'AES-GCM', length: 256 }, false, ['decrypt'])
  return new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: b64(iv) }, aes, b64(ct)))
}
