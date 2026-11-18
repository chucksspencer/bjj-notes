// Note views: one note, lists of notes with their filters, and what counts as being in the inbox.
import type { GamePlanRef, NoteView, SessionView, SourceKind, TechniqueRef } from '../../shared/api.js';
import { uid, type Queryable } from '../../db.js';
import { ATTACHMENTS_JSON } from '../attachments.js';
import { GAME_PLAN_ORDER, GAME_PLAN_REF_JSON, iso, json, originMatches, originText, TECH_REF_JSON } from './sql.js';

/**
 * Whether a note (aliased `alias`) is in the inbox: it isn't on the To try list, and either nothing files it (no
 * technique, no game plan) or a technique it named couldn't be placed (`unplaced`). Worked out here, never stored;
 * everything that lists or counts the inbox uses this.
 */
export const inboxWhere = (alias = 'n') =>
  `(not ${alias}.to_try and (${alias}.unplaced
     or (not exists (select 1 from note_techniques x where x.note_id = ${alias}.id)
         and not exists (select 1 from game_plan_notes y where y.note_id = ${alias}.id))))`;

interface NoteRow {
  id: number;
  body: string;
  raw_text: string | null;
  kind: NoteView['kind'];
  observed_on: string;
  source_timestamp: string | null;
  inbox: boolean;
  to_try: boolean;
  starred_at: string | null;
  answered_at: string | null;
  attachments: unknown;
  session_id: number | null;
  created_via: NoteView['createdVia'];
  s_id: number | null;
  s_kind: string | null;
  s_url: string | null;
  s_title: string | null;
  s_author: string | null;
  ss_date: string | null;
  ss_kind: SessionView['kind'] | null;
  ss_name: string | null;
  ss_instructor: string | null;
  ss_location: string | null;
  ss_gi: SessionView['gi'];
  techniques: unknown;
  game_plans: unknown;
}

const NOTE_SELECT = `
  select n.id, n.body, n.raw_text, n.kind, n.observed_on::text as observed_on, n.source_timestamp, ${inboxWhere('n')} as inbox, n.to_try,
         ${iso('n.starred_at')} as starred_at, ${iso('n.answered_at')} as answered_at, ${ATTACHMENTS_JSON} as attachments,
         n.session_id, n.created_via,
         s.id as s_id, s.kind as s_kind, s.url as s_url, s.title as s_title, s.author as s_author,
         ss.date::text as ss_date, ss.kind as ss_kind, ss.name as ss_name, ss.instructor as ss_instructor,
         ss.location as ss_location, ss.gi as ss_gi,
         coalesce((select json_agg(${TECH_REF_JSON} order by t.name)
                   from note_techniques nt join techniques t on t.id = nt.technique_id
                   where nt.note_id = n.id), '[]'::json) as techniques,
         coalesce((select json_agg(${GAME_PLAN_REF_JSON} order by ${GAME_PLAN_ORDER})
                   from game_plan_notes an join game_plans a on a.id = an.game_plan_id
                   where an.note_id = n.id), '[]'::json) as game_plans
  from notes n
  left join sources s on s.id = n.source_id
  left join sessions ss on ss.id = n.session_id`;

function toNote(r: NoteRow): NoteView {
  return {
    id: r.id,
    body: r.body,
    rawText: r.raw_text,
    kind: r.kind,
    observedOn: r.observed_on,
    source: r.s_id
      ? { id: r.s_id, kind: r.s_kind as SourceKind, url: r.s_url, title: r.s_title, author: r.s_author }
      : null,
    sourceTimestamp: r.source_timestamp,
    techniques: json<TechniqueRef[]>(r.techniques),
    inbox: r.inbox,
    toTry: r.to_try,
    starred: r.starred_at !== null,
    starredAt: r.starred_at,
    answered: r.answered_at !== null,
    attachments: json<NoteView['attachments']>(r.attachments),
    gamePlans: json<GamePlanRef[]>(r.game_plans),
    sessionId: r.session_id,
    session:
      r.session_id && r.ss_kind
        ? {
            id: r.session_id,
            date: r.ss_date!,
            kind: r.ss_kind,
            name: r.ss_name,
            instructor: r.ss_instructor,
            location: r.ss_location,
            gi: r.ss_gi,
          }
        : null,
    createdVia: r.created_via,
  };
}

export interface NoteQuery {
  inbox?: boolean;
  /** Only notes on (true) or off (false) the To try list. */
  toTry?: boolean;
  /** Only starred notes, most recently starred first. */
  starred?: boolean;
  kind?: NoteView['kind'];
  /** Only answered (true) or open (false) notes; meant for questions. */
  answered?: boolean;
  techniqueId?: number;
  /** Full-text search over note bodies, or words from where the note came from. */
  q?: string;
  limit?: number;
  /** Notes with id lower than this (for paging newest-first). */
  beforeId?: number;
  /** Only notes about any of these techniques. */
  techniqueIds?: number[];
  /** Only notes filed under this game plan. */
  gamePlanId?: number;
  /** Only notes on this game plan's techniques that aren't filed under it. */
  relatedToGamePlanId?: number;
  oldestFirst?: boolean;
}

export async function noteList(q: Queryable, opts: NoteQuery = {}): Promise<NoteView[]> {
  const where: string[] = [];
  const params: unknown[] = [];
  const p = (v: unknown) => {
    params.push(v);
    return `$${params.length}`;
  };
  where.push(`n.user_id = ${p(uid(q))}`);
  if (opts.inbox !== undefined) where.push(opts.inbox ? inboxWhere('n') : `not ${inboxWhere('n')}`);
  if (opts.toTry !== undefined) where.push(`n.to_try = ${p(opts.toTry)}`);
  if (opts.starred !== undefined) where.push(`n.starred_at is ${opts.starred ? 'not ' : ''}null`);
  if (opts.kind !== undefined) where.push(`n.kind = ${p(opts.kind)}`);
  if (opts.answered !== undefined) where.push(`n.answered_at is ${opts.answered ? 'not ' : ''}null`);
  if (opts.techniqueId !== undefined) {
    where.push(`exists (select 1 from note_techniques x where x.note_id = n.id and x.technique_id = ${p(opts.techniqueId)})`);
  }
  let order = opts.oldestFirst ? 'n.id asc' : opts.starred ? 'n.starred_at desc, n.id desc' : 'n.observed_on desc, n.id desc';
  if (opts.q?.trim()) {
    const tq = p(opts.q.trim());
    // The note's words, or where it came from ("Josh Jones", "Zen camp", "WIMAFC").
    where.push(`(n.search @@ websearch_to_tsquery('english', ${tq}) or ${originMatches(originText('ss', 's'), tq)})`);
    order = `ts_rank(n.search, websearch_to_tsquery('english', ${tq})) desc, n.observed_on desc, n.id desc`;
  }
  if (opts.beforeId !== undefined) where.push(`n.id < ${p(opts.beforeId)}`);
  if (opts.techniqueIds !== undefined) {
    where.push(`exists (select 1 from note_techniques x where x.note_id = n.id and x.technique_id = any(${p(opts.techniqueIds)}::int[]))`);
  }
  if (opts.gamePlanId !== undefined) {
    where.push(`exists (select 1 from game_plan_notes x where x.note_id = n.id and x.game_plan_id = ${p(opts.gamePlanId)})`);
  }
  if (opts.relatedToGamePlanId !== undefined) where.push(relatedToGamePlan(p(opts.relatedToGamePlanId)));
  const limit = p(Math.min(Math.max(opts.limit ?? 30, 1), 200));
  const { rows } = await q.query<NoteRow>(
    `${NOTE_SELECT} where ${where.join(' and ')} order by ${order} limit ${limit}`,
    params,
  );
  return rows.map(toNote);
}

/** Notes (aliased `n`) on a game plan's techniques that aren't filed under the game plan itself. */
export const relatedToGamePlan = (gamePlan: string) =>
  `(exists (select 1 from note_techniques x join game_plan_cards ax on ax.technique_id = x.technique_id and ax.user_id = x.user_id
            where x.note_id = n.id and ax.game_plan_id = ${gamePlan})
    and not exists (select 1 from game_plan_notes y where y.note_id = n.id and y.game_plan_id = ${gamePlan}))`;

export async function noteView(q: Queryable, id: number): Promise<NoteView | null> {
  const { rows } = await q.query<NoteRow>(`${NOTE_SELECT} where n.id = $1 and n.user_id = $2`, [id, uid(q)]);
  return rows[0] ? toNote(rows[0]) : null;
}
