import type { ReactNode } from 'react';
import { Link } from 'react-router';
import type { NoteView } from '../../../src/shared/api';
import { isPlaceholder } from '../../../src/shared/links';
import { noteOrigin } from '../../../src/shared/sessions';
import { datePhrase, friendlyDate, NOTE_KIND_LABEL } from '../lib/format';
import { useCapture } from './Capture';
import { Clips } from './Clips';
import { NoteStar } from './Star';
import { SourceLink } from './Video';

/** One note: when, what kind, where it came from, the text, its source, and the techniques it's filed under. */
export function NoteItem({
  note,
  today,
  hideTechnique,
  actions,
  meta,
}: {
  note: NoteView;
  today: string;
  hideTechnique?: number;
  /** Extra buttons under the note. */
  actions?: ReactNode;
  /** An extra line under the date, e.g. when it was starred. */
  meta?: ReactNode;
}) {
  const capture = useCapture();
  const others = note.techniques.filter(t => t.id !== hideTechnique);
  const origin = noteOrigin(note, d => datePhrase(d, today));
  return (
    <article className="row">
      <div className="note-head">
        <div>
          <div>
            {friendlyDate(note.observedOn, today)}, {NOTE_KIND_LABEL[note.kind].toLowerCase()}
            {note.toTry && <span className="tag">Not tried yet</span>}
            {note.kind === 'question' && note.answered && <span className="tag">Answered</span>}
          </div>
          {origin && <div className="note-origin">{origin.charAt(0).toUpperCase() + origin.slice(1)}</div>}
          {meta && <div className="note-origin">{meta}</div>}
        </div>
        <div className="note-tools">
          <NoteStar note={note} />
          <button type="button" className="btn ghost small" onClick={() => capture.edit(note)}>
            Edit
          </button>
        </div>
      </div>
      {!(isPlaceholder(note.body) && (note.source?.url || note.attachments.length)) && <div className="note-body">{note.body}</div>}
      <Clips attachments={note.attachments} />
      {note.source?.url && (
        <SourceLink url={note.source.url} timestamp={note.sourceTimestamp} title={note.source.title} author={note.source.author} />
      )}
      {!note.source?.url && (note.source?.author || note.source?.title) && (
        <div className="muted small note-foot">From {[note.source.title, note.source.author].filter(Boolean).join(' by ')}</div>
      )}
      {others.length > 0 && (
        <div className="chips note-foot">
          {others.map(t => (
            <Link key={t.id} className="chip" to={`/t/${t.id}`}>
              {t.name}
            </Link>
          ))}
        </div>
      )}
      {actions && <div className="note-foot note-actions">{actions}</div>}
    </article>
  );
}
