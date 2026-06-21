import { useState, type ReactNode } from 'react'
import type { AuthApi } from '../../lib/supabase/useAuth'
import './AuthGate.css'

interface Props {
  auth: AuthApi
  children: ReactNode
}

export default function AuthGate({ auth, children }: Props) {
  const [mode, setMode] = useState<'in' | 'up'>('in')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirmMsg, setConfirmMsg] = useState<string | null>(null)

  // local mode (no Supabase) or already signed in → show the app
  if (auth.localMode || auth.user) return <>{children}</>
  if (!auth.ready) {
    return <div className="authgate authgate--loading"><span className="caption">loading…</span></div>
  }

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (busy) return
    setError(null); setConfirmMsg(null)
    if (!email.trim() || password.length < 6) { setError('Enter an email and a password (6+ characters).'); return }
    setBusy(true)
    const res = mode === 'in' ? await auth.signIn(email, password) : await auth.signUp(email, password)
    setBusy(false)
    if (res.error) { setError(res.error); return }
    if (mode === 'up' && 'needsConfirm' in res && res.needsConfirm) {
      setConfirmMsg('Check your email to confirm your account, then sign in.')
      setMode('in')
    }
    // on success, onAuthStateChange swaps in the app
  }

  return (
    <div className="authgate">
      <div className="authcard">
        <div className="authcard__brand">
          <span className="authcard__logo" aria-hidden>
            <svg viewBox="0 0 100 100" width="40" height="40">
              <rect x="4" y="4" width="92" height="92" rx="24" fill="var(--color-ink)" />
              <path d="M24 68 L44 34 L57 60 L76 30" fill="none" stroke="var(--color-accent)"
                strokeWidth="10" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </span>
          <span className="authcard__word">Chalk<span className="authcard__word-ai">AI</span></span>
        </div>

        <h1 className="authcard__title">{mode === 'in' ? 'Welcome back' : 'Create your account'}</h1>
        <p className="authcard__sub">{mode === 'in' ? 'Sign in to your board, recordings, and lessons.' : 'Your boards and recordings, saved to your account.'}</p>

        <form className="authcard__form" onSubmit={submit}>
          <label className="authfield">
            <span className="authfield__label">Email</span>
            <input className="authfield__input" type="email" autoComplete="email" value={email}
              onChange={(e) => setEmail(e.target.value)} placeholder="you@school.edu" />
          </label>
          <label className="authfield">
            <span className="authfield__label">Password</span>
            <input className="authfield__input" type="password"
              autoComplete={mode === 'in' ? 'current-password' : 'new-password'} value={password}
              onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" />
          </label>

          {error && <p className="authcard__error">{error}</p>}
          {confirmMsg && <p className="authcard__ok">{confirmMsg}</p>}

          <button className="btn btn--accent authcard__submit" type="submit" disabled={busy}>
            {busy ? '…' : mode === 'in' ? 'Sign in →' : 'Create account →'}
          </button>
        </form>

        <p className="authcard__switch">
          {mode === 'in' ? "No account yet?" : 'Already have an account?'}{' '}
          <button className="authcard__link" onClick={() => { setMode(mode === 'in' ? 'up' : 'in'); setError(null); setConfirmMsg(null) }}>
            {mode === 'in' ? 'Create one' : 'Sign in'}
          </button>
        </p>
      </div>
    </div>
  )
}
