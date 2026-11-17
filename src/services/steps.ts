// A game plan's steps: saving a whole outline, changing one step at a time (add, edit, delete, move), and reading
// them as text for Claude and aloud for Siri. The structure itself (slots and options) is in ../shared/steps.ts.
import { uid, type Queryable } from '../db.js';
import { describeMiss, resolveGamePlan, resolvePosition, resolveStep, resolveTechnique } from '../resolve.js';
import type { GamePlanSlot, GamePlanSpeech, GamePlanStep, GamePlanStepInput, Role, StepAdd, StepMove, StepPatch } from '../shared/api.js';
import { fromOutline, groupSlots, MAX_DEPTH, MAX_STEPS, outlineProblem, type Option, type Slot } from '../shared/steps.js';
import { logActivity, STEP_SNAPSHOT_SQL, type GamePlanSnapshot, type StepSnapshot, type UndoOp } from './activity.js';
import type { Ctx } from './context.js';
import { ConflictError, NotFoundError, UserError } from './errors.js';
import { gamePlanView } from './views.js';

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
const capitalise = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);
const clean = (t: string | null | undefined) => t?.trim() || null;
export const lowerFirst = (t: string) => (/^[A-Z][a-z]/.test(t) ? t.charAt(0).toLowerCase() + t.slice(1) : t);

/** Said when a write names the game plan as last seen (`expectedUpdatedAt`) and it has changed since. */
export const CHANGED_ELSEWHERE = 'This game plan changed somewhere else. Reload to see it.';

/**
 * Takes the game plan for this transaction, so two writers to its steps go one after the other, and returns it
 * as it stands. With `expected` (its `updatedAt` as the caller last saw it), refuses if it has changed since.
 */
export async function lockGamePlan(q: Queryable, id: number, expected?: string): Promise<GamePlanSnapshot> {
  // The same text the game plan's page gets as `updatedAt` (see `iso` in views.ts).
  const row = (
    await q.query<GamePlanSnapshot & { updated_at: string }>(
      `select id, name, aliases, description, start_position_id, start_role, premise, (to_json(updated_at) #>> '{}') as updated_at
       from game_plans where id = $1 and user_id = $2 for update`,
      [id, uid(q)],
    )
  ).rows[0];
  if (!row) throw new NotFoundError(`No game plan #${id}.`);
  if (expected !== undefined && expected !== row.updated_at) throw new ConflictError(CHANGED_ELSEWHERE);
  const { updated_at: _at, ...snapshot } = row;
  return snapshot;
}

/** Every write to a game plan's steps marks the game plan as changed. */
const touch = (q: Queryable, gamePlanId: number) => q.query('update game_plans set updated_at = now() where id = $1 and user_id = $2', [gamePlanId, uid(q)]);

// ---------- a whole outline ----------

/** A step of an outline ready to store: names already matched to cards and positions. */
export interface ResolvedStep {
  depth: number;
  /** An alternative to the step before it at this depth. */
  or: boolean;
  trigger: string | null;
  action: string;
  technique_id: number | null;
  to_position_id: number | null;
  to_role: Role | null;
  note: string | null;
}

/** Links technique cards to a game plan, so notes on them show up there; returns the ones newly linked. */
async function linkCards(q: Queryable, gamePlanId: number, techniqueIds: (number | null)[]): Promise<number[]> {
  const linked: number[] = [];
  for (const t of new Set(techniqueIds.filter((t): t is number => t !== null))) {
    const { rows } = await q.query(
      'insert into game_plan_techniques (game_plan_id, technique_id, user_id) values ($1, $2, $3) on conflict do nothing returning technique_id',
      [gamePlanId, t, uid(q)],
    );
    if (rows[0]) linked.push(t);
  }
  return linked;
}

/**
 * Replaces a game plan's steps with an outline. Each step's technique card is linked to the game plan too;
 * returns those newly linked card ids.
 */
export async function writeSteps(q: Queryable, gamePlanId: number, steps: ResolvedStep[]): Promise<number[]> {
  const problem = outlineProblem(steps);
  if (problem) throw new UserError(problem);
  const me = uid(q);
  await q.query('delete from game_plan_steps where game_plan_id = $1 and user_id = $2', [gamePlanId, me]);
  const insert = async (slots: Slot<Option<ResolvedStep>>[], parent: number | null): Promise<void> => {
    for (const slot of slots) {
      for (const s of slot.options) {
        const { rows } = await q.query<{ id: number }>(
          `insert into game_plan_steps (game_plan_id, user_id, parent_id, ordinal, option, trigger, action, technique_id, to_position_id, to_role, note)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) returning id`,
          [gamePlanId, me, parent, slot.ordinal, s.option, s.option === 0 ? slot.trigger : null, s.action, s.technique_id, s.to_position_id, s.to_role, s.note],
        );
        await insert(s.slots, rows[0]!.id);
      }
    }
  };
  await insert(fromOutline(steps, s => s), null);
  await touch(q, gamePlanId);
  return linkCards(q, gamePlanId, steps.map(s => s.technique_id));
}

/** The card and position a step names by id, kept only if they're there (and the card is yours). */
async function ownRefs(q: Queryable, techniqueIds: number[], positionIds: number[]): Promise<{ techniques: Set<number>; positions: Set<number> }> {
  const techniques = techniqueIds.length
    ? (await q.query<{ id: number }>('select id from techniques where id = any($1::int[]) and user_id = $2', [techniqueIds, uid(q)])).rows.map(r => r.id)
    : [];
  const positions = positionIds.length ? (await q.query<{ id: number }>('select id from positions where id = any($1::int[])', [positionIds])).rows.map(r => r.id) : [];
  return { techniques: new Set(techniques), positions: new Set(positions) };
}

const isId = (v: number | null | undefined): v is number => typeof v === 'number';

/** An outline from the web app, which names cards and positions by id. Ids that aren't yours are dropped. */
export async function resolveStepIds(q: Queryable, steps: GamePlanStepInput[]): Promise<ResolvedStep[]> {
  const own = await ownRefs(q, steps.map(s => s.techniqueId).filter(isId), steps.map(s => s.toPositionId).filter(isId));
  return steps.map(s => ({
    depth: s.depth,
    or: s.or === true,
    trigger: clean(s.trigger),
    action: s.action.trim(),
    technique_id: s.techniqueId && own.techniques.has(s.techniqueId) ? s.techniqueId : null,
    to_position_id: s.toPositionId && own.positions.has(s.toPositionId) ? s.toPositionId : null,
    to_role: s.toRole ?? null,
    note: clean(s.note),
  }));
}

/** One step, as Claude sends it (naming cards and positions). */
export interface NamedStepInput {
  /** 0 = main line; 1 = a branch off the nearest depth-0 step above it; and so on. */
  depth: number;
  /**
   * An alternative to the nearest step above it at the same depth: plan B (then C...), in order of preference.
   * Each alternative, plan A included, is a branch: what comes after it goes one level deeper.
   */
  or?: boolean;
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

/** An outline from Claude, which names things: cards and positions are matched, and misses are reported, not fatal. */
export async function resolveStepNames(q: Queryable, steps: NamedStepInput[], misses: string[]): Promise<ResolvedStep[]> {
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
    out.push({ depth: s.depth, or: s.or === true, trigger: clean(s.when), action, technique_id: technique, to_position_id: to, to_role: s.to_role ?? null, note: clean(s.note) });
  }
  if (noCard.length) misses.push(`no technique card for: ${noCard.join('; ')}`);
  return out;
}

// ---------- one step at a time ----------

const OR_HAS_NO_TRIGGER = 'An alternative answers the same reaction as its plan A, so it has none of its own. Change the reaction on plan A.';

/** What undoes a change to a game plan's steps: the steps as they were (ids included), and any card links it made. */
function stepsUndo(before: GamePlanSnapshot, steps: StepSnapshot[], linked: number[]): UndoOp {
  const restore: UndoOp = { kind: 'restore_game_plan', before, steps };
  if (!linked.length) return restore;
  return { kind: 'batch', ops: [restore, { kind: 'restore_game_plan_links', gamePlanId: before.id, added: { techniques: linked, notes: [] }, removed: { techniques: [], notes: [] } }] };
}

const stepIn = (steps: StepSnapshot[], id: number): StepSnapshot => {
  const step = steps.find(s => s.id === id);
  if (!step) throw new NotFoundError(`No step #${id} in that game plan.`);
  return step;
};

const siblingsOf = (steps: StepSnapshot[], parentId: number | null) => steps.filter(s => s.parent_id === parentId);

/** How deep a step is: 0 on the main line. */
function depthOf(steps: StepSnapshot[], step: StepSnapshot): number {
  let depth = 0;
  for (let at = step; at.parent_id !== null; at = stepIn(steps, at.parent_id)) depth++;
  return depth;
}

/** How many steps hang under a step, at any depth. */
const countUnder = (steps: StepSnapshot[], id: number): number => siblingsOf(steps, id).reduce((n, s) => n + 1 + countUnder(steps, s.id), 0);

/**
 * Stores the steps under one parent as these slots, in this order: slot numbers and options run 1, 2, 3 and
 * 0, 1, 2 with no gaps, and each slot's trigger sits on its first option. Only rows that change are written,
 * so ids stay.
 */
async function placeSlots(q: Queryable, slots: StepSnapshot[][], triggers: (string | null)[]): Promise<void> {
  for (const [i, slot] of slots.entries()) {
    for (const [k, s] of slot.entries()) {
      const trigger = k === 0 ? triggers[i]! : null;
      if (s.ordinal === i + 1 && s.option === k && s.trigger === trigger) continue;
      await q.query('update game_plan_steps set ordinal = $2, option = $3, trigger = $4 where id = $1 and user_id = $5', [s.id, i + 1, k, trigger, uid(q)]);
    }
  }
}

/**
 * Adds one step: a new slot under a step or at the end of the main line ("then", "if"), or one more option in a
 * step's slot ("or"). Nothing else moves, so every other step keeps its id. One undo takes it back.
 */
export async function addStep(ctx: Ctx, gamePlanId: number, input: StepAdd): Promise<{ message: string; stepId: number }> {
  return ctx.db.tx(async q => {
    const me = uid(q);
    const before = await lockGamePlan(q, gamePlanId, input.expectedUpdatedAt);
    const steps = (await q.query<StepSnapshot>(STEP_SNAPSHOT_SQL, [gamePlanId, me])).rows;
    const action = input.action.trim();
    if (!action) throw new UserError('A step needs what to do.');
    if (steps.length >= MAX_STEPS) throw new UserError(`A game plan can have at most ${MAX_STEPS} steps.`);
    const trigger = clean(input.trigger);
    const of = input.of === undefined ? null : stepIn(steps, input.of);

    let parent: number | null;
    let ordinal: number;
    let option: number;
    if (input.relation === 'or') {
      if (!of) throw new UserError('An alternative needs the step it is an alternative to.');
      if (trigger) throw new UserError(OR_HAS_NO_TRIGGER);
      parent = of.parent_id;
      ordinal = of.ordinal;
      option = Math.max(...siblingsOf(steps, parent).filter(s => s.ordinal === ordinal).map(s => s.option)) + 1;
    } else {
      if (input.relation === 'if' && !trigger) throw new UserError('An "if they…" step needs the reaction that leads to it.');
      if (input.relation === 'then' && trigger) throw new UserError('A "then" step has no reaction. Add it as an "if they…" step instead.');
      if (of && depthOf(steps, of) >= MAX_DEPTH) throw new UserError(`Steps can go at most ${MAX_DEPTH} levels deep.`);
      parent = of?.id ?? null;
      ordinal = Math.max(0, ...siblingsOf(steps, parent).map(s => s.ordinal)) + 1;
      option = 0;
    }
    const own = await ownRefs(q, [input.techniqueId].filter(isId), [input.toPositionId].filter(isId));
    const techniqueId = isId(input.techniqueId) && own.techniques.has(input.techniqueId) ? input.techniqueId : null;
    const toPositionId = isId(input.toPositionId) && own.positions.has(input.toPositionId) ? input.toPositionId : null;
    const { rows } = await q.query<{ id: number }>(
      `insert into game_plan_steps (game_plan_id, user_id, parent_id, ordinal, option, trigger, action, technique_id, to_position_id, to_role, note)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) returning id`,
      [gamePlanId, me, parent, ordinal, option, trigger, action, techniqueId, toPositionId, input.toRole ?? null, clean(input.note)],
    );
    const linked = await linkCards(q, gamePlanId, [techniqueId]);
    await touch(q, gamePlanId);
    await logActivity(q, 'add_step', `edit to "${before.name}"`, stepsUndo(before, steps, linked));
    return { message: `Added ${action}.`, stepId: rows[0]!.id };
  });
}

/** Changes one step's own fields. The reaction ("if they…") belongs to the slot, so only plan A can change it. */
export async function updateStep(ctx: Ctx, gamePlanId: number, stepId: number, patch: StepPatch): Promise<string> {
  return ctx.db.tx(async q => {
    const me = uid(q);
    const before = await lockGamePlan(q, gamePlanId, patch.expectedUpdatedAt);
    const steps = (await q.query<StepSnapshot>(STEP_SNAPSHOT_SQL, [gamePlanId, me])).rows;
    const self = stepIn(steps, stepId);
    if (self.option > 0 && clean(patch.trigger)) throw new UserError(OR_HAS_NO_TRIGGER);
    const own = await ownRefs(q, [patch.techniqueId].filter(isId), [patch.toPositionId].filter(isId));
    const next = {
      trigger: patch.trigger !== undefined ? clean(patch.trigger) : self.trigger,
      action: patch.action !== undefined ? patch.action.trim() : self.action,
      technique_id: patch.techniqueId !== undefined ? (isId(patch.techniqueId) && own.techniques.has(patch.techniqueId) ? patch.techniqueId : null) : self.technique_id,
      to_position_id: patch.toPositionId !== undefined ? (isId(patch.toPositionId) && own.positions.has(patch.toPositionId) ? patch.toPositionId : null) : self.to_position_id,
      to_role: patch.toRole !== undefined ? patch.toRole : self.to_role,
      note: patch.note !== undefined ? clean(patch.note) : self.note,
    };
    if (!next.action) throw new UserError('A step needs what to do.');
    if ((Object.keys(next) as (keyof typeof next)[]).every(k => next[k] === self[k])) return `Nothing changed on ${self.action}.`;
    await q.query(
      `update game_plan_steps set trigger = $2, action = $3, technique_id = $4, to_position_id = $5, to_role = $6, note = $7
       where id = $1 and game_plan_id = $8 and user_id = $9`,
      [stepId, next.trigger, next.action, next.technique_id, next.to_position_id, next.to_role, next.note, gamePlanId, me],
    );
    const linked = await linkCards(q, gamePlanId, [next.technique_id]);
    await touch(q, gamePlanId);
    await logActivity(q, 'edit_step', `edit to "${before.name}"`, stepsUndo(before, steps, linked));
    return `Saved ${next.action}.`;
  });
}

/**
 * Deletes a step and everything under it. Without plan A, plan B is the plan: it takes over the reaction the
 * slot answers. The options and slots left are renumbered, so there are no gaps.
 */
export async function deleteStep(ctx: Ctx, gamePlanId: number, stepId: number, expectedUpdatedAt?: string): Promise<string> {
  return ctx.db.tx(async q => {
    const me = uid(q);
    const before = await lockGamePlan(q, gamePlanId, expectedUpdatedAt);
    const steps = (await q.query<StepSnapshot>(STEP_SNAPSHOT_SQL, [gamePlanId, me])).rows;
    const self = stepIn(steps, stepId);
    const under = countUnder(steps, stepId);
    // Its parent link takes everything under it too.
    await q.query('delete from game_plan_steps where id = $1 and game_plan_id = $2 and user_id = $3', [stepId, gamePlanId, me]);
    const slots = groupSlots(siblingsOf(steps, self.parent_id).filter(s => s.id !== stepId));
    await placeSlots(
      q,
      slots,
      slots.map(slot => (slot[0]!.ordinal === self.ordinal && self.option === 0 ? self.trigger : slot[0]!.trigger)),
    );
    await touch(q, gamePlanId);
    await logActivity(q, 'delete_step', `edit to "${before.name}"`, stepsUndo(before, steps, []));
    return `Deleted ${self.action}${under ? ` and the ${plural(under, 'step')} after it` : ''}.`;
  });
}

// ---------- moving a step ----------

const letter = (i: number) => String.fromCharCode(65 + i);

/**
 * Moves a step's slot among the slots under the same parent (the step with its alternatives), or the step among
 * the options of its slot. Returns what happened in words.
 */
async function moveIn(q: Queryable, steps: StepSnapshot[], stepId: number, move: StepMove): Promise<{ message: string; changed: boolean }> {
  const self = stepIn(steps, stepId);
  const slots = groupSlots(siblingsOf(steps, self.parent_id));
  const at = slots.findIndex(slot => slot.some(s => s.id === stepId));
  const name = self.action;
  const given = [move.to, move.before, move.after].filter(v => v !== undefined).length;
  if (given !== 1) throw new UserError('Say where to move it: up, down, first, last, or before or after another step.');

  let next: StepSnapshot[][];
  let said: string;
  if (move.within === 'choice') {
    if (move.to === undefined) throw new UserError('Among its alternatives, a step moves up, down, first or last.');
    const options = slots[at]!;
    const from = options.findIndex(o => o.id === stepId);
    if (options.length === 1) return { message: `${name} has no alternatives to move among.`, changed: false };
    const to = { up: from - 1, down: from + 1, first: 0, last: options.length - 1 }[move.to];
    if (to < 0 || to >= options.length || to === from) {
      return { message: `${name} is already plan ${letter(from)}.`, changed: false };
    }
    const reordered = [...options];
    const [mine] = reordered.splice(from, 1);
    reordered.splice(to, 0, mine!);
    next = slots.map((slot, i) => (i === at ? reordered : slot));
    said = `${name} is now plan ${letter(to)}`;
  } else {
    let to: number;
    let where: string;
    if (move.to !== undefined) {
      to = { up: at - 1, down: at + 1, first: 0, last: slots.length - 1 }[move.to];
      where = move.to === 'up' || move.to === 'down' ? move.to : `to ${move.to}`;
      if (to < 0 || to >= slots.length || to === at) {
        const end = at === 0 ? 'first' : 'last';
        return { message: slots.length === 1 ? `${name} is the only step there.` : `${name} is already ${end}.`, changed: false };
      }
    } else {
      const targetId = (move.before ?? move.after)!;
      const target = slots.findIndex(slot => slot.some(s => s.id === targetId));
      if (target < 0) throw new UserError('That step is somewhere else in the game plan: steps move among the steps next to them.');
      if (target === at) return { message: `${name} and that step are alternatives to each other: move it among its alternatives instead.`, changed: false };
      const targetName = slots[target]![0]!.action;
      // Where it lands once it's out of the list: before the target, or just after it.
      to = move.before !== undefined ? (target > at ? target - 1 : target) : target > at ? target : target + 1;
      where = `${move.before !== undefined ? 'before' : 'after'} ${targetName}`;
      if (to === at) return { message: `${name} is already ${where}.`, changed: false };
    }
    next = [...slots];
    const [mine] = next.splice(at, 1);
    next.splice(to, 0, mine!);
    said = `Moved ${name} ${where}`;
  }
  // A slot answers one reaction: its trigger stays with whichever option is first.
  await placeSlots(
    q,
    next,
    next.map(slot => slot.reduce((first, o) => (o.option < first.option ? o : first)).trigger),
  );
  return { message: said, changed: true };
}

/** Moves a step (from the web app, by id). Steps are updated in place, so their ids stay; one undo puts the order back. */
export async function moveStep(ctx: Ctx, gamePlanId: number, stepId: number, move: StepMove): Promise<string> {
  return ctx.db.tx(async q => {
    const before = await lockGamePlan(q, gamePlanId, move.expectedUpdatedAt);
    const steps = (await q.query<StepSnapshot>(STEP_SNAPSHOT_SQL, [gamePlanId, uid(q)])).rows;
    const r = await moveIn(q, steps, stepId, move);
    if (!r.changed) return r.message;
    await touch(q, gamePlanId);
    await logActivity(q, 'move_step', `move in "${before.name}"`, stepsUndo(before, steps, []));
    return `${r.message}.`;
  });
}

/** Moving a step by voice: the step, and where to, by what they say. */
export interface NamedStepMove {
  step: string;
  to?: StepMove['to'];
  before?: string;
  after?: string;
  /** Make it plan A: first among its alternatives. */
  prefer?: boolean;
}

/** Moves a step of a game plan found by name (for Claude). */
export async function moveStepByName(ctx: Ctx, gamePlanName: string, move: NamedStepMove): Promise<string> {
  const q = ctx.db;
  const plan = await resolveGamePlan(q, gamePlanName);
  if (!plan.match) return describeMiss('game plan', gamePlanName, plan);
  const id = plan.match.id;
  const find = async (words: string): Promise<{ id: number; miss?: undefined } | { id?: undefined; miss: string }> => {
    const r = await resolveStep(q, id, words);
    if (r.match) return { id: r.match.id };
    const names = new Set(r.candidates.map(c => c.name.toLowerCase()));
    if (r.candidates.length > 1 && names.size === 1) {
      return {
        miss: `More than one step in ${plan.match!.name} says "${r.candidates[0]!.name}". Say it with the reaction that leads to it ("if they…"), or move it in the app.`,
      };
    }
    return { miss: `${describeMiss('step', words, r).replace(/\.$/, '')} in ${plan.match!.name}.` };
  };
  const step = await find(move.step);
  if (step.miss !== undefined) return step.miss;
  if (move.prefer) return moveStep(ctx, id, step.id, { within: 'choice', to: 'first' });
  if (move.before !== undefined || move.after !== undefined) {
    const target = await find((move.before ?? move.after)!);
    if (target.miss !== undefined) return target.miss;
    return moveStep(ctx, id, step.id, move.before !== undefined ? { before: target.id } : { after: target.id });
  }
  return moveStep(ctx, id, step.id, { to: move.to });
}

// ---------- reading, for Claude and Siri ----------

/**
 * Steps as indented if/then lines. A step and its alternatives ("Or:") are side by side, lettered on the main
 * line (1a, 1b); what comes after each is indented under it.
 */
export function stepLines(slots: GamePlanSlot[], indent = ''): string[] {
  const lines: string[] = [];
  slots.forEach((slot, n) => {
    slot.options.forEach((s, k) => {
      const marker = indent ? '' : `${n + 1}${slot.options.length > 1 ? String.fromCharCode(97 + k) : ''}. `;
      const head = k > 0 ? `Or: ${lowerFirst(s.action)}` : slot.trigger ? `If ${slot.trigger}: ${lowerFirst(s.action)}` : s.action;
      const card = s.technique ? ` (${s.technique.status})` : '';
      const leads = s.to ? ` → ${s.to.name}${s.toRole ? ` (${s.toRole})` : ''}` : '';
      const why = s.note ? `: ${s.note}` : '';
      const next = s.continuesIn.length ? ` Continues in: ${s.continuesIn.map(a => a.name).join(', ')}.` : '';
      lines.push(`${indent}${marker}${head}${card}${leads}${why}.${next}`.replace(/\.\./g, '.'));
      lines.push(...stepLines(s.slots, `${indent}   `));
    });
  });
  return lines;
}

/**
 * A game plan said aloud, for Siri: found by name, or by where it starts ("bottom half", "half guard bottom").
 * The main line and its branches; deeper steps are left for the app.
 */
export async function gamePlanSpeech(ctx: Ctx, query: string): Promise<GamePlanSpeech> {
  const q = ctx.db;
  const words = query.trim();
  if (!words) return { gamePlanId: null, speech: 'Which game plan? Say its name or a position.' };
  let id: number | null = null;
  let none: string | null = null;
  // "bottom half", "half guard, top": a position (and a side, if one is said) names the game plan that starts there.
  const role = /\bbottom\b/i.test(words) ? 'bottom' : /\btop\b/i.test(words) ? 'top' : null;
  const pos = await resolvePosition(q, words.replace(/\b(top|bottom|from|on|my|game|plan|the)\b/gi, ' ').replace(/\s+/g, ' ').trim() || words);
  if (pos.match) {
    const row = (
      await q.query<{ id: number }>(
        `select id from game_plans where user_id = $1 and start_position_id = $2 and ($3::text is null or start_role is null or start_role = $3)
           and exists (select 1 from game_plan_steps st where st.game_plan_id = game_plans.id)
         order by rank nulls last, name limit 1`,
        [uid(q), pos.match.id, role],
      )
    ).rows[0];
    if (row) id = row.id;
    else none = `You don't have a game plan from ${pos.match.name}${role ? ` on ${role}` : ''} yet.`;
  }
  if (id === null) {
    const byName = await resolveGamePlan(q, words);
    if (byName.match) id = byName.match.id;
    else if (none) return { gamePlanId: null, speech: none };
  }
  if (id === null) return { gamePlanId: null, speech: `I couldn't find a game plan called ${words}.` };
  const v = (await gamePlanView(q, id))!;
  if (!v.steps.length) return { gamePlanId: id, speech: `${v.name} doesn't have any steps yet.` };
  const step = (s: GamePlanStep) => `${lowerFirst(s.action)}${s.note ? `, to ${lowerFirst(s.note)}` : ''}`;
  // Where a step has alternatives, each is its own branch: said as one sentence, with what comes after it inside.
  const branch = (s: GamePlanStep) =>
    `${step(s)}${s.slots.map(c => (c.trigger ? `; if ${c.trigger}, ${step(c.options[0]!)}` : `, then ${step(c.options[0]!)}`)).join('')}`;
  const parts: string[] = [];
  v.steps.forEach((slot, i) => {
    const lead = (t: string) => (i === 0 ? capitalise(t) : `Then ${t}`);
    const [first, ...alternatives] = slot.options;
    if (alternatives.length) {
      parts.push(`${lead(branch(first!))}.`, ...alternatives.map(a => `Or instead, ${branch(a)}.`));
      return;
    }
    parts.push(`${lead(step(first!))}.`);
    for (const r of first!.slots) {
      const [then, ...others] = r.options;
      parts.push(`${r.trigger ? `If ${r.trigger}, ` : 'Then '}${step(then!)}.`, ...others.map(a => `Or ${step(a)}.`));
    }
  });
  const when = v.premise ? ` When ${lowerFirst(v.premise)}:` : '';
  return { gamePlanId: id, speech: `${v.name}.${when} ${parts.join(' ')}`.replace(/\.\./g, '.') };
}
