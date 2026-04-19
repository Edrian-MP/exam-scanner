import { useState } from 'react'

function LoginPage({ apiBase, onLogin, onSignUp, busy, error }) {
  const [mode, setMode] = useState('login')
  const [fullName, setFullName] = useState('')
  const [email, setEmail] = useState('educator@example.com')
  const [password, setPassword] = useState('password123')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [localError, setLocalError] = useState('')

  function handleSubmit(event) {
    event.preventDefault()
    setLocalError('')
    if (mode === 'signup') {
      if (fullName.trim() === '') {
        setLocalError('Full name is required.')
        return
      }
      if (password.length < 8) {
        setLocalError('Password must be at least 8 characters.')
        return
      }
      if (password !== confirmPassword) {
        setLocalError('Password confirmation does not match.')
        return
      }
      onSignUp({ surname: fullName.trim(), email: email.trim().toLowerCase(), password })
      return
    }
    onLogin({ email: email.trim().toLowerCase(), password })
  }

  return (
    <main className="relative flex min-h-screen items-center justify-center overflow-hidden px-4 py-10 sm:px-6">
      <div className="pointer-events-none absolute -left-28 -top-20 h-72 w-72 rounded-full bg-cyan-300/30 blur-3xl" />
      <div className="pointer-events-none absolute -right-24 bottom-0 h-80 w-80 rounded-full bg-sky-300/30 blur-3xl" />

      <section className="w-full max-w-md overflow-hidden rounded-3xl border border-slate-200/80 bg-white/90 shadow-2xl backdrop-blur">
        <div className="h-1 bg-gradient-to-r from-sky-400 via-cyan-500 to-blue-500" />

        <div className="space-y-6 p-6 sm:p-8">
          <header className="space-y-2">
            <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-sky-600">Exam Scanner</p>
            <h1 className="font-['Space_Grotesk'] text-2xl font-bold text-slate-900">
              {mode === 'signup' ? 'Create Educator Account' : 'Educator Login'}
            </h1>
            <p className="text-sm text-slate-500">
              {mode === 'signup'
                ? 'Create your account to access the LMS dashboard and scanning tools.'
                : 'Sign in to access your LMS dashboard and scanning tools.'}
            </p>
          </header>

          <div className="grid grid-cols-2 rounded-xl border border-slate-200 bg-slate-50 p-1">
            <button
              type="button"
              onClick={() => { setMode('login'); setLocalError('') }}
              className={`rounded-lg px-3 py-2 text-xs font-semibold transition ${mode === 'login' ? 'bg-white text-slate-800 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}
            >
              Sign in
            </button>
            <button
              type="button"
              onClick={() => { setMode('signup'); setLocalError('') }}
              className={`rounded-lg px-3 py-2 text-xs font-semibold transition ${mode === 'signup' ? 'bg-white text-slate-800 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}
            >
              Sign up
            </button>
          </div>

          <form onSubmit={handleSubmit} className="space-y-4">
            {mode === 'signup' && (
              <label className="block space-y-1.5">
                <span className="text-[11px] font-bold uppercase tracking-widest text-slate-400">Full Name</span>
                <input
                  type="text"
                  required
                  autoComplete="name"
                  value={fullName}
                  onChange={(e) => setFullName(e.target.value)}
                  className="w-full rounded-xl border border-slate-200 bg-white px-3.5 py-2.5 text-sm text-slate-800 outline-none transition focus:border-sky-400 focus:ring-2 focus:ring-sky-100"
                  placeholder="Jane Doe"
                />
              </label>
            )}

            <label className="block space-y-1.5">
              <span className="text-[11px] font-bold uppercase tracking-widest text-slate-400">Email</span>
              <input
                type="email"
                required
                autoComplete="username"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="w-full rounded-xl border border-slate-200 bg-white px-3.5 py-2.5 text-sm text-slate-800 outline-none transition focus:border-sky-400 focus:ring-2 focus:ring-sky-100"
                placeholder="educator@example.com"
              />
            </label>

            <label className="block space-y-1.5">
              <span className="text-[11px] font-bold uppercase tracking-widest text-slate-400">Password</span>
              <input
                type="password"
                required
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full rounded-xl border border-slate-200 bg-white px-3.5 py-2.5 text-sm text-slate-800 outline-none transition focus:border-sky-400 focus:ring-2 focus:ring-sky-100"
                placeholder="********"
              />
            </label>

            {mode === 'signup' && (
              <label className="block space-y-1.5">
                <span className="text-[11px] font-bold uppercase tracking-widest text-slate-400">Confirm Password</span>
                <input
                  type="password"
                  required
                  autoComplete="new-password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  className="w-full rounded-xl border border-slate-200 bg-white px-3.5 py-2.5 text-sm text-slate-800 outline-none transition focus:border-sky-400 focus:ring-2 focus:ring-sky-100"
                  placeholder="********"
                />
              </label>
            )}

            {(localError || error) && (
              <p className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
                {localError || error}
              </p>
            )}

            <button
              type="submit"
              disabled={busy}
              className="inline-flex w-full items-center justify-center rounded-xl bg-sky-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-sky-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {busy ? (mode === 'signup' ? 'Creating account...' : 'Signing in...') : (mode === 'signup' ? 'Create account' : 'Sign in')}
            </button>
          </form>

          {/* <footer className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-[11px] text-slate-500">
            API: <span className="font-mono text-slate-700">{apiBase}</span>
          </footer> */}
        </div>
      </section>
    </main>
  )
}

export default LoginPage
