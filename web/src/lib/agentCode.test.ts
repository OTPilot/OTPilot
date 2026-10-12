import { describe, expect, it } from 'vitest'
import { agentCode } from './agentCode'

describe('agentCode', () => {
  it('matches the shared test vector (extension/agents.js, mcp/src/code.ts)', async () => {
    const key = btoa(String.fromCharCode(4, ...new Array(64).fill(7)))
    expect(await agentCode(key)).toBe('5ZOI-GAGN')
  })
})
