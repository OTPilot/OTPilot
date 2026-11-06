import { useSyncExternalStore } from 'react'

export type Browser = 'chrome' | 'firefox' | 'edge' | 'safari' | 'other'

// Don't call this while rendering a prerendered page: the server has no
// `navigator` and renders 'other', so Edge / Firefox / Safari would hydrate
// different HTML and React would throw the page away (#418). Use useBrowser().
export function detectBrowser(): Browser {
  // No `navigator` during SSG's server render pass (Landing renders there) —
  // falls through to 'other', same fallback as an unrecognized browser.
  const ua = typeof navigator === 'undefined' ? '' : navigator.userAgent
  if (ua.includes('Edg/')) return 'edge'
  if (ua.includes('Firefox/')) return 'firefox'
  if (ua.includes('Chrome/')) return 'chrome'
  if (ua.includes('Safari/')) return 'safari'
  return 'other'
}

const subscribeNever = () => () => {}
const serverBrowser = (): Browser => 'other'

// The visitor's browser, hydration-safe: the first client render matches the
// server's 'other', then React re-renders with the real one.
export function useBrowser(): Browser {
  return useSyncExternalStore(subscribeNever, detectBrowser, serverBrowser)
}

export type BrowserMeta = {
  name: string
  available: boolean
  href: string | null
}

export const CHROME_STORE_URL = 'https://chromewebstore.google.com/detail/otpilot/mbfpjhjhcmgcchnnnnjcdblkbjifgjpk'

export const browserMeta: Record<Browser, BrowserMeta> = {
  chrome: {
    name: 'Chrome',
    available: true,
    href: CHROME_STORE_URL,
  },
  edge: {
    name: 'Edge',
    available: true,
    href: 'https://microsoftedge.microsoft.com/addons/detail/OTPilot/alcjdoijhlfpmanfjiibhlinehdgdnce',
  },
  firefox: {
    name: 'Firefox',
    available: false,
    href: null,
  },
  safari: {
    name: 'Safari',
    available: false,
    href: null,
  },
  other: {
    name: 'Chrome',
    available: true,
    href: CHROME_STORE_URL,
  },
}
