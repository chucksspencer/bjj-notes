// The focus list: the few game plans being worked on now, in order. Being on it is just a state of a game plan (it
// has a rank, or it doesn't); every change is also written to focus_events, which is the list's history.
import { uid, type Queryable } from '../db.js';
import { describeMiss, resolveGamePlan, resolveTechnique, techniquesMentionedIn, type Resolution } from '../resolve.js';
import { logActivity, type FocusSnapshot, type UndoOp } from './activity.js';
import type { Ctx } from './context.js';
import { insertGamePlan, linkIn, ownRows } from './gamePlanLinks.js';
import { focusView } from './views/gamePlans.js';
import { daysAgo, type FocusAction } from './vocab.js';

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

// ---------- reading it ----------


export async function getFocus(ctx: Ctx): Promise<string> {
  const view = await focusView(ctx);
  const now = new Date(`${view.today}T12:00:00Z`);
  const lines: string[] = [];
  if (view.active.length) {
    lines.push('Focus:');
    for (const a of view.active) lines.push(`${a.rank}. ${a.name} — ${daysAgo(a.lastNoteOn, now)}`);
  } else {
    lines.push('Nothing on the focus list.');
  }
  const off = (await ctx.db.query<{ c: number }>('select count(*)::int as c from game_plans where user_id = $1 and rank is null', [uid(ctx.db)]))
    .rows[0]!.c;
  if (off) lines.push(`${plural(off, 'other game plan')} off focus (get_game_plan lists them all).`);
  return lines.join('\n');
}

// ---------- placing, moving, taking off ----------

/** The focus list as it stands, plus one more game plan, to put back on undo. */
export async function focusSnapshot(q: Queryable, alsoId?: number): Promise<FocusSnapshot[]> {
  return (
    await q.query<FocusSnapshot>('select id, rank from game_plans where user_id = $1 and (rank is not null or id = $2) order by id', [
      uid(q),
      alsoId ?? null,
    ])
  ).rows;
}

const clampPos = (p: number | undefined, len: number) => Math.min(Math.max(1, Math.round(p ?? 1)), len + 1);

/**
 * Puts a game plan on the focus list at a position (default the top), or takes it off (position null), renumbers
 * the rest and records the change. Returns the event's id, or null when nothing changed.
 */
export async function placeOnFocus(
  q: Queryable,
  gamePlanId: number,
  position: number | undefined | null,
): Promise<{ eventId: number | null; from: number | null; to: number | null }> {
  const me = uid(q);
  const ranked = (await q.query<{ id: number; rank: number }>('select id, rank from game_plans where user_id = $1 and rank is not null order by rank, id', [me]))
    .rows;
  const from = ranked.find(r => r.id === gamePlanId)?.rank ?? null;
  const ids = ranked.map(r => r.id).filter(id => id !== gamePlanId);
  let to: number | null = null;
  if (position !== null) {
    to = clampPos(position, ids.length);
    ids.splice(to - 1, 0, gamePlanId);
  }
  if (from === to) return { eventId: null, from, to };
  if (to === null) await q.query('update game_plans set rank = null, updated_at = now() where id = $1 and user_id = $2', [gamePlanId, me]);
  for (const [i, id] of ids.entries()) {
    await q.query('update game_plans set rank = $2 where id = $1 and user_id = $3 and rank is distinct from $2', [id, i + 1, me]);
  }
  if (to !== null) await q.query('update game_plans set updated_at = now() where id = $1 and user_id = $2', [gamePlanId, me]);
  const event = from === null ? 'added' : to === null ? 'removed' : 'moved';
  const { rows } = await q.query<{ id: number }>(
    'insert into focus_events (game_plan_id, user_id, event, from_rank, to_rank) values ($1, $2, $3, $4, $5) returning id',
    [gamePlanId, me, event, from, to],
  );
  return { eventId: rows[0]!.id, from, to };
}

/** What a focus change did, in words. */
function focusVerb(from: number | null, to: number | null): string {
  if (to === null) return 'Taken off focus';
  if (from === null) return `On focus at #${to}`;
  return `Moved to #${to}`;
}

export interface UpdateFocusInput {
  action: FocusAction;
  /** The game plan's name, or the name of a technique linked to it. For "add", a new game plan's name if none matches. */
  item: string;
  /** The game plan's id (from the web app); skips name matching. */
  game_plan_id?: number;
  /** Exact technique ids to link to a new game plan (from the web app). */
  technique_ids?: number[];
  /** 1 = top of the focus list. Used by add and move. */
  position?: number;
  /** Techniques to link to the game plan. On creating one, defaults to a technique its name mentions. */
  techniques?: string[];
  /** On creating a game plan: what it's about. */
  description?: string;
  /** Exact note ids to file under the game plan. */
  note_ids?: number[];
  /** Make a new game plan even if one with a similar name exists (the web app's "New game plan"). */
  create?: boolean;
}


/** Puts a game plan on or off the focus list, or moves it; can make the game plan first. */
export async function updateFocus(ctx: Ctx, input: UpdateFocusInput): Promise<string> {
  const action = input.action;
  return ctx.db.tx(async q => {
    const me = uid(q);
    const extra: string[] = [];
    const ops: UndoOp[] = [];
    let gamePlanId: number;
    let name: string;
    let created = false;

    if (input.game_plan_id !== undefined) {
      const row = (await q.query<{ name: string }>('select name from game_plans where id = $1 and user_id = $2', [input.game_plan_id, me])).rows[0];
      if (!row) return `No game plan #${input.game_plan_id}.`;
      gamePlanId = input.game_plan_id;
      name = row.name;
    } else {
      // Taking something off looks at what's on focus first, so "drop guard retention" finds the one on the list.
      let r: Resolution = action === 'remove' ? await resolveGamePlan(q, input.item, true) : { match: null, candidates: [] };
      if (!r.match && !input.create) r = await resolveGamePlan(q, input.item);
      if (r.match && !input.create) {
        gamePlanId = r.match.id;
        name = r.match.name;
      } else if (action === 'add') {
        name = input.item.trim();
        if (!name) return 'A game plan needs a name.';
        gamePlanId = await insertGamePlan(q, name, input.description);
        created = true;
      } else {
        return describeMiss('game plan', input.item, r);
      }
    }
    const snapshot = await focusSnapshot(q, created ? undefined : gamePlanId);
    const before = snapshot.find(s => s.id === gamePlanId)?.rank ?? null;

    // Techniques: given ones, or (for a new game plan) the card its name is or mentions.
    let techniqueIds: number[] = [];
    if (input.technique_ids?.length) {
      techniqueIds = (await ownRows(q, 'techniques', input.technique_ids)).map(t => t.id);
    } else if (input.techniques?.length) {
      for (const n of input.techniques) {
        const r = await resolveTechnique(q, n);
        if (r.match) techniqueIds.push(r.match.id);
        else extra.push(describeMiss('technique', n, r).replace(/\.$/, ''));
      }
    } else if (created) {
      const r = await resolveTechnique(q, name);
      const found = r.match ? [r.match] : await techniquesMentionedIn(q, name);
      techniqueIds = found.map(t => t.id);
      if (found.length) extra.push(`linked to ${found.map(t => t.name).join(', ')}`);
    }
    const links = await linkIn(q, gamePlanId, { add: { techniqueIds, noteIds: input.note_ids } });
    if (input.techniques?.length || input.technique_ids?.length || input.note_ids?.length) extra.push(...links.parts);
    if (created && !links.added.techniques.length) extra.push('not linked to a technique card yet');

    let verb: string;
    let eventIds: number[] = [];
    if (action === 'add' && before !== null && input.position === undefined) {
      verb = `Already #${before} on focus`;
    } else if (action === 'remove' && before === null) {
      verb = 'Already off focus';
    } else {
      const placed = await placeOnFocus(q, gamePlanId, action === 'remove' ? null : input.position);
      eventIds = placed.eventId ? [placed.eventId] : [];
      verb = created ? `New game plan, on focus at #${placed.to}` : placed.eventId ? focusVerb(placed.from, placed.to) : `Already #${placed.to}`;
    }

    if (!created && links.undo) ops.push(links.undo);
    ops.push({ kind: 'restore_focus', items: snapshot, deleteGamePlanId: created ? gamePlanId : null, eventIds });
    await logActivity(q, 'update_focus', `${action} "${name}"`, ops.length === 1 ? ops[0]! : { kind: 'batch', ops });
    return `${verb}: ${name}${extra.length ? ` (${extra.join('; ')})` : ''}.`;
  });
}

/** Focus history for one game plan or the whole list, oldest first. */
export async function focusHistory(ctx: Ctx, item?: string, limit = 30): Promise<string> {
  let where = 'where e.user_id = $2';
  const params: unknown[] = [limit, uid(ctx.db)];
  if (item) {
    const r = await resolveGamePlan(ctx.db, item);
    if (!r.match) return describeMiss('game plan', item, r);
    where += ' and e.game_plan_id = $3';
    params.push(r.match.id);
  }
  const rows = (
    await ctx.db.query<{ at: string; name: string; event: string; to_rank: number | null }>(
      `select * from (
         select e.at::date::text as at, a.name, e.event, e.to_rank, e.id
         from focus_events e join game_plans a on a.id = e.game_plan_id and a.user_id = e.user_id ${where}
         order by e.id desc limit $1) x
       order by id`,
      params,
    )
  ).rows;
  if (!rows.length) return 'No focus history yet.';
  return rows.map(r => `${r.at} ${r.event}${r.to_rank ? ` (#${r.to_rank})` : ''}: ${r.name}`).join('\n');
}

/** Closes gaps in the focus list so it runs 1, 2, 3... */
export async function renumberFocus(q: Queryable): Promise<void> {
  await q.query(
    `update game_plans a set rank = r.pos
     from (select id, row_number() over (order by rank, id)::int as pos from game_plans where user_id = $1 and rank is not null) r
     where a.id = r.id and a.rank is distinct from r.pos`,
    [uid(q)],
  );
}
