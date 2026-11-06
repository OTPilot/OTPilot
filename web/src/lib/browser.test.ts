// The hooks the prerendered home relies on: on the server they must render
// what the first client render will (no hydration mismatch), and
// detectBrowser() must read the user agent the same way the store links do.
import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { detectBrowser, useBrowser } from './browser'
import { useReducedMotion } from './useReducedMotion'

function Probe() {
  return createElement('span', null, `${useBrowser()}|${String(useReducedMotion())}`)
}

describe('server render', () => {
  it("renders 'other' and reduced motion", () => {
    expect(renderToString(createElement(Probe))).toBe('<span>other|true</span>')
  })
})

const UA = {
  edge: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0',
  firefox: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14.5; rv:131.0) Gecko/20100101 Firefox/131.0',
  chrome: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  safari: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15',
  other: 'curl/8.7.1',
} as const

describe('detectBrowser', () => {
  afterEach(() => { vi.unstubAllGlobals() })

  for (const [expected, ua] of Object.entries(UA)) {
    it(`${expected}: ${ua.slice(0, 40)}…`, () => {
      vi.stubGlobal('navigator', { userAgent: ua })
      expect(detectBrowser()).toBe(expected)
    })
  }

  it("no navigator → 'other'", () => {
    vi.stubGlobal('navigator', undefined)
    expect(detectBrowser()).toBe('other')
  })
})
