// Unlocking the dashboard from the OTPilot extension instead of pasting the
// recovery key (extension/background.js, "Unlocking the web dashboard"). The
// extension answers only this site's origin, only for the account it's signed
// in to, and hands over the vault key + team private key only after the user
// allows it in an extension window. Chrome-family browsers only: elsewhere
// `chrome.runtime` isn't there and the recovery key stays the way in.

// Store ids (Chrome Web Store, Edge Add-ons); VITE_EXTENSION_IDS (comma
// separated) for an unpacked dev build.
const STORE_IDS = ['mbfpjhjhcmgcchnnnnjcdblkbjifgjpk', 'alcjdoijhlfpmanfjiibhlinehdgdnce']
const IDS: string[] = (import.meta.env.VITE_EXTENSION_IDS as string | undefined)
  ?.split(',').map((s) => s.trim()).filter(Boolean) ?? STORE_IDS

type Runtime = {
  sendMessage: (id: string, msg: unknown, cb: (res: unknown) => void) => void
  lastError?: unknown
}

function runtime(): Runtime | null {
  const rt = (globalThis as { chrome?: { runtime?: Runtime } }).chrome?.runtime
  return typeof rt?.sendMessage === 'function' ? rt : null
}

// The extension's answer, or null (not installed, no answer, timed out).
function send<T>(id: string, msg: unknown, timeoutMs: number): Promise<T | null> {
  const rt = runtime()
  if (!rt) return Promise.resolve(null)
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), timeoutMs)
    try {
      rt.sendMessage(id, msg, (res) => {
        clearTimeout(timer)
        resolve(rt.lastError ? null : (res as T) ?? null)
      })
    } catch {
      clearTimeout(timer)
      resolve(null)
    }
  })
}

export type ExtensionAccount = 'same' | 'other' | 'signed-out'
export type FoundExtension = { id: string; account: ExtensionAccount }

/** The installed extension and whether it's signed in to `userId`, or null. */
export async function findExtension(userId: string): Promise<FoundExtension | null> {
  if (!runtime() || !userId) return null
  const found = await Promise.all(IDS.map(async (id) => {
    const res = await send<{ ok?: boolean; account?: ExtensionAccount }>(id, { action: 'hello', userId }, 1500)
    return res?.ok && res.account ? { id, account: res.account } : null
  }))
  return found.find((f) => f?.account === 'same') ?? found.find(Boolean) ?? null
}

const ERRORS: Record<string, string> = {
  denied: 'Not allowed in the extension.',
  other: 'The extension is signed in to a different account.',
  'signed-out': 'Sign in to the OTPilot extension first.',
  'no-sync': 'Turn on sync in the extension first.',
  'no-team-key': 'Your team key isn\'t ready yet. Open the extension once, then try again.',
  superseded: 'Another unlock request replaced this one.',
  expired: 'The request expired. Try again.',
}

/** Asks the extension for the vault key and the team private key (the user approves there). */
export async function keysFromExtension(id: string, userId: string): Promise<{ vaultKey: string; teamKey: JsonWebKey }> {
  // The extension gives up after 2 minutes; this only covers it going away.
  const res = await send<{ ok?: boolean; error?: string; vaultKey?: string; teamKey?: JsonWebKey }>(
    id, { action: 'unlockVault', userId }, 3 * 60 * 1000,
  )
  if (res?.ok && typeof res.vaultKey === 'string' && res.teamKey) return { vaultKey: res.vaultKey, teamKey: res.teamKey }
  throw new Error((res?.error && ERRORS[res.error]) || 'The extension didn\'t answer. Try again, or use your recovery key.')
}
