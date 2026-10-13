import { useId } from 'react';
import type { SessionKind, SessionView } from '../../../src/shared/api';
import { SESSION_KIND_LABEL, sessionLabel } from '../../../src/shared/sessions';
import { useSessions } from '../api';
import { datePhrase, localToday } from '../lib/format';
import { Icon } from './Icon';

/** Where a note came from, as chosen in the note sheet. */
export type Origin =
  /** Not chosen: the server uses the day's only session, if there is exactly one. Shown the same way here. */
  | { mode: 'auto' }
  | { mode: 'none' }
  | { mode: 'existing'; session: SessionView }
  | { mode: 'new'; kind: SessionKind; name: string; instructor: string };

const NEW_KINDS: SessionKind[] = ['class', 'open_mat', 'seminar', 'private', 'competition', 'drilling', 'other'];

/** The session the server will attach for an "auto" origin. */
const autoSession = (onDate: SessionView[] | undefined) => (onDate?.length === 1 ? onDate[0]! : null);

/** What to send with the note: nothing (let the server decide), none, an existing session, or a new one. */
export function originPayload(o: Origin, date: string): { sessionId?: number | null; session?: { kind: SessionKind; name?: string; instructor?: string; date: string } } {
  switch (o.mode) {
    case 'auto':
      return {};
    case 'none':
      return { sessionId: null };
    case 'existing':
      return { sessionId: o.session.id };
    case 'new':
      return { session: { kind: o.kind, name: o.name.trim() || undefined, instructor: o.instructor.trim() || undefined, date } };
  }
}

export function OriginPicker({
  value,
  onChange,
  date,
  onPickSession,
}: {
  value: Origin;
  onChange: (o: Origin) => void;
  /** The note's date; a new session gets it too. */
  date: string;
  /** Called with an existing session when it's picked, so the note can take its date. */
  onPickSession?: (s: SessionView) => void;
}) {
  const id = useId();
  const today = localToday();
  const recent = useSessions();
  const onDate = useSessions(date);
  const auto = value.mode === 'auto' ? autoSession(onDate.data) : null;
  const selectedId = value.mode === 'existing' ? value.session.id : auto?.id;

  // Sessions on the note's date first, then recent ones; always including the selected one.
  const chips: SessionView[] = [];
  const push = (s: SessionView | null | undefined) => {
    if (s && !chips.some(c => c.id === s.id)) chips.push(s);
  };
  if (value.mode === 'existing') push(value.session);
  (onDate.data ?? []).forEach(push);
  (recent.data ?? []).slice(0, 5).forEach(push);
  chips.sort((a, b) => b.date.localeCompare(a.date) || b.id - a.id);

  const when = (d: string) => datePhrase(d, today);
  // Chips stay short: a named event leaves out the instructor.
  const chipLabel = (s: SessionView) => sessionLabel({ ...s, location: null, instructor: s.name ? null : s.instructor }, when);
  const pick = (s: SessionView) => {
    onChange({ mode: 'existing', session: s });
    onPickSession?.(s);
  };
  const draft = value.mode === 'new' ? value : null;

  return (
    <div className="field">
      <span className="label" id={id}>
        From
      </span>
      <div className="segments" role="group" aria-labelledby={id}>
        <button
          type="button"
          className="segment"
          aria-pressed={value.mode === 'none' || (value.mode === 'auto' && !auto)}
          onClick={() => onChange({ mode: 'none' })}
        >
          None
        </button>
        {chips.map(s => (
          <button key={s.id} type="button" className="segment" aria-pressed={selectedId === s.id} onClick={() => pick(s)}>
            {chipLabel(s)}
          </button>
        ))}
        <button
          type="button"
          className="segment segment-icon"
          aria-pressed={value.mode === 'new'}
          onClick={() => value.mode !== 'new' && onChange({ mode: 'new', kind: 'class', name: '', instructor: '' })}
        >
          <Icon name="plus" size={16} />
          New
        </button>
      </div>

      {draft && (
        <div className="origin-new">
          <div className="segments" role="group" aria-label="Kind of session">
            {NEW_KINDS.map(k => (
              <button
                key={k}
                type="button"
                className="segment"
                aria-pressed={draft.kind === k}
                onClick={() => onChange({ ...draft, kind: k })}
              >
                {k === 'other' ? 'Other' : SESSION_KIND_LABEL[k]}
              </button>
            ))}
          </div>
          <div className="origin-fields">
            <label className="field">
              <span className="label">Event</span>
              <input
                className="input"
                placeholder="Optional, e.g. Zen camp"
                value={draft.name}
                onChange={e => onChange({ ...draft, name: e.target.value })}
              />
            </label>
            <label className="field">
              <span className="label">Instructor</span>
              <input
                className="input"
                placeholder="Optional"
                autoComplete="off"
                value={draft.instructor}
                onChange={e => onChange({ ...draft, instructor: e.target.value })}
              />
            </label>
          </div>
          <p className="muted small origin-preview" aria-live="polite">
            {sessionLabel({ kind: draft.kind, name: draft.name, instructor: draft.instructor, date }, when)}
          </p>
        </div>
      )}
    </div>
  );
}
