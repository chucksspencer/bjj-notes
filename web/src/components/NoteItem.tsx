import { Link } from 'react-router';
import type { NoteView } from '../../../src/shared/api';
import { noteOrigin } from '../../../src/shared/sessions';
import { datePhrase, friendlyDate, NOTE_KIND_LABEL } from '../lib/format';
import { useCapture } from './Capture';
import { SourceLink } from './Video';

/** One note: when, what kind, where it came from, the text, its source, and the techniques it's filed under. */
export function NoteItem({ note, today, hideTechnique }: { note: NoteView; today: string; hideTechnique?: number }) {
  const capture = useCapture();
  const others = note.techniques.filter(t => t.id !== hideTechnique);
  const origin = noteOrigin(note, d => datePhrase(d, today));
  return (
    <article className="row">
      <div className="note-head">
        <div>
          <div>
            {friendlyDate(note.observedOn, today)}, {NOTE_KIND_LABEL[note.kind].toLowerCase()}
          </div>
          {origin && <div className="note-origin">{origin.charAt(0).toUpperCase() + origin.slice(1)}</div>}
        </div>
        <button type="button" className="btn ghost small" onClick={() => capture.edit(note)}>
          Edit
        </button>
      </div>
      <div className="note-body">{note.body}</div>
      {note.source?.url && <SourceLink url={note.source.url} timestamp={note.sourceTimestamp} title={note.source.title} />}
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
    </article>
  );
}
