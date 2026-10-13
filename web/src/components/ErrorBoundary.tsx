import { Component, type ErrorInfo, type ReactNode } from 'react';

/**
 * Without a boundary, any render error unmounts the whole app and leaves a blank page.
 * This shows what went wrong and a way out instead. Keyed by route where it's used,
 * so moving to another page clears it.
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: unknown) {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error('BJJ Notes hit an error', error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="page" role="alert">
        <h1 className="display page-title">Something broke</h1>
        <p className="muted">This page hit an error. Reloading usually fixes it, and your notes are safe.</p>
        <pre className="error-detail">{error.message}</pre>
        <button type="button" className="btn" onClick={() => window.location.reload()}>
          Reload
        </button>
      </div>
    );
  }
}
