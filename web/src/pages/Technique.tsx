import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import type { Gi, LinkKind, Role, TechniqueRef, TechniqueType, TechniqueView } from '../../../src/shared/api';
import {
  useAddEdge,
  useAddLink,
  useDeleteTechnique,
  useFocus,
  usePatchTechnique,
  usePositions,
  useRemoveEdge,
  useRemoveLink,
  useTechnique,
} from '../api';
import { Belt } from '../components/Belt';
import { useCapture } from '../components/Capture';
import { Icon } from '../components/Icon';
import { NoteItem } from '../components/NoteItem';
import { Sheet } from '../components/Sheet';
import { TechniqueStar } from '../components/Star';
import { TechniquePicker } from '../components/TechniquePicker';
import { useToast } from '../components/Toast';
import {
  CATEGORY_LABEL,
  CATEGORY_ORDER,
  edgeText,
  linkPhrase,
  LINK_KINDS,
  localToday,
  ROLE_LABEL,
  ROLES,
  techniqueMeta,
  TYPE_LABEL,
  TYPES,
} from '../lib/format';

type Editing = null | 'details' | 'summary' | 'keyDetails' | 'mistakes' | 'position' | 'link';

export function Technique() {
  const id = Number(useParams().id);
  const t = useTechnique(id);
  const focus = useFocus();
  const navigate = useNavigate();
  const [editing, setEditing] = useState<Editing>(null);
  const today = focus.data?.today ?? localToday();

  const back = (
    <button type="button" className="btn ghost back" onClick={() => (history.length > 1 ? navigate(-1) : navigate('/library'))}>
      <Icon name="back" size={20} />
      Back
    </button>
  );

  if (t.isError) {
    return (
      <div className="page">
        {back}
        <div className="panel empty">{t.error.message}</div>
      </div>
    );
  }
  if (!t.data) return <div className="page">{back}</div>;
  const v = t.data;
  return (
    <div className="page">
      {back}
      <TechniqueBody v={v} today={today} onEdit={setEditing} />
      {editing === 'details' && <DetailsSheet v={v} onClose={() => setEditing(null)} />}
      {editing === 'summary' && <SummarySheet v={v} onClose={() => setEditing(null)} />}
      {editing === 'keyDetails' && <ListSheet v={v} field="keyDetails" title="Key details" onClose={() => setEditing(null)} />}
      {editing === 'mistakes' && <ListSheet v={v} field="mistakes" title="Common mistakes" onClose={() => setEditing(null)} />}
      {editing === 'position' && <PositionSheet v={v} onClose={() => setEditing(null)} />}
      {editing === 'link' && <LinkSheet v={v} onClose={() => setEditing(null)} />}
    </div>
  );
}

function TechniqueBody({ v, today, onEdit }: { v: TechniqueView; today: string; onEdit: (e: Editing) => void }) {
  const patch = usePatchTechnique(v.id);
  const removeEdge = useRemoveEdge(v.id);
  const removeLink = useRemoveLink(v.id);
  const del = useDeleteTechnique();
  const capture = useCapture();
  const toast = useToast();
  const navigate = useNavigate();
  const ref: TechniqueRef = { id: v.id, name: v.name, type: v.type, role: v.role, status: v.status };
  const activeFocus = v.focus.find(f => f.status === 'active');

  return (
    <>
      <div className="tech-head">
        <h1 className="display tech-name">{v.name}</h1>
        <TechniqueStar technique={v} size={26} />
      </div>
      <p className="tech-meta">
        {techniqueMeta(v.type, v.role)}
        {v.gi !== 'both' ? `, ${v.gi === 'nogi' ? 'no-gi only' : 'gi only'}` : ''}
        {v.aliases.length ? `. Also called ${v.aliases.join(', ')}` : ''}{' '}
        <button type="button" className="btn ghost small" onClick={() => onEdit('details')}>
          Edit
        </button>
      </p>

      <Belt
        status={v.status}
        disabled={patch.isPending}
        onChange={status => patch.mutate({ status }, { onError: toast.error })}
      />

      {activeFocus && (
        <p className="small" style={{ marginTop: 14 }}>
          <Link to="/focus">Number {activeFocus.rank} on your focus list</Link>
        </p>
      )}

      <SectionHead title="Positions" action="Add" onAction={() => onEdit('position')} />
      {v.edges.length === 0 && <p className="section-hint">Where does this happen? Add a starting position.</p>}
      <section className="panel">
        {v.edges.map(e => (
          <div key={e.id} className="row row-split">
            <span className="grow">
              {e.from ? <Link to={`/p/${e.from.slug}`}>{edgeText({ from: e.from.name, fromRole: e.fromRole, to: null, toRole: null })}</Link> : null}
              {e.to || e.toRole ? (
                <span>
                  {e.from ? ' to ' : 'Into '}
                  {e.to ? <Link to={`/p/${e.to.slug}`}>{e.to.name.toLowerCase()}</Link> : null}
                  {e.toRole ? `${e.to ? ` (${e.toRole})` : e.toRole}` : ''}
                </span>
              ) : null}
            </span>
            <button
              type="button"
              className="btn ghost small"
              aria-label="Remove position"
              disabled={removeEdge.isPending}
              onClick={() => removeEdge.mutate(e.id, { onSuccess: () => toast.show('Position removed', { undoable: true }), onError: toast.error })}
            >
              <Icon name="close" size={18} />
            </button>
          </div>
        ))}
      </section>

      <SectionHead title="Summary" action={v.summary ? 'Edit' : 'Add'} onAction={() => onEdit('summary')} />
      {v.summary ? (
        <section className="panel">
          <div className="row prose">{v.summary}</div>
        </section>
      ) : (
        <p className="section-hint">How it works, in a sentence or two.</p>
      )}

      <SectionHead title="Key details" action={v.keyDetails.length ? 'Edit' : 'Add'} onAction={() => onEdit('keyDetails')} />
      {v.keyDetails.length ? (
        <section className="panel">
          <ul className="row list-plain">
            {v.keyDetails.map((d, i) => (
              <li key={i}>{d}</li>
            ))}
          </ul>
        </section>
      ) : (
        <p className="section-hint">The details that make it work.</p>
      )}

      <SectionHead title="Common mistakes" action={v.mistakes.length ? 'Edit' : 'Add'} onAction={() => onEdit('mistakes')} />
      {v.mistakes.length ? (
        <section className="panel">
          <ul className="row list-plain">
            {v.mistakes.map((d, i) => (
              <li key={i}>{d}</li>
            ))}
          </ul>
        </section>
      ) : (
        <p className="section-hint">What goes wrong, and how you'll notice.</p>
      )}

      <SectionHead title="Related" action="Add" onAction={() => onEdit('link')} />
      {v.links.length === 0 && <p className="section-hint">Chains, counters and setups that connect to this.</p>}
      <section className="panel">
        {v.links.map(l => (
          <div key={`${l.direction}-${l.kind}-${l.technique.id}`} className="row row-split">
            <span className="grow">
              <span className="muted">{linkPhrase(l.kind, l.direction)} </span>
              <Link to={`/t/${l.technique.id}`}>{l.technique.name}</Link>
            </span>
            <button
              type="button"
              className="btn ghost small"
              aria-label="Remove link"
              disabled={removeLink.isPending}
              onClick={() =>
                removeLink.mutate(
                  { otherId: l.technique.id, kind: l.kind, direction: l.direction },
                  { onSuccess: () => toast.show('Link removed', { undoable: true }), onError: toast.error },
                )
              }
            >
              <Icon name="close" size={18} />
            </button>
          </div>
        ))}
      </section>

      <SectionHead
        title={v.noteCount > v.notes.length ? `Notes (${v.notes.length} of ${v.noteCount})` : 'Notes'}
        action="Add note"
        onAction={() => capture.open({ techniques: [ref] })}
      />
      {v.notes.length === 0 && <p className="section-hint">No notes yet. Add what you learned or noticed.</p>}
      <section className="panel">
        {v.notes.map(n => (
          <NoteItem key={n.id} note={n} today={today} hideTechnique={v.id} />
        ))}
      </section>

      <div style={{ marginTop: 32 }}>
        <button
          type="button"
          className="btn danger"
          disabled={del.isPending}
          onClick={() => {
            if (!window.confirm(`Delete ${v.name}? Notes stay; any that were only about this go to your inbox.`)) return;
            del.mutate(v.id, {
              onSuccess: r => {
                toast.show(r.message.replace(/\.$/, ''), { undoable: true });
                navigate('/library');
              },
              onError: toast.error,
            });
          }}
        >
          Delete technique
        </button>
      </div>
    </>
  );
}

function SectionHead({ title, action, onAction }: { title: string; action: string; onAction: () => void }) {
  return (
    <div className="row-split" style={{ marginTop: 28, marginBottom: 8 }}>
      <h2 className="section-title grow" style={{ margin: 0 }}>
        {title}
      </h2>
      <button type="button" className="btn ghost small" onClick={onAction}>
        {action}
      </button>
    </div>
  );
}

function useSave(v: TechniqueView, onClose: () => void) {
  const patch = usePatchTechnique(v.id);
  const toast = useToast();
  return {
    pending: patch.isPending,
    save: (p: Parameters<typeof patch.mutate>[0]) =>
      patch.mutate(p, {
        onSuccess: () => {
          toast.show('Saved', { undoable: true });
          onClose();
        },
        onError: toast.error,
      }),
  };
}

function DetailsSheet({ v, onClose }: { v: TechniqueView; onClose: () => void }) {
  const [name, setName] = useState(v.name);
  const [type, setType] = useState<TechniqueType>(v.type);
  const [role, setRole] = useState<Role | null>(v.role);
  const [gi, setGi] = useState<Gi>(v.gi);
  const [aliases, setAliases] = useState(v.aliases.join(', '));
  const { save, pending } = useSave(v, onClose);
  return (
    <Sheet title="Edit technique" onClose={onClose}>
      <form
        onSubmit={e => {
          e.preventDefault();
          save({
            name: name.trim(),
            type,
            role,
            gi,
            aliases: aliases
              .split(',')
              .map(a => a.trim())
              .filter(Boolean),
          });
        }}
      >
        <label className="field">
          <span className="label">Name</span>
          <input className="input" value={name} onChange={e => setName(e.target.value)} />
        </label>
        <label className="field">
          <span className="label">Also called (comma separated)</span>
          <input className="input" value={aliases} onChange={e => setAliases(e.target.value)} placeholder="Other names, common mishearings" />
        </label>
        <label className="field">
          <span className="label">Type</span>
          <select className="select" value={type} onChange={e => setType(e.target.value as TechniqueType)}>
            {TYPES.map(t => (
              <option key={t} value={t}>
                {TYPE_LABEL[t]}
              </option>
            ))}
          </select>
        </label>
        <div className="field">
          <span className="label">Done from</span>
          <div className="segments">
            {ROLES.map(r => (
              <button key={r} type="button" className="segment" aria-pressed={role === r} onClick={() => setRole(role === r ? null : r)}>
                {ROLE_LABEL[r]}
              </button>
            ))}
          </div>
        </div>
        <div className="field">
          <span className="label">Gi or no-gi</span>
          <div className="segments">
            {(
              [
                ['both', 'Both'],
                ['gi', 'Gi only'],
                ['nogi', 'No-gi only'],
              ] as const
            ).map(([k, label]) => (
              <button key={k} type="button" className="segment" aria-pressed={gi === k} onClick={() => setGi(k)}>
                {label}
              </button>
            ))}
          </div>
        </div>
        <button className="btn block" type="submit" disabled={pending || !name.trim()}>
          Save
        </button>
      </form>
    </Sheet>
  );
}

function SummarySheet({ v, onClose }: { v: TechniqueView; onClose: () => void }) {
  const [text, setText] = useState(v.summary ?? '');
  const { save, pending } = useSave(v, onClose);
  return (
    <Sheet title="Summary" onClose={onClose}>
      <form
        onSubmit={e => {
          e.preventDefault();
          save({ summary: text.trim() || null });
        }}
      >
        <label className="field">
          <span className="visually-hidden">Summary</span>
          <textarea className="textarea" autoFocus value={text} onChange={e => setText(e.target.value)} />
        </label>
        <button className="btn block" type="submit" disabled={pending}>
          Save
        </button>
      </form>
    </Sheet>
  );
}

function ListSheet({ v, field, title, onClose }: { v: TechniqueView; field: 'keyDetails' | 'mistakes'; title: string; onClose: () => void }) {
  const [text, setText] = useState(v[field].join('\n'));
  const { save, pending } = useSave(v, onClose);
  return (
    <Sheet title={title} onClose={onClose}>
      <form
        onSubmit={e => {
          e.preventDefault();
          save({
            [field]: text
              .split('\n')
              .map(l => l.replace(/^[-•*]\s*/, '').trim())
              .filter(Boolean),
          });
        }}
      >
        <label className="field">
          <span className="label">One per line</span>
          <textarea className="textarea" autoFocus rows={8} value={text} onChange={e => setText(e.target.value)} />
        </label>
        <button className="btn block" type="submit" disabled={pending}>
          Save
        </button>
      </form>
    </Sheet>
  );
}

function PositionSelect({ value, onChange, label }: { value: number | ''; onChange: (v: number | '') => void; label: string }) {
  const positions = usePositions();
  return (
    <label className="field grow">
      <span className="label">{label}</span>
      <select className="select" value={value} onChange={e => onChange(e.target.value ? Number(e.target.value) : '')}>
        <option value="">None</option>
        {CATEGORY_ORDER.map(cat => (
          <optgroup key={cat} label={CATEGORY_LABEL[cat]}>
            {positions.data
              ?.filter(p => p.category === cat)
              .map(p => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
          </optgroup>
        ))}
      </select>
    </label>
  );
}

function RoleSelect({ value, onChange, label }: { value: Role | ''; onChange: (v: Role | '') => void; label: string }) {
  return (
    <label className="field" style={{ width: 130 }}>
      <span className="label">{label}</span>
      <select className="select" value={value} onChange={e => onChange(e.target.value as Role | '')}>
        <option value="">Either</option>
        {ROLES.map(r => (
          <option key={r} value={r}>
            {ROLE_LABEL[r]}
          </option>
        ))}
      </select>
    </label>
  );
}

function PositionSheet({ v, onClose }: { v: TechniqueView; onClose: () => void }) {
  const [from, setFrom] = useState<number | ''>('');
  const [fromRole, setFromRole] = useState<Role | ''>(v.role ?? '');
  const [to, setTo] = useState<number | ''>('');
  const [toRole, setToRole] = useState<Role | ''>(v.type === 'sweep' ? 'top' : '');
  const add = useAddEdge(v.id);
  const toast = useToast();
  return (
    <Sheet title="Add position" onClose={onClose}>
      <form
        onSubmit={e => {
          e.preventDefault();
          add.mutate(
            { fromPositionId: from || null, fromRole: fromRole || null, toPositionId: to || null, toRole: toRole || null },
            {
              onSuccess: () => {
                toast.show('Position added', { undoable: true });
                onClose();
              },
              onError: toast.error,
            },
          );
        }}
      >
        <div className="row-split" style={{ alignItems: 'flex-start' }}>
          <PositionSelect label="Starts from" value={from} onChange={setFrom} />
          <RoleSelect label="As" value={fromRole} onChange={setFromRole} />
        </div>
        <div className="row-split" style={{ alignItems: 'flex-start' }}>
          <PositionSelect label="Ends in (optional)" value={to} onChange={setTo} />
          <RoleSelect label="As" value={toRole} onChange={setToRole} />
        </div>
        <p className="muted small" style={{ marginTop: 0 }}>
          A sweep goes from a guard on the bottom to the top; a pass from a guard on top to a pin; a submission has no end
          position.
        </p>
        <button className="btn block" type="submit" disabled={add.isPending || (!from && !to)}>
          Add position
        </button>
      </form>
    </Sheet>
  );
}

function LinkSheet({ v, onClose }: { v: TechniqueView; onClose: () => void }) {
  const [kind, setKind] = useState<LinkKind>('chain');
  const [target, setTarget] = useState<TechniqueRef[]>([]);
  const add = useAddLink(v.id);
  const toast = useToast();
  return (
    <Sheet title="Add related technique" onClose={onClose}>
      <form
        onSubmit={e => {
          e.preventDefault();
          if (!target[0]) return;
          add.mutate(
            { kind, techniqueId: target[0].id },
            {
              onSuccess: () => {
                toast.show('Link added', { undoable: true });
                onClose();
              },
              onError: toast.error,
            },
          );
        }}
      >
        <div className="field">
          <span className="label">{v.name}…</span>
          <div className="segments">
            {LINK_KINDS.map(k => (
              <button key={k.kind} type="button" className="segment" aria-pressed={kind === k.kind} onClick={() => setKind(k.kind)}>
                {k.label}
              </button>
            ))}
          </div>
        </div>
        <TechniquePicker label="Technique" single selected={target} onChange={setTarget} />
        <button className="btn block" type="submit" disabled={add.isPending || !target[0]}>
          Add link
        </button>
      </form>
    </Sheet>
  );
}
