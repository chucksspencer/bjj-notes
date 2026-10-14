import { useDeferredValue, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import type { Role, TechniqueType } from '../../../src/shared/api';
import { useCreateTechnique, useDeleteTechniques, useTechniques, type TechniqueFilters } from '../api';
import { RankBar } from '../components/Belt';
import { Icon } from '../components/Icon';
import { countOf, SelectionBar, useSelection } from '../components/Selection';
import { Sheet } from '../components/Sheet';
import { useToast } from '../components/Toast';
import { ROLE_LABEL, ROLES, techniqueLine, TYPE_LABEL, TYPE_PLURAL, TYPES } from '../lib/format';

export function Library() {
  const [params, setParams] = useSearchParams();
  const [text, setText] = useState(params.get('q') ?? '');
  const q = useDeferredValue(text.trim());
  const type = (params.get('type') as TechniqueType | null) ?? undefined;
  const role = (params.get('role') as Role | null) ?? undefined;
  const sort = params.get('sort') === 'recent' ? 'recent' : 'name';
  const filters: TechniqueFilters = { q: q || undefined, type, role, sort };
  const list = useTechniques(filters);
  const [creating, setCreating] = useState(false);
  const selection = useSelection(list.data?.map(t => t.id) ?? []);
  const del = useDeleteTechniques();
  const toast = useToast();

  const deleteSelected = () => {
    const n = selection.ids.length;
    const which = n === 1 ? 'this one' : 'these';
    if (!window.confirm(`Delete ${countOf(n, 'technique')}? Notes stay; any that were only about ${which} go to your inbox.`)) return;
    del.mutate(selection.ids, {
      onSuccess: r => {
        toast.show(r.message.replace(/\.$/, ''), { undoable: true });
        selection.stop();
      },
      onError: toast.error,
    });
  };

  const setParam = (k: string, v: string | undefined) => {
    const next = new URLSearchParams(params);
    if (v) next.set(k, v);
    else next.delete(k);
    setParams(next, { replace: true });
  };

  return (
    <div className={`page${selection.active ? ' selecting' : ''}`}>
      <header className="page-head">
        <h1 className="display page-title">Library</h1>
        <div className="head-actions">
          {selection.active ? (
            <button type="button" className="btn ghost small" onClick={selection.stop}>
              Done
            </button>
          ) : (
            <>
              <button type="button" className="btn ghost small" onClick={selection.start} disabled={!list.data?.length}>
                Select
              </button>
              <button type="button" className="btn small" onClick={() => setCreating(true)}>
                <Icon name="plus" size={18} />
                New
              </button>
            </>
          )}
        </div>
      </header>

      <div className="search">
        <Icon name="search" size={20} />
        <input
          className="input"
          type="search"
          placeholder="Search names, details or events"
          aria-label="Search techniques"
          value={text}
          onChange={e => {
            setText(e.target.value);
            setParam('q', e.target.value.trim() || undefined);
          }}
        />
      </div>
      <div className="filters">
        <select className="select" aria-label="Type" value={type ?? ''} onChange={e => setParam('type', e.target.value || undefined)}>
          <option value="">All types</option>
          {TYPES.map(t => (
            <option key={t} value={t}>
              {TYPE_PLURAL[t]}
            </option>
          ))}
        </select>
        <select className="select" aria-label="Top or bottom" value={role ?? ''} onChange={e => setParam('role', e.target.value || undefined)}>
          <option value="">Top and bottom</option>
          {ROLES.map(r => (
            <option key={r} value={r}>
              {ROLE_LABEL[r]}
            </option>
          ))}
        </select>
        {!q && (
          <select className="select" aria-label="Order" value={sort} onChange={e => setParam('sort', e.target.value === 'recent' ? 'recent' : undefined)}>
            <option value="name">A to Z</option>
            <option value="recent">Recent notes</option>
          </select>
        )}
      </div>

      <section className="panel" aria-label="Techniques" aria-busy={list.isFetching}>
        {list.isError && <div className="empty">Couldn't load techniques. {list.error.message}</div>}
        {list.data?.length === 0 && (
          <div className="empty">{q || type || role ? 'Nothing matches. Try fewer filters or another spelling.' : 'No techniques yet. Add your first one.'}</div>
        )}
        {list.data?.map(t => {
          const body = (
            <>
              <span className="grow">
                <span className="row-title">
                  {t.name}
                  {t.starred && (
                    <span className="star-mark">
                      <Icon name="star" size={15} filled label="Starred" />
                    </span>
                  )}
                </span>
                <span className="row-meta">{techniqueLine(t.type, t.role, t.edges[0])}</span>
              </span>
              <RankBar status={t.status} />
            </>
          );
          return selection.active ? (
            <label key={t.id} className="row row-split">
              <input type="checkbox" className="check" checked={selection.has(t.id)} onChange={() => selection.toggle(t.id)} aria-label={t.name} />
              {body}
            </label>
          ) : (
            <Link key={t.id} className="row row-split" to={`/t/${t.id}`}>
              {body}
            </Link>
          );
        })}
      </section>

      <SelectionBar selection={selection} noun="techniques" busy={del.isPending} onDelete={deleteSelected} />

      {creating && <NewTechniqueSheet initialName={text.trim()} onClose={() => setCreating(false)} />}
    </div>
  );
}

export function NewTechniqueSheet({ initialName, onClose }: { initialName?: string; onClose: () => void }) {
  const [name, setName] = useState(initialName ?? '');
  const [type, setType] = useState<TechniqueType>('submission');
  const [role, setRole] = useState<Role | ''>('');
  const create = useCreateTechnique();
  const toast = useToast();
  const navigate = useNavigate();
  return (
    <Sheet title="New technique" onClose={onClose}>
      <form
        onSubmit={e => {
          e.preventDefault();
          create.mutate(
            { name: name.trim(), type, role: role || null },
            {
              onSuccess: t => {
                toast.show(`Added ${t.name}`, { undoable: true });
                onClose();
                navigate(`/t/${t.id}`);
              },
              onError: err => {
                const existing = (err as { body?: { id?: number } }).body?.id;
                if (existing) {
                  onClose();
                  navigate(`/t/${existing}`);
                  toast.show(`${name.trim()} is already in your library`);
                } else toast.error(err);
              },
            },
          );
        }}
      >
        <label className="field">
          <span className="label">Name</span>
          <input className="input" autoFocus value={name} onChange={e => setName(e.target.value)} placeholder="Kimura" />
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
            {(['top', 'bottom', 'neutral'] as const).map(r => (
              <button key={r} type="button" className="segment" aria-pressed={role === r} onClick={() => setRole(role === r ? '' : r)}>
                {ROLE_LABEL[r]}
              </button>
            ))}
          </div>
        </div>
        <button className="btn block" type="submit" disabled={!name.trim() || create.isPending}>
          Add technique
        </button>
      </form>
    </Sheet>
  );
}
