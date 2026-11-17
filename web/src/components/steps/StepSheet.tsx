// The sheet for one step, and the position and role pickers it shares with the start sheet.
import { useState } from 'react';
import type { Role, TechniqueRef } from '../../../../src/shared/api';
import { usePositions } from '../../api';
import { CATEGORY_LABEL, CATEGORY_ORDER, ROLES } from '../../lib/format';
import { Sheet } from '../Sheet';
import { TechniquePicker } from '../TechniquePicker';
import type { StepForm } from './model';

/** One step: when (for a branch), what to do, the card it is, where it leaves you, and why. */
export function StepSheet({
  title,
  initial,
  askWhen,
  following,
  busy,
  onSave,
  onDelete,
  onPrefer,
  onEarlier,
  onLater,
  onClose,
}: {
  title: string;
  /** The step as it is, with the reaction that leads to it; null for a new one. */
  initial: (StepForm & { trigger: string | null }) | null;
  askWhen: boolean;
  /** Steps under this one, which go with it if it's deleted. */
  following: number;
  busy: boolean;
  onSave: (step: StepForm & { trigger: string | null }) => void;
  onDelete?: () => void;
  /** For an alternative: make it the preferred one (plan A). */
  onPrefer?: () => void;
  /** For one of several alternatives: one place earlier or later among them (plan C to B, A to B…). */
  onEarlier?: () => void;
  onLater?: () => void;
  onClose: () => void;
}) {
  const [when, setWhen] = useState(initial?.trigger ?? '');
  const [action, setAction] = useState(initial?.action ?? '');
  const [technique, setTechnique] = useState<TechniqueRef[]>(initial?.technique ? [initial.technique] : []);
  const [to, setTo] = useState<{ id: number | null; name: string | null }>({ id: initial?.toPositionId ?? null, name: initial?.toName ?? null });
  const [toRole, setToRole] = useState<Role | null>(initial?.toRole ?? null);
  const [note, setNote] = useState(initial?.note ?? '');
  const doText = action.trim() || technique[0]?.name || '';
  return (
    <Sheet title={title} onClose={onClose}>
      <form
        onSubmit={e => {
          e.preventDefault();
          if (!doText) return;
          onSave({
            trigger: when.trim() || null,
            action: doText,
            technique: technique[0] ?? null,
            toPositionId: to.id,
            toName: to.name,
            toRole: to.id ? toRole : null,
            note: note.trim() || null,
          });
        }}
      >
        {askWhen && (
          <label className="field">
            <span className="label">If they… (what they do)</span>
            <input className="input" autoFocus placeholder="post the far leg" value={when} onChange={e => setWhen(e.target.value)} />
          </label>
        )}
        <label className="field">
          <span className="label">Do</span>
          <input
            className="input"
            autoFocus={!askWhen}
            placeholder="Go to deep half"
            value={action}
            onChange={e => setAction(e.target.value)}
          />
        </label>
        <TechniquePicker label="Technique card (optional)" single selected={technique} onChange={setTechnique} />
        <PositionSelect label="Leaves you in (optional)" value={to.id} onChange={(id, name) => setTo({ id, name })} />
        {to.id !== null && <RoleSegments value={toRole} onChange={setToRole} />}
        <label className="field">
          <span className="label">Why, or the cue (optional)</span>
          <input className="input" placeholder="Make them post the underhook hand" value={note} onChange={e => setNote(e.target.value)} />
        </label>
        <button className="btn block" type="submit" disabled={busy || !doText}>
          Save step
        </button>
        {onPrefer && (
          <button type="button" className="btn quiet block" style={{ marginTop: 8 }} disabled={busy} onClick={onPrefer}>
            Make this plan A
          </button>
        )}
        {(onEarlier || onLater) && (
          <div className="row-split" style={{ marginTop: 8 }}>
            {onEarlier && (
              <button type="button" className="btn quiet grow" disabled={busy} onClick={onEarlier}>
                Try earlier
              </button>
            )}
            {onLater && (
              <button type="button" className="btn quiet grow" disabled={busy} onClick={onLater}>
                Try later
              </button>
            )}
          </div>
        )}
        {onDelete && (
          <button type="button" className="btn danger block" style={{ marginTop: 8 }} disabled={busy} onClick={onDelete}>
            {following ? `Delete step and the ${following} after it` : 'Delete step'}
          </button>
        )}
      </form>
    </Sheet>
  );
}

/** Pick a position, grouped by kind. */
export function PositionSelect({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number | null;
  onChange: (id: number | null, name: string | null) => void;
}) {
  const positions = usePositions();
  return (
    <label className="field">
      <span className="label">{label}</span>
      <select
        className="select"
        value={value ?? ''}
        onChange={e => {
          const id = e.target.value ? Number(e.target.value) : null;
          onChange(id, positions.data?.find(p => p.id === id)?.name ?? null);
        }}
      >
        <option value="">None</option>
        {CATEGORY_ORDER.map(cat => {
          const list = positions.data?.filter(p => p.category === cat) ?? [];
          if (!list.length) return null;
          return (
            <optgroup key={cat} label={CATEGORY_LABEL[cat]}>
              {list.map(p => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </optgroup>
          );
        })}
      </select>
    </label>
  );
}

export function RoleSegments({ value, onChange }: { value: Role | null; onChange: (r: Role | null) => void }) {
  return (
    <div className="field">
      <div className="segments" role="group" aria-label="Top or bottom">
        {ROLES.filter(r => r !== 'neutral').map(r => (
          <button key={r} type="button" className="segment" aria-pressed={value === r} onClick={() => onChange(value === r ? null : r)}>
            On {r}
          </button>
        ))}
      </div>
    </div>
  );
}
