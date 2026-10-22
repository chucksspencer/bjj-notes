// Read side: structured views used by the web app's JSON API and by the MCP text formatters.
import type {
  EdgeView,
  FocusItemView,
  FocusView,
  LabView,
  LinkView,
  NoteView,
  PositionCategory,
  PositionListItem,
  PositionView,
  Role,
  SessionView,
  SourceKind,
  TechniqueListItem,
  TechniqueRef,
  TechniqueType,
  TechniqueView,
} from '../shared/api.js';
import { uid, type Queryable } from '../db.js';
import { today, type Ctx } from './context.js';
import { ATTACHMENTS_JSON } from './attachments.js';
import { EXPECTED_BY_CATEGORY, minusDays } from './vocab.js';

const json = <T>(v: unknown): T => (typeof v === 'string' ? (JSON.parse(v) as T) : (v as T));

const TECH_REF_JSON = `json_build_object('id', t.id, 'name', t.name, 'type', t.type, 'role', t.role, 'status', t.status)`;

// ---------- where notes came from ----------

/** A note's origin as searchable text: its session (event, instructor, place, kind) and its source (title, author). */
const originText = (session: string, source: string) =>
  `lower(concat_ws(' ', ${session}.name, ${session}.instructor, ${session}.location, replace(${session}.kind, '_', ' '), ${source}.title, ${source}.author))`;

/**
 * Every word of the query appears somewhere in the text, as a whole or partial word, so "zen ca" already
 * finds "Zen camp" while typing. Only for queries of 3+ characters, so one or two letters don't match everything.
 */
const originMatches = (text: string, param: string) =>
  `(length(trim(${param})) >= 3 and not exists (
     select 1 from regexp_split_to_table(lower(trim(${param})), '\\s+') w where position(w in ${text}) = 0))`;

/** A timestamp column as ISO 8601 text, which browsers parse (the plain ::text form isn't). */
const iso = (col: string) => `(to_json(${col}) #>> '{}')`;

// ---------- notes ----------

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
}

const NOTE_SELECT = `
  select n.id, n.body, n.raw_text, n.kind, n.observed_on::text as observed_on, n.source_timestamp, n.inbox, n.to_try,
         ${iso('n.starred_at')} as starred_at, ${iso('n.answered_at')} as answered_at, ${ATTACHMENTS_JSON} as attachments,
         n.session_id, n.created_via,
         s.id as s_id, s.kind as s_kind, s.url as s_url, s.title as s_title, s.author as s_author,
         ss.date::text as ss_date, ss.kind as ss_kind, ss.name as ss_name, ss.instructor as ss_instructor,
         ss.location as ss_location, ss.gi as ss_gi,
         coalesce((select json_agg(${TECH_REF_JSON} order by t.name)
                   from note_techniques nt join techniques t on t.id = nt.technique_id
                   where nt.note_id = n.id), '[]'::json) as techniques
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
  if (opts.inbox !== undefined) where.push(`n.inbox = ${p(opts.inbox)}`);
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
  const limit = p(Math.min(Math.max(opts.limit ?? 30, 1), 200));
  const { rows } = await q.query<NoteRow>(
    `${NOTE_SELECT} where ${where.join(' and ')} order by ${order} limit ${limit}`,
    params,
  );
  return rows.map(toNote);
}

export async function noteView(q: Queryable, id: number): Promise<NoteView | null> {
  const { rows } = await q.query<NoteRow>(`${NOTE_SELECT} where n.id = $1 and n.user_id = $2`, [id, uid(q)]);
  return rows[0] ? toNote(rows[0]) : null;
}

// ---------- techniques ----------

interface EdgeRow {
  id: number;
  from_role: Role | null;
  to_role: Role | null;
  pf_id: number | null;
  pf_slug: string | null;
  pf_name: string | null;
  pt_id: number | null;
  pt_slug: string | null;
  pt_name: string | null;
}

const EDGE_SELECT = `
  select e.id, e.from_role, e.to_role,
         pf.id as pf_id, pf.slug as pf_slug, pf.name as pf_name,
         pt.id as pt_id, pt.slug as pt_slug, pt.name as pt_name
  from technique_edges e
  left join positions pf on pf.id = e.from_position_id
  left join positions pt on pt.id = e.to_position_id`;

function toEdge(r: EdgeRow): EdgeView {
  return {
    id: r.id,
    from: r.pf_id ? { id: r.pf_id, slug: r.pf_slug!, name: r.pf_name! } : null,
    fromRole: r.from_role,
    to: r.pt_id ? { id: r.pt_id, slug: r.pt_slug!, name: r.pt_name! } : null,
    toRole: r.to_role,
  };
}

export async function techniqueView(q: Queryable, id: number, noteLimit = 20): Promise<TechniqueView | null> {
  const t = (
    await q.query<{
      id: number;
      name: string;
      aliases: string[];
      type: TechniqueType;
      role: Role | null;
      gi: TechniqueView['gi'];
      status: TechniqueView['status'];
      summary: string | null;
      key_details: string[];
      mistakes: string[];
      updated_at: Date | string;
      starred_at: string | null;
    }>(
      `select id, name, aliases, type, role, gi, status, summary, key_details, mistakes, updated_at, ${iso('starred_at')} as starred_at
       from techniques where id = $1 and user_id = $2`,
      [id, uid(q)],
    )
  ).rows[0];
  if (!t) return null;

  const edges = (await q.query<EdgeRow>(`${EDGE_SELECT} where e.technique_id = $1 order by e.id`, [id])).rows.map(toEdge);
  const links = (
    await q.query<{ kind: LinkView['kind']; dir: 'out' | 'in'; note: string | null; ref: unknown }>(
      `select l.kind, 'out' as dir, l.note, ${TECH_REF_JSON} as ref
       from technique_links l join techniques t on t.id = l.to_id where l.from_id = $1
       union all
       select l.kind, 'in' as dir, l.note, ${TECH_REF_JSON} as ref
       from technique_links l join techniques t on t.id = l.from_id where l.to_id = $1`,
      [id],
    )
  ).rows.map(r => ({ kind: r.kind, direction: r.dir, note: r.note, technique: json<TechniqueRef>(r.ref) }));
  const focus = (
    await q.query<TechniqueView['focus'][number]>(
      `select f.id, f.label, f.status, f.rank from focus_items f
       join focus_item_techniques ft on ft.focus_item_id = f.id
       where ft.technique_id = $1 and f.status <> 'dropped' order by f.rank nulls last, f.id`,
      [id],
    )
  ).rows;
  const notes = noteLimit > 0 ? await noteList(q, { techniqueId: id, limit: noteLimit }) : [];
  const counts = (
    await q.query<{ c: number; last: string | null }>(
      `select count(*)::int as c, max(n.observed_on)::text as last
       from note_techniques nt join notes n on n.id = nt.note_id where nt.technique_id = $1`,
      [id],
    )
  ).rows[0]!;

  return {
    id: t.id,
    name: t.name,
    type: t.type,
    role: t.role,
    status: t.status,
    aliases: t.aliases,
    gi: t.gi,
    summary: t.summary,
    keyDetails: t.key_details,
    mistakes: t.mistakes,
    updatedAt: new Date(t.updated_at).toISOString(),
    edges,
    links,
    focus,
    notes,
    noteCount: counts.c,
    lastNoteOn: counts.last,
    starred: t.starred_at !== null,
    starredAt: t.starred_at,
  };
}

export interface TechniqueQuery {
  /** Name or alias (fuzzy), words in the card, or words from where its notes came from. */
  q?: string;
  type?: TechniqueType;
  role?: Role;
  status?: TechniqueView['status'];
  positionId?: number;
  /** name, last note (recent), or first note (new) */
  sort?: 'name' | 'recent' | 'new';
  limit?: number;
  /** Only techniques that first showed up in your notes on or after this date (YYYY-MM-DD). */
  newSince?: string;
  /** Only starred (true) or unstarred (false) techniques; starred ones come most recently starred first. */
  starred?: boolean;
}

/** When a technique first showed up in your notes (videos still on the To try list don't count yet). */
const FIRST_NOTE = `select min(n.observed_on) from notes n join note_techniques nt on nt.note_id = n.id
                    where nt.technique_id = t.id and not n.to_try`;

export async function techniqueList(q: Queryable, f: TechniqueQuery = {}): Promise<TechniqueListItem[]> {
  const query = f.q?.trim() || null;
  const order = query
    ? 'score desc, t.name'
    : f.starred && !f.sort
      ? 't.starred_at desc, t.name'
      : f.sort === 'recent'
      ? 'last_note desc nulls last, t.updated_at desc, t.name'
      : f.sort === 'new'
        ? 'first_note desc nulls last, t.name'
        : 'lower(t.name)';
  const { rows } = await q.query<{
    id: number;
    name: string;
    type: TechniqueType;
    role: Role | null;
    status: TechniqueView['status'];
    aliases: string[];
    score: number;
    notes: number;
    last_note: string | null;
    first_note: string | null;
    starred_at: string | null;
    edges: unknown;
  }>(
    `select t.id, t.name, t.type, t.role, t.status, t.aliases, ${iso('t.starred_at')} as starred_at,
            coalesce((select max(bjj_name_score(c, $1)) from unnest(array_prepend(t.name, t.aliases)) c), 0) as score,
            (select count(*)::int from note_techniques nt where nt.technique_id = t.id) as notes,
            (select max(n.observed_on)::text from notes n join note_techniques nt on nt.note_id = n.id
              where nt.technique_id = t.id) as last_note,
            (${FIRST_NOTE})::text as first_note,
            coalesce((select json_agg(json_build_object('from', pf.name, 'fromRole', e.from_role,
                                                        'to', pt.name, 'toRole', e.to_role) order by e.id)
                      from technique_edges e
                      left join positions pf on pf.id = e.from_position_id
                      left join positions pt on pt.id = e.to_position_id
                      where e.technique_id = t.id), '[]'::json) as edges
     from techniques t
     where t.user_id = $9
       and ($2::text is null or t.type = $2)
       and ($3::text is null or t.role = $3 or exists (
             select 1 from technique_edges e where e.technique_id = t.id and e.from_role = $3))
       and ($4::text is null or t.status = $4)
       and ($7::date is null or (${FIRST_NOTE}) >= $7)
       and ($8::boolean is null or (t.starred_at is not null) = $8)
       and ($5::int is null or exists (
             select 1 from technique_edges e where e.technique_id = t.id
               and (e.from_position_id = $5 or e.to_position_id = $5)))
       and ($1::text is null
            or (select max(bjj_name_score(c, $1)) from unnest(array_prepend(t.name, t.aliases)) c) >= 0.45
            or to_tsvector('english', coalesce(t.summary, '') || ' ' || array_to_string(t.key_details, ' ')
                                       || ' ' || array_to_string(t.mistakes, ' '))
               @@ websearch_to_tsquery('english', $1)
            -- or where its notes came from: "Zen camp", "Josh Jones", "WIMAFC", "seminar"
            or exists (
              select 1 from note_techniques nt
              join notes n on n.id = nt.note_id
              left join sessions ss on ss.id = n.session_id
              left join sources so on so.id = n.source_id
              where nt.technique_id = t.id and (n.session_id is not null or n.source_id is not null)
                and ${originMatches(originText('ss', 'so'), '$1')}))
     order by ${order}
     limit $6`,
    [
      query,
      f.type ?? null,
      f.role ?? null,
      f.status ?? null,
      f.positionId ?? null,
      Math.min(f.limit ?? 200, 500),
      f.newSince ?? null,
      f.starred ?? null,
      uid(q),
    ],
  );
  return rows.map(r => ({
    id: r.id,
    name: r.name,
    type: r.type,
    role: r.role,
    status: r.status,
    aliases: r.aliases,
    starred: r.starred_at !== null,
    starredAt: r.starred_at,
    noteCount: r.notes,
    lastNoteOn: r.last_note,
    firstNoteOn: r.first_note,
    edges: json<TechniqueListItem['edges']>(r.edges),
  }));
}

// ---------- focus ----------

export async function focusView(ctx: Ctx, q: Queryable = ctx.db): Promise<FocusView> {
  const { rows } = await q.query<{
    id: number;
    label: string;
    goal: string | null;
    status: FocusItemView['status'];
    rank: number | null;
    techniques: unknown;
    last_note: string | null;
  }>(
    `select f.id, f.label, f.goal, f.status, f.rank,
            coalesce((select json_agg(${TECH_REF_JSON} order by t.name)
                      from focus_item_techniques ft join techniques t on t.id = ft.technique_id
                      where ft.focus_item_id = f.id), '[]'::json) as techniques,
            (select max(n.observed_on)::text from notes n
               join note_techniques nt on nt.note_id = n.id
               join focus_item_techniques ft2 on ft2.technique_id = nt.technique_id
              where ft2.focus_item_id = f.id) as last_note
     from focus_items f
     where f.user_id = $1 and f.status in ('active', 'paused', 'backlog')
     order by f.rank nulls last, f.updated_at desc`,
    [uid(q)],
  );
  const items: FocusItemView[] = rows.map(r => ({
    id: r.id,
    label: r.label,
    goal: r.goal,
    status: r.status,
    rank: r.rank,
    techniques: json<TechniqueRef[]>(r.techniques),
    lastNoteOn: r.last_note,
  }));
  return {
    today: today(ctx),
    active: items.filter(i => i.status === 'active'),
    paused: items.filter(i => i.status === 'paused'),
    backlog: items.filter(i => i.status === 'backlog'),
  };
}

// ---------- lab ----------

/** How far back "new in your notes" looks, unless asked otherwise. */
export const LAB_DAYS = 30;
/** Stars are for what's pertinent now: after this many days they fold away as older stars. */
export const STAR_DAYS = 28;
/** Open questions noted longer ago than this fold away as older questions. */
export const QUESTION_DAYS = 60;

/**
 * What's in the Lab, for the web app and Claude alike: starred techniques and notes (recent ones, and
 * older ones folded away), the newest videos to try, techniques first noted in the last `days` days,
 * and open questions for the coach (recent ones, and older ones folded away).
 */
export async function labView(ctx: Ctx, days = LAB_DAYS, tryLimit = 10): Promise<LabView> {
  const q = ctx.db;
  const now = today(ctx);
  const [techniques, notes, toTry, toTryTotal, fresh, questions] = await Promise.all([
    techniqueList(q, { starred: true, limit: 200 }),
    noteList(q, { starred: true, limit: 200 }),
    noteList(q, { toTry: true, limit: tryLimit }),
    q.query<{ c: number }>('select count(*)::int as c from notes where user_id = $1 and to_try', [uid(q)]),
    techniqueList(q, { sort: 'new', newSince: minusDays(now, days), limit: 25 }),
    noteList(q, { kind: 'question', toTry: false, answered: false, limit: 200 }),
  ]);
  const starCutoff = Date.now() - STAR_DAYS * 86_400_000;
  const recent = (x: { starredAt: string | null }) => x.starredAt !== null && Date.parse(x.starredAt) >= starCutoff;
  const questionCutoff = minusDays(now, QUESTION_DAYS);
  return {
    today: now,
    days,
    starDays: STAR_DAYS,
    questionDays: QUESTION_DAYS,
    starred: { techniques: techniques.filter(recent), notes: notes.filter(recent) },
    olderStarred: { techniques: techniques.filter(t => !recent(t)), notes: notes.filter(n => !recent(n)) },
    toTry: { total: toTryTotal.rows[0]!.c, notes: toTry },
    fresh,
    questions: questions.filter(n => n.observedOn >= questionCutoff),
    olderQuestions: questions.filter(n => n.observedOn < questionCutoff),
  };
}

// ---------- positions ----------

export async function positionList(q: Queryable): Promise<PositionListItem[]> {
  const { rows } = await q.query<{
    id: number;
    slug: string;
    name: string;
    category: PositionCategory;
    aliases: string[];
    techniques: number;
  }>(
    `select p.id, p.slug, p.name, p.category, p.aliases,
            (select count(distinct e.technique_id)::int from technique_edges e
               join techniques t on t.id = e.technique_id
              where t.user_id = $1 and (e.from_position_id = p.id or e.to_position_id = p.id)) as techniques
     from positions p order by p.id`,
    [uid(q)],
  );
  return rows.map(r => ({ id: r.id, slug: r.slug, name: r.name, category: r.category, aliases: r.aliases, techniqueCount: r.techniques }));
}

export async function positionView(q: Queryable, positionId: number, role?: Role | null): Promise<PositionView | null> {
  const pos = (
    await q.query<{ id: number; slug: string; name: string; category: PositionCategory; aliases: string[]; description: string | null }>(
      'select id, slug, name, category, aliases, description from positions where id = $1',
      [positionId],
    )
  ).rows[0];
  if (!pos) return null;
  type Row = EdgeRow & { t_id: number; t_name: string; t_type: TechniqueType; t_role: Role | null; t_status: TechniqueView['status'] };
  const sel = `select e.id, e.from_role, e.to_role,
                      pf.id as pf_id, pf.slug as pf_slug, pf.name as pf_name,
                      pt.id as pt_id, pt.slug as pt_slug, pt.name as pt_name,
                      t.id as t_id, t.name as t_name, t.type as t_type, t.role as t_role, t.status as t_status
               from technique_edges e join techniques t on t.id = e.technique_id
               left join positions pf on pf.id = e.from_position_id
               left join positions pt on pt.id = e.to_position_id`;
  const toPT = (r: Row) => ({ id: r.t_id, name: r.t_name, type: r.t_type, role: r.t_role, status: r.t_status, edge: toEdge(r) });
  const from = (
    await q.query<Row>(
      `${sel} where t.user_id = $3 and e.from_position_id = $1 and ($2::text is null or e.from_role is null or e.from_role = $2)
       order by t.type, t.name`,
      [pos.id, role ?? null, uid(q)],
    )
  ).rows.map(toPT);
  const into = (
    await q.query<Row>(
      `${sel} where t.user_id = $3 and e.to_position_id = $1 and ($2::text is null or e.to_role is null or e.to_role = $2)
       order by t.name`,
      [pos.id, role ?? null, uid(q)],
    )
  ).rows.map(toPT);

  const expected = EXPECTED_BY_CATEGORY[pos.category] ?? {};
  const roles: Role[] = role ? [role] : (Object.keys(expected) as Role[]);
  const gaps: PositionView['gaps'] = [];
  for (const rl of roles) {
    for (const type of expected[rl] ?? []) {
      if (!from.some(t => t.type === type && (t.edge.fromRole === rl || t.edge.fromRole === null))) gaps.push({ role: rl, type });
    }
  }
  return { position: pos, role: role ?? null, from, into, gaps };
}
