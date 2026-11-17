// The steps on a game plan's page: the outline, which sheet is open, and the changes each one saves.
import { useState } from 'react';
import type { GamePlanDetail, StepMove } from '../../../../src/shared/api';
import { countSteps, findStep, lowerFirst } from '../../../../src/shared/steps';
import { useAddStep, useDeleteStep, useGamePlanFetching, useMoveStep, useUpdateStep } from '../../api';
import { ROLE_LABEL } from '../../lib/format';
import { Icon } from '../Icon';
import { useToast } from '../Toast';
import { DescribeSheet } from './DescribeSheet';
import { movesAt } from './model';
import { StepsOutline } from './Outline';
import { StartSheet } from './StartSheet';
import { StepSheet } from './StepSheet';

/** Editing state on a game plan's page: which step's sheet is open (by the step's id), if any. */
type StepEdit = { stepId: number; mode: 'edit' } | { stepId: number; mode: 'then' | 'branch' | 'or' } | { stepId: null; mode: 'first' | 'end' };

const TITLES: Record<StepEdit['mode'], string> = { edit: 'Edit step', branch: 'If they…', or: 'Or…', first: 'First step', end: 'Next step', then: 'Then…' };

/**
 * The steps section of a game plan's page: the outline, and editing it a step at a time. Each change saves that
 * one step (the others keep their ids), with Undo; it's refused if the game plan changed somewhere else since
 * this page read it.
 */
export function StepsSection({ gamePlan }: { gamePlan: GamePlanDetail }) {
  const [editing, setEditing] = useState(false);
  const [step, setStep] = useState<StepEdit | null>(null);
  const [describing, setDescribing] = useState(false);
  const [startOpen, setStartOpen] = useState(false);
  const addStep = useAddStep();
  const updateStep = useUpdateStep();
  const deleteStep = useDeleteStep();
  const moveStep = useMoveStep();
  const toast = useToast();
  // While the page is being read again (after an undo, say), what's here may be out of date: writes wait.
  const fetching = useGamePlanFetching(gamePlan.id);
  const busy = addStep.isPending || updateStep.isPending || deleteStep.isPending || moveStep.isPending || fetching;
  const at = { gamePlanId: gamePlan.id, expectedUpdatedAt: gamePlan.updatedAt };
  /** After a write: say so (with Undo, if it changed anything), then close the sheet. */
  const done = (said: string | null) => ({
    onSuccess: (r: { message: string; activityId?: number }) => {
      toast.show(said !== null && r.activityId !== undefined ? said : r.message, { undoId: r.activityId });
      setStep(null);
    },
    // Including "changed somewhere else": the page is read again, and the sheet stays to try once more.
    onError: toast.error,
  });
  const move = (stepId: number, m: StepMove) => moveStep.mutate({ ...at, stepId, ...m }, done(null));

  // The step being edited may have been deleted somewhere else since its sheet opened.
  const current = step?.mode === 'edit' ? findStep(gamePlan.steps, s => s.id === step.stepId) : null;
  const sheet = step && (step.mode !== 'edit' || current) ? step : null;
  const k = current ? current.slot.options.indexOf(current.step) : 0;
  const askWhen = sheet?.mode === 'branch' || (sheet?.mode === 'edit' && current!.trail.length > 0 && k === 0);

  return (
    <>
      <div className="row-split section-row">
        <h2 className="section-title grow">Steps</h2>
        {gamePlan.steps.length > 0 ? (
          <button type="button" className="btn ghost small" aria-pressed={editing} onClick={() => setEditing(!editing)}>
            {editing ? 'Done' : 'Edit'}
          </button>
        ) : null}
        <button type="button" className="btn ghost small" onClick={() => setDescribing(true)}>
          Describe it
        </button>
      </div>

      <button type="button" className="game-plan-start" onClick={() => setStartOpen(true)}>
        {gamePlan.start || gamePlan.premise ? (
          <>
            <span className="game-plan-start-label">Starts</span>
            {gamePlan.start ? (
              <>
                {' '}
                in <strong>{gamePlan.start.name}</strong>
                {gamePlan.startRole ? `, ${ROLE_LABEL[gamePlan.startRole].toLowerCase()}` : ''}
              </>
            ) : null}
            {gamePlan.premise && <span className="game-plan-premise">When {lowerFirst(gamePlan.premise)}</span>}
          </>
        ) : (
          <span className="muted">Where does it start? Add a position and the situation it's for.</span>
        )}
      </button>

      {gamePlan.steps.length > 0 ? (
        <section className="panel steps-panel">
          <StepsOutline
            steps={gamePlan.steps}
            onEdit={
              editing
                ? {
                    step: stepId => setStep({ stepId, mode: 'edit' }),
                    add: (stepId, kind) => setStep({ stepId, mode: kind }),
                    moves: stepId => movesAt(gamePlan.steps, stepId),
                    move,
                    busy,
                  }
                : undefined
            }
          />
          {editing && (
            <div className="step-add steps-add-end">
              <button type="button" className="btn ghost small" onClick={() => setStep({ stepId: null, mode: 'end' })}>
                <Icon name="plus" size={16} />
                Add a step at the end
              </button>
            </div>
          )}
        </section>
      ) : (
        <>
          <p className="section-hint">
            The steps, in order, what to do when they react, and a plan B where you have one. Describe it in your own words, or build it a step at a
            time.
          </p>
          <button type="button" className="btn quiet small section-action" onClick={() => setStep({ stepId: null, mode: 'first' })}>
            <Icon name="plus" size={18} />
            First step
          </button>
        </>
      )}

      {sheet && (
        <StepSheet
          title={TITLES[sheet.mode]}
          initial={
            current
              ? {
                  trigger: k === 0 ? current.slot.trigger : null,
                  action: current.step.action,
                  technique: current.step.technique,
                  toPositionId: current.step.to?.id ?? null,
                  toName: current.step.to?.name ?? null,
                  toRole: current.step.toRole,
                  note: current.step.note,
                }
              : null
          }
          askWhen={askWhen}
          following={current ? countSteps(current.step.slots) : 0}
          busy={busy}
          onClose={() => setStep(null)}
          onSave={form => {
            const fields = { action: form.action, techniqueId: form.technique?.id ?? null, toPositionId: form.toPositionId, toRole: form.toRole, note: form.note };
            if (sheet.mode === 'edit') {
              // The reaction is the slot's: it's only asked (and only sent) where it can change.
              updateStep.mutate({ ...at, stepId: sheet.stepId, ...fields, ...(askWhen ? { trigger: form.trigger } : {}) }, done('Step saved'));
            } else if (sheet.mode === 'or') {
              // "Or" is one more alternative to this step, after the ones it has.
              addStep.mutate({ ...at, relation: 'or', of: sheet.stepId, ...fields }, done('Step added'));
            } else {
              // The main line grows at the end; "Then" and "If they…" hang under the step they were added from, after what's there.
              const relation = sheet.mode === 'branch' && form.trigger ? 'if' : 'then';
              addStep.mutate({ ...at, relation, of: sheet.stepId ?? undefined, ...fields, ...(relation === 'if' ? { trigger: form.trigger } : {}) }, done('Step added'));
            }
          }}
          // Without plan A, plan B is the plan: the server gives it the reaction the slot answers.
          onDelete={sheet.mode === 'edit' ? () => deleteStep.mutate({ ...at, stepId: sheet.stepId }, done('Step deleted')) : undefined}
          onPrefer={sheet.mode === 'edit' && k > 0 ? () => move(sheet.stepId, { within: 'choice', to: 'first' }) : undefined}
          // Plan B's way earlier is "Make this plan A"; from plan C on, one place at a time too.
          onEarlier={sheet.mode === 'edit' && k > 1 ? () => move(sheet.stepId, { within: 'choice', to: 'up' }) : undefined}
          onLater={sheet.mode === 'edit' && k < current!.slot.options.length - 1 ? () => move(sheet.stepId, { within: 'choice', to: 'down' }) : undefined}
        />
      )}
      {startOpen && <StartSheet gamePlan={gamePlan} onClose={() => setStartOpen(false)} />}
      {describing && <DescribeSheet gamePlan={gamePlan} onClose={() => setDescribing(false)} />}
    </>
  );
}
