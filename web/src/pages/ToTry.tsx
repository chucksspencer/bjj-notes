import { useState } from 'react';
import type { NoteView, TechniqueRef } from '../../../src/shared/api';
import { isPlaceholder } from '../../../src/shared/links';
import { useDeleteNote, useDeleteNotes, useEditNote, useFocus, useNotes } from '../api';
import { useCapture } from '../components/Capture';
import { Icon } from '../components/Icon';
import { SelectionBar, useSelection } from '../components/Selection';
import { Sheet } from '../components/Sheet';
import { TechniquePicker, type NewTechnique } from '../components/TechniquePicker';
import { useToast } from '../components/Toast';
import { SourceLink } from '../components/Video';
import { friendlyDate, localToday } from '../lib/format';
import { InboxTabs } from './Inbox';

/** Videos and ideas saved to try before they earn a place in the library ("silly Instagram bullshit"). */
export function ToTry() {
  const notes = useNotes({ toTry: true, limit: 200 });
  const focus = useFocus();
  const today = focus.data?.today ?? localToday();
  const [keeping, setKeeping] = useState<NoteView | null>(null);
  const capture = useCapture();
  const toss = useDeleteNote();
  const tossMany = useDeleteNotes();
  const selection = useSelection(notes.data?.map(n => n.id) ?? []);
  const toast = useToast();

  const tossOne = (n: NoteView) =>
    toss.mutate(n.id, { onSuccess: () => toast.show('Tossed it', { undoable: true }), onError: toast.error });
  const tossSelected = () =>
    tossMany.mutate(selection.ids, {
      onSuccess: () => {
        toast.show(selection.ids.length === 1 ? 'Tossed it' : `Tossed ${selection.ids.length}`, { undoable: true });
        selection.stop();
      },
      onError: toast.error,
    });
  const about = (n: NoteView) => (n.techniques.length ? ` · about ${n.techniques.map(t => t.name).join(', ')}` : '');

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
      <InboxTabs />
      <p className="muted">Silly Instagram bullshit: try it out, then keep it or toss it.</p>
      <section className="panel">
        {notes.isError && <div className="empty">Couldn't load the list. {notes.error.message}</div>}
        {notes.data?.length === 0 && (
          <div className="empty">
            Nothing to try. Share a reel to Save to BJJ Notes, or tick "Haven't tried it yet" when you add a link.
          </div>
        )}
        {notes.data?.map(n =>
          selection.active ? (
            <label key={n.id} className="row note-select">
              <input
                type="checkbox"
                className="check"
                checked={selection.has(n.id)}
                onChange={() => selection.toggle(n.id)}
                aria-label={isPlaceholder(n.body) ? `Saved ${friendlyDate(n.observedOn, today)}` : n.body.slice(0, 60)}
              />
              <span className="grow">
                <span className="note-head">
                  {friendlyDate(n.observedOn, today)}
                  {about(n)}
                </span>
                <span className="note-body">{isPlaceholder(n.body) ? (n.source?.url ?? n.body) : n.body}</span>
              </span>
            </label>
          ) : (
            <article key={n.id} className="row">
              <div className="note-head">
                <span>
                  {friendlyDate(n.observedOn, today)}
                  {about(n)}
                </span>
                <button type="button" className="btn ghost small" onClick={() => capture.edit(n)}>
                  Edit
                </button>
              </div>
              {!isPlaceholder(n.body) && <div className="note-body">{n.body}</div>}
              {n.source?.url && (
                <SourceLink url={n.source.url} timestamp={n.sourceTimestamp} title={n.source.title} author={n.source.author} />
              )}
              <div className="note-foot try-actions">
                <button type="button" className="btn small" onClick={() => setKeeping(n)}>
                  <Icon name="check" size={18} />
                  Keep
                </button>
                <button type="button" className="btn quiet small" disabled={toss.isPending} onClick={() => tossOne(n)}>
                  Toss
                </button>
              </div>
            </article>
          ),
        )}
      </section>
      <SelectionBar selection={selection} noun="videos" action="Toss" busy={tossMany.isPending} onDelete={tossSelected} />
      {keeping && <KeepSheet note={keeping} onClose={() => setKeeping(null)} />}
    </div>
  );
}

/** Tried it and liked it: say what works and file it under a real technique. */
function KeepSheet({ note, onClose }: { note: NoteView; onClose: () => void }) {
  const [text, setText] = useState(isPlaceholder(note.body) ? '' : note.body);
  const [selected, setSelected] = useState<TechniqueRef[]>(note.techniques);
  const [newOnes, setNewOnes] = useState<NewTechnique[]>([]);
  const edit = useEditNote();
  const toast = useToast();
  const ready = selected.length + newOnes.length > 0;

  return (
    <Sheet title="Keep it" onClose={onClose}>
      <form
        onSubmit={e => {
          e.preventDefault();
          if (!ready) return;
          edit.mutate(
            {
              id: note.id,
              ...(text.trim() ? { body: text.trim() } : {}),
              techniqueIds: selected.map(t => t.id),
              newTechniques: newOnes,
              toTry: false,
            },
            {
              onSuccess: r => {
                toast.show(`Kept under ${r.techniques.map(t => t.name).join(', ')}`, { undoable: true });
                onClose();
              },
              onError: toast.error,
            },
          );
        }}
      >
        <label className="field">
          <span className="label">What's the takeaway?</span>
          <textarea
            className="textarea"
            rows={4}
            autoFocus
            placeholder="What works about it, and what to watch for"
            value={text}
            onChange={e => setText(e.target.value)}
          />
        </label>
        <TechniquePicker label="File under" selected={selected} onChange={setSelected} newOnes={newOnes} onNewChange={setNewOnes} />
        <button className="btn block" type="submit" disabled={!ready || edit.isPending}>
          Keep it
        </button>
        {!ready && (
          <p className="muted small" style={{ marginTop: 8 }}>
            Pick the technique it belongs under, or add a new one.
          </p>
        )}
      </form>
    </Sheet>
  );
}
