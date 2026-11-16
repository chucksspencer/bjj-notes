import { useState } from 'react';
import type { GamePlanView } from '../../../src/shared/api';
import { useEditGamePlan, useFocusAction } from '../api';
import { Icon } from './Icon';
import { Sheet } from './Sheet';
import { useToast } from './Toast';

/**
 * A game plan's place on the focus list: a switch to put it on or take it off, and (when it's on) Up, Down and Top.
 * Taking it off means "moved on to other things": the game plan, its steps and notes all stay.
 */
export function FocusControls({ gamePlan, count, compact = false }: { gamePlan: GamePlanView; count: number; compact?: boolean }) {
  const act = useFocusAction();
  const toast = useToast();
  const on = gamePlan.rank !== null;
  const run = (action: 'add' | 'move' | 'remove', position?: number) =>
    act.mutate({ id: gamePlan.id, action, position }, { onSuccess: r => toast.show(r.message.replace(/\.$/, ''), { undoable: true }), onError: toast.error });
  const first = gamePlan.rank === 1;
  const last = gamePlan.rank === count;
  return (
    <div className="focus-actions">
      {!compact && (
        <button
          type="button"
          role="switch"
          aria-checked={on}
          className="switch"
          disabled={act.isPending}
          onClick={() => run(on ? 'remove' : 'add', on ? undefined : 1)}
        >
          <span className="switch-track" aria-hidden>
            <span className="switch-thumb" />
          </span>
          On focus
        </button>
      )}
      {on && !first && (
        <button type="button" className="btn quiet small" disabled={act.isPending} onClick={() => run('move', gamePlan.rank! - 1)}>
          <Icon name="up" size={18} />
          Up
        </button>
      )}
      {on && !last && (
        <button type="button" className="btn quiet small" disabled={act.isPending} onClick={() => run('move', gamePlan.rank! + 1)}>
          <Icon name="down" size={18} />
          Down
        </button>
      )}
      {on && !first && (
        <button type="button" className="btn quiet small" disabled={act.isPending} onClick={() => run('move', 1)}>
          Top
        </button>
      )}
      {compact && on && (
        <button type="button" className="btn quiet small" disabled={act.isPending} onClick={() => run('remove')}>
          Take off focus
        </button>
      )}
    </div>
  );
}

/** A game plan's name, other names and description. */
export function GamePlanEditSheet({ gamePlan, onClose }: { gamePlan: GamePlanView; onClose: () => void }) {
  const [name, setName] = useState(gamePlan.name);
  const [aliases, setAliases] = useState(gamePlan.aliases.join(', '));
  const [description, setDescription] = useState(gamePlan.description ?? '');
  const edit = useEditGamePlan();
  const toast = useToast();
  return (
    <Sheet title="Edit game plan" onClose={onClose}>
      <form
        onSubmit={e => {
          e.preventDefault();
          edit.mutate(
            {
              id: gamePlan.id,
              name: name.trim(),
              description: description.trim() || null,
              aliases: aliases
                .split(',')
                .map(a => a.trim())
                .filter(Boolean),
            },
            {
              onSuccess: () => {
                toast.show('Saved', { undoable: true });
                onClose();
              },
              onError: toast.error,
            },
          );
        }}
      >
        <label className="field">
          <span className="label">Name</span>
          <input className="input" autoFocus value={name} onChange={e => setName(e.target.value)} />
        </label>
        <label className="field">
          <span className="label">Other names (optional, separated by commas)</span>
          <input className="input" placeholder="bottom half system, underhook game" value={aliases} onChange={e => setAliases(e.target.value)} />
        </label>
        <DescriptionField value={description} onChange={setDescription} />
        <button className="btn block" type="submit" disabled={edit.isPending || !name.trim()}>
          Save
        </button>
      </form>
    </Sheet>
  );
}

export function DescriptionField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <label className="field">
      <span className="label">Description (optional)</span>
      <textarea
        className="textarea"
        rows={6}
        maxLength={4000}
        placeholder="The strategy, the cues, and what it looks like when it's working."
        value={value}
        onChange={e => onChange(e.target.value)}
      />
    </label>
  );
}
