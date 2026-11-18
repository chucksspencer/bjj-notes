// The steps as a tree of slots (see src/shared/steps.ts): the shapes the outline, the sheets and a draft share.
import type { GamePlanDraft, GamePlanRef, GamePlanSlot, GamePlanStepInput, PositionRef, Role, StepMove, TechniqueRef } from '../../../../src/shared/api';
import { findStep, fromOutline, toOutline, type Option, type Slot } from '../../../../src/shared/steps';

/** A step's own fields in the step sheet, and in a drafted outline: what's stored, plus names to show. */
export interface StepForm {
  action: string;
  technique: TechniqueRef | null;
  toPositionId: number | null;
  toName: string | null;
  toRole: Role | null;
  note: string | null;
}

/** One step of a drafted outline: nothing is saved yet, so it has no id. */
export type DraftStep = Option<StepForm>;

/** A step the outline draws: a saved one (`GamePlanStep`), or one of a draft (`DraftStep`). */
export interface AnyStep {
  id?: number;
  option: number;
  action: string;
  technique: TechniqueRef | null;
  note: string | null;
  toRole: Role | null;
  slots: Slot<AnyStep>[];
  /** Saved steps: where it leaves you, and the game plans that start there. */
  to?: PositionRef | null;
  continuesIn?: GamePlanRef[];
  /** Drafted steps: the name of where it leaves you. */
  toName?: string | null;
}

/** A drafted outline (flat, with depths) as a tree. */
export const fromDraft = (draft: GamePlanDraft): Slot<DraftStep>[] =>
  fromOutline(draft.steps, s => ({
    action: s.action,
    technique: s.techniqueId && s.techniqueName ? ({ id: s.techniqueId, name: s.techniqueName, type: 'concept', role: null, status: 'seen' } satisfies TechniqueRef) : null,
    toPositionId: s.toPositionId ?? null,
    toName: s.toName,
    toRole: s.toRole ?? null,
    note: s.note ?? null,
  }));

/** A drafted tree as the flat outline the server takes. */
export const toInput = (slots: Slot<DraftStep>[]): GamePlanStepInput[] =>
  toOutline(slots, n => ({ action: n.action, techniqueId: n.technique?.id ?? null, toPositionId: n.toPositionId, toRole: n.toRole, note: n.note }));

/** Where a step can move: up or down with its alternatives, and earlier or later among them. */
export type Moves = { up: StepMove | null; down: StepMove | null; earlier: StepMove | null; later: StepMove | null };

/**
 * The moves a step has, among its neighbours as the outline draws them. Under a step inside a branch, the
 * branches ("if they…") and what follows ("then", at the same indent) show as two runs, so a slot moves within
 * its own run. On the main line, and under one of several alternatives, everything under a step is one run.
 */
export function movesAt(steps: GamePlanSlot[], stepId: number): Moves {
  const none: Moves = { up: null, down: null, earlier: null, later: null };
  const place = findStep(steps, s => s.id === stepId);
  if (!place) return none;
  const { slot, siblings, trail } = place;
  const k = slot.options.indexOf(place.step);
  const parent = trail.at(-1);
  const split = trail.length >= 2 && findStep(steps, s => s === parent)!.slot.options.length === 1;
  const run = siblings.filter(s => !split || !!s.trigger === !!slot.trigger);
  const at = run.indexOf(slot);
  const leader = k === 0;
  return {
    up: leader && at > 0 ? { before: run[at - 1]!.options[0]!.id } : null,
    down: leader && at < run.length - 1 ? { after: run[at + 1]!.options[0]!.id } : null,
    earlier: k > 0 ? { within: 'choice', to: 'up' } : null,
    later: k < slot.options.length - 1 ? { within: 'choice', to: 'down' } : null,
  };
}
