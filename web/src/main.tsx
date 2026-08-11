import { ViteReactSSG } from 'vite-react-ssg'
import type { RouteRecord } from 'vite-react-ssg'
import * as Sentry from '@sentry/react'
import Root from './Root'
import Landing from './pages/Landing'
import Callback from './pages/auth/Callback'
import Login from './pages/auth/Login'
import DashboardLayout from './pages/dashboard/Layout'
import Overview from './pages/dashboard/Overview'
import Billing from './pages/dashboard/Billing'
import Team from './pages/dashboard/Team'
import Settings from './pages/dashboard/Settings'
import Devices from './pages/dashboard/Devices'
import Tos from './pages/legal/Tos'
import Privacy from './pages/legal/Privacy'
import Refunds from './pages/legal/Refunds'
import Gdpr from './pages/legal/Gdpr'
import Support from './pages/Support'
import AcceptInvite from './pages/AcceptInvite'
import Security from './pages/legal/Security'
import './index.css'

export const routes: RouteRecord[] = [
  {
    path: '/',
    element: <Root />,
    children: [
      { index: true, element: <Landing /> },
      { path: 'auth/callback', element: <Callback /> },
      { path: 'auth/login', element: <Login /> },
      {
        path: 'dashboard',
        element: <DashboardLayout />,
        children: [
          { index: true, element: <Overview /> },
          { path: 'billing', element: <Billing /> },
          { path: 'team', element: <Team /> },
          { path: 'devices', element: <Devices /> },
          { path: 'settings', element: <Settings /> },
        ],
      },
      { path: 'teams/accept/:token', element: <AcceptInvite /> },
      { path: 'security', element: <Security /> },
      { path: 'support', element: <Support /> },
      { path: 'tos', element: <Tos /> },
      { path: 'privacy', element: <Privacy /> },
      { path: 'refunds', element: <Refunds /> },
      { path: 'gdpr', element: <Gdpr /> },
    ],
  },
]

export const createRoot = ViteReactSSG({ routes }, ({ isClient }) => {
  // Browser-only side effects (skipped during static build render).
  if (!isClient) return
  if (import.meta.env.VITE_SENTRY_DSN) {
    Sentry.init({
      dsn: import.meta.env.VITE_SENTRY_DSN,
      environment: import.meta.env.MODE,
      tracesSampleRate: 1.0,
    })
  }
})
