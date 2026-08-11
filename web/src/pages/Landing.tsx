import { useCrisp } from '../lib/useCrisp'
import { Seo } from '../seo'
import Navbar from '../components/Navbar'
import Hero from '../components/Hero'
import Features from '../components/Features'
import HowItWorks from '../components/HowItWorks'
import Pricing from '../components/Pricing'
import FAQ from '../components/FAQ'
import Footer from '../components/Footer'

export default function Landing() {
  useCrisp()
  return (
    <div className="min-h-screen bg-[#0a0a0f]">
      <Seo
        title="OTPilot — Auto-fill 2FA codes on any login page"
        description="Chrome extension that auto-fills TOTP 2FA codes on any login page. One-click setup, zero-click login. End-to-end encrypted sync across devices. Free."
        path="/"
      />
      <Navbar />
      <Hero />
      <Features />
      <HowItWorks />
      <Pricing />
      <FAQ />
      <Footer />
    </div>
  )
}
