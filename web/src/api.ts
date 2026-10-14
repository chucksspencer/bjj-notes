import { QueryClient, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  FocusAction,
  FocusView,
  LabView,
  MessageResult,
  NoteCreateInput,
  NoteCreateResult,
  NoteKind,
  NotePatch,
  NoteView,
  PositionListItem,
  PositionView,
  Role,
  SessionView,
  Status,
  TechniqueListItem,
  TechniquePatch,
  TechniqueType,
  TechniqueView,
} from '../../src/shared/api';

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown,
  ) {
    super(message);
  }
}

let onUnauthorized: () => void = () => {};
export function setUnauthorizedHandler(fn: () => void) {
  onUnauthorized = fn;
}

export async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: {
      accept: 'application/json',
      'x-bjj-app': '1',
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 204) return undefined as T;
  const data = (await res.json().catch(() => null)) as { message?: string } | null;
  if (!res.ok) {
    if (res.status === 401 && !path.startsWith('/api/v1/session')) onUnauthorized();
    throw new ApiError(data?.message ?? `Request failed (${res.status}).`, res.status, data);
  }
  return data as T;
}

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 15_000,
      retry: (count, err) => !(err instanceof ApiError && err.status < 500) && count < 2,
      refetchOnWindowFocus: true,
    },
  },
});

export const keys = {
  session: ['session'] as const,
  focus: ['focus'] as const,
  lab: ['lab'] as const,
  techniques: (f: TechniqueFilters = {}) => ['techniques', f] as const,
  technique: (id: number) => ['technique', id] as const,
  notes: (f: NoteFilters) => ['notes', f] as const,
  positions: ['positions'] as const,
  sessions: (date?: string) => ['sessions', date ?? null] as const,
  position: (slug: string, role?: Role) => ['position', slug, role ?? null] as const,
};

/** Everything that may show changed data after a write. */
function invalidateAll(qc: ReturnType<typeof useQueryClient>) {
  for (const k of ['focus', 'lab', 'techniques', 'technique', 'notes', 'positions', 'position', 'sessions']) {
    void qc.invalidateQueries({ queryKey: [k] });
  }
}

// ---------- session ----------

export const useSession = () =>
  useQuery({ queryKey: keys.session, queryFn: () => request<{ signedIn: boolean }>('GET', '/api/v1/session'), staleTime: Infinity });

export function useSignIn() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (password: string) => request<void>('POST', '/api/v1/session', { password }),
    onSuccess: () => qc.setQueryData(keys.session, { signedIn: true }),
  });
}

export function useSignOut() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => request<void>('DELETE', '/api/v1/session'),
    onSuccess: () => {
      qc.clear();
      qc.setQueryData(keys.session, { signedIn: false });
    },
  });
}

// ---------- focus ----------

export const useFocus = () => useQuery({ queryKey: keys.focus, queryFn: () => request<FocusView>('GET', '/api/v1/focus') });

export function useFocusAction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: number; action: FocusAction; position?: number }) =>
      request<MessageResult & { focus: FocusView }>('POST', `/api/v1/focus/${v.id}/actions`, { action: v.action, position: v.position }),
    onSuccess: r => {
      qc.setQueryData(keys.focus, r.focus);
      void qc.invalidateQueries({ queryKey: ['technique'] });
    },
  });
}

export function useAddFocus() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { label: string; techniqueIds?: number[]; position?: number }) =>
      request<MessageResult & { focus: FocusView }>('POST', '/api/v1/focus', v),
    onSuccess: r => {
      qc.setQueryData(keys.focus, r.focus);
      void qc.invalidateQueries({ queryKey: ['technique'] });
    },
  });
}

export function useEditFocus() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: number; label?: string; goal?: string | null }) =>
      request<MessageResult & { focus: FocusView }>('PATCH', `/api/v1/focus/${v.id}`, { label: v.label, goal: v.goal }),
    onSuccess: r => qc.setQueryData(keys.focus, r.focus),
  });
}

// ---------- lab ----------

/** The Lab in one request: starred techniques and notes, videos to try, new techniques, questions for coach. */
export const useLab = () => useQuery({ queryKey: keys.lab, queryFn: () => request<LabView>('GET', '/api/v1/lab') });

// ---------- techniques ----------

export interface TechniqueFilters {
  q?: string;
  type?: TechniqueType;
  role?: Role;
  status?: Status;
  position?: number;
  sort?: 'name' | 'recent';
}

const qs = (o: object) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== '' && v !== null) p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : '';
};

export const useTechniques = (f: TechniqueFilters = {}, enabled = true) =>
  useQuery({
    queryKey: keys.techniques(f),
    queryFn: () => request<TechniqueListItem[]>('GET', `/api/v1/techniques${qs(f)}`),
    enabled,
    placeholderData: prev => prev,
  });

export const useTechnique = (id: number) =>
  useQuery({ queryKey: keys.technique(id), queryFn: () => request<TechniqueView>('GET', `/api/v1/techniques/${id}`) });

export function useCreateTechnique() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { name: string; type: TechniqueType; role?: Role | null }) => request<TechniqueView>('POST', '/api/v1/techniques', v),
    onSuccess: t => {
      qc.setQueryData(keys.technique(t.id), t);
      invalidateAll(qc);
    },
  });
}

/** Writes that return the updated technique. */
function useTechniqueWrite<V>(fn: (v: V) => Promise<TechniqueView>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: t => {
      qc.setQueryData(keys.technique(t.id), t);
      invalidateAll(qc);
    },
  });
}

export const usePatchTechnique = (id: number) =>
  useTechniqueWrite((patch: TechniquePatch) => request<TechniqueView>('PATCH', `/api/v1/techniques/${id}`, patch));

export const useAddEdge = (id: number) =>
  useTechniqueWrite((v: { fromPositionId?: number | null; fromRole?: Role | null; toPositionId?: number | null; toRole?: Role | null }) =>
    request<TechniqueView>('POST', `/api/v1/techniques/${id}/edges`, v),
  );

export const useRemoveEdge = (id: number) =>
  useTechniqueWrite((edgeId: number) => request<TechniqueView>('DELETE', `/api/v1/techniques/${id}/edges/${edgeId}`));

export const useAddLink = (id: number) =>
  useTechniqueWrite((v: { kind: string; techniqueId?: number; name?: string }) => request<TechniqueView>('POST', `/api/v1/techniques/${id}/links`, v));

export const useRemoveLink = (id: number) =>
  useTechniqueWrite((v: { otherId: number; kind: string; direction: 'in' | 'out' }) =>
    request<TechniqueView>('DELETE', `/api/v1/techniques/${id}/links/${v.otherId}/${v.kind}?direction=${v.direction}`),
  );

export function useDeleteTechnique() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => request<MessageResult>('DELETE', `/api/v1/techniques/${id}`),
    onSuccess: () => invalidateAll(qc),
  });
}

export function useDeleteTechniques() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (ids: number[]) => request<MessageResult>('POST', '/api/v1/techniques/delete', { ids }),
    onSuccess: () => invalidateAll(qc),
  });
}

// ---------- notes ----------

const flag = (v: boolean | undefined) => (v === undefined ? undefined : v ? '1' : '0');

export interface NoteFilters {
  inbox?: boolean;
  toTry?: boolean;
  technique?: number;
  q?: string;
  limit?: number;
}

export const useNotes = (f: NoteFilters, enabled = true) =>
  useQuery({
    queryKey: keys.notes(f),
    queryFn: () =>
      request<NoteView[]>('GET', `/api/v1/notes${qs({ ...f, inbox: flag(f.inbox), toTry: flag(f.toTry) })}`),
    enabled,
  });

export function useAddNote() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: NoteCreateInput) => request<NoteCreateResult>('POST', '/api/v1/notes', v),
    onSuccess: () => invalidateAll(qc),
  });
}

export function useEditNote() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...patch }: NotePatch & { id: number }) => request<NoteView>('PATCH', `/api/v1/notes/${id}`, patch),
    onSuccess: () => invalidateAll(qc),
  });
}

export function useFileNote() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: number; techniqueIds?: number[]; newTechniques?: NoteCreateInput['newTechniques'] }) =>
      request<NoteView>('POST', `/api/v1/notes/${v.id}/file`, { techniqueIds: v.techniqueIds, newTechniques: v.newTechniques }),
    onSuccess: () => invalidateAll(qc),
  });
}

export function useDeleteNote() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => request<MessageResult>('DELETE', `/api/v1/notes/${id}`),
    onSuccess: () => invalidateAll(qc),
  });
}

export function useDeleteNotes() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (ids: number[]) => request<MessageResult>('POST', '/api/v1/notes/delete', { ids }),
    onSuccess: () => invalidateAll(qc),
  });
}

// ---------- sessions (where notes came from) ----------

/** Recent sessions, or the ones on a given date. */
export const useSessions = (date?: string) =>
  useQuery({
    queryKey: keys.sessions(date),
    queryFn: () => request<SessionView[]>('GET', `/api/v1/sessions${qs({ date, limit: date ? 20 : 8 })}`),
    staleTime: 60_000,
    placeholderData: prev => prev,
  });

// ---------- positions ----------

export const usePositions = () =>
  useQuery({ queryKey: keys.positions, queryFn: () => request<PositionListItem[]>('GET', '/api/v1/positions'), staleTime: 60_000 });

export const usePosition = (slug: string, role?: Role) =>
  useQuery({
    queryKey: keys.position(slug, role),
    queryFn: () => request<PositionView>('GET', `/api/v1/positions/${encodeURIComponent(slug)}${qs({ role })}`),
    placeholderData: prev => prev,
  });

// ---------- undo ----------

export function useUndo() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => request<MessageResult>('POST', '/api/v1/undo'),
    onSuccess: () => invalidateAll(qc),
  });
}
