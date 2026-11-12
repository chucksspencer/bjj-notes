import { useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import type { AreaView, PositionTechnique, Role } from '../../../src/shared/api';
import { useAreas, useCreateArea, usePosition, usePositions } from '../api';
import { RankBar } from '../components/Belt';
import { Icon } from '../components/Icon';
import { Sheet } from '../components/Sheet';
import { useToast } from '../components/Toast';
import { CATEGORY_LABEL, CATEGORY_ORDER, lastNoteText, localToday, ROLE_LABEL, TYPE_LABEL, TYPE_PLURAL } from '../lib/format';

/**
 * Game: your areas (and the plans in them) by where they start, then the positions they start from. Empty
 * positions fold away.
 */
export function Game() {
  const areas = useAreas();
  const positions = usePositions();
  const [all, setAll] = useState(false);
  const [adding, setAdding] = useState(false);
  const today = areas.data?.today ?? localToday();

  const groups = new Map<string, { title: string; slug: string | null; areas: AreaView[] }>();
  for (const a of areas.data?.areas ?? []) {
    const key = a.start ? `${a.start.id}-${a.startRole ?? ''}` : 'none';
    const title = a.start ? `${a.start.name}${a.startRole ? `, ${a.startRole}` : ''}` : 'Not tied to a position';
    const g = groups.get(key) ?? { title, slug: a.start?.slug ?? null, areas: [] };
    g.areas.push(a);
    groups.set(key, g);
  }
  const ordered = [...groups.entries()].sort(([ka, a], [kb, b]) => (ka === 'none' ? 1 : kb === 'none' ? -1 : a.title.localeCompare(b.title)));
  const planned = new Set((areas.data?.areas ?? []).map(a => a.start?.id).filter(Boolean));
  const used = (p: { id: number; techniqueCount: number }) => p.techniqueCount > 0 || planned.has(p.id);
  const hidden = (positions.data ?? []).filter(p => !used(p)).length;

  return (
    <div className="page">
      <header className="page-head row-split">
        <h1 className="display page-title grow">Game</h1>
        <button type="button" className="btn small" onClick={() => setAdding(true)}>
          <Icon name="plus" size={18} />
          New area
        </button>
      </header>
      <p className="section-hint">Your areas by where they start: the ones with a plan are your systems. Areas on your focus list are numbered.</p>

      {areas.isError && <div className="panel empty">Couldn't load your areas. {areas.error.message}</div>}
      {areas.data?.areas.length === 0 && <div className="panel empty">No areas yet. Make one, or add something to your focus list.</div>}
      {ordered.map(([key, g]) => (
        <section key={key}>
          <h2 className="group-title">{g.slug ? <Link to={`/p/${g.slug}`}>{g.title}</Link> : g.title}</h2>
          <div className="panel">
            {g.areas.map(a => (
              <Link key={a.id} className="row row-split" to={`/areas/${a.id}`}>
                {a.rank !== null && (
                  <span className="area-rank" aria-label={`Number ${a.rank} on your focus`}>
                    {a.rank}
                  </span>
                )}
                <span className="grow">
                  <span className="row-title">{a.name}</span>
                  <span className="row-meta">
                    {[a.stepCount ? `Plan of ${a.stepCount} step${a.stepCount === 1 ? '' : 's'}` : null, lastNoteText(a.lastNoteOn, today)]
                      .filter(Boolean)
                      .join(' · ')}
                  </span>
                </span>
              </Link>
            ))}
          </div>
        </section>
      ))}

      <h2 className="section-title">Positions</h2>
      {positions.isError && <div className="panel empty">Couldn't load positions. {positions.error.message}</div>}
      {positions.data &&
        CATEGORY_ORDER.map(cat => {
          const list = positions.data.filter(p => p.category === cat && (all || used(p)));
          if (!list.length) return null;
          return (
            <section key={cat}>
              <h3 className="group-title">{CATEGORY_LABEL[cat]}</h3>
              <div className="panel">
                {list.map(p => (
                  <Link key={p.id} className="row row-split" to={`/p/${p.slug}`}>
                    <span className={`grow row-title${used(p) ? '' : ' dim'}`}>{p.name}</span>
                    <span className="count" aria-label={`${p.techniqueCount} techniques`}>
                      {p.techniqueCount || ''}
                    </span>
                  </Link>
                ))}
              </div>
            </section>
          );
        })}
      {hidden > 0 && (
        <button type="button" className="btn ghost section-action" aria-expanded={all} onClick={() => setAll(!all)}>
          {all ? 'Hide positions with nothing in them' : `Show all positions (${hidden} more)`}
        </button>
      )}

      {adding && <NewArea onClose={() => setAdding(false)} />}
    </div>
  );
}

/** A new area, off focus unless asked: often a system to write down. */
function NewArea({ onClose }: { onClose: () => void }) {
  const [name, setName] = useState('');
  const [focus, setFocus] = useState(false);
  const create = useCreateArea();
  const toast = useToast();
  const navigate = useNavigate();
  return (
    <Sheet title="New area" onClose={onClose}>
      <form
        onSubmit={e => {
          e.preventDefault();
          if (!name.trim()) return;
          create.mutate(
            { name: name.trim(), focus },
            {
              onSuccess: r => {
                toast.show(`Made ${r.area.name}`, { undoable: true });
                onClose();
                navigate(`/areas/${r.area.id}`);
              },
              onError: toast.error,
            },
          );
        }}
      >
        <label className="field">
          <span className="label">Name</span>
          <input className="input" autoFocus placeholder="Bottom half: winning the underhook" value={name} onChange={e => setName(e.target.value)} />
        </label>
        <label className="check-row">
          <input type="checkbox" className="check" checked={focus} onChange={e => setFocus(e.target.checked)} />
          <span>Put it at the top of my focus list</span>
        </label>
        <button className="btn block" type="submit" disabled={create.isPending || !name.trim()}>
          Make it
        </button>
        <p className="muted small" style={{ marginTop: 8 }}>
          Then give it a plan: where it starts and what to do when they react.
        </p>
      </form>
    </Sheet>
  );
}

export function Position() {
  const slug = useParams().slug ?? '';
  const [params, setParams] = useSearchParams();
  const role = (params.get('role') as Role | null) ?? undefined;
  const view = usePosition(slug, role);
  const v = view.data;

  const byType = new Map<string, PositionTechnique[]>();
  for (const t of v?.from ?? []) byType.set(t.type, [...(byType.get(t.type) ?? []), t]);

  return (
    <div className="page">
      <Link className="btn ghost back" to="/game">
        <Icon name="back" size={20} />
        Game
      </Link>
      {view.isError && <div className="panel empty">{view.error.message}</div>}
      {v && (
        <>
          <h1 className="display tech-name">{v.position.name}</h1>
          <p className="tech-meta">{v.position.aliases.length ? `Also called ${v.position.aliases.join(', ')}` : CATEGORY_LABEL[v.position.category]}</p>
          <div className="segments" role="group" aria-label="Whose side">
            {([undefined, 'top', 'bottom'] as const).map(r => (
              <button
                key={r ?? 'all'}
                type="button"
                className="segment"
                aria-pressed={role === r}
                onClick={() => {
                  const next = new URLSearchParams(params);
                  if (r) next.set('role', r);
                  else next.delete('role');
                  setParams(next, { replace: true });
                }}
              >
                {r ? `On ${r}` : 'Both sides'}
              </button>
            ))}
          </div>

          {v.plans.length > 0 && (
            <>
              <h2 className="section-title">Plans from here</h2>
              <section className="panel">
                {v.plans.map(a => (
                  <Link key={a.id} className="row row-split" to={`/areas/${a.id}`}>
                    {a.rank !== null && <span className="area-rank">{a.rank}</span>}
                    <span className="grow row-title">{a.name}</span>
                  </Link>
                ))}
              </section>
            </>
          )}

          <h2 className="section-title">From here</h2>
          {v.from.length === 0 && <div className="panel empty">Nothing logged from here yet.</div>}
          {[...byType].map(([type, list]) => (
            <section key={type}>
              <h3 className="group-title">{TYPE_PLURAL[type as keyof typeof TYPE_PLURAL]}</h3>
              <div className="panel">
              {list.map(t => (
                <Link key={t.edge.id} className="row row-split" to={`/t/${t.id}`}>
                  <span className="grow">
                    <span className="row-title">{t.name}</span>
                    <span className="row-meta">
                      {[!role && t.edge.fromRole ? `From ${t.edge.fromRole}` : null, t.edge.to ? `to ${t.edge.to.name.toLowerCase()}` : t.edge.toRole ? `to ${t.edge.toRole}` : null]
                        .filter(Boolean)
                        .join(' ')
                        .replace(/^to/, 'To')}
                    </span>
                  </span>
                  <RankBar status={t.status} />
                </Link>
              ))}
              </div>
            </section>
          ))}

          {v.into.length > 0 && (
            <>
              <h2 className="section-title">Ways in</h2>
              <section className="panel">
                {v.into.map(t => (
                  <Link key={t.edge.id} className="row row-split" to={`/t/${t.id}`}>
                    <span className="grow">
                      <span className="row-title">{t.name}</span>
                      <span className="row-meta">
                        {TYPE_LABEL[t.type]}
                        {t.edge.from ? ` from ${t.edge.from.name.toLowerCase()}` : ''}
                      </span>
                    </span>
                    <RankBar status={t.status} />
                  </Link>
                ))}
              </section>
            </>
          )}

          {v.gaps.length > 0 && (
            <>
              <h2 className="section-title">Gaps</h2>
              <section className="panel">
                <ul className="gap-list">
                  {v.gaps.map(g => (
                    <li key={`${g.role}-${g.type}`}>
                      No {TYPE_PLURAL[g.type].toLowerCase()} {g.role === 'neutral' ? '' : `from ${ROLE_LABEL[g.role].toLowerCase()} `}yet
                    </li>
                  ))}
                </ul>
              </section>
            </>
          )}
        </>
      )}
    </div>
  );
}
