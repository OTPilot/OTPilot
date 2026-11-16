import { afterEach, describe, expect, it, vi } from 'vitest'
import { Api, ApiError, MCP_HEADER, VERSION } from '../src/api.js'

describe('Api', () => {
  afterEach(() => { vi.unstubAllGlobals() })

  it('says which MCP it is on every call (x-otpilot-mcp: its version)', async () => {
    const seen: Record<string, string>[] = []
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      seen.push(init.headers as Record<string, string>)
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    })
    await new Api('http://api', 'otpa_x').get('/agent/grants')
    await new Api('http://api').post('/agents/pair', {})
    expect(seen.map(h => h[MCP_HEADER])).toEqual([VERSION, VERSION])
    expect(MCP_HEADER).toBe('x-otpilot-mcp')
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+/)
  })

  it('keeps the status, the code and the body of an error', async () => {
    const body = { error: 'used up', code: 'agent_uses_exhausted', used: 10 }
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify(body), { status: 402 }))
    const e = await new Api('http://api', 't').post('/agent/grants/open', {}).catch(x => x)
    expect(e).toBeInstanceOf(ApiError)
    expect([e.status, e.code, e.message, e.body]).toEqual([402, 'agent_uses_exhausted', 'used up', body])
    vi.stubGlobal('fetch', async () => new Response('nope', { status: 500 }))
    const plain = await new Api('http://api').get('/x').catch(x => x)
    expect([plain.status, plain.code, plain.message]).toEqual([500, undefined, 'HTTP 500'])
  })
})
