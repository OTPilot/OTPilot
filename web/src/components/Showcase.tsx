// The extension at work: real screenshots (generated with the store images,
// extension/store/screenshots.spec.js), so visitors see the product before
// they install it.
const shots = [
  { src: '/screens/1-fill-login.webp', alt: 'OTPilot offering the saved logins in the email field of a sign-in page' },
  { src: '/screens/2-fill-2fa.webp', alt: 'A two-factor authentication page with the code already filled in by OTPilot' },
  { src: '/screens/3-account.webp', alt: 'The OTPilot popup showing an account: its live 2FA code, sign-in details and extra fields' },
  { src: '/screens/4-save-login.webp', alt: 'OTPilot offering to save a new login after signing in' },
]

export default function Showcase() {
  return (
    <section id="see-it" className="py-16 px-6">
      <div className="max-w-6xl mx-auto">
        <h2 className="text-3xl md:text-4xl font-bold text-white mb-4 tracking-tight text-center">
          See it in action
        </h2>
        <p className="text-zinc-400 max-w-xl mx-auto text-center mb-12">
          Your password, then your 2FA code, filled on the page. Everything else about the account one click away.
        </p>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {shots.map((s) => (
            <img
              key={s.src}
              src={s.src}
              alt={s.alt}
              width={1280}
              height={800}
              loading="lazy"
              decoding="async"
              className="w-full h-auto rounded-2xl border border-white/10 shadow-2xl shadow-black/40"
            />
          ))}
        </div>
      </div>
    </section>
  )
}
