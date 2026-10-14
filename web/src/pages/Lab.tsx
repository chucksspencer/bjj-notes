import { useCallback, useState, type ReactNode } from 'react';
import { Link, NavLink } from 'react-router';
import type { NoteView, TechniqueListItem } from '../../../src/shared/api';
import { useEditNote, useLab } from '../api';
import { RankBar } from '../components/Belt';
import { Icon } from '../components/Icon';
import { NoteItem } from '../components/NoteItem';
import { Sheet } from '../components/Sheet';
import { TechniqueStar } from '../components/Star';
import { useToast } from '../components/Toast';
import { datePhrase, lastNoteText, localToday, techniqueLine } from '../lib/format';
import { TRY_EMPTY, TryRow } from './ToTry';

/** Videos to try shown in the Lab; the rest are a tap away. */
const TRY_SHOWN = 3;

/** The two views behind the Focus tab: the Lab (what you're sorting through now) and the Focus list (the long game). */
export function FocusTabs() {
  return (
    <nav className="segments view-tabs" aria-label="Views">
      <NavLink className="segment" to="/" end>
        Lab
      </NavLink>
      <NavLink className="segment" to="/focus">
        Focus
      </NavLink>
    </nav>
  );
}

/**
 * The Lab: the short-term working set next to the long-term focus list. Starred techniques and notes,
 * videos to try, techniques that are new in your notes, and questions waiting for coach. One request, so
 * the sections arrive together; what belongs in each is decided on the server, the same as for Claude.
 */
export function Lab() {
  const lab = useLab();
  const v = lab.data;
  const [answering, setAnswering] = useState<NoteView | null>(null);
  const closeAnswer = useCallback(() => setAnswering(null), []);
  const today = v?.today ?? localToday();
  const starredCount = v ? v.starred.techniques.length + v.starred.notes.length : 0;

  return (
    <div className="page">
      <header className="page-head">
        <h1 className="display page-title">Lab</h1>
      </header>
      <FocusTabs />
      <p className="muted">What you're working through now. The Focus list is the long game.</p>
      {lab.isError && <div className="panel empty">Couldn't load the Lab. {lab.error.message}</div>}

      {v && (
        <>
          <LabSection
            title={
              <>
                <Icon name="star" size={19} filled />
                Starred
              </>
            }
            label="Starred"
            count={starredCount}
          >
            {starredCount === 0 && (
              <div className="empty">Nothing starred. Tap the star on a technique or a note to keep it here while it matters.</div>
            )}
            {v.starred.techniques.map(t => (
              <TechniqueRow key={t.id} t={t} meta={lowerFirst(lastNoteText(t.lastNoteOn, today))} />
            ))}
            {v.starred.notes.map(n => (
              <NoteItem key={n.id} note={n} today={today} />
            ))}
          </LabSection>

          <LabSection
            title="To try"
            count={v.toTry.total}
            more={
              v.toTry.total > 0 && (
                <Link className="btn ghost small" to="/try">
                  See all
                </Link>
              )
            }
          >
            {v.toTry.total === 0 && <div className="empty">{TRY_EMPTY}</div>}
            {v.toTry.notes.slice(0, TRY_SHOWN).map(n => (
              <TryRow key={n.id} note={n} today={today} />
            ))}
          </LabSection>

          <LabSection title="New in your notes" label="New techniques" hint={`Last ${v.days} days`}>
            {v.fresh.length === 0 && <div className="empty">No new techniques in the last {v.days} days.</div>}
            {v.fresh.map(t => (
              <TechniqueRow key={t.id} t={t} meta={t.firstNoteOn ? `first noted ${datePhrase(t.firstNoteOn, today)}` : ''} />
            ))}
          </LabSection>

          <LabSection title="Ask coach" count={v.questions.length}>
            {v.questions.length === 0 && (
              <div className="empty">No open questions. Save a note as a Question and it waits here until you get an answer.</div>
            )}
            {v.questions.map(n => (
              <NoteItem
                key={n.id}
                note={n}
                today={today}
                actions={
                  <button type="button" className="btn quiet small" onClick={() => setAnswering(n)}>
                    <Icon name="check" size={18} />
                    Answered
                  </button>
                }
              />
            ))}
          </LabSection>
        </>
      )}

      {answering && <AnswerSheet note={answering} onClose={closeAnswer} />}
    </div>
  );
}

const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

/** A technique in the Lab: opens the card, shows how far along it is, and stars or unstars in place. */
function TechniqueRow({ t, meta }: { t: TechniqueListItem; meta: string }) {
  return (
    <div className="row row-split lab-tech">
      <Link className="grow lab-tech-link" to={`/t/${t.id}`}>
        <span className="row-title">{t.name}</span>
        <span className="row-meta">{[techniqueLine(t.type, t.role, t.edges[0]), meta].filter(Boolean).join(' · ')}</span>
      </Link>
      <RankBar status={t.status} />
      <TechniqueStar technique={t} />
    </div>
  );
}

function LabSection({
  title,
  label,
  count,
  hint,
  more,
  children,
}: {
  title: ReactNode;
  /** Accessible name when the title isn't plain text. */
  label?: string;
  count?: number;
  hint?: string;
  more?: ReactNode;
  children: ReactNode;
}) {
  const name = label ?? (typeof title === 'string' ? title : undefined);
  return (
    <>
      <div className="section-head">
        <h2 className="section-title">
          {title}
          {count !== undefined && count > 0 && <span className="section-count">{count}</span>}
          {hint && <span className="title-hint">{hint}</span>}
        </h2>
        {more}
      </div>
      <section className="panel" aria-label={name}>
        {children}
      </section>
    </>
  );
}

/** Coach answered: add the answer to the note and take it off the Ask coach list. */
function AnswerSheet({ note, onClose }: { note: NoteView; onClose: () => void }) {
  const [answer, setAnswer] = useState('');
  const edit = useEditNote();
  const toast = useToast();
  const text = answer.trim();
  return (
    <Sheet title="Answered" onClose={onClose}>
      <p className="note-body" style={{ marginTop: 0 }}>
        {note.body}
      </p>
      <form
        onSubmit={e => {
          e.preventDefault();
          edit.mutate(
            { id: note.id, kind: 'instruction', ...(text ? { body: `${note.body}\n\nAnswer: ${text}` } : {}) },
            {
              onSuccess: () => {
                toast.show(text ? 'Answer saved' : 'Off the Ask coach list', { undoable: true });
                onClose();
              },
              onError: toast.error,
            },
          );
        }}
      >
        <label className="field">
          <span className="label">What did coach say?</span>
          <textarea
            className="textarea"
            rows={4}
            autoFocus
            placeholder="The answer, in your words"
            value={answer}
            onChange={e => setAnswer(e.target.value)}
          />
        </label>
        <button className="btn block" type="submit" disabled={edit.isPending}>
          {text ? 'Save answer' : 'Just mark it answered'}
        </button>
      </form>
    </Sheet>
  );
}
