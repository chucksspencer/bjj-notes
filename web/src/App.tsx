import { QueryClientProvider } from '@tanstack/react-query';
import { useEffect } from 'react';
import { BrowserRouter, NavLink, Route, Routes, useLocation } from 'react-router';
import { queryClient, setUnauthorizedHandler, useNotes, useSession } from './api';
import { CaptureProvider, useCapture } from './components/Capture';
import { Icon } from './components/Icon';
import { ToastProvider } from './components/Toast';
import { Focus } from './pages/Focus';
import { Inbox } from './pages/Inbox';
import { Library } from './pages/Library';
import { Login } from './pages/Login';
import { Position, Positions } from './pages/Positions';
import { Technique } from './pages/Technique';

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
  useEffect(() => window.scrollTo(0, 0), [pathname]);
  return (
    <div className="app">
      <main>
        <Routes>
          <Route path="/" element={<Focus />} />
          <Route path="/library" element={<Library />} />
          <Route path="/t/:id" element={<Technique />} />
          <Route path="/positions" element={<Positions />} />
          <Route path="/p/:slug" element={<Position />} />
          <Route path="/inbox" element={<Inbox />} />
          <Route path="*" element={<NotFound />} />
        </Routes>
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
  const inLibrary = pathname.startsWith('/library') || pathname.startsWith('/t/');
  const inPositions = pathname.startsWith('/positions') || pathname.startsWith('/p/');
  return (
    <nav className="tabbar" aria-label="Main">
      <NavLink className="tab" to="/" end>
        <Icon name="focus" />
        Focus
      </NavLink>
      <NavLink className="tab" to="/library" aria-current={inLibrary ? 'page' : undefined}>
        <Icon name="library" />
        Library
      </NavLink>
      <button type="button" className="tab-note" aria-label="New note" onClick={() => capture.open()}>
        <Icon name="plus" size={28} />
      </button>
      <NavLink className="tab" to="/positions" aria-current={inPositions ? 'page' : undefined}>
        <Icon name="positions" />
        Positions
      </NavLink>
      <NavLink className="tab" to="/inbox">
        <Icon name="inbox" />
        Inbox
        {count > 0 && (
          <span className="badge" aria-label={`${count} to file`}>
            {count}
          </span>
        )}
      </NavLink>
    </nav>
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
