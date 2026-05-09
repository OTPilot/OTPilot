// TOTP (RFC 6238) implemented with the Web Crypto API – no dependencies

function base32Decode(input) {
  const alpha = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  input = input.toUpperCase().replace(/\s/g, '').replace(/=+$/, '');
  let bits = 0, val = 0, idx = 0;
  const out = new Uint8Array(Math.ceil(input.length * 5 / 8));
  for (const ch of input) {
    const n = alpha.indexOf(ch);
    if (n < 0) throw new Error('Invalid base32 character: ' + ch);
    val = (val << 5) | n;
    bits += 5;
    if (bits >= 8) { out[idx++] = (val >>> (bits - 8)) & 0xff; bits -= 8; }
  }
  return out.slice(0, idx).buffer;
}

function hexDecode(hex) {
  hex = hex.replace(/\s/g, '');
  if (hex.length % 2 !== 0) throw new Error('Odd-length hex string');
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++)
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out.buffer;
}

function decodeSecret(secret) {
  const s = secret.replace(/\s/g, '');
  // Hex: only 0-9 a-f, even length
  if (/^[0-9a-fA-F]+$/.test(s) && s.length % 2 === 0) return hexDecode(s);
  return base32Decode(s);
}

async function generateTOTP(secret, period = 30, digits = 6) {
  const keyBytes = decodeSecret(secret);
  const counter = Math.floor(Date.now() / 1000 / period);

  // Counter as 8-byte big-endian (upper 4 bytes are 0 for timestamps through ~4000 AD)
  const msg = new ArrayBuffer(8);
  new DataView(msg).setUint32(4, counter, false);

  const key = await crypto.subtle.importKey(
    'raw', keyBytes,
    { name: 'HMAC', hash: 'SHA-1' },
    false, ['sign']
  );
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, msg));

  // Dynamic truncation per RFC 4226
  const off = sig[sig.length - 1] & 0x0f;
  const code =
    (((sig[off]     & 0x7f) << 24) |
     ((sig[off + 1] & 0xff) << 16) |
     ((sig[off + 2] & 0xff) <<  8) |
      (sig[off + 3] & 0xff)) % (10 ** digits);

  return code.toString().padStart(digits, '0');
}

function totpRemaining(period = 30) {
  return period - (Math.floor(Date.now() / 1000) % period);
}
