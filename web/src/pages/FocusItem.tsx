import { useDeferredValue, useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import type { FocusItemDetail, FocusStatus, TechniqueRef } from '../../../src/shared/api';
import { useFocus, useFocusItem, useLinkFocus, useNotes } from '../api';
import { useCapture } from '../components/Capture';
import { FocusActions, FocusEditSheet } from '../components/FocusControls';
import { Icon } from '../components/Icon';
import { NoteItem } from '../components/NoteItem';
import { Sheet } from '../components/Sheet';
import { TechniquePicker } from '../components/TechniquePicker';
import { useToast } from '../components/Toast';
import { friendlyDate, lastNoteText, localToday } from '../lib/format';

type Editing = null | 'details' | 'techniques' | 'notes';

const STATUS_TEXT: Record<Exclude<FocusStatus, 'active'>, string> = {
  paused: 'Paused',
  backlog: 'In the backlog',
  done: 'Done',
  dropped: 'Removed from your focus',
};

/** One focus item: what it's about, its techniques, the notes pinned to it, and its history. */
export function FocusItem() {
  const id = Number(useParams().id);
  const item = useFocusItem(id);
  const focus = useFocus();
  const navigate = useNavigate();
  const [editing, setEditing] = useState<Editing>(null);
  const today = focus.data?.today ?? localToday();

  const back = (
    <button type="button" className="btn ghost back" onClick={() => (history.length > 1 ? navigate(-1) : navigate('/focus'))}>
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
      <h1 className="display tech-name">{v.label}</h1>
      <p className="tech-meta">
        {v.status === 'active' ? `Number ${v.rank} on your focus list` : STATUS_TEXT[v.status]}. {lastNoteText(v.lastNoteOn, today)}.
      </p>
      <FocusActions item={v} first={v.rank === 1} last={v.rank === activeCount} onEdit={() => setEditing('details')} />

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
        <p className="section-hint">The technique cards this is about. Their notes show up here.</p>
      )}

      <LinkedNotes v={v} today={today} onLink={() => setEditing('notes')} />
      <RelatedNotes v={v} today={today} />
      <History v={v} today={today} />

      {editing === 'details' && <FocusEditSheet item={v} onClose={close} />}
      {editing === 'techniques' && <TechniquesSheet v={v} onClose={close} />}
      {editing === 'notes' && <LinkNoteSheet v={v} today={today} onClose={close} />}
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

function LinkedNotes({ v, today, onLink }: { v: FocusItemDetail; today: string; onLink: () => void }) {
  const capture = useCapture();
  const link = useLinkFocus();
  const toast = useToast();
  const ref = { id: v.id, label: v.label, status: v.status };
  return (
    <>
      <SectionHead title="Notes">
        <button type="button" className="btn ghost small" onClick={onLink}>
          Link a note
        </button>
        <button
          type="button"
          className="btn ghost small"
          // A note with one technique is filed under it; with several, the note says which.
          onClick={() => capture.open({ focus: [ref], techniques: v.techniques.length === 1 ? v.techniques : [] })}
        >
          Add note
        </button>
      </SectionHead>
      {v.notes.length === 0 && <p className="section-hint">Notes you pin here stay with it, whatever they're filed under.</p>}
      <section className="panel" aria-label="Linked notes">
        {v.notes.map(n => (
          <NoteItem
            key={n.id}
            note={n}
            today={today}
            hideFocus={v.id}
            actions={
              <button
                type="button"
                className="btn quiet small"
                disabled={link.isPending}
                onClick={() =>
                  link.mutate({ id: v.id, remove: { noteIds: [n.id] } }, { onSuccess: () => toast.show('Unlinked', { undoable: true }), onError: toast.error })
                }
              >
                Unlink
              </button>
            }
          />
        ))}
      </section>
    </>
  );
}

function RelatedNotes({ v, today }: { v: FocusItemDetail; today: string }) {
  const link = useLinkFocus();
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
            hideFocus={v.id}
            actions={
              <button
                type="button"
                className="btn quiet small"
                disabled={link.isPending}
                onClick={() =>
                  link.mutate({ id: v.id, add: { noteIds: [n.id] } }, { onSuccess: () => toast.show('Linked', { undoable: true }), onError: toast.error })
                }
              >
                <Icon name="link" size={18} />
                Link
              </button>
            }
          />
        ))}
      </section>
    </>
  );
}

const EVENT_TEXT: Record<string, string> = {
  added: 'Added',
  moved: 'Moved',
  resumed: 'Back on the list',
  paused: 'Paused',
  backlogged: 'Moved to the backlog',
  completed: 'Done',
  dropped: 'Removed',
};

/** The local calendar date of an ISO timestamp, as YYYY-MM-DD. */
const localDate = (iso: string) => {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

function History({ v, today }: { v: FocusItemDetail; today: string }) {
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

function TechniquesSheet({ v, onClose }: { v: FocusItemDetail; onClose: () => void }) {
  const [techniques, setTechniques] = useState<TechniqueRef[]>(v.techniques);
  const link = useLinkFocus();
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

/** Find a note by its words (or pick a recent one) and pin it to the item. */
function LinkNoteSheet({ v, today, onClose }: { v: FocusItemDetail; today: string; onClose: () => void }) {
  const [text, setText] = useState('');
  const q = useDeferredValue(text.trim());
  const searching = q.length >= 2;
  const found = useNotes({ q: searching ? q : undefined, limit: 20 });
  const link = useLinkFocus();
  const toast = useToast();
  const linked = new Set(v.notes.map(n => n.id));
  const notes = (found.data ?? []).filter(n => !linked.has(n.id));
  return (
    <Sheet title="Link a note" onClose={onClose}>
      <label className="field">
        <span className="visually-hidden">Search notes</span>
        <input className="input" autoFocus type="search" placeholder="Search notes" value={text} onChange={e => setText(e.target.value)} />
      </label>
      <p className="muted small">{searching ? 'Matching notes' : 'Recent notes'}</p>
      <section className="panel" aria-label="Notes to link">
        {found.isSuccess && notes.length === 0 && <div className="empty">{searching ? 'No notes match.' : 'No notes to link.'}</div>}
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
              aria-label={`Link: ${n.body.slice(0, 60)}`}
              disabled={link.isPending}
              onClick={() =>
                link.mutate({ id: v.id, add: { noteIds: [n.id] } }, { onSuccess: () => toast.show('Linked', { undoable: true }), onError: toast.error })
              }
            >
              <Icon name="link" size={18} />
              Link
            </button>
          </div>
        ))}
      </section>
    </Sheet>
  );
}
