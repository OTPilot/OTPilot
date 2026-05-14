import { BrowserRouter, Routes, Route } from 'react-router-dom'
import Landing from './pages/Landing'
import Tos from './pages/legal/Tos'
import Privacy from './pages/legal/Privacy'
import Refunds from './pages/legal/Refunds'
import Gdpr from './pages/legal/Gdpr'

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Landing />} />
        <Route path="/tos" element={<Tos />} />
        <Route path="/privacy" element={<Privacy />} />
        <Route path="/refunds" element={<Refunds />} />
        <Route path="/gdpr" element={<Gdpr />} />
      </Routes>
    </BrowserRouter>
  )
}
