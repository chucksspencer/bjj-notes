// Position views: the list of positions, and one position with the techniques from and into it.
import type { GamePlanRef, PositionCategory, PositionListItem, PositionView, Role, TechniqueType, TechniqueView } from '../../shared/api.js';
import { uid, type Queryable } from '../../db.js';
import { EXPECTED_BY_CATEGORY } from '../vocab.js';
import { GAME_PLAN_ORDER } from './sql.js';
import { toEdge, type EdgeRow } from './techniques.js';

export async function positionList(q: Queryable): Promise<PositionListItem[]> {
  const { rows } = await q.query<{
    id: number;
    slug: string;
    name: string;
    category: PositionCategory;
    aliases: string[];
    techniques: number;
  }>(
    `select p.id, p.slug, p.name, p.category, p.aliases,
            (select count(distinct e.technique_id)::int from technique_edges e
              where e.user_id = $1 and (e.from_position_id = p.id or e.to_position_id = p.id)) as techniques
     from positions p order by p.id`,
    [uid(q)],
  );
  return rows.map(r => ({ id: r.id, slug: r.slug, name: r.name, category: r.category, aliases: r.aliases, techniqueCount: r.techniques }));
}

export async function positionView(q: Queryable, positionId: number, role?: Role | null): Promise<PositionView | null> {
  const pos = (
    await q.query<{ id: number; slug: string; name: string; category: PositionCategory; aliases: string[]; description: string | null }>(
      'select id, slug, name, category, aliases, description from positions where id = $1',
      [positionId],
    )
  ).rows[0];
  if (!pos) return null;
  type Row = EdgeRow & { t_id: number; t_name: string; t_type: TechniqueType; t_role: Role | null; t_status: TechniqueView['status'] };
  const sel = `select e.id, e.from_role, e.to_role,
                      pf.id as pf_id, pf.slug as pf_slug, pf.name as pf_name,
                      pt.id as pt_id, pt.slug as pt_slug, pt.name as pt_name,
                      t.id as t_id, t.name as t_name, t.type as t_type, t.role as t_role, t.status as t_status
               from technique_edges e join techniques t on t.id = e.technique_id and t.user_id = e.user_id
               left join positions pf on pf.id = e.from_position_id
               left join positions pt on pt.id = e.to_position_id`;
  const toPT = (r: Row) => ({ id: r.t_id, name: r.t_name, type: r.t_type, role: r.t_role, status: r.t_status, edge: toEdge(r) });
  const from = (
    await q.query<Row>(
      `${sel} where e.user_id = $3 and e.from_position_id = $1 and ($2::text is null or e.from_role is null or e.from_role = $2)
       order by t.type, t.name`,
      [pos.id, role ?? null, uid(q)],
    )
  ).rows.map(toPT);
  const into = (
    await q.query<Row>(
      `${sel} where e.user_id = $3 and e.to_position_id = $1 and ($2::text is null or e.to_role is null or e.to_role = $2)
       order by t.name`,
      [pos.id, role ?? null, uid(q)],
    )
  ).rows.map(toPT);

  const expected = EXPECTED_BY_CATEGORY[pos.category] ?? {};
  const roles: Role[] = role ? [role] : (Object.keys(expected) as Role[]);
  const gaps: PositionView['gaps'] = [];
  for (const rl of roles) {
    for (const type of expected[rl] ?? []) {
      if (!from.some(t => t.type === type && (t.edge.fromRole === rl || t.edge.fromRole === null))) gaps.push({ role: rl, type });
    }
  }
  const gamePlans = (
    await q.query<GamePlanRef>(
      `select a.id, a.name, a.rank from game_plans a
       where a.user_id = $3 and a.start_position_id = $1 and ($2::text is null or a.start_role is null or a.start_role = $2)
       order by ${GAME_PLAN_ORDER}`,
      [pos.id, role ?? null, uid(q)],
    )
  ).rows;
  return { position: pos, role: role ?? null, from, into, gaps, gamePlans };
}
