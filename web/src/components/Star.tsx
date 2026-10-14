import { useState } from 'react';
import type { NoteView } from '../../../src/shared/api';
import { useEditNote } from '../api';
import { Icon } from './Icon';
import { useToast } from './Toast';

/** Star or unstar a note. Starred notes collect in the Lab. Flips at once, before the server answers. */
export function StarButton({ note }: { note: NoteView }) {
  const edit = useEditNote();
  const toast = useToast();
  // The tapped value, until the note comes back from the server with a different one.
  const [pending, setPending] = useState<{ from: boolean; to: boolean } | null>(null);
  const on = pending && pending.from === note.starred ? pending.to : note.starred;
  return (
    <button
      type="button"
      className={`btn ghost small star${on ? ' on' : ''}`}
      aria-pressed={on}
      aria-label={on ? 'Unstar note' : 'Star note'}
      title={on ? 'Unstar' : 'Star: keep it in the Lab'}
      onClick={() => {
        setPending({ from: note.starred, to: !on });
        edit.mutate(
          { id: note.id, starred: !on },
          {
            onSuccess: () => toast.show(on ? 'Unstarred' : 'Starred. It’s in the Lab', { undoable: true }),
            onError: err => {
              setPending(null);
              toast.error(err);
            },
          },
        );
      }}
    >
      <Icon name="star" size={20} filled={on} />
    </button>
  );
}
