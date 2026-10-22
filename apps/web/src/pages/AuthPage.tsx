import { useState, type FormEvent } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { ApiError, api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { Card, Spinner } from '../components/ui';

export const DEMO = { email: 'demo@nsepaper.dev', password: 'Demo@12345' };

export function AuthPage({ mode }: { mode: 'login' | 'register' }) {
  const { token, signIn } = useAuth();
  const navigate = useNavigate();
  const from = (useLocation().state as { from?: string } | null)?.from ?? '/';
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (token) return <Navigate to={from} replace />;

  const submit = async (e: FormEvent, creds?: { email: string; password: string }) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res =
        mode === 'register' && !creds
          ? await api.register(name, email, password)
          : await api.login(creds?.email ?? email, creds?.password ?? password);
      signIn(res);
      navigate(from, { replace: true });
    } catch (err) {
      if (err instanceof ApiError && Array.isArray(err.details)) {
        setError((err.details as Array<{ path: string; message: string }>).map((d) => `${d.path}: ${d.message}`).join(' · '));
      } else setError(err instanceof Error ? err.message : 'Something went wrong');
    } finally {
      setBusy(false);
    }
  };

  const field = 'mt-1 w-full rounded-lg border border-line px-3 py-2.5 text-sm outline-none focus:border-brand';
  return (
    <div className="mx-auto grid max-w-4xl items-center gap-10 py-6 md:grid-cols-2">
      <div className="hidden md:block">
        <h1 className="text-3xl font-bold leading-tight text-ink-strong">Practice investing in NIFTY 50 stocks — risk-free.</h1>
        <p className="mt-3 text-muted">Start with ₹10,00,000 of virtual cash, trade at real market prices and track your P&amp;L like a real broker account.</p>
        <ul className="mt-6 space-y-2 text-sm">
          <li>✓ Market &amp; limit orders</li>
          <li>✓ Live prices over WebSockets</li>
          <li>✓ Holdings with realised and unrealised P&amp;L</li>
        </ul>
      </div>
      <Card className="p-6 sm:p-8">
        <h2 className="text-xl font-bold text-ink-strong">{mode === 'login' ? 'Welcome back' : 'Create your account'}</h2>
        <form onSubmit={submit} className="mt-6 space-y-4">
          {mode === 'register' && (
            <label className="block text-xs font-medium text-muted">
              Name
              <input className={field} value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" required />
            </label>
          )}
          <label className="block text-xs font-medium text-muted">
            Email
            <input className={field} type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" required />
          </label>
          <label className="block text-xs font-medium text-muted">
            Password
            <input
              className={field}
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
              minLength={mode === 'register' ? 8 : undefined}
              required
            />
          </label>
          {error && <p className="rounded-lg bg-loss-soft px-3 py-2 text-xs text-loss">{error}</p>}
          <button disabled={busy} className="flex w-full items-center justify-center gap-2 rounded-lg bg-brand py-3 text-sm font-bold text-white hover:bg-brand-dark disabled:opacity-60">
            {busy && <Spinner className="h-4 w-4 border-white/40 border-t-white" />}
            {mode === 'login' ? 'Log in' : 'Sign up — get ₹10,00,000'}
          </button>
        </form>
        <button
          onClick={(e) => submit(e, DEMO)}
          disabled={busy}
          className="mt-3 w-full rounded-lg border border-line py-3 text-sm font-semibold text-ink-strong hover:bg-canvas"
        >
          Try the demo account
        </button>
        <p className="mt-5 text-center text-sm text-muted">
          {mode === 'login' ? (
            <>
              New here?{' '}
              <Link to="/register" className="font-semibold text-brand">
                Create an account
              </Link>
            </>
          ) : (
            <>
              Already registered?{' '}
              <Link to="/login" className="font-semibold text-brand">
                Log in
              </Link>
            </>
          )}
        </p>
      </Card>
    </div>
  );
}
