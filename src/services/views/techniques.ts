// Technique views: one card's page (its notes, links, moves between positions) and the library's lists.
import type { EdgeView, GamePlanRef, LinkView, Role, TechniqueListItem, TechniqueRef, TechniqueType, TechniqueView } from '../../shared/api.js';
import { uid, type Queryable } from '../../db.js';
import { GAME_PLAN_ORDER, iso, json, originMatches, originText, TECH_REF_JSON } from './sql.js';
import { noteList } from './notes.js';

export interface EdgeRow {
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

export function toEdge(r: EdgeRow): EdgeView {
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

  const edges = (await q.query<EdgeRow>(`${EDGE_SELECT} where e.technique_id = $1 and e.user_id = $2 order by e.id`, [id, uid(q)])).rows.map(toEdge);
  const links = (
    await q.query<{ kind: LinkView['kind']; dir: 'out' | 'in'; note: string | null; ref: unknown }>(
      `select l.kind, 'out' as dir, l.note, ${TECH_REF_JSON} as ref
       from technique_links l join techniques t on t.id = l.to_id where l.from_id = $1 and l.user_id = $2
       union all
       select l.kind, 'in' as dir, l.note, ${TECH_REF_JSON} as ref
       from technique_links l join techniques t on t.id = l.from_id where l.to_id = $1 and l.user_id = $2`,
      [id, uid(q)],
    )
  ).rows.map(r => ({ kind: r.kind, direction: r.dir, note: r.note, technique: json<TechniqueRef>(r.ref) }));
  const gamePlans = (
    await q.query<GamePlanRef>(
      `select a.id, a.name, a.rank from game_plans a
       where a.user_id = $2 and exists (select 1 from game_plan_cards ax where ax.game_plan_id = a.id and ax.technique_id = $1 and ax.user_id = $2)
       order by ${GAME_PLAN_ORDER}`,
      [id, uid(q)],
    )
  ).rows;
  const notes = noteLimit > 0 ? await noteList(q, { techniqueId: id, limit: noteLimit }) : [];
  const counts = (
    await q.query<{ c: number; last: string | null }>(
      `select count(*)::int as c, max(n.observed_on)::text as last
       from note_techniques nt join notes n on n.id = nt.note_id where nt.technique_id = $1 and nt.user_id = $2`,
      [id, uid(q)],
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
    gamePlans,
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
  /** Only these techniques. */
  ids?: number[];
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
       and ($10::int[] is null or t.id = any($10::int[]))
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
      f.ids ?? null,
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
