// Game plan views: the focus list, every game plan, one game plan's page and its steps as slots and options.
import type {
  FocusEvent,
  FocusView,
  GamePlanCardRef,
  GamePlanDetail,
  GamePlanRef,
  GamePlanSlot,
  GamePlanStep,
  GamePlanView,
  GamePlansView,
  PositionRef,
  TechniqueRef,
} from '../../shared/api.js';
import { uid, type Queryable } from '../../db.js';
import { toTree, type PlacedRow } from '../../shared/steps.js';
import { today, type Ctx } from '../context.js';
import { GAME_PLAN_LAST_NOTE_SQL, GAME_PLAN_ORDER, GAME_PLAN_REF_JSON, iso, json, TECH_REF_JSON } from './sql.js';
import { noteList, relatedToGamePlan } from './notes.js';

/** A card on a game plan (from game_plan_cards, aliased `ax`, with the card as `t`): linked by someone, used by a step, or both. */
const GAME_PLAN_CARD_JSON = `json_build_object('id', t.id, 'name', t.name, 'type', t.type, 'role', t.role, 'status', t.status,
  'linked', ax.linked, 'usedInSteps', ax.in_steps)`;

interface GamePlanRow {
  id: number;
  name: string;
  aliases: string[];
  description: string | null;
  rank: number | null;
  premise: string | null;
  start_role: GamePlanView['startRole'];
  sp_id: number | null;
  sp_slug: string | null;
  sp_name: string | null;
  techniques: unknown;
  step_count: number;
  note_count: number;
  last_note: string | null;
  created_at: string;
  updated_at: string;
}

const GAME_PLAN_SELECT = `
  select a.id, a.name, a.aliases, a.description, a.rank, a.premise, a.start_role, ${iso('a.created_at')} as created_at, ${iso('a.updated_at')} as updated_at,
         sp.id as sp_id, sp.slug as sp_slug, sp.name as sp_name,
         coalesce((select json_agg(${GAME_PLAN_CARD_JSON} order by t.name)
                   from game_plan_cards ax join techniques t on t.id = ax.technique_id
                   where ax.game_plan_id = a.id and ax.user_id = a.user_id), '[]'::json) as techniques,
         (select count(*)::int from game_plan_steps st where st.game_plan_id = a.id) as step_count,
         (select count(*)::int from game_plan_notes an where an.game_plan_id = a.id) as note_count,
         ${GAME_PLAN_LAST_NOTE_SQL} as last_note
  from game_plans a
  left join positions sp on sp.id = a.start_position_id`;

const toGamePlan = (r: GamePlanRow): GamePlanView => ({
  id: r.id,
  name: r.name,
  aliases: r.aliases,
  description: r.description,
  rank: r.rank,
  start: r.sp_id ? { id: r.sp_id, slug: r.sp_slug!, name: r.sp_name! } : null,
  startRole: r.start_role,
  premise: r.premise,
  techniques: json<GamePlanCardRef[]>(r.techniques),
  stepCount: r.step_count,
  noteCount: r.note_count,
  lastNoteOn: r.last_note,
});

/** The focus list, top first. */
export async function focusView(ctx: Ctx, q: Queryable = ctx.db): Promise<FocusView> {
  const { rows } = await q.query<GamePlanRow>(`${GAME_PLAN_SELECT} where a.user_id = $1 and a.rank is not null order by a.rank, a.id`, [uid(q)]);
  return { today: today(ctx), active: rows.map(toGamePlan) };
}

/** Every game plan: on focus first, in order, then the rest by name. */
export async function gamePlansView(ctx: Ctx, q: Queryable = ctx.db): Promise<GamePlansView> {
  const { rows } = await q.query<GamePlanRow>(`${GAME_PLAN_SELECT} where a.user_id = $1 order by ${GAME_PLAN_ORDER}, a.id`, [uid(q)]);
  return { today: today(ctx), gamePlans: rows.map(toGamePlan) };
}

/** How many related notes a game plan's page shows. */
export const RELATED_NOTES = 10;

interface StepRow extends PlacedRow {
  action: string;
  note: string | null;
  to_role: GamePlanStep['toRole'];
  technique: unknown;
  tp_id: number | null;
  tp_slug: string | null;
  tp_name: string | null;
  continues_in: unknown;
}

/**
 * A game plan's steps as a tree of slots: the main line in order, each step with what follows it. A step that
 * leaves you where another game plan starts says so ("continues in").
 */
export async function stepsOf(q: Queryable, gamePlanId: number): Promise<GamePlanSlot[]> {
  const { rows } = await q.query<StepRow>(
    `select st.id, st.parent_id, st.ordinal, st.option, st.trigger, st.action, st.note, st.to_role,
            (select ${TECH_REF_JSON} from techniques t where t.id = st.technique_id) as technique,
            tp.id as tp_id, tp.slug as tp_slug, tp.name as tp_name,
            coalesce((select json_agg(${GAME_PLAN_REF_JSON} order by ${GAME_PLAN_ORDER})
                      from game_plans a
                      where a.user_id = st.user_id and a.id <> st.game_plan_id and st.to_position_id is not null
                        and a.start_position_id = st.to_position_id
                        and (st.to_role is null or a.start_role is null or a.start_role = st.to_role)), '[]'::json) as continues_in
     from game_plan_steps st
     left join positions tp on tp.id = st.to_position_id
     where st.game_plan_id = $1 and st.user_id = $2`,
    [gamePlanId, uid(q)],
  );
  return toTree(rows, r => ({
    id: r.id,
    action: r.action,
    technique: json<TechniqueRef | null>(r.technique),
    to: r.tp_id ? ({ id: r.tp_id, slug: r.tp_slug!, name: r.tp_name! } satisfies PositionRef) : null,
    toRole: r.to_role,
    note: r.note,
    continuesIn: json<GamePlanRef[]>(r.continues_in),
  }));
}

/** One game plan's page, on focus or not; null if it isn't the signed-in person's. */
export async function gamePlanView(q: Queryable, id: number): Promise<GamePlanDetail | null> {
  const row = (await q.query<GamePlanRow>(`${GAME_PLAN_SELECT} where a.id = $1 and a.user_id = $2`, [id, uid(q)])).rows[0];
  if (!row) return null;
  const notes = await noteList(q, { gamePlanId: id, limit: 200 });
  const relatedNotes = await noteList(q, { relatedToGamePlanId: id, limit: RELATED_NOTES });
  const relatedCount = (
    await q.query<{ c: number }>(`select count(*)::int as c from notes n where n.user_id = $2 and ${relatedToGamePlan('$1')}`, [id, uid(q)])
  ).rows[0]!.c;
  const history = (
    await q.query<{ at: string; event: FocusEvent; to_rank: number | null }>(
      `select ${iso('e.at')} as at, e.event, e.to_rank from focus_events e where e.game_plan_id = $1 and e.user_id = $2 order by e.id`,
      [id, uid(q)],
    )
  ).rows;
  return {
    ...toGamePlan(row),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    steps: await stepsOf(q, id),
    notes,
    relatedNotes,
    relatedCount,
    history: history.map(h => ({ at: h.at, event: h.event, toRank: h.to_rank })),
  };
}
