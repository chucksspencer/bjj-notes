import { useDeferredValue, useId, useState } from 'react';
import type { Role, TechniqueRef, TechniqueType } from '../../../src/shared/api';
import { useTechniques } from '../api';
import { ROLE_LABEL, ROLES, techniqueLine, TYPE_LABEL, TYPES } from '../lib/format';
import { Icon } from './Icon';
import { RankBar } from './Belt';

export interface NewTechnique {
  name: string;
  type: TechniqueType;
  role?: Role;
}

/** Pick existing techniques by name (fuzzy), or add a new one inline. */
export function TechniquePicker({
  selected,
  onChange,
  newOnes = [],
  onNewChange,
  label = 'Techniques',
  single = false,
}: {
  selected: TechniqueRef[];
  onChange: (t: TechniqueRef[]) => void;
  newOnes?: NewTechnique[];
  onNewChange?: (n: NewTechnique[]) => void;
  label?: string;
  single?: boolean;
}) {
  const inputId = useId();
  const [text, setText] = useState('');
  const query = useDeferredValue(text.trim());
  const results = useTechniques({ q: query }, query.length > 0);
  const [draftType, setDraftType] = useState<TechniqueType>('submission');
  const [draftRole, setDraftRole] = useState<Role | ''>('');
  const [creating, setCreating] = useState(false);

  const add = (t: TechniqueRef) => {
    onChange(single ? [t] : [...selected.filter(s => s.id !== t.id), t]);
    setText('');
  };
  const exact = results.data?.some(r => r.name.toLowerCase() === query.toLowerCase()) ?? false;
  const shown = (results.data ?? []).filter(r => !selected.some(s => s.id === r.id)).slice(0, 6);
  const full = single && selected.length + newOnes.length >= 1;

  return (
    <div className="field picker">
      <label className="label" htmlFor={inputId}>
        {label}
      </label>
      {(selected.length > 0 || newOnes.length > 0) && (
        <div className="chips" style={{ marginBottom: 8 }}>
          {selected.map(t => (
            <span className="chip" key={t.id}>
              {t.name}
              <button type="button" aria-label={`Remove ${t.name}`} onClick={() => onChange(selected.filter(s => s.id !== t.id))}>
                <Icon name="close" size={16} />
              </button>
            </span>
          ))}
          {newOnes.map(n => (
            <span className="chip" key={`new-${n.name}`}>
              {n.name} (new)
              <button type="button" aria-label={`Remove ${n.name}`} onClick={() => onNewChange?.(newOnes.filter(x => x !== n))}>
                <Icon name="close" size={16} />
              </button>
            </span>
          ))}
        </div>
      )}
      {!full && (
        <input
          id={inputId}
          className="input"
          type="text"
          enterKeyHint="search"
          autoComplete="off"
          autoCapitalize="none"
          placeholder="Search techniques"
          value={text}
          onChange={e => {
            setText(e.target.value);
            setCreating(false);
          }}
        />
      )}
      {query && !full && (
        <div className="panel picker-results">
          {shown.map(t => (
            <button key={t.id} type="button" className="row row-split" onClick={() => add(t)}>
              <span className="grow">
                <span className="row-title">{t.name}</span>
                <span className="row-meta">{techniqueLine(t.type, t.role)}</span>
              </span>
              <RankBar status={t.status} />
            </button>
          ))}
          {!exact && onNewChange && !creating && (
            <button type="button" className="row picker-create" onClick={() => setCreating(true)}>
              Add “{text.trim()}” as a new technique
            </button>
          )}
          {creating && onNewChange && (
            <div className="row">
              <div className="row-title" style={{ marginBottom: 10 }}>
                New technique: {text.trim()}
              </div>
              <div className="segments" style={{ marginBottom: 10 }}>
                <select className="select" value={draftType} onChange={e => setDraftType(e.target.value as TechniqueType)} aria-label="Type">
                  {TYPES.map(t => (
                    <option key={t} value={t}>
                      {TYPE_LABEL[t]}
                    </option>
                  ))}
                </select>
                <select className="select" value={draftRole} onChange={e => setDraftRole(e.target.value as Role | '')} aria-label="Role">
                  <option value="">Top or bottom?</option>
                  {ROLES.map(r => (
                    <option key={r} value={r}>
                      {ROLE_LABEL[r]}
                    </option>
                  ))}
                </select>
              </div>
              <button
                type="button"
                className="btn small"
                onClick={() => {
                  onNewChange([...newOnes, { name: text.trim(), type: draftType, role: draftRole || undefined }]);
                  setText('');
                  setCreating(false);
                }}
              >
                Add technique
              </button>
            </div>
          )}
          {shown.length === 0 && exact && <div className="empty">Already added.</div>}
        </div>
      )}
    </div>
  );
}
