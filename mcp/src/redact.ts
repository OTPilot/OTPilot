// Scrubs the secrets a tool used from any text it returns to the agent — as
// typed, and the encodings a command could print them in.
export function variants(secret: string): string[] {
  if (secret.length < 4) return [secret].filter(Boolean)
  const buf = Buffer.from(secret, 'utf8')
  return [...new Set([
    secret,
    buf.toString('base64'),
    buf.toString('base64').replace(/=+$/, ''),
    buf.toString('base64url'),
    encodeURIComponent(secret),
    buf.toString('hex'),
    JSON.stringify(secret).slice(1, -1),
  ])].filter(v => v.length >= 4 || v === secret)
}

export function redact(text: string, secrets: string[]): string {
  const all = secrets.flatMap(variants).filter(Boolean).sort((a, b) => b.length - a.length)
  let out = text
  for (const v of all) out = out.split(v).join('[REDACTED]')
  return out
}
