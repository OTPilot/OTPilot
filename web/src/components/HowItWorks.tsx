const steps = [
  {
    number: '01',
    title: 'Install the extension',
    description: 'Add OTPilot to Chrome in one click. No account, no setup — works immediately.',
  },
  {
    number: '02',
    title: 'Add your 2FA accounts',
    description: 'OTPilot detects QR codes on setup pages and saves them automatically, or add secrets manually.',
  },
  {
    number: '03',
    title: 'Log in anywhere, faster',
    description: 'When a 2FA field appears, OTPilot fills it instantly. No switching apps, no copy-pasting.',
  },
]

export default function HowItWorks() {
  return (
    <section className="py-24 px-6 border-t border-white/5">
      <div className="max-w-6xl mx-auto">
        <div className="text-center mb-16">
          <h2 className="text-3xl md:text-4xl font-bold text-white mb-4 tracking-tight">
            Up and running in 60 seconds
          </h2>
          <p className="text-zinc-400 max-w-lg mx-auto">
            No complex setup. No sync accounts to create. Just install and go.
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-8 relative">
          {/* Connecting line */}
          <div className="hidden md:block absolute top-8 left-[calc(16.67%+1rem)] right-[calc(16.67%+1rem)] h-px bg-gradient-to-r from-transparent via-teal-500/30 to-transparent" />

          {steps.map((step) => (
            <div key={step.number} className="flex flex-col items-center text-center">
              <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-teal-500/20 to-emerald-500/10 border border-teal-500/20 flex items-center justify-center mb-6 relative z-10">
                <span className="text-xl font-bold bg-gradient-to-r from-teal-400 to-emerald-400 bg-clip-text text-transparent">
                  {step.number}
                </span>
              </div>
              <h3 className="text-white font-semibold mb-2">{step.title}</h3>
              <p className="text-zinc-400 text-sm leading-relaxed max-w-xs">{step.description}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}
