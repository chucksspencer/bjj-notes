// What both the focus list and game plan editing are built on: making a game plan's row, and adding and removing
// its links to techniques and notes.
import { uid, type Queryable } from '../db.js';
import type { GamePlanLinksInput } from '../shared/api.js';
import type { GamePlanLinkIds, UndoOp } from './activity.js';
import { UserError } from './errors.js';

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
const clean = (t: string | null | undefined) => t?.trim() || null;

/** Makes a game plan; returns its id. */
export async function insertGamePlan(q: Queryable, name: string, description?: string | null): Promise<number> {
  const { rows } = await q.query<{ id: number }>('insert into game_plans (name, description, user_id) values ($1, $2, $3) returning id', [
    name,
    clean(description),
    uid(q),
  ]);
  return rows[0]!.id;
}

/** The given ids of the signed-in person's techniques or notes (anything else is left out). */
export async function ownRows(q: Queryable, table: 'techniques' | 'notes', ids: number[]): Promise<{ id: number; name: string }[]> {
  if (!ids.length) return [];
  const name = table === 'techniques' ? 'name' : "'#' || id";
  return (
    await q.query<{ id: number; name: string }>(`select id, ${name} as name from ${table} where id = any($1::int[]) and user_id = $2 order by id`, [
      [...new Set(ids)],
      uid(q),
    ])
  ).rows;
}

/** Adds and removes a game plan's links; returns what changed (as words) and how to take it back. */
export async function linkIn(q: Queryable, id: number, change: GamePlanLinksInput) {
  const me = uid(q);
  const added: GamePlanLinkIds = { techniques: [], notes: [] };
  const removed: GamePlanLinkIds = { techniques: [], notes: [] };
  const linkedNames: string[] = [];
  const unlinkedNames: string[] = [];

  for (const t of await ownRows(q, 'techniques', change.add?.techniqueIds ?? [])) {
    const { rows } = await q.query(
      'insert into game_plan_techniques (game_plan_id, technique_id, user_id) values ($1, $2, $3) on conflict do nothing returning technique_id',
      [id, t.id, me],
    );
    if (rows[0]) {
      added.techniques.push(t.id);
      linkedNames.push(t.name);
    }
  }
  for (const n of await ownRows(q, 'notes', change.add?.noteIds ?? [])) {
    const { rows } = await q.query('insert into game_plan_notes (game_plan_id, note_id, user_id) values ($1, $2, $3) on conflict do nothing returning note_id', [
      id,
      n.id,
      me,
    ]);
    if (rows[0]) added.notes.push(n.id);
  }
  if (change.remove?.techniqueIds?.length) {
    // A card only there because a step uses it can't be unlinked: the step would still use it.
    const inSteps = (
      await q.query<{ name: string; plan: string; actions: string[] }>(
        `select t.name, a.name as plan, array_agg(st.action order by st.id) as actions
         from game_plan_steps st join techniques t on t.id = st.technique_id and t.user_id = st.user_id
         join game_plans a on a.id = st.game_plan_id and a.user_id = st.user_id
         where st.game_plan_id = $1 and st.technique_id = any($2::int[]) and st.user_id = $3
           and not exists (select 1 from game_plan_techniques gt where gt.game_plan_id = st.game_plan_id and gt.technique_id = st.technique_id)
         group by t.id, t.name, a.name order by t.name`,
        [id, change.remove.techniqueIds, me],
      )
    ).rows;
    if (inSteps.length) {
      const [first] = inSteps;
      const steps = [...new Set(first!.actions)].map(a => `"${a}"`).join(', ');
      const which = first!.actions.length === 1 ? 'a step uses' : 'steps use';
      throw new UserError(`${first!.name} is on ${first!.plan} because ${which} it (${steps}). Change or delete the step to take it off.`);
    }
    const { rows } = await q.query<{ technique_id: number; name: string }>(
      `delete from game_plan_techniques ax using techniques t
       where ax.game_plan_id = $1 and ax.technique_id = any($2::int[]) and ax.user_id = $3 and t.id = ax.technique_id
       returning ax.technique_id, t.name`,
      [id, change.remove.techniqueIds, me],
    );
    for (const r of rows) {
      removed.techniques.push(r.technique_id);
      unlinkedNames.push(r.name);
    }
  }
  if (change.remove?.noteIds?.length) {
    const { rows } = await q.query<{ note_id: number }>(
      'delete from game_plan_notes where game_plan_id = $1 and note_id = any($2::int[]) and user_id = $3 returning note_id',
      [id, change.remove.noteIds, me],
    );
    removed.notes.push(...rows.map(r => r.note_id));
  }
  // Filing a note under a game plan is filing it: a name that couldn't be placed no longer holds it in the inbox.
  if (added.notes.length) await q.query('update notes set unplaced = false where id = any($1::int[]) and user_id = $2', [added.notes, me]);

  const parts: string[] = [];
  if (linkedNames.length || added.notes.length) {
    parts.push(`linked ${[...linkedNames, ...(added.notes.length ? [plural(added.notes.length, 'note')] : [])].join(', ')}`);
  }
  if (unlinkedNames.length || removed.notes.length) {
    parts.push(`unlinked ${[...unlinkedNames, ...(removed.notes.length ? [plural(removed.notes.length, 'note')] : [])].join(', ')}`);
  }
  const any = added.techniques.length + added.notes.length + removed.techniques.length + removed.notes.length > 0;
  const undo: UndoOp | null = any ? { kind: 'restore_game_plan_links', gamePlanId: id, added, removed } : null;
  return { parts, undo, added };
}
