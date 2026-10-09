import { Seo } from '../../seo'
import { Link } from 'react-router-dom'

export default function Security() {
  return (
    <div className="min-h-screen bg-[#0a0a0f] px-6 py-16">
      <Seo
        title="Security: how OTPilot protects your passwords and 2FA"
        description="End-to-end encryption in plain language: what OTPilot stores, what it never sees, and how your vault, sync and team sharing are protected."
        path="/security"
      />
      <div className="max-w-2xl mx-auto">
        <Link to="/" className="text-sm text-zinc-500 hover:text-zinc-300 transition-colors mb-8 inline-block">
          ← Back to home
        </Link>
        <h1 className="text-3xl font-bold text-white mb-2">Security</h1>
        <p className="text-zinc-500 text-sm mb-10">How OTPilot protects your data — in plain language.</p>

        <div className="space-y-8 text-zinc-400 leading-relaxed text-sm">
          <section>
            <h2 className="text-white font-semibold text-lg mb-3">What we store vs. what we never see</h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="rounded-lg border border-white/8 p-4">
                <p className="text-zinc-300 font-medium mb-2">We store</p>
                <ul className="space-y-1">
                  <li>Your email (via Supabase)</li>
                  <li>Your plan</li>
                  <li>Device metadata & last sync</li>
                  <li>Encrypted vault items it cannot read</li>
                  <li>Team collections: membership & roles</li>
                </ul>
              </div>
              <div className="rounded-lg border border-white/8 p-4">
                <p className="text-zinc-300 font-medium mb-2">We never see</p>
                <ul className="space-y-1">
                  <li>Your passwords, notes & 2FA secrets</li>
                  <li>What's inside a team collection</li>
                  <li>Your recovery key</li>
                  <li>The codes you share</li>
                  <li>Your master password</li>
                </ul>
              </div>
            </div>
          </section>

          <section>
            <h2 className="text-white font-semibold text-lg mb-3">Personal sync — zero-knowledge</h2>
            <p>Every item in your vault is encrypted on your device with AES-256-GCM, each with its own key, before it leaves it. Those keys are protected by your vault key (your recovery key) — generated locally, it never leaves your devices, and on each device it is itself locked by your master password. The server only ever holds ciphertext it cannot read. If our database were stolen, your data would be unreadable.</p>
          </section>

          <section>
            <h2 className="text-white font-semibold text-lg mb-3">Team collections — end-to-end encrypted</h2>
            <p>A collection's items are encrypted with a collection key that only its members hold: each member receives it wrapped to their own device key, and the server stores only those wrapped copies, the encrypted items and the encrypted name. Removing someone stops their access to future changes; anything they could already see may have been copied, so OTPilot suggests changing those passwords.</p>
          </section>

          <section>
            <h2 className="text-white font-semibold text-lg mb-3">Shared codes — 2-of-2 key split</h2>
            <p>When you share just a 2FA code (not a collection) with a teammate, it's protected by a two-halves system: one half lives in your teammate's extension, the other on our server. <strong className="text-zinc-300">Neither half can decrypt the secret alone</strong> — both are needed, momentarily, only to generate the live 6-digit code. Revoking a teammate deletes the server's half, making their half useless instantly.</p>
          </section>

          <section>
            <h2 className="text-white font-semibold text-lg mb-3">Authentication & payments</h2>
            <p>No passwords to leak — we use magic links and Google sign-in via Supabase. Payments are handled by Stripe; we never receive card data, only a customer ID to identify your plan. All traffic is HTTPS/TLS, and the extension only talks to <code className="bg-white/5 px-1.5 py-0.5 rounded text-zinc-300">api.otpilot.app</code>.</p>
          </section>

          <section>
            <p className="text-zinc-500">See also our <Link to="/privacy" className="text-teal-400 hover:text-teal-300 underline">Privacy Policy</Link>.</p>
          </section>
        </div>
      </div>
    </div>
  )
}
