// SQL fragments and small helpers the views share.

export const json = <T>(v: unknown): T => (typeof v === 'string' ? (JSON.parse(v) as T) : (v as T));

export const TECH_REF_JSON = `json_build_object('id', t.id, 'name', t.name, 'type', t.type, 'role', t.role, 'status', t.status)`;

/**
 * The date of the latest note on a game plan (aliased `a`): one linked to it, or one on any of its
 * techniques. Used by the focus list, a game plan's page and the weekly review's quiet items.
 */
export const GAME_PLAN_LAST_NOTE_SQL = `greatest(
    (select max(n.observed_on) from game_plan_notes an join notes n on n.id = an.note_id where an.game_plan_id = a.id),
    (select max(n.observed_on) from notes n
       join note_techniques nt on nt.note_id = n.id
       join game_plan_cards ax on ax.technique_id = nt.technique_id
      where ax.game_plan_id = a.id and ax.user_id = a.user_id))::text`;

/**
 * The positions someone can see and use: the shared starter ones (no user_id) and their own. `p` is the table's
 * alias and `param` the placeholder holding their user id. Every read of positions goes through this.
 */
export const visiblePosition = (p: string, param: string) => `(${p}.user_id is null or ${p}.user_id = ${param})`;

/** A game plan (aliased `a`) as a GamePlanRef. */
export const GAME_PLAN_REF_JSON = `json_build_object('id', a.id, 'name', a.name, 'rank', a.rank)`;
export const GAME_PLAN_ORDER = 'a.rank nulls last, lower(a.name)';

// ---------- where notes came from ----------

/** A note's origin as searchable text: its session (event, instructor, place, kind) and its source (title, author). */
export const originText = (session: string, source: string) =>
  `lower(concat_ws(' ', ${session}.name, ${session}.instructor, ${session}.location, replace(${session}.kind, '_', ' '), ${source}.title, ${source}.author))`;

/**
 * Every word of the query appears somewhere in the text, as a whole or partial word, so "zen ca" already
 * finds "Zen camp" while typing. Only for queries of 3+ characters, so one or two letters don't match everything.
 */
export const originMatches = (text: string, param: string) =>
  `(length(trim(${param})) >= 3 and not exists (
     select 1 from regexp_split_to_table(lower(trim(${param})), '\\s+') w where position(w in ${text}) = 0))`;

/** A timestamp column as ISO 8601 text, which browsers parse (the plain ::text form isn't). */
export const iso = (col: string) => `(to_json(${col}) #>> '{}')`;
