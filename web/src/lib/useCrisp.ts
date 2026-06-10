import { useEffect } from 'react'

const CRISP_WEBSITE_ID = '9a65ace4-ef4c-4c6a-971a-4bafb3a80fb0'

declare global {
  interface Window {
    $crisp: unknown[]
    CRISP_WEBSITE_ID: string
  }
}

interface UseCrispOptions {
  email?: string | null
  name?: string | null
  open?: boolean
}

export function useCrisp({ email, name, open }: UseCrispOptions = {}) {
  useEffect(() => {
    if (!window.$crisp) {
      window.$crisp = []
      window.CRISP_WEBSITE_ID = CRISP_WEBSITE_ID
      const script = document.createElement('script')
      script.src = 'https://client.crisp.chat/l.js'
      script.async = true
      document.head.appendChild(script)
    }

    if (email) window.$crisp.push(['set', 'user:email', [email]])
    if (name)  window.$crisp.push(['set', 'user:nickname', [name]])
    if (open)  window.$crisp.push(['do', 'chat:open'])

    return () => {
      if (open) window.$crisp.push(['do', 'chat:close'])
    }
  }, [email, name, open])
}
