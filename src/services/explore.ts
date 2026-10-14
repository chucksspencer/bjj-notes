import { describeMiss, resolvePosition } from '../resolve.js';
import { noteOrigin } from '../shared/sessions.js';
import { today, type Ctx } from './context.js';
import type { Status, TechniqueType } from '../shared/api.js';
import { noteList, positionView, techniqueList } from './views.js';
import { daysAgo, isoDate, type Role } from './vocab.js';

/** What you can do from a position (optionally as top or bottom), what leads into it, and the gaps. */
export async function getPosition(ctx: Ctx, name: string, role?: Role): Promise<string> {
  const r = await resolvePosition(ctx.db, name);
  if (!r.match) return describeMiss('position', name, r);
  const v = (await positionView(ctx.db, r.match.id, role))!;

  const where = `${v.position.name}${role ? ` (${role})` : ''}`;
  const lines: string[] = [`${where} — ${v.position.category}.`];
  if (v.from.length) {
    const byType = new Map<string, string[]>();
    for (const t of v.from) {
      const e = t.edge;
      const dest = e.to ? ` → ${e.to.name}${e.toRole ? ` (${e.toRole})` : ''}` : e.toRole ? ` → ${e.toRole}` : '';
      const label = `${t.name}${!role && e.fromRole ? ` [${e.fromRole}]` : ''}${dest} (${t.status})`;
      byType.set(t.type, [...(byType.get(t.type) ?? []), label]);
    }
    for (const [type, names] of byType) lines.push(`${type}: ${names.join('; ')}`);
  } else {
    lines.push('No techniques logged from here yet.');
  }
  if (v.into.length) {
    lines.push(`Ways in: ${v.into.map(t => `${t.name}${t.edge.from ? ` (from ${t.edge.from.name})` : ''}`).join('; ')}`);
  }
  if (v.gaps.length) lines.push(`Gaps: no ${v.gaps.map(g => `${g.role} ${g.type}`).join(', ')} logged.`);
  return lines.join('\n');
}

export interface SearchInput {
  query?: string;
  type?: TechniqueType;
  role?: Role;
  position?: string;
  status?: Status;
  limit?: number;
}

export async function search(ctx: Ctx, input: SearchInput): Promise<string> {
  const limit = Math.min(input.limit ?? 8, 25);
  const query = input.query?.trim() || undefined;
  let positionId: number | undefined;
  if (input.position) {
    const r = await resolvePosition(ctx.db, input.position);
    if (!r.match) return describeMiss('position', input.position, r);
    positionId = r.match.id;
  }
  const lines: string[] = [];
  const techniques = await techniqueList(ctx.db, { q: query, type: input.type, role: input.role, status: input.status, positionId, limit });
  if (techniques.length) {
    lines.push('Techniques:');
    for (const t of techniques) {
      lines.push(`- ${t.name} (${[t.type, t.role].filter(Boolean).join(', ')}; ${t.status}; ${t.noteCount} note${t.noteCount === 1 ? '' : 's'})`);
    }
  }
  if (query) {
    const notes = await noteList(ctx.db, { q: query, limit });
    if (notes.length) {
      lines.push('Notes:');
      for (const n of notes) {
        const origin = noteOrigin(n);
        lines.push(
          `- #${n.id} ${n.observedOn}${origin ? ` ${origin}` : ''}${n.toTry ? ' [to try]' : ''}${n.techniques.length ? ` [${n.techniques.map(t => t.name).join(', ')}]` : ''}: ${n.body}`,
        );
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

/** The date `days` before a YYYY-MM-DD date. */
function minusDays(date: string, days: number): string {
  return isoDate(new Date(Date.parse(`${date}T12:00:00Z`) - days * 86_400_000));
}

/**
 * Lab: the short-term working set, next to the long-term focus list. Starred notes, videos to try,
 * techniques new in the notes, and open questions for the coach.
 */
export async function getLab(ctx: Ctx, days = 30): Promise<string> {
  const q = ctx.db;
  const since = minusDays(today(ctx), days);
  const [starred, toTry, fresh, questions] = await Promise.all([
    noteList(q, { starred: true, limit: 25 }),
    noteList(q, { toTry: true, limit: 10 }),
    techniqueList(q, { sort: 'new', newSince: since, limit: 15 }),
    noteList(q, { kind: 'question', toTry: false, limit: 10 }),
  ]);
  const toTryTotal = (await q.query<{ c: number }>('select count(*)::int as c from notes where to_try')).rows[0]!.c;
  const about = (n: { techniques: { name: string }[] }) => (n.techniques.length ? ` [${n.techniques.map(t => t.name).join(', ')}]` : '');
  const section = (title: string, lines: string[], empty: string) => [title, ...(lines.length ? lines : [`- ${empty}`])];
  return [
    ...section(`Starred (${starred.length}):`, starred.map(n => `- #${n.id} ${n.observedOn}${about(n)}: ${n.body}`), 'nothing starred'),
    ...section(
      `To try (${toTryTotal}${toTryTotal > toTry.length ? `, newest ${toTry.length} shown` : ''}):`,
      toTry.map(n => `- #${n.id} ${n.observedOn}${about(n)}: ${n.body}${n.source?.url ? ` <${n.source.url}>` : ''}`),
      'nothing waiting to be tried',
    ),
    ...section(
      `New in your notes (last ${days} days):`,
      fresh.map(t => `- ${t.name} (${[t.type, t.role].filter(Boolean).join(', ')}; ${t.status}; first noted ${t.firstNoteOn})`),
      'no new techniques',
    ),
    ...section(`Ask coach (${questions.length}):`, questions.map(n => `- #${n.id} ${n.observedOn}${about(n)}: ${n.body}`), 'no open questions'),
  ].join('\n');
}
