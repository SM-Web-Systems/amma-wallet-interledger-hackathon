import { useState } from 'react';
import { authApi } from '../lib/api';
import { useAuthStore } from '../store/auth';

export default function AccountEmail() {
  const user = useAuthStore(state => state.user);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [replacing, setReplacing] = useState(false);
  if (!user || user.isEmailVerified) return null;
  const address = user.email ?? (replacing ? null : user.pendingEmail ?? null);
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true); setError(''); setMessage('');
    try {
      const result = address ? await authApi.resendVerification() : await authApi.addEmail({email: email.trim(), currentPassword: password});
      if (useAuthStore.getState().user?.id !== user!.id) return;
      if (!address) {
        useAuthStore.setState(state => state.user?.id === user!.id ? {user: {...state.user, pendingEmail: email.trim().toLowerCase(), isEmailVerified: false}} : {});
        setReplacing(false);
      }
      setPassword(''); setMessage(result.message);
    } catch (err) { setError(err instanceof Error ? err.message : 'Could not update your email. Please retry.'); }
    finally { setBusy(false); }
  }
  return <section aria-label="Email verification" className="bg-stellar-card border border-stellar-border rounded-2xl p-6 space-y-3">
    <h2 className="font-semibold text-stellar-text">{address ? 'Verify your email' : 'Add an email for LMS access'}</h2>
    <p className="text-sm text-stellar-muted">LMS needs a verified email. After opening the verification link in your inbox, return to LMS and start sign-in again.</p>
    <form onSubmit={submit} className="space-y-3">
      {address ? <p className="text-stellar-text break-all">{address}</p> : <>
        <label className="block text-sm text-stellar-text">Email address
          <input type="email" required maxLength={254} autoComplete="email" value={email} onChange={event => setEmail(event.target.value)}
            className="mt-1 block w-full rounded-lg bg-stellar-dark border border-stellar-border p-2 text-stellar-text" />
        </label>
        <label className="block text-sm text-stellar-text">Current AmmaWallet password
          <input type="password" required maxLength={1024} autoComplete="current-password" value={password} onChange={event => setPassword(event.target.value)}
            className="mt-1 block w-full rounded-lg bg-stellar-dark border border-stellar-border p-2 text-stellar-text" />
        </label>
      </>}
      {message && <p role="status" className="text-sm text-stellar-text">{message}</p>}
      {error && <p role="alert" className="text-sm text-red-700 dark:text-red-400">{error}</p>}
      <button type="submit" disabled={busy} className="rounded-lg bg-stellar-blue px-4 py-2 text-white disabled:opacity-50">
        {busy ? 'Sending…' : address ? 'Resend verification email' : 'Add email and send verification'}
      </button>
      {address && !user.email && <button type="button" disabled={busy} onClick={() => { setReplacing(true); setMessage(''); setError(''); }}
        className="ml-3 text-sm underline text-stellar-muted disabled:opacity-50">Use a different email</button>}
    </form>
  </section>;
}
