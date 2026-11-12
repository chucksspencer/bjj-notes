// Areas: parts of the game, each with a description, techniques, notes and optionally a plan (an area with a
// plan is a "system"). Being on the focus list is just a state of an area: it has a rank, or it doesn't.
import { uid, type Queryable } from '../db.js';
import { describeMiss, resolveArea, resolvePosition, resolveTechnique, techniquesMentionedIn, type Resolution } from '../resolve.js';
import type { AreaLinksInput, AreaPatch, PlanStep, PlanStepInput, Role } from '../shared/api.js';
import {
  logActivity,
  refreshInbox,
  renumberFocus,
  STEP_SNAPSHOT_SQL,
  type AreaLinkIds,
  type AreaSnapshot,
  type FocusSnapshot,
  type StepSnapshot,
  type UndoOp,
} from './activity.js';
import { mediaTag } from './attachments.js';
import { today, type Ctx } from './context.js';
import { UserError } from './errors.js';
import { areasView, areaView, focusView } from './views.js';
import { daysAgo, type FocusAction } from './vocab.js';

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
const capitalise = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);
const clean = (t: string | null | undefined) => t?.trim() || null;

/** A plan can be this deep (0 = main line). */
export const MAX_DEPTH = 6;
/** And this long. */
export const MAX_STEPS = 60;

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
  const off = (await ctx.db.query<{ c: number }>('select count(*)::int as c from areas where user_id = $1 and rank is null', [uid(ctx.db)]))
    .rows[0]!.c;
  if (off) lines.push(`${plural(off, 'other area')} off focus (get_area lists them all).`);
  return lines.join('\n');
}

/** The focus list as it stands, plus one more area, to put back on undo. */
async function focusSnapshot(q: Queryable, alsoId?: number): Promise<FocusSnapshot[]> {
  return (
    await q.query<FocusSnapshot>('select id, rank from areas where user_id = $1 and (rank is not null or id = $2) order by id', [
      uid(q),
      alsoId ?? null,
    ])
  ).rows;
}

const clampPos = (p: number | undefined, len: number) => Math.min(Math.max(1, Math.round(p ?? 1)), len + 1);

/**
 * Puts an area on the focus list at a position (default the top), or takes it off (position null), renumbers
 * the rest and records the change. Returns the event's id, or null when nothing changed.
 */
async function placeOnFocus(
  q: Queryable,
  areaId: number,
  position: number | undefined | null,
): Promise<{ eventId: number | null; from: number | null; to: number | null }> {
  const me = uid(q);
  const ranked = (await q.query<{ id: number; rank: number }>('select id, rank from areas where user_id = $1 and rank is not null order by rank, id', [me]))
    .rows;
  const from = ranked.find(r => r.id === areaId)?.rank ?? null;
  const ids = ranked.map(r => r.id).filter(id => id !== areaId);
  let to: number | null = null;
  if (position !== null) {
    to = clampPos(position, ids.length);
    ids.splice(to - 1, 0, areaId);
  }
  if (from === to) return { eventId: null, from, to };
  if (to === null) await q.query('update areas set rank = null, updated_at = now() where id = $1 and user_id = $2', [areaId, me]);
  for (const [i, id] of ids.entries()) {
    await q.query('update areas set rank = $2 where id = $1 and user_id = $3 and rank is distinct from $2', [id, i + 1, me]);
  }
  if (to !== null) await q.query('update areas set updated_at = now() where id = $1 and user_id = $2', [areaId, me]);
  const event = from === null ? 'added' : to === null ? 'removed' : 'moved';
  const { rows } = await q.query<{ id: number }>(
    'insert into focus_events (area_id, event, from_rank, to_rank) values ($1, $2, $3, $4) returning id',
    [areaId, event, from, to],
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
  /** The area's name, or the name of a technique linked to it. For "add", a new area's name if none matches. */
  item: string;
  /** Exact area id (from the web app); skips name matching. */
  item_id?: number;
  /** Exact technique ids to link to a new area (from the web app). */
  technique_ids?: number[];
  /** 1 = top of the focus list. Used by add and move. */
  position?: number;
  /** Techniques to link to the area. On creating one, defaults to a technique its name mentions. */
  techniques?: string[];
  /** On creating an area: what it's about. */
  description?: string;
  /** Exact note ids to file under the area. */
  note_ids?: number[];
  /** Make a new area even if one with a similar name exists (the web app's "New area"). */
  create?: boolean;
}

/** The older focus actions, as what they mean now. */
const ACTION: Record<FocusAction, 'add' | 'move' | 'remove'> = {
  add: 'add',
  move: 'move',
  remove: 'remove',
  resume: 'add',
  pause: 'remove',
  backlog: 'remove',
  complete: 'remove',
  drop: 'remove',
};

/** Makes an area; returns its id. */
async function insertArea(q: Queryable, name: string, description?: string | null): Promise<number> {
  const { rows } = await q.query<{ id: number }>('insert into areas (name, description, user_id) values ($1, $2, $3) returning id', [
    name,
    clean(description),
    uid(q),
  ]);
  return rows[0]!.id;
}

/** Puts an area on or off the focus list, or moves it; can make the area first. */
export async function updateFocus(ctx: Ctx, input: UpdateFocusInput): Promise<string> {
  const action = ACTION[input.action];
  return ctx.db.tx(async q => {
    const me = uid(q);
    const extra: string[] = [];
    const ops: UndoOp[] = [];
    let areaId: number;
    let name: string;
    let created = false;

    if (input.item_id !== undefined) {
      const row = (await q.query<{ name: string }>('select name from areas where id = $1 and user_id = $2', [input.item_id, me])).rows[0];
      if (!row) return `No area #${input.item_id}.`;
      areaId = input.item_id;
      name = row.name;
    } else {
      // Taking something off looks at what's on focus first, so "drop guard retention" finds the one on the list.
      let r: Resolution = action === 'remove' ? await resolveArea(q, input.item, true) : { match: null, candidates: [] };
      if (!r.match && !input.create) r = await resolveArea(q, input.item);
      if (r.match && !input.create) {
        areaId = r.match.id;
        name = r.match.name;
      } else if (action === 'add') {
        name = input.item.trim();
        if (!name) return 'An area needs a name.';
        areaId = await insertArea(q, name, input.description);
        created = true;
      } else {
        return describeMiss('area', input.item, r);
      }
    }
    const snapshot = await focusSnapshot(q, created ? undefined : areaId);
    const before = snapshot.find(s => s.id === areaId)?.rank ?? null;

    // Techniques: given ones, or (for a new area) the card its name is or mentions.
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
    const links = await linkIn(q, areaId, { add: { techniqueIds, noteIds: input.note_ids } });
    if (input.techniques?.length || input.technique_ids?.length || input.note_ids?.length) extra.push(...links.parts);
    if (created && !links.added.techniques.length) extra.push('not linked to a technique card yet');

    let verb: string;
    let eventIds: number[] = [];
    if (action === 'add' && before !== null && input.position === undefined) {
      verb = `Already #${before} on focus`;
    } else if (action === 'remove' && before === null) {
      verb = 'Already off focus';
    } else {
      const placed = await placeOnFocus(q, areaId, action === 'remove' ? null : input.position);
      eventIds = placed.eventId ? [placed.eventId] : [];
      verb = created ? `New area, on focus at #${placed.to}` : placed.eventId ? focusVerb(placed.from, placed.to) : `Already #${placed.to}`;
    }

    if (!created && links.undo) ops.push(links.undo);
    ops.push({ kind: 'restore_focus', items: snapshot, deleteItemId: created ? areaId : null, eventIds, addedLinks: [] });
    await logActivity(q, 'update_focus', `${action} "${name}"`, ops.length === 1 ? ops[0]! : { kind: 'batch', ops });
    return `${verb}: ${name}${extra.length ? ` (${extra.join('; ')})` : ''}.`;
  });
}

/** Focus history for one area or the whole list, oldest first. */
export async function focusHistory(ctx: Ctx, item?: string, limit = 30): Promise<string> {
  let where = 'where a.user_id = $2';
  const params: unknown[] = [limit, uid(ctx.db)];
  if (item) {
    const r = await resolveArea(ctx.db, item);
    if (!r.match) return describeMiss('area', item, r);
    where += ' and e.area_id = $3';
    params.push(r.match.id);
  }
  const rows = (
    await ctx.db.query<{ at: string; name: string; event: string; to_rank: number | null }>(
      `select * from (
         select e.at::date::text as at, a.name, e.event, e.to_rank, e.id
         from focus_events e join areas a on a.id = e.area_id ${where}
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

/** Adds and removes an area's links; returns what changed (as words) and how to take it back. */
async function linkIn(q: Queryable, id: number, change: AreaLinksInput) {
  const me = uid(q);
  const added: AreaLinkIds = { techniques: [], notes: [] };
  const removed: AreaLinkIds = { techniques: [], notes: [] };
  const linkedNames: string[] = [];
  const unlinkedNames: string[] = [];

  for (const t of await ownRows(q, 'techniques', change.add?.techniqueIds ?? [])) {
    const { rows } = await q.query(
      'insert into area_techniques (area_id, technique_id, user_id) values ($1, $2, $3) on conflict do nothing returning technique_id',
      [id, t.id, me],
    );
    if (rows[0]) {
      added.techniques.push(t.id);
      linkedNames.push(t.name);
    }
  }
  for (const n of await ownRows(q, 'notes', change.add?.noteIds ?? [])) {
    const { rows } = await q.query('insert into area_notes (area_id, note_id, user_id) values ($1, $2, $3) on conflict do nothing returning note_id', [
      id,
      n.id,
      me,
    ]);
    if (rows[0]) added.notes.push(n.id);
  }
  if (change.remove?.techniqueIds?.length) {
    const { rows } = await q.query<{ technique_id: number; name: string }>(
      `delete from area_techniques ax using techniques t
       where ax.area_id = $1 and ax.technique_id = any($2::int[]) and ax.user_id = $3 and t.id = ax.technique_id
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
      'delete from area_notes where area_id = $1 and note_id = any($2::int[]) and user_id = $3 returning note_id',
      [id, change.remove.noteIds, me],
    );
    removed.notes.push(...rows.map(r => r.note_id));
  }
  // A note filed under an area is filed: it leaves the inbox (and comes back if that was all that filed it).
  await refreshInbox(q, [...added.notes, ...removed.notes]);

  const parts: string[] = [];
  if (linkedNames.length || added.notes.length) {
    parts.push(`linked ${[...linkedNames, ...(added.notes.length ? [plural(added.notes.length, 'note')] : [])].join(', ')}`);
  }
  if (unlinkedNames.length || removed.notes.length) {
    parts.push(`unlinked ${[...unlinkedNames, ...(removed.notes.length ? [plural(removed.notes.length, 'note')] : [])].join(', ')}`);
  }
  const any = added.techniques.length + added.notes.length + removed.techniques.length + removed.notes.length > 0;
  const undo: UndoOp | null = any ? { kind: 'restore_focus_links', itemId: id, added, removed } : null;
  return { parts, undo, added };
}

/** Links techniques and notes to an area, or unlinks them (from the web app). */
export async function linkArea(ctx: Ctx, id: number, change: AreaLinksInput): Promise<string> {
  return ctx.db.tx(async q => {
    const area = (await q.query<{ name: string }>('select name from areas where id = $1 and user_id = $2', [id, uid(q)])).rows[0];
    if (!area) return `No area #${id}.`;
    const r = await linkIn(q, id, change);
    if (!r.undo) return `Nothing changed on ${area.name}.`;
    await logActivity(q, 'link_area', `links on "${area.name}"`, r.undo);
    return `${capitalise(r.parts.join('; '))} on ${area.name}.`;
  });
}

// ---------- editing an area and its plan ----------

const AREA_SNAPSHOT_SQL = `select id, name, aliases, description, start_position_id, start_role, premise
  from areas where id = $1 and user_id = $2`;

/** A step ready to store: names already matched to cards and positions. */
interface ResolvedStep {
  depth: number;
  trigger: string | null;
  action: string;
  technique_id: number | null;
  to_position_id: number | null;
  to_role: Role | null;
  note: string | null;
}

/** Checks the outline's shape: it starts on the main line and goes at most one level deeper per step. */
function checkOutline(steps: { depth: number }[]): void {
  if (steps.length > MAX_STEPS) throw new UserError(`A plan can have at most ${MAX_STEPS} steps.`);
  let prev = -1;
  for (const [i, s] of steps.entries()) {
    if (!Number.isInteger(s.depth) || s.depth < 0 || s.depth > MAX_DEPTH) throw new UserError(`Step ${i + 1}: depth must be 0 to ${MAX_DEPTH}.`);
    if (s.depth > prev + 1) {
      throw new UserError(
        i === 0 ? 'The first step must be on the main line (depth 0).' : `Step ${i + 1} is ${s.depth - prev} levels deeper than the step before it.`,
      );
    }
    prev = s.depth;
  }
}

/**
 * Replaces an area's plan. Each step's technique card is linked to the area too, so notes on it show up there;
 * returns those newly linked card ids.
 */
async function writePlan(q: Queryable, areaId: number, steps: ResolvedStep[]): Promise<number[]> {
  checkOutline(steps);
  const me = uid(q);
  await q.query('delete from area_steps where area_id = $1 and user_id = $2', [areaId, me]);
  const parents: number[] = [];
  const ordinals = new Map<number | null, number>();
  for (const s of steps) {
    const parent = s.depth === 0 ? null : parents[s.depth - 1]!;
    const ordinal = (ordinals.get(parent) ?? 0) + 1;
    ordinals.set(parent, ordinal);
    const { rows } = await q.query<{ id: number }>(
      `insert into area_steps (area_id, user_id, parent_id, ordinal, trigger, action, technique_id, to_position_id, to_role, note)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) returning id`,
      [areaId, me, parent, ordinal, s.trigger, s.action, s.technique_id, s.to_position_id, s.to_role, s.note],
    );
    parents[s.depth] = rows[0]!.id;
    parents.length = s.depth + 1;
  }
  const linked: number[] = [];
  for (const t of new Set(steps.map(s => s.technique_id).filter((t): t is number => t !== null))) {
    const { rows } = await q.query(
      'insert into area_techniques (area_id, technique_id, user_id) values ($1, $2, $3) on conflict do nothing returning technique_id',
      [areaId, t, me],
    );
    if (rows[0]) linked.push(t);
  }
  return linked;
}

/** Steps from the web app, which names cards and positions by id. Ids that aren't yours are dropped. */
async function resolveStepIds(q: Queryable, steps: PlanStepInput[]): Promise<ResolvedStep[]> {
  const techniques = new Set(
    (await ownRows(q, 'techniques', steps.map(s => s.techniqueId).filter((t): t is number => typeof t === 'number'))).map(t => t.id),
  );
  const positionIds = steps.map(s => s.toPositionId).filter((p): p is number => typeof p === 'number');
  const positions = new Set(
    positionIds.length ? (await q.query<{ id: number }>('select id from positions where id = any($1::int[])', [positionIds])).rows.map(r => r.id) : [],
  );
  return steps.map(s => ({
    depth: s.depth,
    trigger: clean(s.trigger),
    action: s.action.trim(),
    technique_id: s.techniqueId && techniques.has(s.techniqueId) ? s.techniqueId : null,
    to_position_id: s.toPositionId && positions.has(s.toPositionId) ? s.toPositionId : null,
    to_role: s.toRole ?? null,
    note: clean(s.note),
  }));
}

/** One line of a plan, as Claude sends it. */
export interface StepInput {
  /** 0 = main line; 1 = a branch off the nearest depth-0 step above it; and so on. */
  depth: number;
  /** The reaction that leads here ("they post the far leg"). */
  when?: string;
  /** What to do, as said. Linked to a technique card when it names one clearly. */
  do: string;
  /** The card to link, when the words in `do` aren't its name. */
  technique?: string;
  /** Where it leaves you, e.g. "deep half". */
  to?: string;
  to_role?: Role;
  /** Intent or cue. */
  note?: string;
}

/** Steps from Claude, which names things: cards and positions are matched, and misses are reported, not fatal. */
export async function resolveStepNames(q: Queryable, steps: StepInput[], misses: string[]): Promise<ResolvedStep[]> {
  const out: ResolvedStep[] = [];
  const noCard: string[] = [];
  for (const s of steps) {
    const action = s.do.trim();
    if (!action) throw new UserError('Every step needs "do": what to do.');
    let technique: number | null = null;
    if (s.technique?.trim()) {
      const r = await resolveTechnique(q, s.technique);
      if (r.match) technique = r.match.id;
      else misses.push(describeMiss('technique', s.technique, r).replace(/\.$/, ''));
    } else {
      const r = await resolveTechnique(q, action);
      if (r.match) technique = r.match.id;
      else noCard.push(action);
    }
    let to: number | null = null;
    if (s.to?.trim()) {
      const r = await resolvePosition(q, s.to);
      if (r.match) to = r.match.id;
      else misses.push(describeMiss('position', s.to, r).replace(/\.$/, ''));
    }
    out.push({ depth: s.depth, trigger: clean(s.when), action, technique_id: technique, to_position_id: to, to_role: s.to_role ?? null, note: clean(s.note) });
  }
  if (noCard.length) misses.push(`no technique card for: ${noCard.join('; ')}`);
  return out;
}

interface Fields {
  name?: string;
  aliases?: string[];
  description?: string | null;
  start_position_id?: number | null;
  start_role?: Role | null;
  premise?: string | null;
}

/**
 * Changes an area's own fields and (when given) its plan. Returns what changed in words and the undo for it;
 * null if there's no such area.
 */
async function editIn(q: Queryable, id: number, f: Fields, steps?: ResolvedStep[]) {
  const me = uid(q);
  const before = (await q.query<AreaSnapshot>(AREA_SNAPSHOT_SQL, [id, me])).rows[0];
  if (!before) return null;
  const after: AreaSnapshot = {
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
      `update areas set name = $2, aliases = $3, description = $4, start_position_id = $5, start_role = $6, premise = $7, updated_at = now()
       where id = $1 and user_id = $8`,
      [id, after.name, after.aliases, after.description, after.start_position_id, after.start_role, after.premise, me],
    );
  }
  let stepsBefore: StepSnapshot[] | undefined;
  let linked: number[] = [];
  if (steps) {
    stepsBefore = (await q.query<StepSnapshot>(STEP_SNAPSHOT_SQL, [id, me])).rows;
    linked = await writePlan(q, id, steps);
    parts.push(steps.length ? `plan saved (${plural(steps.length, 'step')})` : stepsBefore.length ? 'plan cleared' : 'no plan');
  }
  const ops: UndoOp[] = [];
  if (fieldsChanged || steps) ops.push({ kind: 'restore_area', before, ...(stepsBefore ? { steps: stepsBefore } : {}) });
  if (linked.length) ops.push({ kind: 'restore_focus_links', itemId: id, added: { techniques: linked, notes: [] }, removed: { techniques: [], notes: [] } });
  return { before: before.name, name: after.name, parts, ops };
}

/** Changes an area from the web app: its fields and, when given, its whole plan. */
export async function editArea(ctx: Ctx, id: number, patch: AreaPatch): Promise<string> {
  return ctx.db.tx(async q => {
    if (patch.startPositionId) {
      const ok = (await q.query('select 1 from positions where id = $1', [patch.startPositionId])).rows.length > 0;
      if (!ok) throw new UserError(`No position #${patch.startPositionId}.`);
    }
    const steps = patch.plan ? await resolveStepIds(q, patch.plan) : undefined;
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
    );
    if (!r) return `No area #${id}.`;
    // Logged even when nothing changed, so the Undo the app offers never reaches back to an earlier change.
    const undo: UndoOp = r.ops.length === 0 ? { kind: 'batch', ops: [] } : r.ops.length === 1 ? r.ops[0]! : { kind: 'batch', ops: r.ops };
    await logActivity(q, 'edit_area', `edit to "${r.before}"`, undo);
    return r.parts.length ? `${r.name}: ${r.parts.join('; ')}.` : `Nothing changed on ${r.name}.`;
  });
}

export interface SaveAreaInput {
  /** Matched against names, aliases and linked techniques; a new area is made when nothing matches. */
  name: string;
  rename_to?: string;
  aliases?: string[];
  description?: string;
  /** Techniques to link (by name). */
  techniques?: string[];
  /** Where the plan starts, e.g. "half guard". An empty string clears it. */
  start?: string;
  start_role?: Role;
  premise?: string;
  /** Replaces the whole plan. An empty list clears it. */
  steps?: StepInput[];
  /** true puts it on the focus list (at position, default the top); false takes it off. */
  focus?: boolean;
  position?: number;
}

/** Makes or changes an area by name (for Claude): fields, plan, links and focus, undone together. */
export async function saveArea(ctx: Ctx, input: SaveAreaInput): Promise<string> {
  return ctx.db.tx(async q => {
    const misses: string[] = [];
    const found = await resolveArea(q, input.name);
    let id: number;
    let created = false;
    if (found.match) {
      id = found.match.id;
    } else {
      const name = input.name.trim();
      if (!name) return 'An area needs a name.';
      id = await insertArea(q, name);
      created = true;
      if (found.candidates.length) misses.push(`made a new area; closest existing: ${found.candidates.map(c => c.name).join(', ')}`);
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
      ops.push({ kind: 'restore_focus', items: snapshot, deleteItemId: created ? id : null, eventIds, addedLinks: [] });
    }
    // A new area is undone by deleting it, which takes its plan and links with it.
    const undo: UndoOp | null = created ? ops[ops.length - 1]! : ops.length ? (ops.length === 1 ? ops[0]! : { kind: 'batch', ops }) : null;
    if (undo) await logActivity(q, 'save_area', created ? `new area "${edit.name}"` : `edit to "${edit.before}"`, undo);

    // Read the start back by name, so a misheard position is easy to catch.
    if (start) {
      const pos = (await q.query<{ name: string }>('select name from positions where id = $1', [start])).rows[0]!.name;
      const at = parts.indexOf('start updated');
      const said = `starts in ${pos}${input.start_role ? ` (${input.start_role})` : ''}`;
      if (at >= 0) parts[at] = said;
      else if (created) parts.unshift(said);
    }
    // A new area's own fields go without saying.
    const shown = created ? parts.filter(p => !['start updated', 'premise updated', 'description updated', 'aliases updated', 'no plan'].includes(p)) : parts;
    const head = created ? `New area: ${edit.name}` : edit.name;
    const said = shown.length ? `${head}: ${shown.join('; ')}` : created ? head : `Nothing changed on ${edit.name}`;
    return `${said}${misses.length ? ` (${misses.join('; ')})` : ''}.`;
  });
}

/** Makes an area from the web app; on the focus list unless asked otherwise. Returns its id. */
export async function createArea(
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
    const id = (await ctx.db.query<{ id: number }>('select id from areas where user_id = $1 order by id desc limit 1', [uid(ctx.db)])).rows[0]!.id;
    return { message, id };
  }
  return ctx.db.tx(async q => {
    const name = input.name.trim();
    if (!name) throw new UserError('An area needs a name.');
    const id = await insertArea(q, name, input.description);
    const links = await linkIn(q, id, { add: { techniqueIds: input.techniqueIds, noteIds: input.noteIds } });
    await logActivity(q, 'save_area', `new area "${name}"`, { kind: 'restore_focus', items: [], deleteItemId: id, eventIds: [], addedLinks: [] });
    return { message: `New area: ${name}${links.parts.length ? ` (${links.parts.join('; ')})` : ''}.`, id };
  });
}

/** Deletes an area for good (its notes and techniques stay). Undo puts it back, plan and history included. */
export async function deleteArea(ctx: Ctx, target: { id?: number; name?: string }): Promise<string> {
  return ctx.db.tx(async q => {
    const me = uid(q);
    let id = target.id;
    if (id === undefined) {
      const r = await resolveArea(q, target.name ?? '');
      if (!r.match) return describeMiss('area', target.name ?? '', r);
      id = r.match.id;
    }
    const row = (
      await q.query<AreaSnapshot & { rank: number | null; goal: string | null; created_at: string; updated_at: string }>(
        `select id, name, aliases, description, start_position_id, start_role, premise, rank, goal,
                created_at::text as created_at, updated_at::text as updated_at
         from areas where id = $1 and user_id = $2`,
        [id, me],
      )
    ).rows[0];
    if (!row) return `No area #${id}.`;
    const techniqueIds = (await q.query<{ technique_id: number }>('select technique_id from area_techniques where area_id = $1', [id])).rows.map(
      r => r.technique_id,
    );
    const noteIds = (await q.query<{ note_id: number }>('select note_id from area_notes where area_id = $1', [id])).rows.map(r => r.note_id);
    const steps = (await q.query<StepSnapshot>(STEP_SNAPSHOT_SQL, [id, me])).rows;
    const events = (
      await q.query<Extract<UndoOp, { kind: 'restore_deleted_area' }>['events'][number]>(
        `select id, event, from_status, to_status, from_rank, to_rank, at::text as at from focus_events where area_id = $1 order by id`,
        [id],
      )
    ).rows;
    await q.query('delete from areas where id = $1 and user_id = $2', [id, me]);
    await renumberFocus(q);
    await refreshInbox(q, noteIds);
    await logActivity(q, 'delete_area', `delete "${row.name}"`, { kind: 'restore_deleted_area', row, techniqueIds, noteIds, steps, events });
    return `Deleted ${row.name}.${noteIds.length ? ` Its ${plural(noteIds.length, 'note')} stay.` : ''}`;
  });
}

// ---------- reading, for Claude and Siri ----------

/** A plan as indented if/then lines. */
export function planLines(plan: PlanStep[], indent = ''): string[] {
  const lines: string[] = [];
  plan.forEach((s, i) => {
    const marker = indent ? '' : `${i + 1}. `;
    const head = s.trigger ? `If ${s.trigger}: ${lowerFirst(s.action)}` : s.action;
    const card = s.technique ? ` (${s.technique.status})` : '';
    const leads = s.to ? ` → ${s.to.name}${s.toRole ? ` (${s.toRole})` : ''}` : '';
    const why = s.note ? `: ${s.note}` : '';
    const next = s.continuesIn.length ? ` Continues in: ${s.continuesIn.map(a => a.name).join(', ')}.` : '';
    lines.push(`${indent}${marker}${head}${card}${leads}${why}.${next}`.replace(/\.\./g, '.'));
    lines.push(...planLines(s.children, `${indent}   `));
  });
  return lines;
}

const lowerFirst = (t: string) => (/^[A-Z][a-z]/.test(t) ? t.charAt(0).toLowerCase() + t.slice(1) : t);

/** Every step of a plan, depth first. */
function flatten(plan: PlanStep[]): PlanStep[] {
  return plan.flatMap(s => [s, ...flatten(s.children)]);
}

const STATUS_ORDER = ['seen', 'learning', 'drilling', 'hitting', 'reliable'];

/** One area as text: where it is on focus, its plan read as if/then, techniques and notes. */
export async function getArea(ctx: Ctx, name: string): Promise<string> {
  const r = await resolveArea(ctx.db, name);
  if (!r.match) return describeMiss('area', name, r);
  const v = (await areaView(ctx.db, r.match.id))!;
  const now = new Date(`${today(ctx)}T12:00:00Z`);
  const where = v.rank ? `#${v.rank} on your focus list` : 'off focus';
  const lines = [`${v.name}. ${where}; ${daysAgo(v.lastNoteOn, now)}.`];
  if (v.aliases.length) lines.push(`Also called: ${v.aliases.join(', ')}.`);
  if (v.start || v.premise) {
    const from = v.start ? `Starts in ${v.start.name}${v.startRole ? `, ${v.startRole}` : ''}` : 'Starts';
    lines.push(`${from}${v.premise ? `, when ${lowerFirst(v.premise)}` : ''}.`);
  }
  if (v.description) lines.push(v.description);
  if (v.plan.length) {
    lines.push('Plan:', ...planLines(v.plan));
    const carded = flatten(v.plan).filter(s => s.technique);
    if (carded.length) {
      const weakest = carded.reduce((a, b) => (STATUS_ORDER.indexOf(b.technique!.status) < STATUS_ORDER.indexOf(a.technique!.status) ? b : a));
      lines.push(`Weakest step: ${weakest.technique!.name} (${weakest.technique!.status}).`);
    }
  } else {
    lines.push('No plan yet.');
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

/** Every area, grouped by where its plan starts, with its place on focus. */
export async function listAreas(ctx: Ctx): Promise<string> {
  const { areas } = await areasView(ctx);
  if (!areas.length) return 'No areas yet.';
  const groups = new Map<string, string[]>();
  for (const a of areas) {
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
