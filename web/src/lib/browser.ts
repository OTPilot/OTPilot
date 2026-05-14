export type Browser = 'chrome' | 'firefox' | 'edge' | 'other'

export function detectBrowser(): Browser {
  const ua = navigator.userAgent
  if (ua.includes('Edg/')) return 'edge'
  if (ua.includes('Firefox/')) return 'firefox'
  if (ua.includes('Chrome/')) return 'chrome'
  return 'other'
}

export const browserMeta: Record<Browser, { label: string; href: string }> = {
  chrome: {
    label: 'Add to Chrome',
    href: 'https://chromewebstore.google.com/detail/otpilot',
  },
  firefox: {
    label: 'Add to Firefox',
    href: 'https://addons.mozilla.org/en-US/firefox/addon/otpilot/',
  },
  edge: {
    label: 'Add to Edge',
    href: 'https://microsoftedge.microsoft.com/addons/detail/otpilot',
  },
  other: {
    label: 'Get the extension',
    href: 'https://chromewebstore.google.com/detail/otpilot',
  },
}
