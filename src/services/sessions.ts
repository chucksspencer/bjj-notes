// Training sessions: classes, seminars, open mats. A note's session is where it came from.
import type { Gi, SessionKind, SessionView } from '../shared/api.js';
import { sessionLabel, sessionPhrase } from '../shared/sessions.js';
import type { Queryable } from '../db.js';
import { logActivity, type SessionSnapshot } from './activity.js';
import { today, type Ctx } from './context.js';
import { NotFoundError } from './errors.js';

export interface SessionDetails {
  kind?: SessionKind;
  name?: string;
  instructor?: string;
  location?: string;
  gi?: Gi;
  summary?: string;
}

interface SessionRow {
  id: number;
  date: string;
  kind: SessionKind;
  name: string | null;
  instructor: string | null;
  location: string | null;
  gi: Gi | null;
  summary: string | null;
}

const SESSION_SQL = `select id, date::text as date, kind, name, instructor, location, gi, summary from sessions`;

export const toSessionView = (r: SessionRow): SessionView => ({
  id: r.id,
  date: r.date,
  kind: r.kind,
  name: r.name,
  instructor: r.instructor,
  location: r.location,
  gi: r.gi,
});

const clean = (s: string | undefined | null) => s?.trim().replace(/\s+/g, ' ') || null;
const same = (a: string | null, b: string | null) => a!.toLowerCase() === b!.toLowerCase();

/** Fields that tell two sessions on the same day apart. */
const IDENTITY = ['name', 'instructor', 'location', 'gi'] as const;

export interface FoundSession {
  id: number;
  created: boolean;
  /** The row before details were filled in, when an existing session was updated. */
  before: SessionSnapshot | null;
  view: SessionView;
}

/**
 * The session these details describe: an existing one on that date of the same kind whose details don't
 * conflict (it gains any details it was missing), or a new one. So "class today" said twice is one class,
 * while a differently named seminar on the same day is a second session.
 */
export async function findOrCreateSession(q: Queryable, date: string, d: SessionDetails): Promise<FoundSession> {
  const kind = d.kind ?? 'class';
  const want = { name: clean(d.name), instructor: clean(d.instructor), location: clean(d.location), gi: d.gi ?? null };
  const summary = clean(d.summary);
  const candidates = (await q.query<SessionRow>(`${SESSION_SQL} where date = $1 and kind = $2 order by id desc`, [date, kind])).rows;

  let best: SessionRow | null = null;
  let bestScore = -1;
  for (const c of candidates) {
    const conflict = IDENTITY.some(f => want[f] !== null && c[f] !== null && !same(want[f], c[f]));
    if (conflict) continue;
    const score = IDENTITY.filter(f => want[f] !== null && c[f] !== null).length;
    if (score > bestScore) {
      best = c;
      bestScore = score;
    }
  }

  if (!best) {
    const { rows } = await q.query<SessionRow>(
      `insert into sessions (date, kind, name, instructor, location, gi, summary) values ($1, $2, $3, $4, $5, $6, $7)
       returning id, date::text as date, kind, name, instructor, location, gi, summary`,
      [date, kind, want.name, want.instructor, want.location, want.gi, summary],
    );
    return { id: rows[0]!.id, created: true, before: null, view: toSessionView(rows[0]!) };
  }

  const next: SessionRow = {
    ...best,
    name: best.name ?? want.name,
    instructor: best.instructor ?? want.instructor,
    location: best.location ?? want.location,
    gi: best.gi ?? want.gi,
  };
  if (summary && !(best.summary ?? '').includes(summary)) next.summary = best.summary ? `${best.summary}\n\n${summary}` : summary;
  const changed = [...IDENTITY, 'summary' as const].some(f => next[f] !== best[f]);
  if (!changed) return { id: best.id, created: false, before: null, view: toSessionView(best) };
  await q.query('update sessions set name = $2, instructor = $3, location = $4, gi = $5, summary = $6 where id = $1', [
    best.id,
    next.name,
    next.instructor,
    next.location,
    next.gi,
    next.summary,
  ]);
  return { id: best.id, created: false, before: snapshot(best), view: toSessionView(next) };
}

const snapshot = (r: SessionRow): SessionSnapshot => ({
  id: r.id,
  name: r.name,
  instructor: r.instructor,
  location: r.location,
  gi: r.gi,
  summary: r.summary,
});

export async function sessionById(q: Queryable, id: number): Promise<SessionView> {
  const row = (await q.query<SessionRow>(`${SESSION_SQL} where id = $1`, [id])).rows[0];
  if (!row) throw new NotFoundError(`No session #${id}.`);
  return toSessionView(row);
}

/** Recent sessions (or those on one date), newest first, for picking where a note came from. */
export async function sessionList(q: Queryable, opts: { limit?: number; date?: string } = {}): Promise<SessionView[]> {
  const { rows } = await q.query<SessionRow>(
    `${SESSION_SQL} where ($2::date is null or date = $2) order by date desc, id desc limit $1`,
    [Math.min(Math.max(opts.limit ?? 12, 1), 100), opts.date ?? null],
  );
  return rows.map(toSessionView);
}

export interface LogSessionInput extends SessionDetails {
  date?: string;
}

export async function logSession(ctx: Ctx, input: LogSessionInput): Promise<string> {
  return ctx.db.tx(async q => {
    const date = input.date ?? today(ctx);
    const found = await findOrCreateSession(q, date, input);
    const attached = (
      await q.query<{ id: number }>(
        'update notes set session_id = $1 where observed_on = $2 and session_id is null returning id',
        [found.id, date],
      )
    ).rows.map(r => r.id);
    const label = sessionLabel(found.view);
    if (found.created || found.before || attached.length) {
      await logActivity(q, 'log_session', label, {
        kind: 'delete_session',
        sessionId: found.id,
        attachedNoteIds: attached,
        created: found.created,
        before: found.before,
      });
    }
    const phrase = sessionPhrase(found.view);
    const lead = found.created ? `Logged ${phrase}` : found.before ? `Updated ${phrase}` : `Already logged: ${label}`;
    return `${lead}${attached.length ? ` and attached ${attached.length} note${attached.length > 1 ? 's' : ''} from that day` : ''}.`;
  });
}
