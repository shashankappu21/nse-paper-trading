import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { lazy, Suspense, type ReactNode } from 'react';
import { Layout } from './components/Layout';
import { PageLoader, Empty } from './components/ui';
import { useAuth } from './lib/auth';
import { AuthPage } from './pages/AuthPage';
import { ExplorePage } from './pages/ExplorePage';
import { OrdersPage } from './pages/OrdersPage';
import { PortfolioPage } from './pages/PortfolioPage';

// The chart library is the heaviest dependency; load it only when a stock page is opened.
const StockPage = lazy(() => import('./pages/StockPage').then((m) => ({ default: m.StockPage })));

function RequireAuth({ children }: { children: ReactNode }) {
  const { token, ready } = useAuth();
  const location = useLocation();
  if (!token) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  if (!ready) return <PageLoader />;
  return <>{children}</>;
}

export function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<ExplorePage />} />
        <Route path="stocks/:symbol" element={<Suspense fallback={<PageLoader />}><StockPage /></Suspense>} />
        <Route path="portfolio" element={<RequireAuth><PortfolioPage /></RequireAuth>} />
        <Route path="orders" element={<RequireAuth><OrdersPage /></RequireAuth>} />
        <Route path="login" element={<AuthPage mode="login" />} />
        <Route path="register" element={<AuthPage mode="register" />} />
        <Route path="*" element={<Empty title="Page not found" />} />
      </Route>
    </Routes>
  );
}
