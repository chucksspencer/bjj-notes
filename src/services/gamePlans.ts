// Game plans: parts of the game, each with a description, techniques, notes and optionally steps (where it starts,
// then a main line with branches for how the opponent reacts: what's called a "system"). Being on the focus list is
// just a state of a game plan: it has a rank, or it doesn't.
import { uid, type Queryable } from '../db.js';
import { describeMiss, resolveGamePlan, resolvePosition, resolveTechnique, techniquesMentionedIn, type Resolution } from '../resolve.js';
import type { GamePlanLinksInput, GamePlanPatch, Role } from '../shared/api.js';
import { stepsIn } from '../shared/steps.js';
import {
  logActivity,
  refreshInbox,
  renumberFocus,
  STEP_SNAPSHOT_SQL,
  type GamePlanLinkIds,
  type GamePlanSnapshot,
  type FocusSnapshot,
  type StepSnapshot,
  type UndoOp,
} from './activity.js';
import { mediaTag } from './attachments.js';
import { today, type Ctx } from './context.js';
import { UserError } from './errors.js';
import { lockGamePlan, lowerFirst, resolveStepIds, resolveStepNames, stepLines, writeSteps, type NamedStepInput, type ResolvedStep } from './steps.js';
import { gamePlansView, gamePlanView, focusView } from './views.js';
import { daysAgo, type FocusAction } from './vocab.js';

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
const capitalise = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);
const clean = (t: string | null | undefined) => t?.trim() || null;

// ---------- the focus list ----------

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

/** The focus list as it stands, plus one more game plan, to put back on undo. */
async function focusSnapshot(q: Queryable, alsoId?: number): Promise<FocusSnapshot[]> {
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
async function placeOnFocus(
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

/** Makes a game plan; returns its id. */
async function insertGamePlan(q: Queryable, name: string, description?: string | null): Promise<number> {
  const { rows } = await q.query<{ id: number }>('insert into game_plans (name, description, user_id) values ($1, $2, $3) returning id', [
    name,
    clean(description),
    uid(q),
  ]);
  return rows[0]!.id;
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

// ---------- links ----------

/** The given ids of the signed-in person's techniques or notes (anything else is left out). */
async function ownRows(q: Queryable, table: 'techniques' | 'notes', ids: number[]): Promise<{ id: number; name: string }[]> {
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
async function linkIn(q: Queryable, id: number, change: GamePlanLinksInput) {
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
  // A note filed under a game plan is filed: it leaves the inbox (and comes back if that was all that filed it).
  await refreshInbox(q, [...added.notes, ...removed.notes]);

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

/** Links techniques and notes to a game plan, or unlinks them (from the web app). */
export async function linkGamePlan(ctx: Ctx, id: number, change: GamePlanLinksInput): Promise<string> {
  return ctx.db.tx(async q => {
    const gamePlan = (await q.query<{ name: string }>('select name from game_plans where id = $1 and user_id = $2', [id, uid(q)])).rows[0];
    if (!gamePlan) return `No game plan #${id}.`;
    const r = await linkIn(q, id, change);
    if (!r.undo) return `Nothing changed on ${gamePlan.name}.`;
    await logActivity(q, 'link_game_plan', `links on "${gamePlan.name}"`, r.undo);
    return `${capitalise(r.parts.join('; '))} on ${gamePlan.name}.`;
  });
}

// ---------- editing a game plan (its steps are in steps.ts) ----------

interface Fields {
  name?: string;
  aliases?: string[];
  description?: string | null;
  start_position_id?: number | null;
  start_role?: Role | null;
  premise?: string | null;
}

/**
 * Changes a game plan's own fields and (when given) its steps. Returns what changed in words and the undo for it;
 * null if there's no such game plan.
 */
async function editIn(q: Queryable, id: number, f: Fields, steps?: ResolvedStep[], expectedUpdatedAt?: string) {
  const me = uid(q);
  if (!(await q.query('select 1 from game_plans where id = $1 and user_id = $2', [id, me])).rows.length) return null;
  const before = await lockGamePlan(q, id, expectedUpdatedAt);
  const after: GamePlanSnapshot = {
    id,
    name: f.name?.trim() || before.name,
    aliases: f.aliases ? [...new Set(f.aliases.map(a => a.trim()).filter(Boolean))] : before.aliases,
    description: f.description !== undefined ? clean(f.description) : before.description,
    start_position_id: f.start_position_id !== undefined ? f.start_position_id : before.start_position_id,
    start_role: f.start_role !== undefined ? f.start_role : (before.start_role as Role | null),
    premise: f.premise !== undefined ? clean(f.premise) : before.premise,
  };
  const parts: string[] = [];
  if (after.name !== before.name) parts.push(`renamed to ${after.name}`);
  if (after.aliases.join('|') !== before.aliases.join('|')) parts.push('aliases updated');
  if (after.description !== before.description) parts.push(after.description ? 'description updated' : 'description cleared');
  if (after.start_position_id !== before.start_position_id || after.start_role !== before.start_role) {
    parts.push(after.start_position_id || after.start_role ? 'start updated' : 'start cleared');
  }
  if (after.premise !== before.premise) parts.push(after.premise ? 'premise updated' : 'premise cleared');
  const fieldsChanged = parts.length > 0;
  if (fieldsChanged) {
    await q.query(
      `update game_plans set name = $2, aliases = $3, description = $4, start_position_id = $5, start_role = $6, premise = $7, updated_at = now()
       where id = $1 and user_id = $8`,
      [id, after.name, after.aliases, after.description, after.start_position_id, after.start_role, after.premise, me],
    );
  }
  let stepsBefore: StepSnapshot[] | undefined;
  let linked: number[] = [];
  if (steps) {
    stepsBefore = (await q.query<StepSnapshot>(STEP_SNAPSHOT_SQL, [id, me])).rows;
    linked = await writeSteps(q, id, steps);
    parts.push(steps.length ? `steps saved (${plural(steps.length, 'step')})` : stepsBefore.length ? 'steps cleared' : 'no steps');
  }
  const ops: UndoOp[] = [];
  if (fieldsChanged || steps) ops.push({ kind: 'restore_game_plan', before, ...(stepsBefore ? { steps: stepsBefore } : {}) });
  if (linked.length) ops.push({ kind: 'restore_game_plan_links', gamePlanId: id, added: { techniques: linked, notes: [] }, removed: { techniques: [], notes: [] } });
  return { before: before.name, name: after.name, parts, ops };
}

/**
 * Changes a game plan from the web app: its fields and, when given, all its steps (what "Describe it" saves).
 * With `expectedUpdatedAt`, nothing is saved if the game plan has changed since the app last read it.
 */
export async function editGamePlan(ctx: Ctx, id: number, patch: GamePlanPatch): Promise<string> {
  return ctx.db.tx(async q => {
    if (patch.startPositionId) {
      const ok = (await q.query('select 1 from positions where id = $1', [patch.startPositionId])).rows.length > 0;
      if (!ok) throw new UserError(`No position #${patch.startPositionId}.`);
    }
    const steps = patch.steps ? await resolveStepIds(q, patch.steps) : undefined;
    const r = await editIn(
      q,
      id,
      {
        name: patch.name,
        aliases: patch.aliases,
        description: patch.description,
        start_position_id: patch.startPositionId,
        start_role: patch.startRole,
        premise: patch.premise,
      },
      steps,
      patch.expectedUpdatedAt,
    );
    if (!r) return `No game plan #${id}.`;
    if (r.ops.length) await logActivity(q, 'edit_game_plan', `edit to "${r.before}"`, r.ops.length === 1 ? r.ops[0]! : { kind: 'batch', ops: r.ops });
    return r.parts.length ? `${r.name}: ${r.parts.join('; ')}.` : `Nothing changed on ${r.name}.`;
  });
}

export interface SaveGamePlanInput {
  /** Matched against names, aliases and linked techniques; a new game plan is made when nothing matches. */
  name: string;
  rename_to?: string;
  aliases?: string[];
  description?: string;
  /** Techniques to link (by name). */
  techniques?: string[];
  /** Where it starts, e.g. "half guard". An empty string clears it. */
  start?: string;
  start_role?: Role;
  premise?: string;
  /** Replaces all the steps. An empty list clears them. */
  steps?: NamedStepInput[];
  /** true puts it on the focus list (at position, default the top); false takes it off. */
  focus?: boolean;
  position?: number;
}

/** Makes or changes a game plan by name (for Claude): fields, steps, links and focus, undone together. */
export async function saveGamePlan(ctx: Ctx, input: SaveGamePlanInput): Promise<string> {
  return ctx.db.tx(async q => {
    const misses: string[] = [];
    const found = await resolveGamePlan(q, input.name);
    let id: number;
    let created = false;
    if (found.match) {
      id = found.match.id;
    } else {
      const name = input.name.trim();
      if (!name) return 'A game plan needs a name.';
      id = await insertGamePlan(q, name);
      created = true;
      if (found.candidates.length) misses.push(`made a new game plan; closest existing: ${found.candidates.map(c => c.name).join(', ')}`);
    }
    const snapshot = await focusSnapshot(q, created ? undefined : id);

    let start: number | null | undefined;
    if (input.start !== undefined) {
      if (!input.start.trim()) start = null;
      else {
        const r = await resolvePosition(q, input.start);
        if (r.match) start = r.match.id;
        else misses.push(describeMiss('position', input.start, r).replace(/\.$/, ''));
      }
    }
    const steps = input.steps ? await resolveStepNames(q, input.steps, misses) : undefined;
    const edit = (await editIn(
      q,
      id,
      { name: input.rename_to, aliases: input.aliases, description: input.description, start_position_id: start, start_role: input.start_role, premise: input.premise },
      steps,
    ))!;
    const ops: UndoOp[] = [...edit.ops];
    const parts = [...edit.parts];

    const techniqueIds: number[] = [];
    for (const n of input.techniques ?? []) {
      const r = await resolveTechnique(q, n);
      if (r.match) techniqueIds.push(r.match.id);
      else misses.push(describeMiss('technique', n, r).replace(/\.$/, ''));
    }
    const links = await linkIn(q, id, { add: { techniqueIds } });
    if (links.undo) ops.push(links.undo);
    parts.push(...links.parts);

    const eventIds: number[] = [];
    if (input.focus !== undefined) {
      const was = snapshot.find(s => s.id === id)?.rank ?? null;
      if (input.focus || was !== null) {
        const placed = await placeOnFocus(q, id, input.focus ? (input.position ?? (was === null ? 1 : was)) : null);
        if (placed.eventId) {
          eventIds.push(placed.eventId);
          parts.push(placed.to === null ? 'taken off focus' : placed.from === null ? `on focus at #${placed.to}` : `moved to #${placed.to}`);
        }
      }
    }
    if (created || eventIds.length) {
      ops.push({ kind: 'restore_focus', items: snapshot, deleteGamePlanId: created ? id : null, eventIds });
    }
    // A new game plan is undone by deleting it, which takes its steps and links with it.
    const undo: UndoOp | null = created ? ops[ops.length - 1]! : ops.length ? (ops.length === 1 ? ops[0]! : { kind: 'batch', ops }) : null;
    if (undo) await logActivity(q, 'save_game_plan', created ? `new game plan "${edit.name}"` : `edit to "${edit.before}"`, undo);

    // Read the start back by name, so a misheard position is easy to catch.
    if (start) {
      const pos = (await q.query<{ name: string }>('select name from positions where id = $1', [start])).rows[0]!.name;
      const at = parts.indexOf('start updated');
      const said = `starts in ${pos}${input.start_role ? ` (${input.start_role})` : ''}`;
      if (at >= 0) parts[at] = said;
      else if (created) parts.unshift(said);
    }
    // A new game plan's own fields go without saying.
    const shown = created ? parts.filter(p => !['start updated', 'premise updated', 'description updated', 'aliases updated', 'no steps'].includes(p)) : parts;
    const head = created ? `New game plan: ${edit.name}` : edit.name;
    const said = shown.length ? `${head}: ${shown.join('; ')}` : created ? head : `Nothing changed on ${edit.name}`;
    return `${said}${misses.length ? ` (${misses.join('; ')})` : ''}.`;
  });
}

/** Makes a game plan from the web app; on the focus list unless asked otherwise. Returns its id. */
export async function createGamePlan(
  ctx: Ctx,
  input: { name: string; description?: string; techniqueIds?: number[]; noteIds?: number[]; focus?: boolean; position?: number },
): Promise<{ message: string; id: number }> {
  if (input.focus !== false) {
    const message = await updateFocus(ctx, {
      action: 'add',
      item: input.name,
      create: true,
      description: input.description,
      technique_ids: input.techniqueIds,
      note_ids: input.noteIds,
      position: input.position,
    });
    const id = (await ctx.db.query<{ id: number }>('select id from game_plans where user_id = $1 order by id desc limit 1', [uid(ctx.db)])).rows[0]!.id;
    return { message, id };
  }
  return ctx.db.tx(async q => {
    const name = input.name.trim();
    if (!name) throw new UserError('A game plan needs a name.');
    const id = await insertGamePlan(q, name, input.description);
    const links = await linkIn(q, id, { add: { techniqueIds: input.techniqueIds, noteIds: input.noteIds } });
    await logActivity(q, 'save_game_plan', `new game plan "${name}"`, { kind: 'restore_focus', items: [], deleteGamePlanId: id, eventIds: [] });
    return { message: `New game plan: ${name}${links.parts.length ? ` (${links.parts.join('; ')})` : ''}.`, id };
  });
}

/** Deletes a game plan for good (its notes and techniques stay). Undo puts it back, steps and history included. */
export async function deleteGamePlan(ctx: Ctx, target: { id?: number; name?: string }): Promise<string> {
  return ctx.db.tx(async q => {
    const me = uid(q);
    let id = target.id;
    if (id === undefined) {
      const r = await resolveGamePlan(q, target.name ?? '');
      if (!r.match) return describeMiss('game plan', target.name ?? '', r);
      id = r.match.id;
    }
    const row = (
      await q.query<GamePlanSnapshot & { rank: number | null; created_at: string; updated_at: string }>(
        `select id, name, aliases, description, start_position_id, start_role, premise, rank,
                created_at::text as created_at, updated_at::text as updated_at
         from game_plans where id = $1 and user_id = $2`,
        [id, me],
      )
    ).rows[0];
    if (!row) return `No game plan #${id}.`;
    const techniqueIds = (
      await q.query<{ technique_id: number }>('select technique_id from game_plan_techniques where game_plan_id = $1 and user_id = $2', [id, me])
    ).rows.map(r => r.technique_id);
    const noteIds = (await q.query<{ note_id: number }>('select note_id from game_plan_notes where game_plan_id = $1 and user_id = $2', [id, me])).rows.map(
      r => r.note_id,
    );
    const steps = (await q.query<StepSnapshot>(STEP_SNAPSHOT_SQL, [id, me])).rows;
    const events = (
      await q.query<Extract<UndoOp, { kind: 'restore_deleted_game_plan' }>['events'][number]>(
        `select id, event, from_rank, to_rank, at::text as at from focus_events where game_plan_id = $1 and user_id = $2 order by id`,
        [id, me],
      )
    ).rows;
    await q.query('delete from game_plans where id = $1 and user_id = $2', [id, me]);
    await renumberFocus(q);
    await refreshInbox(q, noteIds);
    await logActivity(q, 'delete_game_plan', `delete "${row.name}"`, { kind: 'restore_deleted_game_plan', row, techniqueIds, noteIds, steps, events });
    return `Deleted ${row.name}.${noteIds.length ? ` Its ${plural(noteIds.length, 'note')} stay.` : ''}`;
  });
}

// ---------- reading, for Claude and Siri ----------

const STATUS_ORDER = ['seen', 'learning', 'drilling', 'hitting', 'reliable'];

/** One game plan as text: where it is on focus, its steps read as if/then, techniques and notes. */
export async function getGamePlan(ctx: Ctx, name: string): Promise<string> {
  const r = await resolveGamePlan(ctx.db, name);
  if (!r.match) return describeMiss('game plan', name, r);
  const v = (await gamePlanView(ctx.db, r.match.id))!;
  const now = new Date(`${today(ctx)}T12:00:00Z`);
  const where = v.rank ? `#${v.rank} on your focus list` : 'off focus';
  const lines = [`${v.name}. ${where}; ${daysAgo(v.lastNoteOn, now)}.`];
  if (v.aliases.length) lines.push(`Also called: ${v.aliases.join(', ')}.`);
  if (v.start || v.premise) {
    const from = v.start ? `Starts in ${v.start.name}${v.startRole ? `, ${v.startRole}` : ''}` : 'Starts';
    lines.push(`${from}${v.premise ? `, when ${lowerFirst(v.premise)}` : ''}.`);
  }
  if (v.description) lines.push(v.description);
  if (v.steps.length) {
    lines.push('Steps:', ...stepLines(v.steps));
    const carded = stepsIn(v.steps).filter(s => s.technique);
    if (carded.length) {
      const weakest = carded.reduce((a, b) => (STATUS_ORDER.indexOf(b.technique!.status) < STATUS_ORDER.indexOf(a.technique!.status) ? b : a));
      lines.push(`Weakest step: ${weakest.technique!.name} (${weakest.technique!.status}).`);
    }
  } else {
    lines.push('No steps yet.');
  }
  lines.push(v.techniques.length ? `Techniques: ${v.techniques.map(t => `${t.name} (${t.status})`).join(', ')}.` : 'No techniques linked.');
  if (v.notes.length) {
    lines.push(`Notes filed here (${v.notes.length}):`);
    for (const n of v.notes.slice(0, 15)) {
      const body = n.body.length > 160 ? `${n.body.slice(0, 157)}...` : n.body;
      lines.push(`- #${n.id} ${n.observedOn}${mediaTag(n.attachments)}: ${body}`);
    }
    if (v.notes.length > 15) lines.push(`- and ${v.notes.length - 15} more`);
  }
  if (v.relatedCount) lines.push(`${plural(v.relatedCount, 'other note')} on its techniques.`);
  return lines.join('\n');
}

/** Every game plan, grouped by where it starts, with its place on focus. */
export async function listGamePlans(ctx: Ctx): Promise<string> {
  const { gamePlans } = await gamePlansView(ctx);
  if (!gamePlans.length) return 'No game plans yet.';
  const groups = new Map<string, string[]>();
  for (const a of gamePlans) {
    const key = a.start ? `${a.start.name}${a.startRole ? ` (${a.startRole})` : ''}` : 'No starting position';
    const bits = [a.rank ? `#${a.rank} on focus` : null, a.stepCount ? plural(a.stepCount, 'step') : null].filter(Boolean);
    groups.set(key, [...(groups.get(key) ?? []), `${a.name}${bits.length ? ` [${bits.join(', ')}]` : ''}`]);
  }
  const lines: string[] = [];
  const none = groups.get('No starting position');
  groups.delete('No starting position');
  for (const [k, v] of [...groups].sort(([a], [b]) => a.localeCompare(b))) lines.push(`${k}: ${v.join('; ')}`);
  if (none) lines.push(`No starting position: ${none.join('; ')}`);
  return lines.join('\n');
}
