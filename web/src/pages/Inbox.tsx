import { useState } from 'react';
import type { NoteView, TechniqueRef } from '../../../src/shared/api';
import { useDeleteNotes, useFileNote, useFocus, useNotes } from '../api';
import { useCapture } from '../components/Capture';
import { countOf, SelectionBar, useSelection } from '../components/Selection';
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
  const selection = useSelection(notes.data?.map(n => n.id) ?? []);
  const del = useDeleteNotes();
  const toast = useToast();

  const deleteSelected = () => {
    if (!window.confirm(`Delete ${countOf(selection.ids.length, 'note')}?`)) return;
    del.mutate(selection.ids, {
      onSuccess: r => {
        toast.show(r.message.replace(/\.$/, ''), { undoable: true });
        selection.stop();
      },
      onError: toast.error,
    });
  };

  return (
    <div className={`page${selection.active ? ' selecting' : ''}`}>
      <header className="page-head">
        <h1 className="display page-title">Inbox</h1>
        {selection.active ? (
          <button type="button" className="btn ghost small" onClick={selection.stop}>
            Done
          </button>
        ) : (
          notes.data?.length !== 0 && (
            <button type="button" className="btn ghost small" onClick={selection.start} disabled={!notes.data}>
              Select
            </button>
          )
        )}
      </header>
      <p className="muted">Notes that aren't filed under a technique yet.</p>
      <section className="panel">
        {notes.isError && <div className="empty">Couldn't load the inbox. {notes.error.message}</div>}
        {notes.data?.length === 0 && <div className="empty">Nothing to file.</div>}
        {notes.data?.map(n =>
          selection.active ? (
            <label key={n.id} className="row note-select">
              <input
                type="checkbox"
                className="check"
                checked={selection.has(n.id)}
                onChange={() => selection.toggle(n.id)}
                aria-label={`Note: ${n.body.slice(0, 60)}`}
              />
              <span className="grow">
                <span className="note-head">
                  {friendlyDate(n.observedOn, today)}, {NOTE_KIND_LABEL[n.kind].toLowerCase()}
                </span>
                <span className="note-body">{n.body}</span>
              </span>
            </label>
          ) : (
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
              {n.source?.url && (
                <SourceLink url={n.source.url} timestamp={n.sourceTimestamp} title={n.source.title} author={n.source.author} />
              )}
              <div className="note-foot">
                <button type="button" className="btn quiet small" onClick={() => setFiling(n)}>
                  File under a technique
                </button>
              </div>
            </article>
          ),
        )}
      </section>
      <SelectionBar selection={selection} noun="notes" busy={del.isPending} onAction={deleteSelected} />
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
