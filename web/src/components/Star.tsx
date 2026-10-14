import { useState } from 'react';
import type { NoteView } from '../../../src/shared/api';
import { useEditNote, usePatchTechnique } from '../api';
import { Icon } from './Icon';
import { useToast } from './Toast';

/**
 * A star toggle. Starred techniques and notes collect in the Lab. It flips at once and keeps the tapped
 * value until the server's answer comes back; the label stays put and aria-pressed says whether it's on.
 */
function StarToggle({ starred, label, size = 20, set }: { starred: boolean; label: string; size?: number; set: (on: boolean) => Promise<unknown> }) {
  const toast = useToast();
  const [pending, setPending] = useState<{ from: boolean; to: boolean } | null>(null);
  const on = pending && pending.from === starred ? pending.to : starred;
  return (
    <button
      type="button"
      className={`btn ghost small star${on ? ' on' : ''}`}
      aria-pressed={on}
      aria-label={label}
      title={on ? 'Starred: in the Lab. Tap to unstar' : 'Star: keep it in the Lab'}
      onClick={() => {
        setPending({ from: starred, to: !on });
        set(!on).then(
          () => toast.show(on ? 'Unstarred' : 'Starred. It’s in the Lab', { undoable: true }),
          err => {
            setPending(null);
            toast.error(err);
          },
        );
      }}
    >
      <Icon name="star" size={size} filled={on} />
    </button>
  );
}

export function NoteStar({ note }: { note: NoteView }) {
  const edit = useEditNote();
  return <StarToggle starred={note.starred} label="Star note" set={starred => edit.mutateAsync({ id: note.id, starred })} />;
}

export function TechniqueStar({ technique, size }: { technique: { id: number; name: string; starred: boolean }; size?: number }) {
  const patch = usePatchTechnique(technique.id);
  return (
    <StarToggle starred={technique.starred} label={`Star ${technique.name}`} size={size} set={starred => patch.mutateAsync({ starred })} />
  );
}
