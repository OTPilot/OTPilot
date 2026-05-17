import { BrowserRouter, Routes, Route } from 'react-router-dom'
import { Analytics } from '@vercel/analytics/react'
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

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Landing />} />
        <Route path="/auth/callback" element={<Callback />} />
        <Route path="/auth/login" element={<Login />} />

        <Route path="/dashboard" element={<DashboardLayout />}>
          <Route index element={<Overview />} />
          <Route path="billing" element={<Billing />} />
          <Route path="team" element={<Team />} />
          <Route path="devices" element={<Devices />} />
          <Route path="settings" element={<Settings />} />
        </Route>

        <Route path="/tos" element={<Tos />} />
        <Route path="/privacy" element={<Privacy />} />
        <Route path="/refunds" element={<Refunds />} />
        <Route path="/gdpr" element={<Gdpr />} />
      </Routes>
      <Analytics />
    </BrowserRouter>
  )
}
