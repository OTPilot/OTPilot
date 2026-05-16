# OTPilot Web

Landing page + dashboard. Built with React 18, Vite, TanStack Query, and Tailwind CSS.

## Routes

| Path | Description |
|------|-------------|
| `/` | Landing page |
| `/auth/callback` | Supabase OAuth callback |
| `/dashboard` | Overview (plan, last sync) |
| `/dashboard/billing` | Plan + Stripe upgrade |
| `/dashboard/team` | Team management (Fase 3) |
| `/dashboard/settings` | Account settings |
| `/tos` · `/privacy` · `/refunds` · `/gdpr` | Legal pages |

## Running locally

```bash
npm install
npm run dev       # http://localhost:5173 (or next available port)
```

## Environment variables

Create `web/.env.local`:

```
VITE_SUPABASE_URL=https://<project>.supabase.co
VITE_SUPABASE_ANON_KEY=sb_publishable_...
VITE_API_URL=http://localhost:8080
```

## Build

```bash
npm run build      # type-check + vite build → dist/
npm run preview    # preview the production build locally
```

## Deploy

Connected to Vercel via GitHub integration. Every push to `main` triggers a deploy automatically.
