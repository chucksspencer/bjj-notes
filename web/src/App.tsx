import { QueryClientProvider } from '@tanstack/react-query';
import { useEffect, type ReactNode } from 'react';
import { BrowserRouter, Link, Navigate, Route, Routes, useLocation } from 'react-router';
import { queryClient, setUnauthorizedHandler, useNotes, useSession } from './api';
import { CaptureProvider, useCapture } from './components/Capture';
import { ErrorBoundary } from './components/ErrorBoundary';
import { Icon } from './components/Icon';
import { ToastProvider } from './components/Toast';
import { Focus } from './pages/Focus';
import { Inbox } from './pages/Inbox';
import { Lab } from './pages/Lab';
import { Library } from './pages/Library';
import { Login } from './pages/Login';
import { Position, Positions } from './pages/Positions';
import { Technique } from './pages/Technique';
import { ToTry } from './pages/ToTry';

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Gate />
      </BrowserRouter>
    </QueryClientProvider>
  );
}

function Gate() {
  const session = useSession();
  useEffect(() => {
    setUnauthorizedHandler(() => queryClient.setQueryData(['session'], { signedIn: false }));
  }, []);
  if (session.isPending) return null;
  if (!session.data?.signedIn) return <Login />;
  return (
    <ToastProvider>
      <CaptureProvider>
        <Shell />
      </CaptureProvider>
    </ToastProvider>
  );
}

function Shell() {
  const { pathname } = useLocation();
  useEffect(() => {
    // Braces matter: Chrome 150+ returns a Promise from scrollTo, and React would call
    // a returned value as this effect's cleanup on the next navigation and crash.
    window.scrollTo(0, 0);
  }, [pathname]);
  return (
    <div className="app">
      <main>
        <ErrorBoundary key={pathname}>
          <Routes>
            <Route path="/" element={<Lab />} />
            <Route path="/focus" element={<Focus />} />
            <Route path="/try" element={<ToTry />} />
            <Route path="/library" element={<Library />} />
            <Route path="/t/:id" element={<Technique />} />
            <Route path="/positions" element={<Positions />} />
            <Route path="/p/:slug" element={<Position />} />
            <Route path="/inbox" element={<Inbox />} />
            <Route path="/inbox/try" element={<Navigate to="/try" replace />} />
            <Route path="*" element={<NotFound />} />
          </Routes>
        </ErrorBoundary>
      </main>
      <TabBar />
    </div>
  );
}

function TabBar() {
  const capture = useCapture();
  const inbox = useNotes({ inbox: true, limit: 100 });
  const count = inbox.data?.length ?? 0;
  const { pathname } = useLocation();
  const under = (...prefixes: string[]) => prefixes.some(p => pathname === p || pathname.startsWith(`${p}/`));
  return (
    <nav className="tabbar" aria-label="Main">
      <Tab to="/" active={pathname === '/' || under('/focus', '/try')}>
        <Icon name="focus" />
        Focus
      </Tab>
      <Tab to="/library" active={under('/library', '/t')}>
        <Icon name="library" />
        Library
      </Tab>
      <button type="button" className="tab-note" aria-label="New note" onClick={() => capture.open()}>
        <Icon name="plus" size={28} />
      </button>
      <Tab to="/positions" active={under('/positions', '/p')}>
        <Icon name="positions" />
        Positions
      </Tab>
      <Tab to="/inbox" active={under('/inbox')}>
        <Icon name="inbox" />
        Inbox
        {count > 0 && (
          <span className="badge" aria-label={`${count} to file`}>
            {count}
          </span>
        )}
      </Tab>
    </nav>
  );
}

/** A tab that stays lit on the pages under it (a technique card under Library, say). */
function Tab({ to, active, children }: { to: string; active: boolean; children: ReactNode }) {
  return (
    <Link className="tab" to={to} aria-current={active ? 'page' : undefined}>
      {children}
    </Link>
  );
}

function NotFound() {
  return (
    <div className="page">
      <h1 className="display page-title">Not here</h1>
      <p className="muted">That page doesn't exist. Use the tabs below to get back.</p>
    </div>
  );
}
