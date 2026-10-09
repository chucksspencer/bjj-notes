import type { Queryable } from './db.js';

export interface Candidate {
  id: number;
  name: string;
  score: number;
  exact: boolean;
}

export interface Resolution {
  /** Set when the name confidently identifies one row. */
  match: Candidate | null;
  /** Closest rows when there is no confident match, best first. */
  candidates: Candidate[];
}

// Tuned against voice-transcription errors: "barra toe plata" -> Baratoplata (0.85),
// "kimora" -> Kimura (0.83), "ghost" -> Ghost escape (0.9), while "omoplata" stays
// apart from Baratoplata (0.55).
const AUTO_MATCH = 0.7;
const MARGIN = 0.15;
const CANDIDATE_FLOOR = 0.35;

function decide(rows: Candidate[]): Resolution {
  const [best, second] = rows;
  if (!best) return { match: null, candidates: [] };
  if (best.exact) return { match: best, candidates: [] };
  const clear = !second || best.score - second.score >= MARGIN;
  if (best.score >= AUTO_MATCH && clear) return { match: best, candidates: [] };
  return { match: null, candidates: rows.filter(r => r.score >= CANDIDATE_FLOOR).slice(0, 3) };
}

async function rank(q: Queryable, sql: string, name: string): Promise<Candidate[]> {
  const { rows } = await q.query<{ id: number; name: string; score: number; exact: boolean }>(sql, [name]);
  return rows.map(r => ({ id: r.id, name: r.name, score: Number(r.score), exact: r.exact }));
}

export async function resolveTechnique(q: Queryable, name: string): Promise<Resolution> {
  return decide(
    await rank(
      q,
      `select t.id, t.name,
              max(bjj_name_score(c, $1)) as score,
              bool_or(bjj_norm(c) = bjj_norm($1)) as exact
       from techniques t, unnest(array_prepend(t.name, t.aliases)) as c
       group by t.id, t.name
       order by exact desc, score desc
       limit 5`,
      name,
    ),
  );
}

export async function resolvePosition(q: Queryable, name: string): Promise<Resolution> {
  return decide(
    await rank(
      q,
      `select p.id, p.name,
              max(bjj_name_score(c, $1)) as score,
              bool_or(bjj_norm(c) = bjj_norm($1)) as exact
       from positions p, unnest(array_prepend(p.name, array_prepend(p.slug, p.aliases))) as c
       group by p.id, p.name
       order by exact desc, score desc
       limit 5`,
      name,
    ),
  );
}

/** Techniques whose name or alias appears as whole words inside a longer text, longest first. */
export async function techniquesMentionedIn(q: Queryable, text: string, limit = 3): Promise<{ id: number; name: string }[]> {
  const { rows } = await q.query<{ id: number; name: string }>(
    `select t.id, t.name
     from techniques t, unnest(array_prepend(t.name, t.aliases)) as c
     where length(bjj_norm(c)) >= 4 and position(bjj_words(c) in bjj_words($1)) > 0
     group by t.id, t.name
     order by max(length(c)) desc
     limit $2`,
    [text, limit],
  );
  return rows;
}

/** Focus items match on their label or on the name of any linked technique. */
export async function resolveFocusItem(q: Queryable, name: string, includeClosed = false): Promise<Resolution> {
  return decide(
    await rank(
      q,
      `select f.id, f.label as name,
              max(bjj_name_score(c, $1)) as score,
              bool_or(bjj_norm(c) = bjj_norm($1)) as exact
       from focus_items f
       left join focus_item_techniques ft on ft.focus_item_id = f.id
       left join techniques t on t.id = ft.technique_id
       cross join lateral unnest(array_remove(array[f.label, t.name], null)) as c
       where ${includeClosed ? 'true' : "f.status in ('active', 'paused', 'backlog')"}
       group by f.id, f.label
       order by exact desc, score desc
       limit 5`,
      name,
    ),
  );
}

export function describeMiss(kind: string, name: string, r: Resolution): string {
  if (r.candidates.length === 0) return `No ${kind} matches "${name}".`;
  return `No confident ${kind} match for "${name}". Closest: ${r.candidates.map(c => c.name).join(', ')}.`;
}
