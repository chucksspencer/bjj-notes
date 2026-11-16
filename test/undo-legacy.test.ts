// Undo entries are stored as they were written, so the log still holds the shapes from before focus items became
// areas (016) and areas became game plans (018). normalizeUndoOp turns each into today's shape.
import { describe, expect, it } from 'vitest';
import { normalizeUndoOp } from '../src/services/activity.js';

const before = { id: 7, name: 'Escapes', aliases: [], description: null, start_position_id: null, start_role: null, premise: null };
const step = { id: 1, parent_id: null, ordinal: 1, trigger: null, action: 'Shuck', technique_id: null, to_position_id: null, to_role: null, note: null };
const linkIds = { techniques: [3], notes: [] };

describe('old undo entries', () => {
  it('maps every renamed kind and key to the current shape', () => {
    expect(normalizeUndoOp({ kind: 'restore_area', before, steps: [step] })).toEqual({ kind: 'restore_game_plan', before, steps: [step] });
    const row = { ...before, rank: 2, goal: null, created_at: 'c', updated_at: 'u' };
    expect(normalizeUndoOp({ kind: 'restore_deleted_area', row, techniqueIds: [3], noteIds: [], steps: [], events: [] })).toEqual({
      kind: 'restore_deleted_game_plan',
      row,
      techniqueIds: [3],
      noteIds: [],
      steps: [],
      events: [],
    });
    expect(normalizeUndoOp({ kind: 'restore_focus_links', itemId: 7, added: linkIds, removed: linkIds })).toEqual({
      kind: 'restore_game_plan_links',
      gamePlanId: 7,
      added: linkIds,
      removed: linkIds,
    });
    expect(normalizeUndoOp({ kind: 'restore_focus_label', itemId: 7, label: 'Old', goal: 'g' })).toEqual({
      kind: 'restore_game_plan_label',
      gamePlanId: 7,
      label: 'Old',
      goal: 'g',
    });
    expect(normalizeUndoOp({ kind: 'restore_focus', items: [{ id: 7, rank: 1 }], deleteItemId: 9, eventIds: [4], addedLinks: [{ item: 7, technique: 3 }] })).toEqual({
      kind: 'restore_focus',
      items: [{ id: 7, rank: 1 }],
      deleteGamePlanId: 9,
      eventIds: [4],
      addedLinks: [{ gamePlanId: 7, techniqueId: 3 }],
    });
    const note = { kind: 'restore_note', row: { id: 1 }, techniqueIds: [], focusItemIds: [7] };
    expect(normalizeUndoOp(note)).toEqual({ kind: 'restore_note', row: { id: 1 }, techniqueIds: [], gamePlanIds: [7] });
    const technique = { kind: 'restore_deleted_technique', row: { id: 3 }, edges: [], links: [], noteIds: [], focusItemIds: [7] };
    expect(normalizeUndoOp(technique)).toMatchObject({ gamePlanIds: [7] });
    expect(normalizeUndoOp(technique)).not.toHaveProperty('focusItemIds');
  });

  it('maps the entries inside a batch, however deep', () => {
    const old = { kind: 'batch', ops: [{ kind: 'batch', ops: [{ kind: 'restore_area', before }] }, { kind: 'restore_focus_links', itemId: 7, added: linkIds, removed: linkIds }] };
    expect(normalizeUndoOp(old)).toEqual({
      kind: 'batch',
      ops: [
        { kind: 'batch', ops: [{ kind: 'restore_game_plan', before }] },
        { kind: 'restore_game_plan_links', gamePlanId: 7, added: linkIds, removed: linkIds },
      ],
    });
  });

  it('leaves current entries alone', () => {
    const current = [
      { kind: 'restore_game_plan', before, steps: [step] },
      { kind: 'restore_focus', items: [], deleteGamePlanId: null, eventIds: [] },
      { kind: 'restore_game_plan_links', gamePlanId: 7, added: linkIds, removed: linkIds },
      { kind: 'restore_note', row: { id: 1 }, techniqueIds: [], gamePlanIds: [7] },
      { kind: 'delete_note', noteId: 1, createdTechniqueIds: [] },
    ];
    for (const op of current) expect(normalizeUndoOp(op)).toEqual(op);
  });
});
