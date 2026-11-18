import { LoaderCircle, ShieldCheck } from 'lucide-react'

type AuthScreenProps = {
  busy: boolean
  error: string
  onGoogleSignIn: () => void
}

function GoogleMark() {
  return <svg aria-hidden="true" viewBox="0 0 48 48" width="20" height="20">
    <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5Z"/>
    <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.76 7.18l7.73 6C44.42 37.8 46.98 31.7 46.98 24.55Z"/>
    <path fill="#FBBC05" d="M10.53 28.59A14.4 14.4 0 0 1 9.75 24c0-1.6.28-3.15.78-4.59l-7.98-6.19A23.9 23.9 0 0 0 0 24c0 3.87.93 7.53 2.56 10.78l7.97-6.19Z"/>
    <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.9-5.8l-7.73-6c-2.15 1.45-4.91 2.3-8.17 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48Z"/>
  </svg>
}

export default function AuthScreen({ busy, error, onGoogleSignIn }: AuthScreenProps) {
  return <main className="auth-screen">
    <section className="auth-card" aria-labelledby="auth-title">
      <div className="auth-brand"><span className="brand-symbol">r.</span><span>resell<span>manager</span></span></div>
      <div className="auth-eyebrow">DEIN BUSINESS. ÜBERALL.</div>
      <h1 id="auth-title">Willkommen zurück.</h1>
      <p className="auth-description">Melde dich an, um deine Produkte, Verkäufe und Belege sicher auf all deinen Geräten zu synchronisieren.</p>
      <button className="auth-google-button" type="button" onClick={onGoogleSignIn} disabled={busy}>
        {busy ? <LoaderCircle size={19} className="spin"/> : <GoogleMark/>}
        <span>{busy ? 'Google wird geöffnet …' : 'Mit Google anmelden'}</span>
      </button>
      {error && <p className="auth-error" role="alert">{error}</p>}
      <div className="auth-security"><ShieldCheck size={16}/><span>Sichere Anmeldung über Google. Dein Passwort wird nicht mit dem Reselling-Manager geteilt.</span></div>
      <p className="auth-footer">Mit der Anmeldung werden deine Daten deinem persönlichen Konto zugeordnet.</p>
    </section>
  </main>
}
