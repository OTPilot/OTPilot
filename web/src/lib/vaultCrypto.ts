// 2.0 vault crypto for the web dashboard — mirrors the extension's
// vaultCrypto.js (item records, collection names) and keys.js (ECIES key
// wrapping to a teammate's public key). Keep the formats and AAD strings in
// sync with those files: the extension and the web read each other's data.
//
//   VK  vault key (the recovery key): wraps each personal item's key
//   CK  collection key: wraps nothing here but share keys and names
//   SK  share key: encrypts one share's copy of an item
//   IK  item key: a fresh one per encryption, wrapped under VK / CK / SK

const ITEM_FORMAT = 2
const enc = new TextEncoder()
const dec = new TextDecoder()

// A plain ArrayBuffer copy (a valid BufferSource for Web Crypto's typings).
function ab(u: Uint8Array): ArrayBuffer {
  return u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer
}

export const b64e = (buf: ArrayBuffer | Uint8Array): string => {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf)
  let s = ''
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i])
  return btoa(s)
}
export const b64d = (str: string): Uint8Array => Uint8Array.from(atob(str), (c) => c.charCodeAt(0))

const itemAad = (id: string) => enc.encode(`otpilot:item:v${ITEM_FORMAT}:${id}`)
const keyAad = (id: string) => enc.encode(`otpilot:ik:v${ITEM_FORMAT}:${id}`)
const nameAad = (id: string) => enc.encode(`otpilot:collection-name:v1:${id}`)

export type Box = { iv: string; ct: string }
export type ItemRecord = { id: string; v: number; key: Box; data: Box }

export function generateKey(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(32))
}

/** Raw 32-byte key from bytes or base64. */
function toRaw(key: Uint8Array | string): Uint8Array {
  const raw = typeof key === 'string' ? b64d(key) : key
  if (raw.length !== 32) throw new Error('key must be 32 bytes')
  return raw
}

function importAes(key: Uint8Array | string, usages: KeyUsage[]) {
  return crypto.subtle.importKey('raw', ab(toRaw(key)), 'AES-GCM', false, usages)
}

async function seal(key: CryptoKey, plaintext: Uint8Array, aad: Uint8Array): Promise<Box> {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: ab(iv), additionalData: ab(aad) }, key, ab(plaintext))
  return { iv: b64e(iv), ct: b64e(ct) }
}

async function open(key: CryptoKey, box: Box, aad: Uint8Array): Promise<Uint8Array> {
  const pt = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: ab(b64d(box.iv)), additionalData: ab(aad) }, key, ab(b64d(box.ct)),
  )
  return new Uint8Array(pt)
}

/** An item (with a string `id`) → its record, the item key wrapped under `wrappingKey`. */
export async function encryptItem<T extends { id: string }>(item: T, wrappingKey: Uint8Array | string): Promise<ItemRecord> {
  if (!item?.id) throw new Error('item.id required')
  const ik = generateKey()
  try {
    const data = await seal(await importAes(ik, ['encrypt']), enc.encode(JSON.stringify(item)), itemAad(item.id))
    const key = await seal(await importAes(wrappingKey, ['encrypt']), ik, keyAad(item.id))
    return { id: item.id, v: ITEM_FORMAT, key, data }
  } finally {
    ik.fill(0)
  }
}

export async function decryptItem<T extends { id: string }>(record: ItemRecord, wrappingKey: Uint8Array | string): Promise<T> {
  if (record?.v !== ITEM_FORMAT) throw new Error(`unsupported item format: ${record?.v}`)
  const ik = await open(await importAes(wrappingKey, ['decrypt']), record.key, keyAad(record.id))
  let pt: Uint8Array
  try {
    pt = await open(await importAes(ik, ['decrypt']), record.data, itemAad(record.id))
  } finally {
    ik.fill(0)
  }
  const item = JSON.parse(dec.decode(pt)) as T
  if (item.id !== record.id) throw new Error('item id mismatch')
  return item
}

/** A collection's name (or a share key under a collection key), bound to `id`. */
export async function encryptName(name: string, collectionKey: Uint8Array | string, id: string): Promise<string> {
  return JSON.stringify(await seal(await importAes(collectionKey, ['encrypt']), enc.encode(String(name)), nameAad(id)))
}

export async function decryptName(encrypted: string, collectionKey: Uint8Array | string, id: string): Promise<string> {
  return dec.decode(await open(await importAes(collectionKey, ['decrypt']), JSON.parse(encrypted), nameAad(id)))
}

// ── ECIES (P-256) — keys.js wrapUserShare / unwrapUserShare ──────────────

/** Wraps `secret` (32 bytes) to a teammate's public key (raw point, base64). */
export async function wrapToPublicKey(secret: Uint8Array, publicKeyB64: string): Promise<string> {
  const peer = await crypto.subtle.importKey('raw', ab(b64d(publicKeyB64)), { name: 'ECDH', namedCurve: 'P-256' }, false, [])
  const eph = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveKey'])
  const aes = await crypto.subtle.deriveKey(
    { name: 'ECDH', public: peer }, eph.privateKey, { name: 'AES-GCM', length: 256 }, false, ['encrypt'],
  )
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: ab(iv) }, aes, ab(secret))
  const epk = await crypto.subtle.exportKey('raw', eph.publicKey)
  return JSON.stringify({ epk: b64e(epk), iv: b64e(iv), ct: b64e(ct) })
}

/** Opens what `wrapToPublicKey` made for this user's private key. */
export async function unwrapWithPrivateKey(blob: string, privateKey: CryptoKey): Promise<Uint8Array> {
  const { epk, iv, ct } = JSON.parse(blob)
  const peer = await crypto.subtle.importKey('raw', ab(b64d(epk)), { name: 'ECDH', namedCurve: 'P-256' }, false, [])
  const aes = await crypto.subtle.deriveKey(
    { name: 'ECDH', public: peer }, privateKey, { name: 'AES-GCM', length: 256 }, false, ['decrypt'],
  )
  return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: ab(b64d(iv)) }, aes, ab(b64d(ct))))
}

/** The public key (raw point, base64) of a private P-256 JWK. */
export async function publicKeyOf(jwk: JsonWebKey): Promise<string> {
  const pub = await crypto.subtle.importKey(
    'jwk', { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y }, { name: 'ECDH', namedCurve: 'P-256' }, true, [],
  )
  return b64e(await crypto.subtle.exportKey('raw', pub))
}
