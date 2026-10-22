import { QueryClient, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  AccountView,
  ApiTokenView,
  FocusAction,
  InviteCheck,
  InviteView,
  Me,
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
  SessionInfo,
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
  account: ['account'] as const,
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
  useQuery({ queryKey: keys.session, queryFn: () => request<SessionInfo>('GET', '/api/v1/session'), staleTime: Infinity });

/**
 * Signed in or out as someone: nothing of the previous person's stays in the cache, and the session the
 * app's gate is watching changes in place (clearing the whole cache would detach it from that query).
 */
function switchSession(qc: ReturnType<typeof useQueryClient>, info: SessionInfo) {
  qc.removeQueries({ predicate: q => q.queryKey[0] !== keys.session[0] });
  qc.setQueryData(keys.session, info);
}

/** The signed-in person (only called inside the signed-in app). */
export function useMe(): Me | null {
  const session = useSession();
  return session.data?.signedIn ? session.data.user : null;
}

export function useSignIn() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { email: string; password: string }) => request<SessionInfo>('POST', '/api/v1/session', v),
    onSuccess: info => switchSession(qc, info),
  });
}

export function useSignOut() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => request<void>('DELETE', '/api/v1/session'),
    onSuccess: () => switchSession(qc, { signedIn: false }),
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

/** Unstar everything, or only stars older than some number of days. One undo puts them back. */
export function useClearStars() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (olderThanDays?: number) => request<MessageResult>('POST', '/api/v1/stars/clear', { olderThanDays }),
    onSuccess: () => invalidateAll(qc),
  });
}

/** Mark several questions answered at once. */
export function useMarkAnswered() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (ids: number[]) => request<MessageResult>('POST', '/api/v1/notes/answered', { ids }),
    onSuccess: () => invalidateAll(qc),
  });
}

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

// ---------- account and people ----------

export const useAccount = () => useQuery({ queryKey: keys.account, queryFn: () => request<AccountView>('GET', '/api/v1/account') });

function useAccountWrite<V, R>(fn: (v: V) => Promise<R>) {
  const qc = useQueryClient();
  return useMutation({ mutationFn: fn, onSuccess: () => void qc.invalidateQueries({ queryKey: keys.account }) });
}

export function useUpdateProfile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { name?: string | null; email?: string | null }) => request<Me>('PATCH', '/api/v1/account', v),
    onSuccess: me => {
      qc.setQueryData(keys.session, { signedIn: true, user: me } satisfies SessionInfo);
      void qc.invalidateQueries({ queryKey: keys.account });
    },
  });
}

export const useChangePassword = () =>
  useMutation({ mutationFn: (v: { current: string; password: string }) => request<MessageResult>('POST', '/api/v1/account/password', v) });

export const useCreateToken = () =>
  useAccountWrite((v: { label?: string }) => request<{ token: string; row: ApiTokenView }>('POST', '/api/v1/account/tokens', v));

export const useRevokeToken = () => useAccountWrite((id: number) => request<MessageResult>('DELETE', `/api/v1/account/tokens/${id}`));

export const useCreateInvite = () =>
  useAccountWrite((v: { name?: string; email?: string }) => request<{ url: string; invite: InviteView }>('POST', '/api/v1/invites', v));

export const useRevokeInvite = () => useAccountWrite((id: number) => request<MessageResult>('DELETE', `/api/v1/invites/${id}`));

export const useResetLink = () =>
  useAccountWrite((userId: number) => request<{ url: string; invite: InviteView }>('POST', `/api/v1/people/${userId}/reset`));

export const useRemovePerson = () => useAccountWrite((userId: number) => request<MessageResult>('DELETE', `/api/v1/people/${userId}`));

/** What a join or reset link is for (no sign-in needed). */
export const useInviteCheck = (token: string) =>
  useQuery({
    queryKey: ['invite', token],
    queryFn: () => request<InviteCheck>('POST', '/api/v1/invites/check', { token }),
    enabled: token.length > 0,
    staleTime: Infinity,
  });

export function useAcceptInvite() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { token: string; name?: string; email?: string; password: string }) =>
      request<SessionInfo>('POST', '/api/v1/invites/accept', v),
    onSuccess: info => switchSession(qc, info),
  });
}
