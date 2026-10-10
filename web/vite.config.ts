/// <reference types="vite-react-ssg" />
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { GUIDES } from './src/pages/guides/guides'

/** The public pages: prerendered for search engines and listed in the
 * sitemap, from this one list. */
const PUBLIC_PAGES: { path: string; priority: number }[] = [
  { path: '/', priority: 1.0 },
  ...GUIDES.map(g => ({ path: g.path, priority: g.kind === 'compare' ? 0.8 : 0.6 })),
  { path: '/security', priority: 0.7 },
  ...['/privacy', '/tos', '/gdpr', '/refunds'].map(path => ({ path, priority: 0.3 })),
]

function writeSitemap() {
  const lastmod = new Date().toISOString().slice(0, 10)
  const urls = PUBLIC_PAGES.map(p => `  <url>
    <loc>https://otpilot.app${p.path}</loc>
    <lastmod>${lastmod}</lastmod>
    <priority>${p.priority.toFixed(1)}</priority>
  </url>`).join('\n')
  writeFileSync(resolve(process.cwd(), 'dist/sitemap.xml'),
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`)
}

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
    // Prerender the public pages (indexed by search engines); dashboard,
    // auth and support stay a client-only SPA, served through the
    // app-shell fallback below. Keep in sync with public/sitemap.xml.
    includedRoutes: () => PUBLIC_PAGES.map(p => p.path),
    onFinished: () => {
      writeAppShell()
      writeSitemap()
    },
  },
})
