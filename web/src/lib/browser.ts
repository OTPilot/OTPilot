export type Browser = 'chrome' | 'firefox' | 'edge' | 'safari' | 'other'

export function detectBrowser(): Browser {
  const ua = navigator.userAgent
  if (ua.includes('Edg/')) return 'edge'
  if (ua.includes('Firefox/')) return 'firefox'
  if (ua.includes('Chrome/')) return 'chrome'
  if (ua.includes('Safari/')) return 'safari'
  return 'other'
}

export type BrowserMeta = {
  name: string
  available: boolean
  href: string | null
}

export const CHROME_STORE_URL = 'https://chromewebstore.google.com/detail/otpilot'

export const browserMeta: Record<Browser, BrowserMeta> = {
  chrome: {
    name: 'Chrome',
    available: true,
    href: CHROME_STORE_URL,
  },
  edge: {
    name: 'Edge',
    available: true,
    href: 'https://microsoftedge.microsoft.com/addons/detail/otpilot',
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
