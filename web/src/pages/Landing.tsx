import { useCrisp } from '../lib/useCrisp'
import { Seo } from '../seo'
import Navbar from '../components/Navbar'
import Hero from '../components/Hero'
import Showcase from '../components/Showcase'
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
        title="OTPilot — Password manager with built-in 2FA"
        description="Password manager with built-in 2FA for Chrome. Fills your password and your 2FA code on any login page. End-to-end encrypted, synced across devices, free to start."
        path="/"
      />
      <Navbar />
      <Hero />
      <Showcase />
      <Features />
      <HowItWorks />
      <Pricing />
      <FAQ />
      <Footer />
    </div>
  )
}
