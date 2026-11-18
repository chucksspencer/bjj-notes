// The sheet for where a game plan starts.
import { useState } from 'react';
import type { GamePlanDetail, Role } from '../../../../src/shared/api';
import { useEditGamePlan } from '../../api';
import { Sheet } from '../Sheet';
import { useToast } from '../Toast';
import { PositionSelect, RoleSegments } from './StepSheet';

/** Where the game plan starts and the situation it's for. */
export function StartSheet({ gamePlan, onClose }: { gamePlan: GamePlanDetail; onClose: () => void }) {
  const [start, setStart] = useState<number | null>(gamePlan.start?.id ?? null);
  const [role, setRole] = useState<Role | null>(gamePlan.startRole);
  const [premise, setPremise] = useState(gamePlan.premise ?? '');
  const edit = useEditGamePlan();
  const toast = useToast();
  return (
    <Sheet title="Where it starts" onClose={onClose}>
      <form
        onSubmit={e => {
          e.preventDefault();
          edit.mutate(
            { id: gamePlan.id, startPositionId: start, startRole: start ? role : null, premise: premise.trim() || null },
            {
              onSuccess: r => {
                toast.show('Saved', { undoId: r.activityId });
                onClose();
              },
              onError: toast.error,
            },
          );
        }}
      >
        <PositionSelect label="Position" value={start} onChange={id => setStart(id)} />
        {start !== null && <RoleSegments value={role} onChange={setRole} />}
        <label className="field">
          <span className="label">When… (the situation, optional)</span>
          <input className="input" placeholder="they have the underhook and crossface" value={premise} onChange={e => setPremise(e.target.value)} />
        </label>
        <button className="btn block" type="submit" disabled={edit.isPending}>
          Save
        </button>
      </form>
    </Sheet>
  );
}
