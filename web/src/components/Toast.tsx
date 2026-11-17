import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { useUndo } from '../api';

interface ToastState {
  id: number;
  text: string;
  /** The undo entry this toast's Undo reverses; without one there is no Undo button. */
  undoId?: number;
  error: boolean;
}

interface ToastApi {
  /** Shows a confirmation; given the id of the change it reports (the mutation's activityId), it offers Undo for that change only. */
  show: (text: string, opts?: { undoId?: number }) => void;
  error: (err: unknown) => void;
}

const Ctx = createContext<ToastApi>({ show: () => {}, error: () => {} });
export const useToast = () => useContext(Ctx);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<ToastState | null>(null);
  const timer = useRef<number>(undefined);
  const undo = useUndo();

  const open = useCallback((t: Omit<ToastState, 'id'>) => {
    window.clearTimeout(timer.current);
    setToast({ ...t, id: Date.now() });
    timer.current = window.setTimeout(() => setToast(null), t.undoId ? 6000 : 3500);
  }, []);

  const api: ToastApi = {
    show: (text, opts) => open({ text, undoId: opts?.undoId, error: false }),
    error: err => open({ text: err instanceof Error ? err.message : 'Something went wrong.', error: true }),
  };

  useEffect(() => () => window.clearTimeout(timer.current), []);

  return (
    <Ctx.Provider value={api}>
      {children}
      <div aria-live="polite">
        {toast && (
          <div className={`toast${toast.error ? ' error' : ''}`} key={toast.id} role="status">
            <span>{toast.text}</span>
            {toast.undoId !== undefined && (
              <button
                type="button"
                className="btn small"
                disabled={undo.isPending}
                onClick={() =>
                  undo.mutate(toast.undoId!, {
                    onSuccess: r => open({ text: r.message, error: false }),
                    onError: e => api.error(e),
                  })
                }
              >
                Undo
              </button>
            )}
          </div>
        )}
      </div>
    </Ctx.Provider>
  );
}
