import { describeMiss, resolvePosition } from '../resolve.js';
import { today, type Ctx } from './context.js';
import { daysAgo, EXPECTED_BY_CATEGORY, isoDate, type Role } from './vocab.js';

/** What you can do from a position (optionally as top or bottom), what leads into it, and the gaps. */
export async function getPosition(ctx: Ctx, name: string, role?: Role): Promise<string> {
  const q = ctx.db;
  const r = await resolvePosition(q, name);
  if (!r.match) return describeMiss('position', name, r);
  const pos = (await q.query<{ id: number; name: string; category: string; aliases: string[] }>(
    'select id, name, category, aliases from positions where id = $1',
    [r.match.id],
  )).rows[0]!;

  const out = (
    await q.query<{ name: string; type: string; from_role: string | null; to_name: string | null; to_role: string | null; status: string }>(
      `select t.name, t.type, e.from_role, pt.name as to_name, e.to_role, t.status
       from technique_edges e join techniques t on t.id = e.technique_id
       left join positions pt on pt.id = e.to_position_id
       where e.from_position_id = $1 and ($2::text is null or e.from_role is null or e.from_role = $2)
       order by t.type, t.name`,
      [pos.id, role ?? null],
    )
  ).rows;
  const into = (
    await q.query<{ name: string; type: string; from_name: string | null }>(
      `select t.name, t.type, pf.name as from_name
       from technique_edges e join techniques t on t.id = e.technique_id
       left join positions pf on pf.id = e.from_position_id
       where e.to_position_id = $1 and ($2::text is null or e.to_role is null or e.to_role = $2)
       order by t.name`,
      [pos.id, role ?? null],
    )
  ).rows;

  const where = `${pos.name}${role ? ` (${role})` : ''}`;
  const lines: string[] = [`${where} — ${pos.category}.`];
  if (out.length) {
    const byType = new Map<string, string[]>();
    for (const t of out) {
      const dest = t.to_name ? ` → ${t.to_name}${t.to_role ? ` (${t.to_role})` : ''}` : t.to_role ? ` → ${t.to_role}` : '';
      const label = `${t.name}${!role && t.from_role ? ` [${t.from_role}]` : ''}${dest} (${t.status})`;
      byType.set(t.type, [...(byType.get(t.type) ?? []), label]);
    }
    for (const [type, names] of byType) lines.push(`${type}: ${names.join('; ')}`);
  } else {
    lines.push('No techniques logged from here yet.');
  }
  if (into.length) lines.push(`Ways in: ${into.map(t => `${t.name}${t.from_name ? ` (from ${t.from_name})` : ''}`).join('; ')}`);

  const roles: Role[] = role ? [role] : (Object.keys(EXPECTED_BY_CATEGORY[pos.category] ?? {}) as Role[]);
  const gaps: string[] = [];
  for (const rl of roles) {
    for (const type of EXPECTED_BY_CATEGORY[pos.category]?.[rl] ?? []) {
      if (!out.some(t => t.type === type && (t.from_role === rl || t.from_role === null))) gaps.push(`${rl} ${type}`);
    }
  }
  if (gaps.length) lines.push(`Gaps: no ${gaps.join(', ')} logged.`);
  return lines.join('\n');
}

export interface SearchInput {
  query?: string;
  type?: string;
  role?: Role;
  position?: string;
  status?: string;
  limit?: number;
}

export async function search(ctx: Ctx, input: SearchInput): Promise<string> {
  const q = ctx.db;
  const limit = Math.min(input.limit ?? 8, 25);
  const query = input.query?.trim() || null;
  let positionId: number | null = null;
  const lines: string[] = [];

  if (input.position) {
    const r = await resolvePosition(q, input.position);
    if (!r.match) return describeMiss('position', input.position, r);
    positionId = r.match.id;
  }

  const techniques = (
    await q.query<{ name: string; type: string; role: string | null; status: string; score: number; notes: number }>(
      `select t.name, t.type, t.role, t.status,
              coalesce((select max(bjj_name_score(c, $1)) from unnest(array_prepend(t.name, t.aliases)) c), 0) as score,
              (select count(*)::int from note_techniques nt where nt.technique_id = t.id) as notes
       from techniques t
       where ($2::text is null or t.type = $2)
         and ($3::text is null or t.role = $3 or exists (
               select 1 from technique_edges e where e.technique_id = t.id and e.from_role = $3))
         and ($4::text is null or t.status = $4)
         and ($5::int is null or exists (
               select 1 from technique_edges e where e.technique_id = t.id
                 and (e.from_position_id = $5 or e.to_position_id = $5)))
         and ($1::text is null
              or (select max(bjj_name_score(c, $1)) from unnest(array_prepend(t.name, t.aliases)) c) >= 0.45
              or to_tsvector('english', coalesce(t.summary, '') || ' ' || array_to_string(t.key_details, ' ')
                                         || ' ' || array_to_string(t.mistakes, ' '))
                 @@ websearch_to_tsquery('english', $1))
       order by score desc, t.name
       limit $6`,
      [query, input.type ?? null, input.role ?? null, input.status ?? null, positionId, limit],
    )
  ).rows;
  if (techniques.length) {
    lines.push('Techniques:');
    for (const t of techniques) {
      lines.push(`- ${t.name} (${[t.type, t.role].filter(Boolean).join(', ')}; ${t.status}; ${t.notes} note${t.notes === 1 ? '' : 's'})`);
    }
  }

  if (query) {
    const notes = (
      await q.query<{ id: number; body: string; observed_on: string; techniques: string[] | null }>(
        `select n.id, n.body, n.observed_on::text as observed_on,
                array_remove(array_agg(t.name order by t.name), null) as techniques
         from notes n
         left join note_techniques nt on nt.note_id = n.id
         left join techniques t on t.id = nt.technique_id
         where n.search @@ websearch_to_tsquery('english', $1)
         group by n.id
         order by ts_rank(n.search, websearch_to_tsquery('english', $1)) desc, n.observed_on desc
         limit $2`,
        [query, limit],
      )
    ).rows;
    if (notes.length) {
      lines.push('Notes:');
      for (const n of notes) {
        lines.push(`- #${n.id} ${isoDate(n.observed_on)}${n.techniques?.length ? ` [${n.techniques.join(', ')}]` : ''}: ${n.body}`);
      }
    }
  }
  return lines.length ? lines.join('\n') : `Nothing found${query ? ` for "${query}"` : ''}.`;
}

/** Training summary over the last N days, plus focus items that have gone quiet. */
export async function review(ctx: Ctx, days = 7): Promise<string> {
  const q = ctx.db;
  const end = today(ctx);
  const start = isoDate(new Date(Date.parse(end) - (days - 1) * 86_400_000));
  const sessions = (
    await q.query<{ kind: string; c: number }>(
      'select kind, count(*)::int as c from sessions where date between $1 and $2 group by kind order by c desc',
      [start, end],
    )
  ).rows;
  const noteCount = (
    await q.query<{ c: number }>('select count(*)::int as c from notes where observed_on between $1 and $2', [start, end])
  ).rows[0]!.c;
  const top = (
    await q.query<{ name: string; c: number }>(
      `select t.name, count(*)::int as c from notes n
       join note_techniques nt on nt.note_id = n.id join techniques t on t.id = nt.technique_id
       where n.observed_on between $1 and $2 group by t.name order by c desc, t.name limit 5`,
      [start, end],
    )
  ).rows;
  const quiet = (
    await q.query<{ label: string; rank: number; last_note: string | null }>(
      `select f.label, f.rank,
              (select max(n.observed_on)::text from notes n
                 join note_techniques nt on nt.note_id = n.id
                 join focus_item_techniques ft on ft.technique_id = nt.technique_id
                where ft.focus_item_id = f.id) as last_note
       from focus_items f where f.status = 'active' order by f.rank`,
    )
  ).rows.filter(f => !f.last_note || Date.parse(end) - Date.parse(f.last_note) > 14 * 86_400_000);
  const inbox = (await q.query<{ c: number }>('select count(*)::int as c from notes where inbox')).rows[0]!.c;

  const sessionTotal = sessions.reduce((s, r) => s + r.c, 0);
  const lines = [
    `Last ${days} days (${start} to ${end}): ${sessionTotal} session${sessionTotal === 1 ? '' : 's'}${
      sessions.length ? ` (${sessions.map(s => `${s.c} ${s.kind.replace('_', ' ')}`).join(', ')})` : ''
    }, ${noteCount} note${noteCount === 1 ? '' : 's'}.`,
  ];
  if (top.length) lines.push(`Most noted: ${top.map(t => `${t.name} (${t.c})`).join(', ')}.`);
  if (quiet.length) {
    const now = new Date(`${end}T12:00:00Z`);
    lines.push(`Quiet focus items (nothing in 2+ weeks): ${quiet.map(f => `#${f.rank} ${f.label} — ${daysAgo(f.last_note, now)}`).join('; ')}.`);
  }
  if (inbox) lines.push(`${inbox} note${inbox === 1 ? '' : 's'} waiting in the inbox.`);
  return lines.join('\n');
}
