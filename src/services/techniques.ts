import type { Queryable } from '../db.js';
import { describeMiss, resolvePosition, resolveTechnique } from '../resolve.js';
import { noteOrigin } from '../shared/sessions.js';
import { logActivity, type EdgeSnapshot, type LinkSnapshot, type TechniqueSnapshot, type UndoOp } from './activity.js';
import type { Ctx } from './context.js';
import type { Role, TechniqueType } from './vocab.js';
import { UserError } from './errors.js';
import { techniqueView } from './views.js';

export interface EdgeInput {
  from?: string;
  from_id?: number;
  from_role?: Role;
  to?: string;
  to_id?: number;
  to_role?: Role;
}

export interface LinkInput {
  kind: 'chain' | 'counter' | 'variation' | 'setup' | 'related';
  technique?: string;
  technique_id?: number;
  note?: string;
}

export interface SaveTechniqueInput {
  /** Matched fuzzily. Ignored when id is given. */
  name?: string;
  id?: number;
  rename_to?: string;
  type?: TechniqueType;
  /** null clears it */
  role?: Role | null;
  gi?: 'gi' | 'nogi' | 'both';
  status?: 'seen' | 'learning' | 'drilling' | 'hitting' | 'reliable';
  /** null clears it */
  summary?: string | null;
  aliases?: string[];
  key_details?: string[];
  mistakes?: string[];
  /** Replace key_details/mistakes instead of appending to them. */
  replace_lists?: boolean;
  /** Replace aliases instead of appending to them. */
  replace_aliases?: boolean;
  positions?: EdgeInput[];
  links?: LinkInput[];
}

export interface SaveResult {
  /** The saved technique, or null when nothing was saved. */
  id: number | null;
  message: string;
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
  return (await saveTechniqueResult(ctx, input)).message;
}

export async function saveTechniqueResult(ctx: Ctx, input: SaveTechniqueInput): Promise<SaveResult> {
  return ctx.db.tx(async q => {
    const notes: string[] = [];
    const createdTechniqueIds: number[] = [];
    let id: number;
    let before: TechniqueSnapshot | null = null;

    if (input.id !== undefined) {
      const exists = (await q.query<{ id: number }>('select id from techniques where id = $1', [input.id])).rows[0];
      if (!exists) return { id: null, message: `No technique #${input.id}.` };
      id = input.id;
      before = await snapshot(q, id);
    } else {
      const name = (input.name ?? '').trim();
      if (!name) return { id: null, message: 'A technique name is required.' };
      const found = await resolveTechnique(q, name);
      if (found.match) {
        id = found.match.id;
        before = await snapshot(q, id);
        if (!found.match.exact) notes.push(`matched "${name}" to ${found.match.name}`);
      } else {
        if (!input.type) {
          return { id: null, message: `${describeMiss('technique', name, found)} To create a new card, call again with a type.` };
        }
        id = await createStub(q, name, input.type, input.role ?? undefined);
        if (found.candidates.length) notes.push(`similar existing: ${found.candidates.map(c => c.name).join(', ')}`);
      }
    }

    const cur = await snapshot(q, id);
    const next = {
      name: input.rename_to?.trim() || cur.name,
      aliases: mergeList(cur.aliases, input.aliases, !!input.replace_aliases),
      type: input.type ?? cur.type,
      role: input.role !== undefined ? input.role : cur.role,
      gi: input.gi ?? cur.gi,
      status: input.status ?? cur.status,
      summary: input.summary !== undefined ? input.summary?.trim() || null : cur.summary,
      key_details: mergeList(cur.key_details, input.key_details, !!input.replace_lists),
      mistakes: mergeList(cur.mistakes, input.mistakes, !!input.replace_lists),
    };
    if (input.rename_to && input.rename_to.trim().toLowerCase() !== cur.name.toLowerCase()) {
      const clash = (
        await q.query<{ id: number }>('select id from techniques where lower(name) = lower($1) and id <> $2', [next.name, id])
      ).rows[0];
      if (clash) throw new UserError(`Another technique is already called ${next.name}.`);
      next.aliases = mergeList(next.aliases, [cur.name], false); // keep the old name findable
    }
    next.aliases = next.aliases.filter(a => a.toLowerCase() !== next.name.toLowerCase());
    await q.query(
      `update techniques set name = $2, aliases = $3, type = $4, role = $5, gi = $6, status = $7,
         summary = $8, key_details = $9, mistakes = $10, updated_at = now() where id = $1`,
      [id, next.name, next.aliases, next.type, next.role, next.gi, next.status, next.summary, next.key_details, next.mistakes],
    );

    const addedEdgeIds: number[] = [];
    for (const e of input.positions ?? []) {
      const from = e.from_id === undefined && e.from ? await resolvePosition(q, e.from) : null;
      const to = e.to_id === undefined && e.to ? await resolvePosition(q, e.to) : null;
      if (from && !from.match) {
        notes.push(describeMiss('position', e.from!, from));
        continue;
      }
      if (to && !to.match) {
        notes.push(describeMiss('position', e.to!, to));
        continue;
      }
      const fromId = e.from_id ?? from?.match?.id ?? null;
      const toId = e.to_id ?? to?.match?.id ?? null;
      const { rows } = await q.query<{ id: number }>(
        `insert into technique_edges (technique_id, from_position_id, from_role, to_position_id, to_role)
         values ($1, $2, $3, $4, $5) on conflict do nothing returning id`,
        [id, fromId, e.from_role ?? next.role ?? null, toId, e.to_role ?? null],
      );
      if (rows[0]) addedEdgeIds.push(rows[0].id);
    }

    const addedLinks: { from: number; to: number; kind: string }[] = [];
    for (const l of input.links ?? []) {
      let targetId = l.technique_id;
      if (targetId === undefined) {
        if (!l.technique?.trim()) continue;
        const target = await resolveTechnique(q, l.technique);
        targetId = target.match?.id;
        if (!targetId) {
          targetId = await createStub(q, l.technique);
          createdTechniqueIds.push(targetId);
          notes.push(`created a new card for ${l.technique}`);
        }
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
    return { id, message: notes.length ? `${summary} (${notes.join('; ')}).` : `${summary}.` };
  });
}

export async function getTechnique(ctx: Ctx, name: string, noteLimit = 5): Promise<string> {
  const found = await resolveTechnique(ctx.db, name);
  if (!found.match) return describeMiss('technique', name, found);
  const t = (await techniqueView(ctx.db, found.match.id, noteLimit))!;

  const lines: string[] = [];
  const meta = [t.type, t.role, t.gi === 'both' ? null : t.gi].filter(Boolean).join(', ');
  lines.push(`${t.name} (${meta}). Status: ${t.status}.`);
  if (t.aliases.length) lines.push(`Also called: ${t.aliases.join(', ')}.`);
  for (const e of t.edges) {
    const from = e.from ? `${e.from.name}${e.fromRole ? ` (${e.fromRole})` : ''}` : null;
    const to = e.to ? `${e.to.name}${e.toRole ? ` (${e.toRole})` : ''}` : e.toRole ? `${e.toRole}` : null;
    lines.push(`Position: ${[from ?? '?', to].filter(Boolean).join(' → ')}`);
  }
  if (t.summary) lines.push(`Summary: ${t.summary}`);
  if (t.keyDetails.length) lines.push(`Key details:\n${t.keyDetails.map(d => `- ${d}`).join('\n')}`);
  if (t.mistakes.length) lines.push(`Common mistakes:\n${t.mistakes.map(d => `- ${d}`).join('\n')}`);
  if (t.links.length) {
    lines.push(
      `Related: ${t.links
        .map(l => (l.direction === 'out' ? `${l.kind} → ${l.technique.name}` : `${l.technique.name} → ${l.kind} → this`))
        .join('; ')}`,
    );
  }
  for (const f of t.focus) {
    lines.push(`Focus: ${f.status === 'active' ? `#${f.rank} on the active list` : f.status} ("${f.label}").`);
  }
  if (t.notes.length) {
    lines.push(`Notes (${t.notes.length} of ${t.noteCount}, newest first):`);
    for (const n of t.notes) {
      const named = [n.source?.title, n.source?.author].filter(Boolean).join(' by ');
      const src = n.source?.url
        ? ` [${n.source.title ?? n.source.url}${n.sourceTimestamp ? ` @${n.sourceTimestamp}` : ''}]`
        : named
          ? ` [from ${named}]`
          : '';
      const origin = noteOrigin(n);
      lines.push(`- ${n.observedOn} ${n.kind}${origin ? ` ${origin}` : ''} #${n.id}: ${n.body}${src}`);
    }
  } else if (t.noteCount) {
    // Asked for the card without its notes (note_limit 0).
    lines.push(`${t.noteCount} note${t.noteCount === 1 ? '' : 's'} (not shown).`);
  } else {
    lines.push('No notes yet.');
  }
  return lines.join('\n');
}

/** Removes one position edge from a technique. */
export async function removeEdge(ctx: Ctx, techniqueId: number, edgeId: number): Promise<string> {
  return ctx.db.tx(async q => {
    const edge = (
      await q.query<EdgeSnapshot>(
        'delete from technique_edges where id = $1 and technique_id = $2 returning id, technique_id, from_position_id, from_role, to_position_id, to_role',
        [edgeId, techniqueId],
      )
    ).rows[0];
    if (!edge) return 'That position link was already gone.';
    const name = (await q.query<{ name: string }>('select name from techniques where id = $1', [techniqueId])).rows[0]!.name;
    await logActivity(q, 'remove_edge', `removed a position from ${name}`, { kind: 'restore_edge', edge });
    return `Removed the position from ${name}.`;
  });
}

/** Removes a relationship between two techniques. */
export async function removeLink(ctx: Ctx, fromId: number, toId: number, kind: string): Promise<string> {
  return ctx.db.tx(async q => {
    const link = (
      await q.query<LinkSnapshot>(
        'delete from technique_links where from_id = $1 and to_id = $2 and kind = $3 returning from_id, to_id, kind, note',
        [fromId, toId, kind],
      )
    ).rows[0];
    if (!link) return 'That link was already gone.';
    await logActivity(q, 'remove_link', `removed a ${kind} link`, { kind: 'restore_link', link });
    return 'Removed the link.';
  });
}

/** Removes one card and returns how to put it back; null if it doesn't exist. Runs inside the caller's transaction. */
async function removeTechnique(q: Queryable, id: number): Promise<{ name: string; inboxed: number; undo: UndoOp } | null> {
  const row = (
    await q.query<TechniqueSnapshot & { created_at: string; updated_at: string }>(
      `select ${SNAPSHOT_COLS}, created_at::text as created_at, updated_at::text as updated_at from techniques where id = $1`,
      [id],
    )
  ).rows[0];
  if (!row) return null;
  const edges = (
    await q.query<EdgeSnapshot>(
      'select id, technique_id, from_position_id, from_role, to_position_id, to_role from technique_edges where technique_id = $1',
      [id],
    )
  ).rows;
  const links = (
    await q.query<LinkSnapshot>('select from_id, to_id, kind, note from technique_links where from_id = $1 or to_id = $1', [id])
  ).rows;
  const noteIds = (await q.query<{ note_id: number }>('select note_id from note_techniques where technique_id = $1', [id])).rows.map(
    r => r.note_id,
  );
  const focusItemIds = (
    await q.query<{ focus_item_id: number }>('select focus_item_id from focus_item_techniques where technique_id = $1', [id])
  ).rows.map(r => r.focus_item_id);
  const orphaned = (
    await q.query<{ id: number }>(
      `select n.id from notes n where n.id = any($1::int[]) and not n.inbox
         and not exists (select 1 from note_techniques x where x.note_id = n.id and x.technique_id <> $2)`,
      [noteIds, id],
    )
  ).rows.map(r => r.id);
  await q.query('delete from techniques where id = $1', [id]);
  if (orphaned.length) await q.query('update notes set inbox = true where id = any($1::int[])', [orphaned]);
  return {
    name: row.name,
    inboxed: orphaned.length,
    undo: { kind: 'restore_deleted_technique', row, edges, links, noteIds, focusItemIds, inboxedNoteIds: orphaned },
  };
}

const movedToInbox = (n: number) => (n ? `; ${n} note${n > 1 ? 's' : ''} moved to the inbox` : '');

/** Deletes a technique card. Its notes stay (and go to the inbox if they're left unlinked); undo restores everything. */
export async function deleteTechnique(ctx: Ctx, id: number): Promise<string> {
  return ctx.db.tx(async q => {
    const removed = await removeTechnique(q, id);
    if (!removed) return `No technique #${id}.`;
    await logActivity(q, 'delete_technique', `deleted ${removed.name}`, removed.undo);
    return `Deleted ${removed.name}${movedToInbox(removed.inboxed)}.`;
  });
}

/** Deletes several cards as one change: a single undo brings them all back. */
export async function deleteTechniques(ctx: Ctx, ids: number[]): Promise<string> {
  return ctx.db.tx(async q => {
    const removed = [];
    for (const id of new Set(ids)) {
      const r = await removeTechnique(q, id);
      if (r) removed.push(r);
    }
    if (!removed.length) return 'Nothing to delete.';
    if (removed.length === 1) {
      await logActivity(q, 'delete_technique', `deleted ${removed[0]!.name}`, removed[0]!.undo);
      return `Deleted ${removed[0]!.name}${movedToInbox(removed[0]!.inboxed)}.`;
    }
    const what = `${removed.length} techniques`;
    await logActivity(q, 'delete_techniques', `deleting ${what}`, { kind: 'batch', ops: removed.map(r => r.undo) });
    return `Deleted ${what}${movedToInbox(removed.reduce((n, r) => n + r.inboxed, 0))}.`;
  });
}
