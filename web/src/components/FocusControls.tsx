import { useState } from 'react';
import type { FocusAction, FocusItemView, FocusRef } from '../../../src/shared/api';
import { useEditFocus, useFocus, useFocusAction } from '../api';
import { Icon } from './Icon';
import { Sheet } from './Sheet';
import { useToast } from './Toast';

/** What can be done to a focus item, on the list and on its page: move it, finish it, pause it, edit or remove it. */
export function FocusActions({
  item,
  first,
  last,
  onEdit,
}: {
  item: FocusItemView;
  /** Top of the active list (no Up or Top). */
  first: boolean;
  /** Bottom of the active list (no Down). */
  last: boolean;
  onEdit: () => void;
}) {
  const act = useFocusAction();
  const toast = useToast();
  const run = (action: FocusAction, position?: number, done?: string) =>
    act.mutate(
      { id: item.id, action, position },
      { onSuccess: r => toast.show(done ?? r.message.replace(/\.$/, ''), { undoable: true }), onError: toast.error },
    );
  const open = item.status === 'active' || item.status === 'paused' || item.status === 'backlog';

  return (
    <div className="focus-actions">
      {item.status === 'active' ? (
        <>
          {!first && (
            <button type="button" className="btn quiet small" disabled={act.isPending} onClick={() => run('move', (item.rank ?? 2) - 1)}>
              <Icon name="up" size={18} />
              Up
            </button>
          )}
          {!last && (
            <button type="button" className="btn quiet small" disabled={act.isPending} onClick={() => run('move', (item.rank ?? 0) + 1)}>
              <Icon name="down" size={18} />
              Down
            </button>
          )}
          {!first && (
            <button type="button" className="btn quiet small" disabled={act.isPending} onClick={() => run('move', 1)}>
              Top
            </button>
          )}
          <button type="button" className="btn quiet small" disabled={act.isPending} onClick={() => run('complete', undefined, `Done: ${item.label}`)}>
            <Icon name="check" size={18} />
            Done
          </button>
          <button type="button" className="btn quiet small" disabled={act.isPending} onClick={() => run('pause', undefined, `Paused ${item.label}`)}>
            Pause
          </button>
        </>
      ) : (
        open && (
          <button type="button" className="btn quiet small" disabled={act.isPending} onClick={() => run('resume', 1, `${item.label} is back at the top`)}>
            Resume
          </button>
        )
      )}
      <button type="button" className="btn quiet small" onClick={onEdit}>
        Edit
      </button>
      {open && (
        <button type="button" className="btn danger small" disabled={act.isPending} onClick={() => run('drop', undefined, `Removed ${item.label}`)}>
          Remove
        </button>
      )}
    </div>
  );
}

/** A focus item's title and description. */
export function FocusEditSheet({ item, onClose }: { item: FocusItemView; onClose: () => void }) {
  const [label, setLabel] = useState(item.label);
  const [description, setDescription] = useState(item.description ?? '');
  const edit = useEditFocus();
  const toast = useToast();
  return (
    <Sheet title="Edit focus" onClose={onClose}>
      <form
        onSubmit={e => {
          e.preventDefault();
          edit.mutate(
            { id: item.id, label: label.trim(), description: description.trim() || null },
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
          <span className="label">Title</span>
          <input className="input" autoFocus value={label} onChange={e => setLabel(e.target.value)} />
        </label>
        <DescriptionField value={description} onChange={setDescription} />
        <button className="btn block" type="submit" disabled={edit.isPending || !label.trim()}>
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

/** Pick which of your open focus items a note is about. */
export function FocusPicker({ selected, onChange }: { selected: FocusRef[]; onChange: (f: FocusRef[]) => void }) {
  const focus = useFocus();
  // Folded away until wanted: most notes aren't pinned to a focus item. Folded, it shows only the ones it's on.
  const [expanded, setExpanded] = useState(false);
  const open = focus.data ? [...focus.data.active, ...focus.data.paused, ...focus.data.backlog] : [];
  // Keep showing an item the note is on even after it's been finished.
  const shown: FocusRef[] = [...open.map(f => ({ id: f.id, label: f.label, status: f.status })), ...selected.filter(s => !open.some(f => f.id === s.id))];
  if (!shown.length) return null;
  if (!expanded) {
    return (
      <div className="field">
        {selected.length > 0 && (
          <>
            <span className="label">On your focus</span>
            <div className="chips" style={{ marginBottom: 4 }}>
              {selected.map(f => (
                <span className="chip chip-toggle" aria-pressed="true" key={f.id}>
                  {f.label}
                  <button type="button" aria-label={`Take it off ${f.label}`} onClick={() => onChange(selected.filter(s => s.id !== f.id))}>
                    <Icon name="close" size={16} />
                  </button>
                </span>
              ))}
            </div>
          </>
        )}
        <button type="button" className="btn ghost" style={{ marginLeft: -8 }} onClick={() => setExpanded(true)}>
          {selected.length ? 'Change focus items' : 'Put it on a focus item'}
        </button>
      </div>
    );
  }
  const on = (id: number) => selected.some(s => s.id === id);
  return (
    <div className="field">
      <span className="label">On your focus (optional)</span>
      <div className="chips" role="group" aria-label="Focus items">
        {shown.map(f => (
          <button
            key={f.id}
            type="button"
            className="chip chip-toggle"
            aria-pressed={on(f.id)}
            onClick={() => onChange(on(f.id) ? selected.filter(s => s.id !== f.id) : [...selected, f])}
          >
            {on(f.id) && <Icon name="check" size={16} />}
            {f.label}
          </button>
        ))}
      </div>
    </div>
  );
}
