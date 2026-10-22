import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';

type Tone = 'success' | 'error' | 'info';
interface Toast {
  id: number;
  title: string;
  body?: string;
  tone: Tone;
}

const ToastContext = createContext<(t: Omit<Toast, 'id'>) => void>(() => undefined);
let seq = 0;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((t: Omit<Toast, 'id'>) => {
    const id = ++seq;
    setToasts((all) => [...all.slice(-3), { ...t, id }]);
    setTimeout(() => setToasts((all) => all.filter((x) => x.id !== id)), 4500);
  }, []);

  return (
    <ToastContext.Provider value={push}>
      {children}
      <div className="pointer-events-none fixed inset-x-0 bottom-4 z-50 flex flex-col items-center gap-2 px-4 sm:items-end sm:pr-6" aria-live="polite">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={`pointer-events-auto w-full max-w-sm rounded-xl border bg-white px-4 py-3 shadow-lg ${
              t.tone === 'success' ? 'border-brand/40' : t.tone === 'error' ? 'border-loss/40' : 'border-line'
            }`}
          >
            <p className={`text-sm font-semibold ${t.tone === 'success' ? 'text-brand' : t.tone === 'error' ? 'text-loss' : 'text-ink-strong'}`}>
              {t.title}
            </p>
            {t.body && <p className="mt-0.5 text-xs text-muted">{t.body}</p>}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export const useToast = () => useContext(ToastContext);
