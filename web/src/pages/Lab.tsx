import { useCallback, useState, type ReactNode } from 'react';
import { Link, NavLink } from 'react-router';
import type { LabView, NoteView, TechniqueListItem } from '../../../src/shared/api';
import { useClearStars, useEditNote, useLab, useMarkAnswered } from '../api';
import { RankBar } from '../components/Belt';
import { Icon } from '../components/Icon';
import { NoteItem } from '../components/NoteItem';
import { countOf, SelectionBar, useSelection, type Selection } from '../components/Selection';
import { Sheet } from '../components/Sheet';
import { TechniqueStar } from '../components/Star';
import { useToast } from '../components/Toast';
import { agoText, datePhrase, friendlyDate, localToday, techniqueLine } from '../lib/format';
import { TRY_EMPTY, TryCompactRow } from './ToTry';

/** Videos to try shown in the Lab; the rest (and the players) are a tap away. */
const TRY_SHOWN = 5;

/**
 * The Focus tab's header, drawn as the end of a purple belt: the weave, then the black rank bar.
 * Holds the title, the Lab | Focus switch, and a line about what's there.
 */
export function FocusHeader({ title, summary, action }: { title: string; summary: ReactNode; action?: ReactNode }) {
  return (
    <header className="band">
      <div className="band-text">
        <div className="band-top">
          <h1 className="display page-title">{title}</h1>
          <div className="band-actions">
            {action}
            <Link className="btn band-account" to="/account" aria-label="Account">
              <Icon name="person" size={24} />
            </Link>
          </div>
        </div>
        <FocusTabs />
        <p className="band-summary">{summary}</p>
      </div>
      <div className="band-bar" aria-hidden>
        <span />
        <span />
        <span />
        <span />
      </div>
    </header>
  );
}

/** "3 starred, 2 to try and 1 question for coach." */
function labSummary(v: LabView): string {
  const starred = v.starred.techniques.length + v.starred.notes.length;
  const parts = [
    starred ? `${starred} starred` : '',
    v.toTry.total ? `${v.toTry.total} to try` : '',
    v.fresh.length ? countOf(v.fresh.length, 'new technique') : '',
    v.questions.length ? `${countOf(v.questions.length, 'question')} for coach` : '',
  ].filter(Boolean);
  if (!parts.length) return 'Nothing waiting. Star what matters this week, or save a video to try.';
  const list = parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}` : parts[0]!;
  return `${list}.`;
}

/** The two views behind the Focus tab: the Lab (what you're sorting through now) and the Focus list (the long game). */
function FocusTabs() {
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
  const today = v?.today ?? localToday();
  const allQuestions = v ? [...v.questions, ...v.olderQuestions] : [];
  const selection = useSelection(allQuestions.map(n => n.id));

  return (
    <div className={`page band-page${selection.active ? ' selecting' : ''}`}>
      <FocusHeader title="Lab" summary={v ? labSummary(v) : '\u00a0'} />
      {lab.isError && <div className="panel empty">Couldn't load the Lab. {lab.error.message}</div>}

      {v && (
        <>
          <StarredSection v={v} />

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
              <TryCompactRow key={n.id} note={n} today={today} />
            ))}
          </LabSection>

          <LabSection title="New in your notes" label="New techniques" hint={`Last ${v.days} days`}>
            {v.fresh.length === 0 && <div className="empty">No new techniques in the last {v.days} days.</div>}
            {v.fresh.map(t => (
              <TechniqueRow key={t.id} t={t} meta={t.firstNoteOn ? `first noted ${datePhrase(t.firstNoteOn, today)}` : ''} />
            ))}
          </LabSection>

          <AskCoachSection v={v} selection={selection} />
        </>
      )}
    </div>
  );
}

/** Starred techniques and notes. Stars older than a few weeks fold away, ready to clear. */
function StarredSection({ v }: { v: LabView }) {
  const clear = useClearStars();
  const toast = useToast();
  const recent = v.starred.techniques.length + v.starred.notes.length;
  const older = v.olderStarred.techniques.length + v.olderStarred.notes.length;
  const weeks = Math.round(v.starDays / 7);
  const run = (olderThanDays?: number) =>
    clear.mutate(olderThanDays, { onSuccess: r => toast.show(r.message.replace(/\.$/, ''), { undoable: true }), onError: toast.error });

  return (
    <LabSection
      title={
        <>
          <Icon name="star" size={19} filled />
          Starred
        </>
      }
      label="Starred"
      count={recent}
      more={
        recent + older > 0 && (
          <button
            type="button"
            className="btn ghost small"
            disabled={clear.isPending}
            onClick={() => {
              if (window.confirm(`Unstar all ${countOf(recent + older, 'star')}? You can undo it.`)) run();
            }}
          >
            Clear
          </button>
        )
      }
    >
      {recent === 0 && (
        <div className="empty">
          {older
            ? `Nothing starred in the last ${weeks} weeks.`
            : 'Nothing starred. Tap the star on a technique or a note to keep it here while it matters.'}
        </div>
      )}
      <StarredItems starred={v.starred} today={v.today} />
      {older > 0 && (
        <Fold label={countOf(older, 'older star')} hint={`Starred over ${weeks} weeks ago`}>
          <StarredItems starred={v.olderStarred} today={v.today} />
          <div className="row fold-actions">
            <button type="button" className="btn quiet small" disabled={clear.isPending} onClick={() => run(v.starDays)}>
              Unstar {older === 1 ? 'it' : `these ${older}`}
            </button>
          </div>
        </Fold>
      )}
    </LabSection>
  );
}

function StarredItems({ starred, today }: { starred: LabView['starred']; today: string }) {
  return (
    <>
      {starred.techniques.map(t => (
        <TechniqueRow key={t.id} t={t} meta={t.starredAt ? `starred ${agoText(t.starredAt)}` : ''} />
      ))}
      {starred.notes.map(n => (
        <NoteItem key={n.id} note={n} today={today} meta={n.starredAt ? `Starred ${agoText(n.starredAt)}` : undefined} />
      ))}
    </>
  );
}

/** Open questions for coach: recent ones, older ones folded away; select several to mark them answered. */
function AskCoachSection({ v, selection }: { v: LabView; selection: Selection }) {
  const [answering, setAnswering] = useState<NoteView | null>(null);
  const closeAnswer = useCallback(() => setAnswering(null), []);
  const mark = useMarkAnswered();
  const toast = useToast();
  const total = v.questions.length + v.olderQuestions.length;
  const answeredButton = (n: NoteView) => (
    <button type="button" className="btn quiet small" onClick={() => setAnswering(n)}>
      <Icon name="check" size={18} />
      Answered
    </button>
  );
  const markSelected = () =>
    mark.mutate(selection.ids, {
      onSuccess: r => {
        toast.show(r.message.replace(/\.$/, ''), { undoable: true });
        selection.stop();
      },
      onError: toast.error,
    });

  return (
    <>
      <LabSection
        title="Ask coach"
        className="coach"
        count={v.questions.length}
        more={
          total > 0 &&
          (selection.active ? (
            <button type="button" className="btn ghost small" onClick={selection.stop}>
              Done
            </button>
          ) : (
            <button type="button" className="btn ghost small" onClick={selection.start}>
              Select
            </button>
          ))
        }
      >
        {selection.active ? (
          [...v.questions, ...v.olderQuestions].map(n => (
            <label key={n.id} className="row note-select">
              <input
                type="checkbox"
                className="check"
                checked={selection.has(n.id)}
                onChange={() => selection.toggle(n.id)}
                aria-label={`Question: ${n.body.slice(0, 60)}`}
              />
              <span className="grow">
                <span className="note-head">{friendlyDate(n.observedOn, v.today)}</span>
                <span className="note-body">{n.body}</span>
              </span>
            </label>
          ))
        ) : (
          <>
            {v.questions.length === 0 && (
              <div className="empty">
                {v.olderQuestions.length
                  ? `No questions from the last ${v.questionDays} days.`
                  : 'No open questions. Save a note as a Question and it waits here until you get an answer.'}
              </div>
            )}
            {v.questions.map(n => (
              <NoteItem key={n.id} note={n} today={v.today} actions={answeredButton(n)} />
            ))}
            {v.olderQuestions.length > 0 && (
              <Fold label={countOf(v.olderQuestions.length, 'older question')} hint={`Noted over ${v.questionDays} days ago`}>
                {v.olderQuestions.map(n => (
                  <NoteItem key={n.id} note={n} today={v.today} actions={answeredButton(n)} />
                ))}
              </Fold>
            )}
          </>
        )}
      </LabSection>
      <SelectionBar
        selection={selection}
        noun="questions"
        action="Mark answered"
        tone="primary"
        busy={mark.isPending}
        onAction={markSelected}
      />
      {answering && <AnswerSheet note={answering} onClose={closeAnswer} />}
    </>
  );
}

/** A folded group at the end of a section: a row that opens to show what's inside. */
function Fold({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className="row fold" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="grow">
          <span className="fold-label">{label}</span>
          {hint && <span className="row-meta">{hint}</span>}
        </span>
        <Icon name="chevron" size={20} />
      </button>
      {open && children}
    </>
  );
}

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
  className,
  children,
}: {
  title: ReactNode;
  className?: string;
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
      <section className={`panel${className ? ` ${className}` : ''}`} aria-label={name}>
        {children}
      </section>
    </>
  );
}

/** Coach answered: add the answer to the question and mark it answered, which takes it off Ask coach. */
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
            { id: note.id, answered: true, ...(text ? { body: `${note.body}\n\nAnswer: ${text}` } : {}) },
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
