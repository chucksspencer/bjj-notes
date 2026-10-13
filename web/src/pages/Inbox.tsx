import { useState } from 'react';
import type { NoteView, TechniqueRef } from '../../../src/shared/api';
import { useFileNote, useFocus, useNotes } from '../api';
import { useCapture } from '../components/Capture';
import { Sheet } from '../components/Sheet';
import { TechniquePicker, type NewTechnique } from '../components/TechniquePicker';
import { useToast } from '../components/Toast';
import { SourceLink } from '../components/Video';
import { friendlyDate, localToday, NOTE_KIND_LABEL } from '../lib/format';

export function Inbox() {
  const notes = useNotes({ inbox: true, limit: 100 });
  const focus = useFocus();
  const today = focus.data?.today ?? localToday();
  const [filing, setFiling] = useState<NoteView | null>(null);
  const capture = useCapture();

  return (
    <div className="page">
      <header className="page-head">
        <h1 className="display page-title">Inbox</h1>
      </header>
      <p className="muted" style={{ marginTop: -8 }}>
        Notes that aren't filed under a technique yet.
      </p>
      <section className="panel">
        {notes.isError && <div className="empty">Couldn't load the inbox. {notes.error.message}</div>}
        {notes.data?.length === 0 && <div className="empty">Nothing to file.</div>}
        {notes.data?.map(n => (
          <article key={n.id} className="row">
            <div className="note-head">
              <span>
                {friendlyDate(n.observedOn, today)}, {NOTE_KIND_LABEL[n.kind].toLowerCase()}
              </span>
              <button type="button" className="btn ghost small" onClick={() => capture.edit(n)}>
                Edit
              </button>
            </div>
            <div className="note-body">{n.body}</div>
            {n.source?.url && <SourceLink url={n.source.url} timestamp={n.sourceTimestamp} title={n.source.title} />}
            <div className="note-foot">
              <button type="button" className="btn quiet small" onClick={() => setFiling(n)}>
                File under a technique
              </button>
            </div>
          </article>
        ))}
      </section>
      {filing && <FileSheet note={filing} onClose={() => setFiling(null)} />}
    </div>
  );
}

function FileSheet({ note, onClose }: { note: NoteView; onClose: () => void }) {
  const [selected, setSelected] = useState<TechniqueRef[]>(note.techniques);
  const [newOnes, setNewOnes] = useState<NewTechnique[]>([]);
  const file = useFileNote();
  const toast = useToast();
  return (
    <Sheet title="File note" onClose={onClose}>
      <p className="note-body" style={{ marginTop: 0 }}>
        {note.body}
      </p>
      <TechniquePicker selected={selected} onChange={setSelected} newOnes={newOnes} onNewChange={setNewOnes} />
      <button
        type="button"
        className="btn block"
        disabled={file.isPending || (selected.length === 0 && newOnes.length === 0)}
        onClick={() =>
          file.mutate(
            { id: note.id, techniqueIds: selected.map(t => t.id), newTechniques: newOnes },
            {
              onSuccess: r => {
                toast.show(`Filed under ${r.techniques.map(t => t.name).join(', ')}`, { undoable: true });
                onClose();
              },
              onError: toast.error,
            },
          )
        }
      >
        File note
      </button>
    </Sheet>
  );
}
