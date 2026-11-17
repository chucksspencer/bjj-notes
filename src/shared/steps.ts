// Shared by the server and the web app. A game plan's steps as one structure: slots and options.
//
// Under one parent (a step, or the game plan itself for the main line) the steps are a list of slots, in order.
// A slot is a choice between its options: plan A first, then plan B, and so on. Each option is a branch: its own
// slots are what follows that option. The next slot under the same parent is what follows once the choice is
// resolved, whichever option was used. A slot with a trigger is an "if they…" branch; without one it is a "then".

/** Steps can nest this deep (0 = main line). */
export const MAX_DEPTH = 6;
/** And a game plan can have this many. */
export const MAX_STEPS = 60;

/** A choice between options, in order of preference. Its trigger is the reaction all of them answer. */
export interface Slot<S> {
  /** Its place among the slots under the same parent (1 = first). */
  ordinal: number;
  /** The reaction that leads here ("they post the far leg"); null for "then". */
  trigger: string | null;
  /** Plan A, then plan B, and so on. Never empty. */
  options: S[];
}

/** What every step has: the slots that follow it. `S` is the step type itself. */
export interface Branch<S> {
  slots: Slot<S>[];
}

/** A step made of its own fields `F`, its place in its slot (0 = plan A), and what follows it. */
export type Option<F> = F & { option: number; slots: Slot<Option<F>>[] };

// ---------- from stored rows ----------

/** A stored step, as far as its place goes. */
export interface PlacedRow {
  id: number;
  parent_id: number | null;
  ordinal: number;
  option: number;
  trigger: string | null;
}

/** Steps under one parent, grouped into slots: slots in order, and each slot's options in order. */
export function groupSlots<R extends { ordinal: number; option: number }>(siblings: R[]): R[][] {
  const out: R[][] = [];
  let ordinal: number | null = null;
  for (const r of [...siblings].sort((a, b) => a.ordinal - b.ordinal || a.option - b.option)) {
    if (r.ordinal === ordinal) out.at(-1)!.push(r);
    else out.push([r]);
    ordinal = r.ordinal;
  }
  return out;
}

/** A game plan's stored steps (in any order) as a tree of slots. `fields` picks what each step carries. */
export function toTree<R extends PlacedRow, F>(rows: R[], fields: (row: R) => F): Slot<Option<F>>[] {
  const under = new Map<number | null, R[]>();
  for (const r of rows) under.set(r.parent_id, [...(under.get(r.parent_id) ?? []), r]);
  const slotsUnder = (parent: number | null): Slot<Option<F>>[] =>
    groupSlots(under.get(parent) ?? []).map(group => ({
      ordinal: group[0]!.ordinal,
      trigger: group[0]!.trigger,
      options: group.map(r => ({ ...fields(r), option: r.option, slots: slotsUnder(r.id) })),
    }));
  return slotsUnder(null);
}

// ---------- the flat outline ----------

/**
 * One step of a flat outline: the format Claude sends, and "Describe it" drafts. Steps come in reading order.
 * `depth` says where each hangs (0 = main line; one deeper = under the nearest step above it at the depth
 * before). `or` makes it an alternative to the nearest step above it at the same depth, under the same step.
 */
export interface OutlineStep {
  depth: number;
  or?: boolean;
  trigger?: string | null;
}

/** What's wrong with an outline's shape, in words; null when it's fine. */
export function outlineProblem(steps: OutlineStep[]): string | null {
  if (steps.length > MAX_STEPS) return `A game plan can have at most ${MAX_STEPS} steps.`;
  let prev = -1;
  // Whether there's already a step at each depth under the current parent (for "or" to be an alternative to).
  const has: boolean[] = [];
  for (const [i, s] of steps.entries()) {
    if (!Number.isInteger(s.depth) || s.depth < 0 || s.depth > MAX_DEPTH) return `Step ${i + 1}: depth must be 0 to ${MAX_DEPTH}.`;
    if (s.depth > prev + 1) {
      return i === 0 ? 'The first step must be on the main line (depth 0).' : `Step ${i + 1} is ${s.depth - prev} levels deeper than the step before it.`;
    }
    if (s.or && !has[s.depth]) return `Step ${i + 1}: "or" needs a step before it at the same level to be an alternative to.`;
    has[s.depth] = true;
    has.length = s.depth + 1;
    prev = s.depth;
  }
  return null;
}

/**
 * A flat outline as a tree of slots. The outline must be well formed (see `outlineProblem`). An alternative's
 * own trigger is dropped: it answers the same reaction as its plan A.
 */
export function fromOutline<T extends OutlineStep, F>(steps: T[], fields: (step: T) => F): Slot<Option<F>>[] {
  const top: Slot<Option<F>>[] = [];
  // The step the outline is inside at each depth.
  const open: Option<F>[] = [];
  for (const s of steps) {
    open.length = s.depth;
    const slots = s.depth === 0 ? top : open[s.depth - 1]!.slots;
    const last = slots.at(-1);
    const step: Option<F> = { ...fields(s), option: s.or && last ? last.options.length : 0, slots: [] };
    if (s.or && last) last.options.push(step);
    else slots.push({ ordinal: slots.length + 1, trigger: s.trigger?.trim() || null, options: [step] });
    open[s.depth] = step;
  }
  return top;
}

/** A tree of slots as a flat outline, in reading order: each option, then what follows it, then the next option. */
export function toOutline<S extends Branch<S>, T>(slots: Slot<S>[], fields: (step: S) => T, depth = 0): (T & { depth: number; or: boolean; trigger: string | null })[] {
  return slots.flatMap(slot =>
    slot.options.flatMap((step, k) => [{ ...fields(step), depth, or: k > 0, trigger: k === 0 ? slot.trigger : null }, ...toOutline(step.slots, fields, depth + 1)]),
  );
}

// ---------- walking ----------

/** Where a step is in the tree. */
export interface Place<S> {
  step: S;
  /** The slot it is an option of. */
  slot: Slot<S>;
  /** The slots under the same parent, its own included. */
  siblings: Slot<S>[];
  /** The steps it hangs under, from the main line down; empty for a step on the main line. */
  trail: S[];
}

/** Calls `visit` for every step, depth first, in reading order. */
export function walk<S extends Branch<S>>(slots: Slot<S>[], visit: (place: Place<S>) => void, trail: S[] = []): void {
  for (const slot of slots) {
    for (const step of slot.options) {
      visit({ step, slot, siblings: slots, trail });
      walk(step.slots, visit, [...trail, step]);
    }
  }
}

/** Every step, depth first, in reading order. */
export function stepsIn<S extends Branch<S>>(slots: Slot<S>[]): S[] {
  const out: S[] = [];
  walk(slots, p => out.push(p.step));
  return out;
}

/** How many steps there are, counting every option and everything under each. */
export const countSteps = <S extends Branch<S>>(slots: Slot<S>[]): number => stepsIn(slots).length;

/** The first step that passes `test`, with where it is; null if none does. */
export function findStep<S extends Branch<S>>(slots: Slot<S>[], test: (step: S) => boolean): Place<S> | null {
  let found: Place<S> | null = null;
  walk(slots, p => {
    if (!found && test(p.step)) found = p;
  });
  return found;
}
