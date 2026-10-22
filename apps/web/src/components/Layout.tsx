import { NavLink, Outlet, Link } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { formatINR } from '../lib/format';
import { useConnectionState } from '../lib/realtime';
import { SearchBox } from './SearchBox';

const links = [
  { to: '/', label: 'Explore', end: true },
  { to: '/portfolio', label: 'Holdings' },
  { to: '/orders', label: 'Orders' },
];

function LiveDot() {
  const state = useConnectionState();
  const color = state === 'live' ? 'bg-brand' : state === 'connecting' ? 'bg-amber-400' : 'bg-loss';
  return (
    <span className="hidden items-center gap-1.5 text-xs text-muted md:inline-flex" title={`Price stream: ${state}`}>
      <span className={`h-2 w-2 rounded-full ${color} ${state === 'live' ? 'animate-pulse' : ''}`} />
      {state === 'live' ? 'Live' : state === 'connecting' ? 'Connecting' : 'Offline'}
    </span>
  );
}

export function Layout() {
  const { user, cash, signOut } = useAuth();
  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-30 border-b border-line bg-white/95 backdrop-blur">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-6 gap-y-3 px-4 py-3">
          <Link to="/" className="flex items-center gap-2 text-lg font-bold text-ink-strong">
            <img src="/favicon.svg" alt="" className="h-7 w-7" />
            PaperTrade
          </Link>
          <nav className="order-3 flex w-full gap-5 text-sm font-medium sm:order-none sm:w-auto">
            {links.map((l) => (
              <NavLink key={l.to} to={l.to} end={l.end} className={({ isActive }) => (isActive ? 'text-brand' : 'text-ink hover:text-ink-strong')}>
                {l.label}
              </NavLink>
            ))}
          </nav>
          <div className="flex flex-1 justify-end sm:justify-center">
            <SearchBox />
          </div>
          <div className="flex items-center gap-4">
            <LiveDot />
            {user ? (
              <div className="flex items-center gap-3">
                <div className="hidden text-right sm:block">
                  <p className="text-xs text-muted">Available cash</p>
                  <p className="num text-sm font-semibold text-ink-strong">{formatINR(cash)}</p>
                </div>
                <button onClick={signOut} className="rounded-lg border border-line px-3 py-1.5 text-sm hover:bg-canvas" title={user.email}>
                  Log out
                </button>
              </div>
            ) : (
              <Link to="/login" className="rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-white hover:bg-brand-dark">
                Log in
              </Link>
            )}
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-6">
        <Outlet />
      </main>
      <footer className="mx-auto max-w-6xl px-4 pb-10 pt-4 text-xs text-muted">
        Paper trading only — virtual money, no real orders are sent to NSE. Prices via Yahoo Finance may be delayed.
      </footer>
    </div>
  );
}
