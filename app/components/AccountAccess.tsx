'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { LogIn, LogOut, UserRound, X } from 'lucide-react';

type Account = { id: string; email: string };
type AuthReply = { user?: Account | null; message?: string; error?: string; configured?: boolean; needsConfirmation?: boolean };
type Mode = 'login' | 'signup';

export default function AccountAccess() {
  const [account, setAccount] = useState<Account | null>(null);
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<Mode>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState('');

  const load = useCallback(async () => {
    try {
      const response = await fetch('/api/auth', { cache: 'no-store', credentials: 'same-origin' });
      const result = await response.json() as AuthReply;
      setConfigured(result.configured !== false);
      setAccount(result.user ?? null);
    } catch {
      setConfigured(null);
      setAccount(null);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  // Let the research dashboard load the correct account's cloud bookmarks.
  useEffect(() => {
    window.dispatchEvent(new CustomEvent('propiq-auth-change', { detail: account?.id ?? null }));
  }, [account]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    setPending(true);
    setMessage('');
    try {
      const response = await fetch('/api/auth', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin', body: JSON.stringify({ action: mode, email, password })
      });
      const result = await response.json() as AuthReply;
      if (!response.ok) throw new Error(result.error || 'Authentication failed.');
      if (result.user) {
        setAccount(result.user);
        setPassword('');
        setOpen(false);
        setMessage('');
      } else if (result.needsConfirmation) {
        setPassword('');
        setMessage('Check your email to confirm your account, then sign in.');
        setMode('login');
      } else setMessage(result.message || 'Please try again.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Could not connect.');
    } finally { setPending(false); }
  }

  async function signOut() {
    if (pending) return;
    setPending(true);
    try {
      const response = await fetch('/api/auth', { method: 'DELETE', credentials: 'same-origin' });
      if (!response.ok) throw new Error('Unable to sign out.');
      setAccount(null);
      setOpen(false);
      setMessage('');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Unable to sign out.');
      setOpen(true);
    } finally { setPending(false); }
  }

  return (
    <>
      <button type="button" className="account-trigger" onClick={() => { setMessage(''); setOpen(true); }}>
        <UserRound size={16} />
        <span>{account ? 'My account' : 'Sign in'}</span>
      </button>
      {open && (
        <div className="auth-backdrop" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) setOpen(false); }}>
          <section className="auth-dialog" role="dialog" aria-modal="true" aria-label={account ? 'My account' : 'Account access'}>
            <div className="auth-header">
              <div><span className="auth-kicker">PROPIQ ACCOUNT</span><h2>{account ? 'Your account' : mode === 'login' ? 'Welcome back' : 'Create your account'}</h2></div>
              <button type="button" className="auth-close" onClick={() => setOpen(false)} aria-label="Close"><X size={19} /></button>
            </div>
            {account ? (
              <div className="auth-account">
                <p>Signed in as <strong>{account.email}</strong></p>
                <p className="auth-hint">Phase 3 foundation: Your existing saved research is still stored in this browser. Cloud syncing and plans arrive in later updates.</p>
                <button type="button" className="auth-secondary" disabled={pending} onClick={() => void signOut()}><LogOut size={16} /> Sign out</button>
              </div>
            ) : configured === false ? (
              <p className="auth-error">Account sign-in is not configured yet. Add SUPABASE_URL and SUPABASE_ANON_KEY to Railway Variables, and connect a Supabase project.</p>
            ) : (
              <>
                <p className="auth-hint">{mode === 'login' ? 'Sign in with your email and password.' : 'Join PropIQ to prepare for cloud-saved research and subscription access.'}</p>
                <form className="auth-form" onSubmit={event => void submit(event)}>
                  <label>Email address<input type="email" autoComplete="email" required maxLength={254} value={email} onChange={e => setEmail(e.target.value)} placeholder="you@example.com" /></label>
                  <label>Password<input type="password" autoComplete={mode === 'login' ? 'current-password' : 'new-password'} required minLength={6} maxLength={72} value={password} onChange={e => setPassword(e.target.value)} placeholder="Enter your password" /></label>
                  {message && <p className="auth-message" role="status">{message}</p>}
                  <button className="auth-primary" type="submit" disabled={pending}><LogIn size={16} /> {pending ? 'Please wait…' : mode === 'login' ? 'Sign in' : 'Create account'}</button>
                </form>
                <button className="auth-switch" type="button" disabled={pending} onClick={() => { setMode(mode === 'login' ? 'signup' : 'login'); setMessage(''); }}>
                  {mode === 'login' ? 'New to PropIQ? Create an account' : 'Already have an account? Sign in'}
                </button>
              </>
            )}
            {account && message && <p className="auth-message" role="status">{message}</p>}
          </section>
        </div>
      )}
    </>
  );
}
