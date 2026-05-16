import { Link } from 'react-router-dom'

const rights = [
  {
    title: 'Right of access (Art. 15)',
    description: 'You can request a copy of all personal data we hold about you. Email us at privacy@otpilot.app and we\'ll respond within 30 days.',
  },
  {
    title: 'Right to erasure (Art. 17)',
    description: 'You can delete your account at any time from the dashboard settings. All personal data is permanently purged within 30 days. Your local extension data is unaffected.',
  },
  {
    title: 'Right to data portability (Art. 20)',
    description: 'Your TOTP accounts can be exported as an encrypted backup file from the extension at any time. This file is yours and works independently of our service.',
  },
  {
    title: 'Right to rectification (Art. 16)',
    description: 'You can update your email address from the dashboard settings at any time.',
  },
  {
    title: 'Right to restrict processing (Art. 18)',
    description: 'You can request that we stop processing your data while keeping your account. Contact privacy@otpilot.app.',
  },
  {
    title: 'Right to object (Art. 21)',
    description: 'You can object to processing based on legitimate interests. We do not use your data for marketing without explicit consent.',
  },
]

const processors = [
  {
    name: 'Supabase',
    purpose: 'Authentication (magic links, OAuth)',
    location: 'USA / EU (configurable)',
    gdpr: 'DPA available · SCCs in place',
    link: 'https://supabase.com/privacy',
  },
  {
    name: 'Railway',
    purpose: 'API hosting & PostgreSQL database',
    location: 'USA',
    gdpr: 'DPA available · SCCs in place',
    link: 'https://railway.app/legal/privacy',
  },
  {
    name: 'Stripe',
    purpose: 'Payment processing',
    location: 'USA / EU',
    gdpr: 'PCI DSS compliant · DPA available',
    link: 'https://stripe.com/privacy',
  },
]

export default function Gdpr() {
  return (
    <div className="min-h-screen bg-[#0a0a0f] px-6 py-16">
      <div className="max-w-2xl mx-auto">
        <Link to="/" className="text-sm text-zinc-500 hover:text-zinc-300 transition-colors mb-8 inline-block">
          ← Back to home
        </Link>
        <h1 className="text-3xl font-bold text-white mb-2">GDPR Compliance</h1>
        <p className="text-zinc-500 text-sm mb-2">Last updated: May 2026</p>
        <p className="text-zinc-400 text-sm mb-10">
          This document describes how OTPilot complies with the EU General Data Protection Regulation (GDPR).
          For a general overview of what data we collect and why, see our{' '}
          <Link to="/privacy" className="text-teal-400 hover:text-teal-300 underline">Privacy Policy</Link>.
        </p>

        <div className="space-y-10 text-sm text-zinc-400 leading-relaxed">

          <section>
            <h2 className="text-white font-semibold text-lg mb-3">Data controller</h2>
            <p>
              The data controller for OTPilot is Alberto Paparelli, operating under the OTPilot project.
              For any GDPR-related requests, contact:{' '}
              <a href="mailto:privacy@otpilot.app" className="text-teal-400 hover:text-teal-300 underline">
                privacy@otpilot.app
              </a>
            </p>
          </section>

          <section>
            <h2 className="text-white font-semibold text-lg mb-3">Legal bases for processing</h2>
            <div className="space-y-3">
              <div className="p-4 rounded-xl bg-white/[0.03] border border-white/8">
                <p className="text-zinc-300 font-medium mb-1">Contract performance (Art. 6(1)(b))</p>
                <p>Processing your email address and encrypted sync data is necessary to provide the cloud sync service you signed up for.</p>
              </div>
              <div className="p-4 rounded-xl bg-white/[0.03] border border-white/8">
                <p className="text-zinc-300 font-medium mb-1">Legitimate interests (Art. 6(1)(f))</p>
                <p>Processing IP addresses for rate limiting and security is necessary to protect the service and its users from abuse.</p>
              </div>
              <div className="p-4 rounded-xl bg-white/[0.03] border border-white/8">
                <p className="text-zinc-300 font-medium mb-1">Legal obligation (Art. 6(1)(c))</p>
                <p>Stripe billing records are retained as required by applicable financial regulations.</p>
              </div>
            </div>
          </section>

          <section>
            <h2 className="text-white font-semibold text-lg mb-4">Your rights under GDPR</h2>
            <div className="space-y-3">
              {rights.map((right) => (
                <div key={right.title} className="p-4 rounded-xl bg-white/[0.03] border border-white/8">
                  <p className="text-zinc-300 font-medium mb-1">{right.title}</p>
                  <p>{right.description}</p>
                </div>
              ))}
            </div>
            <p className="mt-4 text-xs text-zinc-500">
              We respond to all rights requests within 30 days. If you are not satisfied with our response,
              you have the right to lodge a complaint with your local supervisory authority.
            </p>
          </section>

          <section>
            <h2 className="text-white font-semibold text-lg mb-3">Data retention</h2>
            <div className="overflow-x-auto">
              <table className="w-full text-sm border-collapse">
                <thead>
                  <tr className="border-b border-white/10">
                    <th className="text-left py-2 pr-4 text-zinc-300 font-medium">Data</th>
                    <th className="text-left py-2 text-zinc-300 font-medium">Retention period</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/5">
                  <tr>
                    <td className="py-2.5 pr-4">Account data (email, plan)</td>
                    <td className="py-2.5">Until account deletion + 30 days</td>
                  </tr>
                  <tr>
                    <td className="py-2.5 pr-4">Encrypted accounts blob</td>
                    <td className="py-2.5">Until account deletion + 30 days</td>
                  </tr>
                  <tr>
                    <td className="py-2.5 pr-4">IP address logs</td>
                    <td className="py-2.5">Up to 7 days (server logs rotation)</td>
                  </tr>
                  <tr>
                    <td className="py-2.5 pr-4">Stripe billing records</td>
                    <td className="py-2.5">As required by law (typically 7 years)</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </section>

          <section>
            <h2 className="text-white font-semibold text-lg mb-4">Sub-processors</h2>
            <p className="mb-4">We use the following third-party processors. Each has a Data Processing Agreement (DPA) in place.</p>
            <div className="space-y-3">
              {processors.map((p) => (
                <div key={p.name} className="p-4 rounded-xl bg-white/[0.03] border border-white/8">
                  <div className="flex items-start justify-between gap-4 mb-1">
                    <p className="text-zinc-300 font-medium">{p.name}</p>
                    <a
                      href={p.link}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-xs text-teal-400 hover:text-teal-300 shrink-0"
                    >
                      Privacy policy →
                    </a>
                  </div>
                  <p className="text-xs text-zinc-500 mb-0.5">{p.purpose}</p>
                  <p className="text-xs text-zinc-600">{p.location} · {p.gdpr}</p>
                </div>
              ))}
            </div>
          </section>

          <section>
            <h2 className="text-white font-semibold text-lg mb-3">International data transfers</h2>
            <p>
              Some of our sub-processors are based in the United States. Data transfers to the US are covered by
              Standard Contractual Clauses (SCCs) as defined by the European Commission. Supabase offers EU-region
              hosting which keeps authentication data within the EU upon request.
            </p>
          </section>

          <section>
            <h2 className="text-white font-semibold text-lg mb-3">Security measures</h2>
            <ul className="space-y-1.5">
              {[
                'TOTP secrets are end-to-end encrypted — we cannot access them even if compelled',
                'All data in transit is protected by TLS 1.2+',
                'Database access is restricted to the API service with least-privilege credentials',
                'Authentication tokens are short-lived JWTs signed by Supabase',
                'Rate limiting is enforced on all API endpoints',
              ].map((item) => (
                <li key={item} className="flex items-start gap-2">
                  <svg className="w-4 h-4 text-teal-400 mt-0.5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
                  </svg>
                  {item}
                </li>
              ))}
            </ul>
          </section>

          <section>
            <h2 className="text-white font-semibold text-lg mb-3">Contact & complaints</h2>
            <p className="mb-3">
              For any GDPR-related request, contact:{' '}
              <a href="mailto:privacy@otpilot.app" className="text-teal-400 hover:text-teal-300 underline">
                privacy@otpilot.app
              </a>
            </p>
            <p>
              If you are located in the EU/EEA and believe we have not handled your data lawfully, you have
              the right to lodge a complaint with your national data protection authority (e.g. AEPD in Spain,
              CNIL in France, ICO in the UK).
            </p>
          </section>

        </div>
      </div>
    </div>
  )
}
