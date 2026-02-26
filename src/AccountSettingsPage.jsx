import { useEffect, useState } from 'react'

function AccountSettingsPage({ educator, busy, error, onSave, onCancel }) {
  const [fullName, setFullName] = useState(educator?.full_name || '')
  const [email, setEmail] = useState(educator?.email || '')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [photoData, setPhotoData] = useState(educator?.profile_photo_data || null)
  const [localError, setLocalError] = useState('')

  useEffect(() => {
    setFullName(educator?.full_name || '')
    setEmail(educator?.email || '')
    setPhotoData(educator?.profile_photo_data || null)
  }, [educator])

  function handlePhotoUpload(event) {
    const file = event.target.files?.[0]
    if (!file) return
    if (!file.type.startsWith('image/')) {
      setLocalError('Please upload an image file.')
      return
    }
    if (file.size > 2 * 1024 * 1024) {
      setLocalError('Image must be 2MB or smaller.')
      return
    }

    const reader = new FileReader()
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : ''
      if (!result.startsWith('data:image/')) {
        setLocalError('Unsupported image format.')
        return
      }
      setPhotoData(result)
      setLocalError('')
    }
    reader.onerror = () => setLocalError('Failed to read image file.')
    reader.readAsDataURL(file)
  }

  function handleSubmit(event) {
    event.preventDefault()
    setLocalError('')

    if (fullName.trim() === '' || email.trim() === '') {
      setLocalError('Full name and email are required.')
      return
    }
    if (password !== '' && password.length < 8) {
      setLocalError('Password must be at least 8 characters.')
      return
    }
    if (password !== confirmPassword) {
      setLocalError('Password confirmation does not match.')
      return
    }

    onSave({
      full_name: fullName.trim(),
      email: email.trim().toLowerCase(),
      password,
      profile_photo_data: photoData,
    })
  }

  const initials = (fullName || '?')
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() || '')
    .join('') || '?'

  return (
    <main className="mx-auto max-w-4xl px-4 py-6 sm:px-6 lg:px-8">
      <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-panel">
        <div className="h-1 bg-gradient-to-r from-cyan-400 via-sky-500 to-blue-500" />
        <div className="border-b border-slate-100 px-6 py-4">
          <h1 className="font-['Space_Grotesk'] text-xl font-bold text-slate-900">Account Settings</h1>
          <p className="mt-1 text-sm text-slate-500">Update your educator details and profile picture.</p>
        </div>

        <form onSubmit={handleSubmit} className="grid gap-6 p-6 lg:grid-cols-[220px_1fr]">
          <div className="space-y-3">
            <div className="flex justify-center">
              {photoData ? (
                <img
                  src={photoData}
                  alt="Profile preview"
                  className="h-36 w-36 rounded-2xl border border-slate-200 object-cover shadow-sm"
                />
              ) : (
                <div className="flex h-36 w-36 items-center justify-center rounded-2xl border border-slate-200 bg-slate-100 text-3xl font-bold text-slate-500">
                  {initials}
                </div>
              )}
            </div>

            <label className="block">
              <span className="mb-1 block text-[11px] font-bold uppercase tracking-widest text-slate-400">Profile picture</span>
              <input
                type="file"
                accept="image/*"
                onChange={handlePhotoUpload}
                className="block w-full text-xs text-slate-500 file:mr-3 file:rounded-lg file:border-0 file:bg-sky-50 file:px-3 file:py-2 file:text-xs file:font-semibold file:text-sky-700 hover:file:bg-sky-100"
              />
            </label>

            <button
              type="button"
              onClick={() => setPhotoData(null)}
              className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-600 transition hover:bg-slate-50"
            >
              Remove Picture
            </button>
          </div>

          <div className="space-y-4">
            <label className="block space-y-1.5">
              <span className="text-[11px] font-bold uppercase tracking-widest text-slate-400">Full Name</span>
              <input
                type="text"
                required
                value={fullName}
                onChange={(e) => setFullName(e.target.value)}
                className="w-full rounded-xl border border-slate-200 bg-white px-3.5 py-2.5 text-sm text-slate-800 outline-none transition focus:border-sky-400 focus:ring-2 focus:ring-sky-100"
              />
            </label>

            <label className="block space-y-1.5">
              <span className="text-[11px] font-bold uppercase tracking-widest text-slate-400">Email</span>
              <input
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="w-full rounded-xl border border-slate-200 bg-white px-3.5 py-2.5 text-sm text-slate-800 outline-none transition focus:border-sky-400 focus:ring-2 focus:ring-sky-100"
              />
            </label>

            <div className="grid gap-4 sm:grid-cols-2">
              <label className="block space-y-1.5">
                <span className="text-[11px] font-bold uppercase tracking-widest text-slate-400">New Password</span>
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Leave blank to keep current"
                  className="w-full rounded-xl border border-slate-200 bg-white px-3.5 py-2.5 text-sm text-slate-800 outline-none transition focus:border-sky-400 focus:ring-2 focus:ring-sky-100"
                />
              </label>

              <label className="block space-y-1.5">
                <span className="text-[11px] font-bold uppercase tracking-widest text-slate-400">Confirm Password</span>
                <input
                  type="password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  placeholder="Repeat new password"
                  className="w-full rounded-xl border border-slate-200 bg-white px-3.5 py-2.5 text-sm text-slate-800 outline-none transition focus:border-sky-400 focus:ring-2 focus:ring-sky-100"
                />
              </label>
            </div>

            {(localError || error) && (
              <p className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
                {localError || error}
              </p>
            )}

            <div className="flex flex-wrap gap-2 pt-1">
              <button
                type="submit"
                disabled={busy}
                className="rounded-xl bg-sky-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-sky-700 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {busy ? 'Saving...' : 'Save Changes'}
              </button>
              <button
                type="button"
                onClick={onCancel}
                className="rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm font-semibold text-slate-600 shadow-sm transition hover:bg-slate-50"
              >
                Back to Dashboard
              </button>
            </div>
          </div>
        </form>
      </section>
    </main>
  )
}

export default AccountSettingsPage
