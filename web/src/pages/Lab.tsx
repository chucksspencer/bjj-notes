import { useCallback, useState, type ReactNode } from 'react';
import { Link, NavLink } from 'react-router';
import type { NoteView } from '../../../src/shared/api';
import { useEditNote, useFocus, useNotes, useTechniques } from '../api';
import { RankBar } from '../components/Belt';
import { Icon } from '../components/Icon';
import { NoteItem } from '../components/NoteItem';
import { Sheet } from '../components/Sheet';
import { useToast } from '../components/Toast';
import { datePhrase, localToday, techniqueLine } from '../lib/format';
import { TRY_EMPTY, TryRow } from './ToTry';

/** How far back "new in your notes" looks. */
const NEW_DAYS = 30;
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

function minusDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T12:00:00Z`) - days * 86_400_000).toISOString().slice(0, 10);
}

/**
 * The Lab: the short-term working set next to the long-term focus list. Starred notes, videos to try,
 * techniques that are new in your notes, and questions waiting for coach.
 */
export function Lab() {
  const focus = useFocus();
  const today = focus.data?.today ?? localToday();
  const starred = useNotes({ starred: true, limit: 100 });
  const toTry = useNotes({ toTry: true, limit: 200 });
  const fresh = useTechniques({ sort: 'new', newSince: minusDays(today, NEW_DAYS), limit: 20 }, !focus.isPending);
  const questions = useNotes({ kind: 'question', toTry: false, limit: 50 });
  const [answering, setAnswering] = useState<NoteView | null>(null);
  const closeAnswer = useCallback(() => setAnswering(null), []);
  const tryCount = toTry.data?.length ?? 0;

  return (
    <div className="page">
      <header className="page-head">
        <h1 className="display page-title">Lab</h1>
      </header>
      <FocusTabs />
      <p className="muted">What you're working through now. The Focus list is the long game.</p>

      <LabSection
        title={
          <>
            <Icon name="star" size={19} filled />
            Starred
          </>
        }
        label="Starred"
        count={starred.data?.length}
        error={starred.error}
      >
        {starred.data?.length === 0 && <div className="empty">Nothing starred. Tap the star on any note to keep it here while it matters.</div>}
        {starred.data?.map(n => <NoteItem key={n.id} note={n} today={today} />)}
      </LabSection>

      <LabSection
        title="To try"
        count={tryCount}
        error={toTry.error}
        more={
          tryCount > 0 && (
            <Link className="btn ghost small" to="/try">
              {tryCount > TRY_SHOWN ? `All ${tryCount}` : 'Open list'}
            </Link>
          )
        }
      >
        {toTry.data?.length === 0 && <div className="empty">{TRY_EMPTY}</div>}
        {toTry.data?.slice(0, TRY_SHOWN).map(n => <TryRow key={n.id} note={n} today={today} />)}
      </LabSection>

      <LabSection title="New in your notes" label="New techniques" hint={`Last ${NEW_DAYS} days`} error={fresh.error}>
        {fresh.data?.length === 0 && <div className="empty">No new techniques in the last {NEW_DAYS} days.</div>}
        {fresh.data?.map(t => (
          <Link key={t.id} className="row row-split" to={`/t/${t.id}`}>
            <span className="grow">
              <span className="row-title">{t.name}</span>
              <span className="row-meta">
                {techniqueLine(t.type, t.role, t.edges[0])}
                {t.firstNoteOn && ` · first noted ${datePhrase(t.firstNoteOn, today)}`}
              </span>
            </span>
            <RankBar status={t.status} />
          </Link>
        ))}
      </LabSection>

      <LabSection title="Ask coach" count={questions.data?.length} error={questions.error}>
        {questions.data?.length === 0 && (
          <div className="empty">No open questions. Save a note as a Question and it waits here until you get an answer.</div>
        )}
        {questions.data?.map(n => (
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

      {answering && <AnswerSheet note={answering} onClose={closeAnswer} />}
    </div>
  );
}

function LabSection({
  title,
  label,
  count,
  hint,
  more,
  error,
  children,
}: {
  title: ReactNode;
  /** Accessible name when the title isn't plain text. */
  label?: string;
  count?: number;
  hint?: string;
  more?: ReactNode;
  error: Error | null;
  children: ReactNode;
}) {
  const name = label ?? (typeof title === 'string' ? title : undefined);
  return (
    <>
      <div className="section-head">
        <h2 className="section-title">
          {title}
          {count !== undefined && count > 0 && <span className="section-count">{count}</span>}
          {hint && <span className="section-hint">{hint}</span>}
        </h2>
        {more}
      </div>
      <section className="panel" aria-label={name}>
        {error && <div className="empty">Couldn't load this. {error.message}</div>}
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
