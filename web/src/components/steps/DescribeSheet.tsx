// "Describe it": say the game plan in words, check the outline Claude drafts, then save it.
import { useState } from 'react';
import type { GamePlanDetail } from '../../../../src/shared/api';
import { useDraftGamePlan, useEditGamePlan } from '../../api';
import { Sheet } from '../Sheet';
import { useToast } from '../Toast';
import { fromDraft, lowerFirst, toInput } from './model';
import { StepsOutline } from './Outline';

/** Say the game plan in your own words; Claude outlines it; check it, then save it (replacing the steps). */
export function DescribeSheet({ gamePlan, onClose }: { gamePlan: GamePlanDetail; onClose: () => void }) {
  const [text, setText] = useState('');
  const draft = useDraftGamePlan();
  const edit = useEditGamePlan();
  const toast = useToast();
  const d = draft.data;
  const tree = d ? fromDraft(d) : [];
  return (
    <Sheet title="Describe the game plan" onClose={onClose}>
      {!d ? (
        <form
          onSubmit={e => {
            e.preventDefault();
            if (text.trim()) draft.mutate(text.trim(), { onError: toast.error });
          }}
        >
          <label className="field">
            <span className="label">In your own words</span>
            <textarea
              className="textarea"
              autoFocus
              rows={7}
              placeholder="From bottom half, if they have the underhook and crossface: John Wayne sweep to make them post, win the underhook, then shuck. If they post the far leg, go to deep half. If they base back, octopus."
              value={text}
              onChange={e => setText(e.target.value)}
            />
          </label>
          <button className="btn block" type="submit" disabled={draft.isPending || !text.trim()}>
            {draft.isPending ? 'Outlining…' : 'Outline it'}
          </button>
          {gamePlan.steps.length > 0 && <p className="muted small">You'll see the outline before it replaces the steps you have.</p>}
        </form>
      ) : (
        <>
          {(d.start || d.premise) && (
            <p className="game-plan-start static">
              <span className="game-plan-start-label">Starts</span>
              {d.start && (
                <>
                  {' '}
                  in <strong>{d.start.name}</strong>
                  {d.startRole ? `, ${d.startRole}` : ''}
                </>
              )}
              {d.premise && <span className="game-plan-premise">When {lowerFirst(d.premise)}</span>}
            </p>
          )}
          <section className="panel steps-panel">
            {tree.length ? <StepsOutline steps={tree} draft /> : <div className="empty">Claude didn't find any steps in that.</div>}
          </section>
          <div className="row-split" style={{ marginTop: 12 }}>
            <button type="button" className="btn quiet grow" onClick={() => draft.reset()}>
              Change the words
            </button>
            <button
              type="button"
              className="btn grow"
              disabled={edit.isPending || !tree.length}
              onClick={() =>
                edit.mutate(
                  {
                    id: gamePlan.id,
                    // Replaces every step: refused if the game plan changed somewhere else since this page read it.
                    expectedUpdatedAt: gamePlan.updatedAt,
                    steps: toInput(tree),
                    ...(d.start ? { startPositionId: d.start.id, startRole: d.startRole } : {}),
                    ...(d.premise ? { premise: d.premise } : {}),
                  },
                  {
                    onSuccess: r => {
                      toast.show('Steps saved', { undoId: r.activityId });
                      onClose();
                    },
                    onError: toast.error,
                  },
                )
              }
            >
              Save steps
            </button>
          </div>
        </>
      )}
    </Sheet>
  );
}
