import { Link, useParams, useSearchParams } from 'react-router';
import type { PositionTechnique, Role } from '../../../src/shared/api';
import { usePosition, usePositions } from '../api';
import { RankBar } from '../components/Belt';
import { Icon } from '../components/Icon';
import { CATEGORY_LABEL, CATEGORY_ORDER, ROLE_LABEL, TYPE_LABEL, TYPE_PLURAL } from '../lib/format';

export function Positions() {
  const positions = usePositions();
  return (
    <div className="page">
      <header className="page-head">
        <h1 className="display page-title">Positions</h1>
      </header>
      {positions.isError && <div className="panel empty">Couldn't load positions. {positions.error.message}</div>}
      {positions.data &&
        CATEGORY_ORDER.map(cat => {
          const list = positions.data.filter(p => p.category === cat);
          if (!list.length) return null;
          return (
            <section key={cat}>
              <h2 className="section-title">{CATEGORY_LABEL[cat]}</h2>
              <div className="panel">
                {list.map(p => (
                  <Link key={p.id} className="row row-split" to={`/p/${p.slug}`}>
                    <span className={`grow row-title${p.techniqueCount ? '' : ' dim'}`}>{p.name}</span>
                    <span className="count" aria-label={`${p.techniqueCount} techniques`}>
                      {p.techniqueCount || ''}
                    </span>
                  </Link>
                ))}
              </div>
            </section>
          );
        })}
    </div>
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
      <Link className="btn ghost back" to="/positions">
        <Icon name="back" size={20} />
        Positions
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
