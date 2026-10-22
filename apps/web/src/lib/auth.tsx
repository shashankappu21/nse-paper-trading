import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { AuthResponse, UserDto } from '@nse/shared';
import { api, setToken, setUnauthorizedHandler } from './api';

const STORAGE_KEY = 'papertrade.token';

function readToken(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

interface AuthState {
  token: string | null;
  user: UserDto | null;
  cash: number | null;
  ready: boolean;
  signIn(res: AuthResponse): void;
  signOut(): void;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const [token, setTokenState] = useState<string | null>(() => {
    const t = readToken();
    setToken(t);
    return t;
  });

  const signOut = useCallback(() => {
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      /* storage unavailable */
    }
    setToken(null);
    setTokenState(null);
    qc.clear();
  }, [qc]);

  const signIn = useCallback(
    (res: AuthResponse) => {
      try {
        localStorage.setItem(STORAGE_KEY, res.token);
      } catch {
        /* storage unavailable: session-only login */
      }
      setToken(res.token);
      setTokenState(res.token);
      qc.clear();
    },
    [qc],
  );

  // Braces matter: an expression body would return signOut, and React would run it as the cleanup.
  useEffect(() => {
    setUnauthorizedHandler(signOut);
  }, [signOut]);

  const me = useQuery({ queryKey: ['me', token], queryFn: api.me, enabled: !!token, retry: false });

  const value = useMemo<AuthState>(
    () => ({
      token,
      user: me.data?.user ?? null,
      cash: me.data?.cash ?? null,
      ready: !token || !me.isLoading,
      signIn,
      signOut,
    }),
    [token, me.data, me.isLoading, signIn, signOut],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth outside AuthProvider');
  return ctx;
}
