import { useDeferredValue, useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import type { AreaDetail, TechniqueRef } from '../../../src/shared/api';
import { useArea, useDeleteArea, useFocus, useLinkArea, useNotes } from '../api';
import { AreaEditSheet, FocusControls } from '../components/AreaControls';
import { useCapture } from '../components/Capture';
import { Icon } from '../components/Icon';
import { NoteItem } from '../components/NoteItem';
import { PlanSection } from '../components/Plan';
import { Sheet } from '../components/Sheet';
import { TechniquePicker } from '../components/TechniquePicker';
import { useToast } from '../components/Toast';
import { friendlyDate, lastNoteText, localToday } from '../lib/format';

type Editing = null | 'details' | 'techniques' | 'notes' | 'delete';

/**
 * One area: whether it's on focus, what it's about, its plan (if it's a system), its techniques, the notes
 * filed under it, and its focus history.
 */
export function Area() {
  const id = Number(useParams().id);
  const item = useArea(id);
  const focus = useFocus();
  const navigate = useNavigate();
  const [editing, setEditing] = useState<Editing>(null);
  const today = focus.data?.today ?? localToday();

  const back = (
    <button type="button" className="btn ghost back" onClick={() => (history.length > 1 ? navigate(-1) : navigate('/game'))}>
      <Icon name="back" size={20} />
      Back
    </button>
  );
  if (item.isError) {
    return (
      <div className="page">
        {back}
        <div className="panel empty">{item.error.message}</div>
      </div>
    );
  }
  if (!item.data) return <div className="page">{back}</div>;
  const v = item.data;
  const activeCount = focus.data?.active.length ?? 0;
  const close = () => setEditing(null);

  return (
    <div className="page">
      {back}
      <div className="row-split tech-head">
        <h1 className="display tech-name grow">{v.name}</h1>
        <button type="button" className="btn ghost small" onClick={() => setEditing('details')}>
          Edit
        </button>
      </div>
      <p className="tech-meta">
        {v.rank ? `Number ${v.rank} on your focus list` : 'Off focus'}. {lastNoteText(v.lastNoteOn, today)}.
        {v.aliases.length > 0 && <span className="block">Also called {v.aliases.join(', ')}</span>}
      </p>
      <FocusControls area={v} count={activeCount} />

      <PlanSection area={v} />

      <SectionHead title="Description">
        <button type="button" className="btn ghost small" onClick={() => setEditing('details')}>
          {v.description ? 'Edit' : 'Add'}
        </button>
      </SectionHead>
      {v.description ? (
        <section className="panel">
          <div className="row prose">{v.description}</div>
        </section>
      ) : (
        <p className="section-hint">The strategy, the cues, and what it looks like when it's working.</p>
      )}

      <SectionHead title="Techniques">
        <button type="button" className="btn ghost small" onClick={() => setEditing('techniques')}>
          {v.techniques.length ? 'Change' : 'Add'}
        </button>
      </SectionHead>
      {v.techniques.length ? (
        <div className="chips">
          {v.techniques.map(t => (
            <Link key={t.id} className="chip" to={`/t/${t.id}`}>
              {t.name}
            </Link>
          ))}
        </div>
      ) : (
        <p className="section-hint">The technique cards this is about. Their notes show up here, and so do the cards in its plan.</p>
      )}

      <LinkedNotes v={v} today={today} onLink={() => setEditing('notes')} />
      <RelatedNotes v={v} today={today} />
      <History v={v} today={today} />

      <button type="button" className="btn danger delete-link" onClick={() => setEditing('delete')}>
        Delete area
      </button>

      {editing === 'details' && <AreaEditSheet area={v} onClose={close} />}
      {editing === 'techniques' && <TechniquesSheet v={v} onClose={close} />}
      {editing === 'notes' && <LinkNoteSheet v={v} today={today} onClose={close} />}
      {editing === 'delete' && <DeleteSheet v={v} onClose={close} onDeleted={() => navigate('/game', { replace: true })} />}
    </div>
  );
}

function SectionHead({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="row-split" style={{ marginTop: 28, marginBottom: 8 }}>
      <h2 className="section-title grow" style={{ margin: 0 }}>
        {title}
      </h2>
      {children}
    </div>
  );
}

function LinkedNotes({ v, today, onLink }: { v: AreaDetail; today: string; onLink: () => void }) {
  const capture = useCapture();
  const link = useLinkArea();
  const toast = useToast();
  const ref = { id: v.id, name: v.name, rank: v.rank };
  return (
    <>
      <SectionHead title="Notes">
        <button type="button" className="btn ghost small" onClick={onLink}>
          File a note here
        </button>
        <button
          type="button"
          className="btn ghost small"
          // A note with one technique is filed under it too; with several, the note says which.
          onClick={() => capture.open({ areas: [ref], techniques: v.techniques.length === 1 ? v.techniques : [] })}
        >
          Add note
        </button>
      </SectionHead>
      {v.notes.length === 0 && <p className="section-hint">Notes filed here stay with it, whatever techniques they're about.</p>}
      <section className="panel" aria-label="Notes filed here">
        {v.notes.map(n => (
          <NoteItem
            key={n.id}
            note={n}
            today={today}
            hideArea={v.id}
            actions={
              <button
                type="button"
                className="btn quiet small"
                disabled={link.isPending}
                onClick={() =>
                  link.mutate({ id: v.id, remove: { noteIds: [n.id] } }, { onSuccess: () => toast.show('Taken out', { undoable: true }), onError: toast.error })
                }
              >
                Take out
              </button>
            }
          />
        ))}
      </section>
    </>
  );
}

function RelatedNotes({ v, today }: { v: AreaDetail; today: string }) {
  const link = useLinkArea();
  const toast = useToast();
  if (!v.relatedNotes.length) return null;
  return (
    <>
      <SectionHead title={v.relatedCount > v.relatedNotes.length ? `From its techniques (${v.relatedNotes.length} of ${v.relatedCount})` : 'From its techniques'} />
      <section className="panel" aria-label="From its techniques">
        {v.relatedNotes.map(n => (
          <NoteItem
            key={n.id}
            note={n}
            today={today}
            hideArea={v.id}
            actions={
              <button
                type="button"
                className="btn quiet small"
                disabled={link.isPending}
                onClick={() =>
                  link.mutate({ id: v.id, add: { noteIds: [n.id] } }, { onSuccess: () => toast.show('Filed here', { undoable: true }), onError: toast.error })
                }
              >
                File here
              </button>
            }
          />
        ))}
      </section>
    </>
  );
}

// Paused, backlogged, completed and dropped are from before areas, when the list had statuses.
const EVENT_TEXT: Record<string, string> = {
  added: 'On focus',
  moved: 'Moved',
  removed: 'Off focus',
  resumed: 'Back on focus',
  paused: 'Paused',
  backlogged: 'Moved to the backlog',
  completed: 'Done',
  dropped: 'Off focus',
};

/** The local calendar date of an ISO timestamp, as YYYY-MM-DD. */
const localDate = (iso: string) => {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

function History({ v, today }: { v: AreaDetail; today: string }) {
  if (!v.history.length) return null;
  return (
    <>
      <SectionHead title="History" />
      <section className="panel" aria-label="History">
        <ul className="row list-plain focus-history">
          {v.history.map((h, i) => (
            <li key={i}>
              <span className="muted">{friendlyDate(localDate(h.at), today)}:</span> {EVENT_TEXT[h.event] ?? h.event}
              {h.toRank ? ` at #${h.toRank}` : ''}
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}

function TechniquesSheet({ v, onClose }: { v: AreaDetail; onClose: () => void }) {
  const [techniques, setTechniques] = useState<TechniqueRef[]>(v.techniques);
  const link = useLinkArea();
  const toast = useToast();
  const before = new Set(v.techniques.map(t => t.id));
  const after = new Set(techniques.map(t => t.id));
  const add = [...after].filter(id => !before.has(id));
  const remove = [...before].filter(id => !after.has(id));
  return (
    <Sheet title="Techniques" onClose={onClose}>
      <form
        onSubmit={e => {
          e.preventDefault();
          if (!add.length && !remove.length) return onClose();
          link.mutate(
            { id: v.id, add: { techniqueIds: add }, remove: { techniqueIds: remove } },
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
        <TechniquePicker label="Technique cards" selected={techniques} onChange={setTechniques} />
        <button className="btn block" type="submit" disabled={link.isPending}>
          Save
        </button>
      </form>
    </Sheet>
  );
}

/** Find a note by its words (or pick a recent one) and file it under the area. */
function LinkNoteSheet({ v, today, onClose }: { v: AreaDetail; today: string; onClose: () => void }) {
  const [text, setText] = useState('');
  const q = useDeferredValue(text.trim());
  const searching = q.length >= 2;
  const found = useNotes({ q: searching ? q : undefined, limit: 20 });
  const link = useLinkArea();
  const toast = useToast();
  const linked = new Set(v.notes.map(n => n.id));
  const notes = (found.data ?? []).filter(n => !linked.has(n.id));
  return (
    <Sheet title="File a note here" onClose={onClose}>
      <label className="field">
        <span className="visually-hidden">Search notes</span>
        <input className="input" autoFocus type="search" placeholder="Search notes" value={text} onChange={e => setText(e.target.value)} />
      </label>
      <p className="muted small">{searching ? 'Matching notes' : 'Recent notes'}</p>
      <section className="panel" aria-label="Notes to file here">
        {found.isSuccess && notes.length === 0 && <div className="empty">{searching ? 'No notes match.' : 'No notes to file.'}</div>}
        {notes.map(n => (
          <div key={n.id} className="row row-split note-pick">
            <span className="grow">
              <span className="row-meta">
                {friendlyDate(n.observedOn, today)}
                {n.techniques.length ? `, ${n.techniques.map(t => t.name).join(', ')}` : ''}
              </span>
              <span className="note-pick-body">{n.body}</span>
            </span>
            <button
              type="button"
              className="btn quiet small"
              aria-label={`File here: ${n.body.slice(0, 60)}`}
              disabled={link.isPending}
              onClick={() =>
                link.mutate({ id: v.id, add: { noteIds: [n.id] } }, { onSuccess: () => toast.show('Filed here', { undoable: true }), onError: toast.error })
              }
            >
              File here
            </button>
          </div>
        ))}
      </section>
    </Sheet>
  );
}

/** Deleting is for good (with Undo): the area, its plan and its focus history. Its notes and cards stay. */
function DeleteSheet({ v, onClose, onDeleted }: { v: AreaDetail; onClose: () => void; onDeleted: () => void }) {
  const del = useDeleteArea();
  const toast = useToast();
  return (
    <Sheet title={`Delete ${v.name}?`} onClose={onClose}>
      <p>
        {v.stepCount ? `Its plan (${v.stepCount} step${v.stepCount === 1 ? '' : 's'}) goes with it. ` : ''}
        Its notes and technique cards stay.
        {v.rank ? ' To stop working on it for now, take it off focus instead.' : ''}
      </p>
      <button
        type="button"
        className="btn danger block"
        disabled={del.isPending}
        onClick={() =>
          del.mutate(v.id, {
            onSuccess: () => {
              toast.show(`Deleted ${v.name}`, { undoable: true });
              onDeleted();
            },
            onError: toast.error,
          })
        }
      >
        Delete area
      </button>
      <button type="button" className="btn quiet block" style={{ marginTop: 8 }} onClick={onClose}>
        Keep it
      </button>
    </Sheet>
  );
}
