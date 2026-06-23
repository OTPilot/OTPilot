// Team shared-code crypto for the web dashboard.
//
// Sharing needs the plaintext TOTP secret, which lives E2E-encrypted in the sync
// vault. The dashboard never holds the recovery key, so the user pastes it once
// to decrypt the vault in-browser for the share. The 2-of-2 split then matches
// the extension (keys.js): K encrypts the secret; per recipient K2 = K XOR K1 is
// kept by the server and K1 is wrapped (ECIES P-256) to the recipient's pubkey.

// Returns a plain ArrayBuffer view of the bytes (a valid BufferSource) — avoids
// TS friction between Uint8Array<ArrayBufferLike> and the Web Crypto signatures.
function ab(u: Uint8Array): ArrayBuffer {
  return u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer
}

const b64e = (buf: ArrayBuffer | Uint8Array): string => {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf)
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s)
}
const b64d = (str: string): Uint8Array => {
  const bin = atob(str)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

export type VaultAccount = { name: string; secret: string; email?: string }

/** Decrypts the sync vault blob with the recovery key (base64 32-byte AES-GCM key). */
export async function decryptVault(blob: string, recoveryKeyB64: string): Promise<VaultAccount[]> {
  const { v, iv, data } = JSON.parse(blob)
  if (v !== 1) throw new Error('Unknown vault format')
  const key = await crypto.subtle.importKey('raw', ab(b64d(recoveryKeyB64)), 'AES-GCM', false, ['decrypt'])
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: ab(b64d(iv)) }, key, ab(b64d(data)))
  const parsed = JSON.parse(new TextDecoder().decode(plain))
  const accounts = Array.isArray(parsed) ? parsed : (parsed.accounts ?? [])
  return accounts as VaultAccount[]
}

/** Wraps K1 to a recipient's ECDH P-256 public key (raw point, base64) via ECIES. */
async function wrapUserShare(k1: Uint8Array, recipientPubB64: string): Promise<string> {
  const peerPub = await crypto.subtle.importKey(
    'raw', ab(b64d(recipientPubB64)), { name: 'ECDH', namedCurve: 'P-256' }, false, []
  )
  const eph = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveKey'])
  const aesKey = await crypto.subtle.deriveKey(
    { name: 'ECDH', public: peerPub }, eph.privateKey,
    { name: 'AES-GCM', length: 256 }, false, ['encrypt']
  )
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: ab(iv) }, aesKey, ab(k1))
  const epk = await crypto.subtle.exportKey('raw', eph.publicKey)
  return JSON.stringify({ epk: b64e(epk), iv: b64e(iv), ct: b64e(ct) })
}

export type ShareRecipient = { user_id: string; public_key: string | null }

export type SharePayload = {
  account_name: string
  account_email?: string
  encrypted_secret: string
  iv: string
  recipients: { user_id: string; server_share: string; encrypted_user_share: string }[]
}

/** Builds the 2-of-2 share payload for POST /teams/:id/codes. */
export async function buildShare(
  accountName: string,
  accountEmail: string | undefined,
  secret: string,
  recipients: ShareRecipient[],
): Promise<SharePayload> {
  const k = crypto.getRandomValues(new Uint8Array(32))
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const aesKey = await crypto.subtle.importKey('raw', ab(k), 'AES-GCM', false, ['encrypt'])
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: ab(iv) }, aesKey, new TextEncoder().encode(secret)
  )

  const out: SharePayload['recipients'] = []
  for (const r of recipients) {
    if (!r.public_key) throw new Error('A recipient has not signed in to the extension yet')
    const k1 = crypto.getRandomValues(new Uint8Array(32))
    const k2 = k.map((b, i) => b ^ k1[i]) // K2 = K XOR K1
    out.push({
      user_id: r.user_id,
      server_share: b64e(k2),
      encrypted_user_share: await wrapUserShare(k1, r.public_key),
    })
  }

  return {
    account_name: accountName,
    account_email: accountEmail || undefined,
    encrypted_secret: b64e(ct),
    iv: b64e(iv),
    recipients: out,
  }
}
