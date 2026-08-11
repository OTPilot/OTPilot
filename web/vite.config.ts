/// <reference types="vite-react-ssg" />
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

/** Neutral SPA fallback shell for every route besides "/" (dashboard, auth,
 * legal, support — none of that needs to be crawlable, see vercel.json's
 * catch-all rewrite). Reusing the root `index.html` is wrong: it's the fully
 * prerendered Landing page, baked with Landing's own markup *and*
 * `window.__staticRouterHydrationData` for the "/" route — hydrating that on
 * `/dashboard` mismatches the current URL against data for a different route,
 * so the client gets stuck showing the landing page instead of rendering the
 * actual route. This strips the baked root content and hydration data
 * (keeping the correct, content-hashed script/link tags from this build) so
 * the client does a fresh render from `window.location` instead. */
function writeAppShell() {
  const indexPath = resolve(process.cwd(), 'dist/index.html')
  let html = readFileSync(indexPath, 'utf-8')
  html = html.replace(/<title data-rh="true">[\s\S]*?(?=<meta charset)/, '<title>OTPilot</title>')
  html = html.replace(
    /<div id="root"[^>]*>[\s\S]*?<script>window\.__staticRouterHydrationData[\s\S]*?<\/script><\/div>/,
    '<div id="root"></div>',
  )
  writeFileSync(resolve(process.cwd(), 'dist/app-shell.html'), html)
}

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: { port: 5175 },
  ssgOptions: {
    // Clean URLs: "/" only, output stays dist/index.html regardless.
    dirStyle: 'nested',
    // Prerender the landing page only — dashboard/auth/legal stay a
    // client-only SPA, served through the app-shell fallback below.
    includedRoutes: () => ['/'],
    onFinished: () => {
      writeAppShell()
    },
  },
})
