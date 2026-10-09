import type { Queryable } from '../db.js';
import { describeMiss, resolvePosition, resolveTechnique } from '../resolve.js';
import { logActivity, type TechniqueSnapshot } from './activity.js';
import type { Ctx } from './context.js';
import { isoDate, type Role, type TechniqueType } from './vocab.js';

export interface EdgeInput {
  from?: string;
  from_role?: Role;
  to?: string;
  to_role?: Role;
}

export interface LinkInput {
  kind: 'chain' | 'counter' | 'variation' | 'setup' | 'related';
  technique: string;
  note?: string;
}

export interface SaveTechniqueInput {
  name: string;
  rename_to?: string;
  type?: TechniqueType;
  role?: Role;
  gi?: 'gi' | 'nogi' | 'both';
  status?: 'seen' | 'learning' | 'drilling' | 'hitting' | 'reliable';
  summary?: string;
  aliases?: string[];
  key_details?: string[];
  mistakes?: string[];
  /** Replace key_details/mistakes instead of appending to them. */
  replace_lists?: boolean;
  positions?: EdgeInput[];
  links?: LinkInput[];
}

const SNAPSHOT_COLS = 'id, name, aliases, type, role, gi, status, summary, key_details, mistakes';

async function snapshot(q: Queryable, id: number): Promise<TechniqueSnapshot> {
  const { rows } = await q.query<TechniqueSnapshot>(`select ${SNAPSHOT_COLS} from techniques where id = $1`, [id]);
  return rows[0]!;
}

/** Creates a bare technique card; returns its id. Used when a note or link mentions something new. */
export async function createStub(q: Queryable, name: string, type: TechniqueType = 'concept', role?: Role): Promise<number> {
  const { rows } = await q.query<{ id: number }>(
    'insert into techniques (name, type, role) values ($1, $2, $3) returning id',
    [name.trim(), type, role ?? null],
  );
  return rows[0]!.id;
}

function mergeList(existing: string[], incoming: string[] | undefined, replace: boolean): string[] {
  if (!incoming) return existing;
  const cleaned = incoming.map(s => s.trim()).filter(Boolean);
  if (replace) return cleaned;
  const seen = new Set(existing.map(s => s.toLowerCase()));
  return [...existing, ...cleaned.filter(s => !seen.has(s.toLowerCase()))];
}

export async function saveTechnique(ctx: Ctx, input: SaveTechniqueInput): Promise<string> {
  return ctx.db.tx(async q => {
    const found = await resolveTechnique(q, input.name);
    const notes: string[] = [];
    const createdTechniqueIds: number[] = [];
    let id: number;
    let before: TechniqueSnapshot | null = null;

    if (found.match) {
      id = found.match.id;
      before = await snapshot(q, id);
      if (!found.match.exact) notes.push(`matched "${input.name}" to ${found.match.name}`);
    } else {
      if (!input.type) {
        return `${describeMiss('technique', input.name, found)} To create a new card, call again with a type.`;
      }
      id = await createStub(q, input.name, input.type, input.role);
      if (found.candidates.length) notes.push(`similar existing: ${found.candidates.map(c => c.name).join(', ')}`);
    }

    const cur = await snapshot(q, id);
    const next = {
      name: input.rename_to?.trim() || cur.name,
      aliases: mergeList(cur.aliases, input.aliases, false),
      type: input.type ?? cur.type,
      role: input.role ?? cur.role,
      gi: input.gi ?? cur.gi,
      status: input.status ?? cur.status,
      summary: input.summary ?? cur.summary,
      key_details: mergeList(cur.key_details, input.key_details, !!input.replace_lists),
      mistakes: mergeList(cur.mistakes, input.mistakes, !!input.replace_lists),
    };
    if (input.rename_to && input.rename_to.trim().toLowerCase() !== cur.name.toLowerCase()) {
      next.aliases = mergeList(next.aliases, [cur.name], false); // keep the old name findable
    }
    await q.query(
      `update techniques set name = $2, aliases = $3, type = $4, role = $5, gi = $6, status = $7,
         summary = $8, key_details = $9, mistakes = $10, updated_at = now() where id = $1`,
      [id, next.name, next.aliases, next.type, next.role, next.gi, next.status, next.summary, next.key_details, next.mistakes],
    );

    const addedEdgeIds: number[] = [];
    for (const e of input.positions ?? []) {
      const from = e.from ? await resolvePosition(q, e.from) : null;
      const to = e.to ? await resolvePosition(q, e.to) : null;
      if (from && !from.match) {
        notes.push(describeMiss('position', e.from!, from));
        continue;
      }
      if (to && !to.match) {
        notes.push(describeMiss('position', e.to!, to));
        continue;
      }
      const { rows } = await q.query<{ id: number }>(
        `insert into technique_edges (technique_id, from_position_id, from_role, to_position_id, to_role)
         values ($1, $2, $3, $4, $5) on conflict do nothing returning id`,
        [id, from?.match?.id ?? null, e.from_role ?? next.role ?? null, to?.match?.id ?? null, e.to_role ?? null],
      );
      if (rows[0]) addedEdgeIds.push(rows[0].id);
    }

    const addedLinks: { from: number; to: number; kind: string }[] = [];
    for (const l of input.links ?? []) {
      const target = await resolveTechnique(q, l.technique);
      let targetId = target.match?.id;
      if (!targetId) {
        targetId = await createStub(q, l.technique);
        createdTechniqueIds.push(targetId);
        notes.push(`created a new card for ${l.technique}`);
      }
      if (targetId === id) continue;
      const { rows } = await q.query<{ from_id: number }>(
        `insert into technique_links (from_id, to_id, kind, note) values ($1, $2, $3, $4)
         on conflict do nothing returning from_id`,
        [id, targetId, l.kind, l.note ?? null],
      );
      if (rows[0]) addedLinks.push({ from: id, to: targetId, kind: l.kind });
    }

    const verb = before ? 'Updated' : 'Created';
    const summary = `${verb} ${next.name}`;
    await logActivity(
      q,
      before ? 'update_technique' : 'create_technique',
      summary,
      before
        ? { kind: 'restore_technique', before, addedEdgeIds, addedLinks, createdTechniqueIds }
        : { kind: 'delete_techniques', techniqueIds: [id, ...createdTechniqueIds] },
    );
    return notes.length ? `${summary} (${notes.join('; ')}).` : `${summary}.`;
  });
}

interface CardRow extends TechniqueSnapshot {
  updated_at: Date;
}

export async function getTechnique(ctx: Ctx, name: string, noteLimit = 5): Promise<string> {
  const q = ctx.db;
  const found = await resolveTechnique(q, name);
  if (!found.match) return describeMiss('technique', name, found);
  const t = (await q.query<CardRow>(`select ${SNAPSHOT_COLS}, updated_at from techniques where id = $1`, [found.match.id])).rows[0]!;

  const edges = (
    await q.query<{ from_name: string | null; from_role: string | null; to_name: string | null; to_role: string | null }>(
      `select pf.name as from_name, e.from_role, pt.name as to_name, e.to_role
       from technique_edges e
       left join positions pf on pf.id = e.from_position_id
       left join positions pt on pt.id = e.to_position_id
       where e.technique_id = $1 order by e.id`,
      [t.id],
    )
  ).rows;

  const links = (
    await q.query<{ kind: string; dir: 'out' | 'in'; name: string }>(
      `select l.kind, 'out' as dir, t2.name from technique_links l join techniques t2 on t2.id = l.to_id where l.from_id = $1
       union all
       select l.kind, 'in' as dir, t2.name from technique_links l join techniques t2 on t2.id = l.from_id where l.to_id = $1`,
      [t.id],
    )
  ).rows;

  const focus = (
    await q.query<{ label: string; status: string; rank: number | null }>(
      `select f.label, f.status, f.rank from focus_items f
       join focus_item_techniques ft on ft.focus_item_id = f.id
       where ft.technique_id = $1 and f.status <> 'dropped' order by f.rank nulls last`,
      [t.id],
    )
  ).rows;

  const notes = (
    await q.query<{ id: number; body: string; kind: string; observed_on: string; url: string | null; title: string | null; source_timestamp: string | null }>(
      `select n.id, n.body, n.kind, n.observed_on::text as observed_on, s.url, s.title, n.source_timestamp
       from notes n join note_techniques nt on nt.note_id = n.id
       left join sources s on s.id = n.source_id
       where nt.technique_id = $1 order by n.observed_on desc, n.id desc limit $2`,
      [t.id, noteLimit],
    )
  ).rows;
  const noteCount = (
    await q.query<{ c: number }>('select count(*)::int as c from note_techniques where technique_id = $1', [t.id])
  ).rows[0]!.c;

  const lines: string[] = [];
  const meta = [t.type, t.role, t.gi === 'both' ? null : t.gi].filter(Boolean).join(', ');
  lines.push(`${t.name} (${meta}). Status: ${t.status}.`);
  if (t.aliases.length) lines.push(`Also called: ${t.aliases.join(', ')}.`);
  for (const e of edges) {
    const from = e.from_name ? `${e.from_name}${e.from_role ? ` (${e.from_role})` : ''}` : null;
    const to = e.to_name ? `${e.to_name}${e.to_role ? ` (${e.to_role})` : ''}` : e.to_role ? `${e.to_role}` : null;
    lines.push(`Position: ${[from ?? '?', to].filter(Boolean).join(' → ')}`);
  }
  if (t.summary) lines.push(`Summary: ${t.summary}`);
  if (t.key_details.length) lines.push(`Key details:\n${t.key_details.map(d => `- ${d}`).join('\n')}`);
  if (t.mistakes.length) lines.push(`Common mistakes:\n${t.mistakes.map(d => `- ${d}`).join('\n')}`);
  if (links.length) {
    lines.push(
      `Related: ${links.map(l => (l.dir === 'out' ? `${l.kind} → ${l.name}` : `${l.name} → ${l.kind} → this`)).join('; ')}`,
    );
  }
  for (const f of focus) {
    lines.push(`Focus: ${f.status === 'active' ? `#${f.rank} on the active list` : f.status} ("${f.label}").`);
  }
  if (notes.length) {
    lines.push(`Notes (${notes.length} of ${noteCount}, newest first):`);
    for (const n of notes) {
      const src = n.url ? ` [${n.title ?? n.url}${n.source_timestamp ? ` @${n.source_timestamp}` : ''}]` : '';
      lines.push(`- ${isoDate(n.observed_on)} ${n.kind} #${n.id}: ${n.body}${src}`);
    }
  } else {
    lines.push('No notes yet.');
  }
  return lines.join('\n');
}
