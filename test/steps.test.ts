// The shared steps structure (src/shared/steps.ts): slots and options. Pure functions, so no server or database.
import { describe, expect, it } from 'vitest';
import {
  countSteps,
  findStep,
  fromOutline,
  groupSlots,
  MAX_DEPTH,
  MAX_STEPS,
  outlineProblem,
  stepsIn,
  toOutline,
  toTree,
  walk,
  type Option,
  type OutlineStep,
  type Slot,
} from '../src/shared/steps.js';

type Named = Option<{ name: string }>;
const step = (depth: number, name: string, extra: Partial<OutlineStep> = {}) => ({ depth, name, ...extra });
const names = (slots: Slot<Named>[]): unknown[] => slots.map(s => [s.ordinal, s.trigger, s.options.map(o => (o.slots.length ? [o.option, o.name, names(o.slots)] : [o.option, o.name]))]);

// 1a. Sweep / 1b. Or: lever (then: come up) / 2. Shuck: if they post, deep half or dogfight; if they base, octopus; then pass.
const outline = [
  step(0, 'Sweep'),
  step(0, 'Lever', { or: true }),
  step(1, 'Come up'),
  step(0, 'Shuck'),
  step(1, 'Deep half', { trigger: 'they post' }),
  step(1, 'Dogfight', { or: true }),
  step(2, 'Finish'),
  step(1, 'Octopus', { trigger: 'they base' }),
  step(1, 'Pass'),
];
const tree = () => fromOutline(outline, s => ({ name: s.name }));

describe('an outline as a tree of slots', () => {
  it('puts each "or" in the slot of the step it is an alternative to, and what follows an option under it', () => {
    expect(names(tree())).toEqual([
      [1, null, [[0, 'Sweep'], [1, 'Lever', [[1, null, [[0, 'Come up']]]]]]],
      [
        2,
        null,
        [
          [
            0,
            'Shuck',
            [
              [1, 'they post', [[0, 'Deep half'], [1, 'Dogfight', [[1, null, [[0, 'Finish']]]]]]],
              [2, 'they base', [[0, 'Octopus']]],
              [3, null, [[0, 'Pass']]],
            ],
          ],
        ],
      ],
    ]);
  });

  it('goes back to the same flat outline', () => {
    const back = toOutline(tree(), s => ({ name: s.name }));
    expect(back).toEqual(outline.map(s => ({ name: s.name, depth: s.depth, or: s.or === true, trigger: s.trigger ?? null })));
    // And round again, to the same tree.
    expect(names(fromOutline(back, s => ({ name: s.name })))).toEqual(names(tree()));
  });

  it("drops an alternative's own trigger and tidies the slot's", () => {
    const slots = fromOutline([step(0, 'A', { trigger: '  they stall ' }), step(0, 'B', { or: true, trigger: 'ignored' }), step(0, 'C', { trigger: ' ' })], s => ({ name: s.name }));
    expect(names(slots)).toEqual([
      [1, 'they stall', [[0, 'A'], [1, 'B']]],
      [2, null, [[0, 'C']]],
    ]);
    expect(toOutline(slots, s => ({ name: s.name })).map(s => s.trigger)).toEqual(['they stall', null, null]);
  });

  it('is empty for no steps', () => {
    expect(fromOutline([], s => s)).toEqual([]);
    expect(toOutline([], s => s)).toEqual([]);
    expect(countSteps([])).toBe(0);
  });
});

describe('checking an outline', () => {
  const problem = (...steps: [number, boolean?][]) => outlineProblem(steps.map(([depth, or]) => ({ depth, or })));

  it('passes a well-formed one', () => {
    expect(outlineProblem(outline)).toBeNull();
    expect(outlineProblem([])).toBeNull();
    expect(problem(...Array.from({ length: MAX_DEPTH + 1 }, (_, d): [number] => [d]))).toBeNull();
  });

  it('says what is wrong, by step', () => {
    expect(problem([1])).toBe('The first step must be on the main line (depth 0).');
    expect(problem([0], [2])).toBe('Step 2 is 2 levels deeper than the step before it.');
    expect(problem([0], [1], [0], [3])).toBe('Step 4 is 3 levels deeper than the step before it.');
    expect(problem([0, true])).toBe('Step 1: "or" needs a step before it at the same level to be an alternative to.');
    expect(problem([0], [1, true])).toBe('Step 2: "or" needs a step before it at the same level to be an alternative to.');
    // A branch under one step isn't something a later step's first branch can be an alternative to.
    expect(problem([0], [1], [0], [1, true])).toBe('Step 4: "or" needs a step before it at the same level to be an alternative to.');
    expect(problem([0], [1], [1, true], [0], [0, true])).toBeNull();
    expect(problem([0], [-1])).toBe(`Step 2: depth must be 0 to ${MAX_DEPTH}.`);
    expect(problem([0], [0.5])).toBe(`Step 2: depth must be 0 to ${MAX_DEPTH}.`);
    expect(problem(...Array.from({ length: MAX_DEPTH + 2 }, (_, d): [number] => [d]))).toBe(`Step ${MAX_DEPTH + 2}: depth must be 0 to ${MAX_DEPTH}.`);
    expect(problem(...Array.from({ length: MAX_STEPS + 1 }, (): [number] => [0]))).toBe(`A game plan can have at most ${MAX_STEPS} steps.`);
    expect(problem(...Array.from({ length: MAX_STEPS }, (): [number] => [0]))).toBeNull();
  });
});

describe('stored rows as slots', () => {
  const row = (id: number, parent_id: number | null, ordinal: number, option: number, trigger: string | null = null) => ({ id, parent_id, ordinal, option, trigger });

  it('groups the steps under one parent by slot, options in order, whatever order they come in', () => {
    const rows = [row(5, null, 2, 1), row(1, null, 1, 0), row(4, null, 2, 0), row(9, null, 4, 0), row(7, null, 2, 2)];
    expect(groupSlots(rows).map(slot => slot.map(r => r.id))).toEqual([[1], [4, 5, 7], [9]]);
    expect(groupSlots([])).toEqual([]);
    // The rows given aren't reordered.
    expect(rows.map(r => r.id)).toEqual([5, 1, 4, 9, 7]);
  });

  it('builds the tree from rows in any order, with the trigger from plan A', () => {
    const rows = [
      row(12, 10, 1, 1),
      row(20, null, 2, 0),
      row(13, 12, 1, 0),
      row(10, null, 1, 0),
      row(11, 10, 1, 0, 'they post'),
      row(14, 10, 2, 0),
      row(21, null, 2, 1),
    ];
    const slots = toTree(rows, r => ({ id: r.id }));
    const ids = (list: typeof slots): unknown[] => list.map(s => [s.ordinal, s.trigger, s.options.map(o => (o.slots.length ? [o.option, o.id, ids(o.slots)] : [o.option, o.id]))]);
    expect(ids(slots)).toEqual([
      [1, null, [[0, 10, [[1, 'they post', [[0, 11], [1, 12, [[1, null, [[0, 13]]]]]]], [2, null, [[0, 14]]]]]]],
      [2, null, [[0, 20], [1, 21]]],
    ]);
    expect(stepsIn(slots).map(s => s.id)).toEqual([10, 11, 12, 13, 14, 20, 21]);
  });
});

describe('walking the tree', () => {
  it('visits every step depth first, in reading order, and counts them', () => {
    expect(stepsIn(tree()).map(s => s.name)).toEqual(outline.map(s => s.name));
    expect(countSteps(tree())).toBe(outline.length);
    expect(countSteps(findStep(tree(), s => s.name === 'Shuck')!.step.slots)).toBe(5);
  });

  it('says where each step is: its slot, the slots beside it, and the steps above it', () => {
    const slots = tree();
    const seen: string[] = [];
    walk(slots, p => seen.push(`${p.trail.map(s => s.name).join(' > ')}|${p.slot.ordinal}/${p.siblings.length}|${p.step.option}|${p.step.name}`));
    expect(seen).toEqual([
      '|1/2|0|Sweep',
      '|1/2|1|Lever',
      'Lever|1/1|0|Come up',
      '|2/2|0|Shuck',
      'Shuck|1/3|0|Deep half',
      'Shuck|1/3|1|Dogfight',
      'Shuck > Dogfight|1/1|0|Finish',
      'Shuck|2/3|0|Octopus',
      'Shuck|3/3|0|Pass',
    ]);
    const place = findStep(slots, s => s.name === 'Dogfight')!;
    expect([place.slot.trigger, place.slot.options.map(o => o.name), place.trail.map(s => s.name)]).toEqual(['they post', ['Deep half', 'Dogfight'], ['Shuck']]);
    expect(place.siblings).toBe(place.trail[0]!.slots);
    expect(findStep(slots, s => s.name === 'Nope')).toBeNull();
  });
});
