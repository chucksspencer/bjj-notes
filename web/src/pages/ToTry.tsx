import { useCallback, useState } from 'react';
import { Link } from 'react-router';
import type { NoteView, TechniqueRef } from '../../../src/shared/api';
import { instagramPost, isPlaceholder } from '../../../src/shared/links';
import { useDeleteNote, useDeleteNotes, useEditNote, useFocus, useNotes } from '../api';
import { useCapture } from '../components/Capture';
import { Icon } from '../components/Icon';
import { SelectionBar, useSelection } from '../components/Selection';
import { Sheet } from '../components/Sheet';
import { TechniquePicker, type NewTechnique } from '../components/TechniquePicker';
import { useToast } from '../components/Toast';
import { SourceLink } from '../components/Video';
import { datePhrase, friendlyDate, hostLabel, localToday, youTubeId } from '../lib/format';

/** Videos and ideas saved to try before they earn a place in the library ("silly Instagram bullshit"). Part of the Lab. */
export function ToTry() {
  const notes = useNotes({ toTry: true, limit: 200 });
  const focus = useFocus();
  const today = focus.data?.today ?? localToday();
  const tossMany = useDeleteNotes();
  const selection = useSelection(notes.data?.map(n => n.id) ?? []);
  const toast = useToast();

  const tossSelected = () =>
    tossMany.mutate(selection.ids, {
      onSuccess: () => {
        toast.show(selection.ids.length === 1 ? 'Tossed it' : `Tossed ${selection.ids.length}`, { undoable: true });
        selection.stop();
      },
      onError: toast.error,
    });

  return (
    <div className={`page${selection.active ? ' selecting' : ''}`}>
      <Link className="btn ghost back" to="/">
        <Icon name="back" size={20} />
        Lab
      </Link>
      <header className="page-head">
        <h1 className="display page-title">To try</h1>
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
      <p className="muted">Silly Instagram bullshit: try it out, then keep it or toss it.</p>
      <section className="panel">
        {notes.isError && <div className="empty">Couldn't load the list. {notes.error.message}</div>}
        {notes.data?.length === 0 && <div className="empty">{TRY_EMPTY}</div>}
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
            <TryRow key={n.id} note={n} today={today} />
          ),
        )}
      </section>
      <SelectionBar selection={selection} noun="videos" action="Toss" busy={tossMany.isPending} onAction={tossSelected} />
    </div>
  );
}

export const TRY_EMPTY = 'Nothing to try. Share a reel to Save to BJJ Notes, or tick "Haven\'t tried it yet" when you add a link.';

const about = (n: NoteView) => (n.techniques.length ? ` · about ${n.techniques.map(t => t.name).join(', ')}` : '');

/** One thing to try: the video, and Keep (file it under a technique) or Toss. */
export function TryRow({ note, today }: { note: NoteView; today: string }) {
  const [keeping, setKeeping] = useState(false);
  const closeKeep = useCallback(() => setKeeping(false), []);
  const capture = useCapture();
  const toss = useDeleteNote();
  const toast = useToast();
  return (
    <article className="row">
      <div className="note-head">
        <span>
          {friendlyDate(note.observedOn, today)}
          {about(note)}
        </span>
        <button type="button" className="btn ghost small" onClick={() => capture.edit(note)}>
          Edit
        </button>
      </div>
      {!isPlaceholder(note.body) && <div className="note-body">{note.body}</div>}
      {note.source?.url && (
        <SourceLink url={note.source.url} timestamp={note.sourceTimestamp} title={note.source.title} author={note.source.author} />
      )}
      <div className="note-foot try-actions">
        <button type="button" className="btn small" onClick={() => setKeeping(true)}>
          <Icon name="check" size={18} />
          Keep
        </button>
        <button
          type="button"
          className="btn quiet small"
          disabled={toss.isPending}
          onClick={() => toss.mutate(note.id, { onSuccess: () => toast.show('Tossed it', { undoable: true }), onError: toast.error })}
        >
          Toss
        </button>
      </div>
      {keeping && <KeepSheet note={note} onClose={closeKeep} />}
    </article>
  );
}

/** What a saved link is, in a few words: its title, or "Instagram reel", "YouTube video", the site. */
function sourceLabel(note: NoteView): string {
  const url = note.source?.url;
  if (note.source?.title) return note.source.title;
  if (!url) return 'Idea';
  const ig = instagramPost(url);
  if (ig) return `Instagram ${ig.kind === 'reel' ? 'reel' : 'post'}`;
  if (youTubeId(url)) return 'YouTube video';
  return hostLabel(url);
}

/**
 * One thing to try, in a few lines for the Lab: what it is (opens in its app), your note, and Keep or Toss.
 * The players are on the full To try list.
 */
export function TryCompactRow({ note, today }: { note: NoteView; today: string }) {
  const [keeping, setKeeping] = useState(false);
  const closeKeep = useCallback(() => setKeeping(false), []);
  const toss = useDeleteNote();
  const toast = useToast();
  const url = note.source?.url;
  const label = sourceLabel(note);
  return (
    <article className="row try-compact">
      <div className="try-compact-main">
        <div className="try-compact-title">
          {url ? (
            <a href={url} target="_blank" rel="noreferrer noopener">
              <Icon name="play" size={13} />
              {label}
            </a>
          ) : (
            <span>{label}</span>
          )}
        </div>
        {!isPlaceholder(note.body) && <div className="try-compact-body">{note.body}</div>}
        <div className="row-meta">
          {note.source?.author ? `${note.source.author} · ` : ''}
          Saved {datePhrase(note.observedOn, today)}
          {about(note)}
        </div>
      </div>
      <div className="try-compact-actions">
        <button type="button" className="btn quiet small" onClick={() => setKeeping(true)}>
          <Icon name="check" size={16} />
          Keep
        </button>
        <button
          type="button"
          className="btn ghost small"
          disabled={toss.isPending}
          onClick={() => toss.mutate(note.id, { onSuccess: () => toast.show('Tossed it', { undoable: true }), onError: toast.error })}
        >
          Toss
        </button>
      </div>
      {keeping && <KeepSheet note={note} onClose={closeKeep} />}
    </article>
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
