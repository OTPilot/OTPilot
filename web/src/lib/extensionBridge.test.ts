// The dashboard ↔ extension unlock, against a fake `chrome.runtime`: which
// installed extension is used, and what each refusal says.
import { afterEach, describe, expect, it } from 'vitest'
import { findExtension, keysFromExtension } from './extensionBridge'

type Handler = (id: string, msg: { action: string; userId?: string }) => unknown
let lastError: unknown

function fakeRuntime(handler: Handler) {
  (globalThis as { chrome?: unknown }).chrome = {
    runtime: {
      get lastError() { return lastError },
      sendMessage(id: string, msg: { action: string }, cb: (res: unknown) => void) {
        const res = handler(id, msg)
        // Not installed: Chrome answers with lastError set.
        setTimeout(() => {
          lastError = res === undefined ? { message: 'Could not establish connection' } : undefined
          cb(res)
          lastError = undefined
        })
      },
    },
  }
}

afterEach(() => { delete (globalThis as { chrome?: unknown }).chrome })

const EDGE = 'alcjdoijhlfpmanfjiibhlinehdgdnce'

describe('findExtension', () => {
  it('is null without chrome.runtime (other browsers, no extension)', async () => {
    expect(await findExtension('me')).toBeNull()
  })

  it('finds the installed one and says whose account it has', async () => {
    fakeRuntime((id, msg) => (id === EDGE && msg.action === 'hello' ? { ok: true, account: msg.userId === 'me' ? 'same' : 'other' } : undefined))
    expect(await findExtension('me')).toEqual({ id: EDGE, account: 'same' })
    expect(await findExtension('someone')).toEqual({ id: EDGE, account: 'other' })
  })
})

describe('keysFromExtension', () => {
  it('returns the keys once allowed', async () => {
    fakeRuntime(() => ({ ok: true, vaultKey: 'vk', teamKey: { d: 'x' } }))
    expect(await keysFromExtension(EDGE, 'me')).toEqual({ vaultKey: 'vk', teamKey: { d: 'x' } })
  })

  it('explains a refusal', async () => {
    fakeRuntime(() => ({ ok: false, error: 'denied' }))
    await expect(keysFromExtension(EDGE, 'me')).rejects.toThrow('Not allowed in the extension.')
    fakeRuntime(() => ({ ok: false, error: 'no-sync' }))
    await expect(keysFromExtension(EDGE, 'me')).rejects.toThrow('Turn on sync in the extension first.')
    fakeRuntime(() => undefined)
    await expect(keysFromExtension(EDGE, 'me')).rejects.toThrow(/didn't answer/)
  })
})
