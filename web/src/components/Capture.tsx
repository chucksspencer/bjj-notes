import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';
import type { NoteKind, NoteView, TechniqueRef } from '../../../src/shared/api';
import { useAddNote, useDeleteNote, useEditNote } from '../api';
import { localToday, NOTE_KIND_LABEL, NOTE_KINDS } from '../lib/format';
import { OriginPicker, originPayload, type Origin } from './OriginPicker';
import { Sheet } from './Sheet';
import { TechniquePicker, type NewTechnique } from './TechniquePicker';
import { useToast } from './Toast';

interface CaptureApi {
  /** New note, optionally about some techniques already. */
  open: (preset?: { techniques?: TechniqueRef[] }) => void;
  edit: (note: NoteView) => void;
}

const Ctx = createContext<CaptureApi>({ open: () => {}, edit: () => {} });
export const useCapture = () => useContext(Ctx);

type State = { mode: 'new'; techniques: TechniqueRef[] } | { mode: 'edit'; note: NoteView } | null;

export function CaptureProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<State>(null);
  const api: CaptureApi = {
    open: useCallback(preset => setState({ mode: 'new', techniques: preset?.techniques ?? [] }), []),
    edit: useCallback(note => setState({ mode: 'edit', note }), []),
  };
  const close = useCallback(() => setState(null), []);
  return (
    <Ctx.Provider value={api}>
      {children}
      {state && <NoteForm key={state.mode === 'edit' ? `e${state.note.id}` : 'new'} state={state} onClose={close} />}
    </Ctx.Provider>
  );
}

function NoteForm({ state, onClose }: { state: NonNullable<State>; onClose: () => void }) {
  const editing = state.mode === 'edit' ? state.note : null;
  const [text, setText] = useState(editing?.body ?? '');
  const [techniques, setTechniques] = useState<TechniqueRef[]>(editing?.techniques ?? (state.mode === 'new' ? state.techniques : []));
  const [newOnes, setNewOnes] = useState<NewTechnique[]>([]);
  const [kind, setKind] = useState<NoteKind>(editing?.kind ?? 'instruction');
  const [date, setDate] = useState(editing?.observedOn ?? localToday());
  const [origin, setOrigin] = useState<Origin>(
    editing ? (editing.session ? { mode: 'existing', session: editing.session } : { mode: 'none' }) : { mode: 'auto' },
  );
  const [showSource, setShowSource] = useState(false);
  const [url, setUrl] = useState('');
  const [timestamp, setTimestamp] = useState('');
  // A video you haven't tried yet waits on the To try list instead of being filed.
  const [toTry, setToTry] = useState(true);
  const add = useAddNote();
  const editNote = useEditNote();
  const del = useDeleteNote();
  const toast = useToast();
  const busy = add.isPending || editNote.isPending || del.isPending;

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!text.trim()) return;
    if (editing) {
      const unchanged = origin.mode === 'existing' ? origin.session.id === editing.sessionId : origin.mode === 'none' && !editing.sessionId;
      editNote.mutate(
        {
          id: editing.id,
          body: text,
          kind,
          date,
          techniqueIds: techniques.map(t => t.id),
          ...(unchanged ? {} : originPayload(origin, date)),
        },
        {
          onSuccess: () => {
            toast.show('Note updated', { undoable: true });
            onClose();
          },
          onError: toast.error,
        },
      );
      return;
    }
    add.mutate(
      {
        text,
        kind,
        date,
        techniqueIds: techniques.map(t => t.id),
        newTechniques: newOnes,
        source: url.trim() ? { url: url.trim(), timestamp: timestamp.trim() || undefined } : undefined,
        toTry: url.trim() ? toTry : undefined,
        ...originPayload(origin, date),
      },
      {
        onSuccess: r => {
          const names = r.note.techniques.map(t => t.name);
          toast.show(r.note.toTry ? 'Added to To try' : names.length ? `Saved to ${names.join(', ')}` : 'Saved to your inbox', {
            undoable: true,
          });
          onClose();
        },
        onError: toast.error,
      },
    );
  };

  return (
    <Sheet title={editing ? 'Edit note' : 'New note'} onClose={onClose}>
      <form onSubmit={submit}>
        <label className="field">
          <span className="visually-hidden">Note</span>
          <textarea
            className="textarea"
            autoFocus
            placeholder="What did you learn or notice?"
            value={text}
            onChange={e => setText(e.target.value)}
            rows={5}
          />
        </label>

        <TechniquePicker selected={techniques} onChange={setTechniques} newOnes={newOnes} onNewChange={editing ? undefined : setNewOnes} />

        <div className="field">
          <span className="label">Kind of note</span>
          <div className="segments" role="group" aria-label="Kind of note">
            {NOTE_KINDS.map(k => (
              <button key={k} type="button" className="segment" aria-pressed={kind === k} onClick={() => setKind(k)}>
                {NOTE_KIND_LABEL[k]}
              </button>
            ))}
          </div>
        </div>

        <label className="field">
          <span className="label">Date</span>
          <input className="input" type="date" value={date} max={localToday()} onChange={e => setDate(e.target.value || localToday())} />
        </label>

        <OriginPicker value={origin} onChange={setOrigin} date={date} onPickSession={s => setDate(s.date)} />

        {!editing &&
          (showSource ? (
            <>
              <div className="row-split" style={{ alignItems: 'flex-start' }}>
                <label className="field grow">
                  <span className="label">Video or post link</span>
                  <input
                    className="input"
                    type="url"
                    inputMode="url"
                    placeholder="https://youtu.be/…"
                    value={url}
                    onChange={e => setUrl(e.target.value)}
                  />
                </label>
                <label className="field" style={{ width: 96 }}>
                  <span className="label">At</span>
                  <input className="input" placeholder="4:32" value={timestamp} onChange={e => setTimestamp(e.target.value)} />
                </label>
              </div>
              {url.trim() && (
                <label className="check-row">
                  <input type="checkbox" className="check" checked={toTry} onChange={e => setToTry(e.target.checked)} />
                  <span>Haven't tried it yet — put it on To try</span>
                </label>
              )}
            </>
          ) : (
            <button type="button" className="btn ghost" style={{ marginBottom: 14, marginLeft: -8 }} onClick={() => setShowSource(true)}>
              Add a video or post link
            </button>
          ))}

        <button className="btn block" type="submit" disabled={busy || !text.trim()}>
          {editing ? 'Save changes' : 'Save note'}
        </button>
        {editing && (
          <button
            type="button"
            className="btn danger block"
            style={{ marginTop: 8 }}
            disabled={busy}
            onClick={() =>
              del.mutate(editing.id, {
                onSuccess: () => {
                  toast.show('Note deleted', { undoable: true });
                  onClose();
                },
                onError: toast.error,
              })
            }
          >
            Delete note
          </button>
        )}
        {!editing && techniques.length === 0 && newOnes.length === 0 && !(url.trim() && toTry) && (
          <p className="muted small" style={{ marginTop: 8 }}>
            Notes without a technique go to your inbox to file later.
          </p>
        )}
      </form>
    </Sheet>
  );
}
