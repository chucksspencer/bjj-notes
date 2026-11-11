import { uid, type Queryable } from '../db.js';
import { describeMiss, resolveFocusItem, resolveTechnique, techniquesMentionedIn } from '../resolve.js';
import { logActivity, type FocusLinkIds, type FocusSnapshot, type UndoOp } from './activity.js';
import { mediaTag } from './attachments.js';
import { today, type Ctx } from './context.js';
import { focusItemView, focusView } from './views.js';
import { daysAgo, type FocusAction } from './vocab.js';

export async function getFocus(ctx: Ctx): Promise<string> {
  const view = await focusView(ctx);
  const now = new Date(`${view.today}T12:00:00Z`);
  const lines: string[] = [];
  if (view.active.length) {
    lines.push('Active focus:');
    for (const i of view.active) {
      lines.push(`${i.rank}. ${i.label} — ${daysAgo(i.lastNoteOn, now)}`);
    }
  } else {
    lines.push('Nothing on the active focus list.');
  }
  if (view.paused.length) lines.push(`Paused: ${view.paused.map(i => i.label).join('; ')}.`);
  if (view.backlog.length) lines.push(`Backlog: ${view.backlog.map(i => i.label).join('; ')}.`);
  return lines.join('\n');
}

export interface UpdateFocusInput {
  action: FocusAction;
  /** The item's label, or the name of a technique linked to it. For "add", the new label. */
  item: string;
  /** Exact focus item id (from the web app); skips name matching. */
  item_id?: number;
  /** Exact technique ids to link (from the web app). */
  technique_ids?: number[];
  /** 1 = top of the active list. Used by add, move and resume. */
  position?: number;
  /** Techniques to link to the item. On add, defaults to a technique matching the label. */
  techniques?: string[];
  /** On add: what the item is about. */
  description?: string;
  /** On add: exact note ids to link. */
  note_ids?: number[];
}

const EVENT_FOR: Record<Exclude<FocusAction, 'add' | 'move' | 'resume'>, { status: string; event: string; verb: string }> = {
  pause: { status: 'paused', event: 'paused', verb: 'Paused' },
  backlog: { status: 'backlog', event: 'backlogged', verb: 'Moved to the backlog' },
  complete: { status: 'done', event: 'completed', verb: 'Marked done' },
  drop: { status: 'dropped', event: 'dropped', verb: 'Dropped' },
};

export async function updateFocus(ctx: Ctx, input: UpdateFocusInput): Promise<string> {
  return ctx.db.tx(async q => {
    const snapshot = (
      await q.query<FocusSnapshot>(
        "select id, status, rank from focus_items where user_id = $1 and status in ('active', 'paused', 'backlog')",
        [uid(q)],
      )
    ).rows;
    const activeIds = (
      await q.query<{ id: number }>("select id from focus_items where user_id = $1 and status = 'active' order by rank nulls last, id", [uid(q)])
    ).rows.map(r => r.id);
    const eventIds: number[] = [];
    const addedLinks: { item: number; technique: number }[] = [];
    const extra: string[] = [];
    let deleteItemId: number | null = null;
    let itemId: number;
    let label: string;
    let verb: string;

    const event = async (id: number, ev: string, fromStatus: string | null, toStatus: string, fromRank: number | null, toRank: number | null) => {
      const { rows } = await q.query<{ id: number }>(
        `insert into focus_events (focus_item_id, event, from_status, to_status, from_rank, to_rank)
         values ($1, $2, $3, $4, $5, $6) returning id`,
        [id, ev, fromStatus, toStatus, fromRank, toRank],
      );
      eventIds.push(rows[0]!.id);
    };
    const clampPos = (p: number | undefined, len: number) => Math.min(Math.max(1, Math.round(p ?? 1)), len + 1);

    if (input.action === 'add') {
      label = input.item.trim();
      const pos = clampPos(input.position, activeIds.length);
      const { rows } = await q.query<{ id: number }>(
        "insert into focus_items (label, description, status, user_id) values ($1, $2, 'active', $3) returning id",
        [label, input.description?.trim() || null, uid(q)],
      );
      itemId = rows[0]!.id;
      deleteItemId = itemId;
      activeIds.splice(pos - 1, 0, itemId);
      verb = `Added to focus at #${pos}`;
      const toLink: { id: number; name: string }[] = [];
      if (input.technique_ids?.length) {
        toLink.push(
          ...(
            await q.query<{ id: number; name: string }>('select id, name from techniques where id = any($1::int[]) and user_id = $2', [
              input.technique_ids,
              uid(q),
            ])
          ).rows,
        );
      } else if (input.techniques?.length) {
        for (const n of input.techniques) {
          const r = await resolveTechnique(q, n);
          if (r.match) toLink.push(r.match);
          else extra.push(describeMiss('technique', n, r));
        }
      } else {
        // No techniques given: link the card the label names, or the cards it mentions.
        const r = await resolveTechnique(q, label);
        toLink.push(...(r.match ? [r.match] : await techniquesMentionedIn(q, label)));
      }
      for (const t of toLink) {
        const { rows: added } = await q.query<{ technique_id: number }>(
          'insert into focus_item_techniques (focus_item_id, technique_id, user_id) values ($1, $2, $3) on conflict do nothing returning technique_id',
          [itemId, t.id, uid(q)],
        );
        if (added[0]) addedLinks.push({ item: itemId, technique: t.id });
      }
      if (toLink.length && !input.techniques?.length && !input.technique_ids?.length) {
        extra.push(`linked to ${toLink.map(t => t.name).join(', ')}`);
      }
      if (!addedLinks.length) extra.push('not linked to a technique card yet');
      // Linked notes go with the item if the add is undone.
      const notes = (await ownIds(q, 'notes', input.note_ids ?? [])).map(n => n.id);
      for (const n of notes) {
        await q.query('insert into focus_item_notes (focus_item_id, note_id, user_id) values ($1, $2, $3) on conflict do nothing', [itemId, n, uid(q)]);
      }
      if (notes.length) extra.push(`${notes.length} note${notes.length === 1 ? '' : 's'} linked`);
    } else {
      if (input.item_id !== undefined) {
        const row = (await q.query<{ label: string }>('select label from focus_items where id = $1 and user_id = $2', [input.item_id, uid(q)]))
          .rows[0];
        if (!row) return `No focus item #${input.item_id}.`;
        itemId = input.item_id;
        label = row.label;
      } else {
        const r = await resolveFocusItem(q, input.item);
        if (!r.match) return describeMiss('focus item', input.item, r);
        itemId = r.match.id;
        label = r.match.name;
      }
      const cur = snapshot.find(s => s.id === itemId);
      if (!cur) return `${label} is already ${input.action === 'complete' ? 'done' : 'off the list'}.`;

      if (input.action === 'move' || input.action === 'resume') {
        const without = activeIds.filter(id => id !== itemId);
        const pos = clampPos(input.position, without.length);
        without.splice(pos - 1, 0, itemId);
        activeIds.splice(0, activeIds.length, ...without);
        if (cur.status !== 'active') {
          await q.query("update focus_items set status = 'active', updated_at = now() where id = $1 and user_id = $2", [itemId, uid(q)]);
        }
        verb = cur.status === 'active' ? `Moved to #${pos}` : `Back on the active list at #${pos}`;
      } else {
        const spec = EVENT_FOR[input.action];
        await q.query('update focus_items set status = $2, rank = null, updated_at = now() where id = $1 and user_id = $3', [
          itemId,
          spec.status,
          uid(q),
        ]);
        const idx = activeIds.indexOf(itemId);
        if (idx >= 0) activeIds.splice(idx, 1);
        verb = spec.verb;
      }

      for (const n of input.techniques ?? []) {
        const t = await resolveTechnique(q, n);
        if (!t.match) {
          extra.push(describeMiss('technique', n, t));
          continue;
        }
        const { rows } = await q.query<{ focus_item_id: number }>(
          'insert into focus_item_techniques (focus_item_id, technique_id, user_id) values ($1, $2, $3) on conflict do nothing returning focus_item_id',
          [itemId, t.match.id, uid(q)],
        );
        if (rows[0]) addedLinks.push({ item: itemId, technique: t.match.id });
      }
    }

    // Re-number the active list and record what changed.
    for (const [i, id] of activeIds.entries()) {
      await q.query('update focus_items set rank = $2 where id = $1 and user_id = $3 and rank is distinct from $2', [id, i + 1, uid(q)]);
    }
    const prev = snapshot.find(s => s.id === itemId);
    const now = (
      await q.query<{ status: string; rank: number | null }>('select status, rank from focus_items where id = $1 and user_id = $2', [itemId, uid(q)])
    ).rows[0]!;
    const ev =
      input.action === 'add'
        ? 'added'
        : input.action === 'move'
          ? prev?.status === 'active'
            ? 'moved'
            : 'resumed'
          : input.action === 'resume'
            ? 'resumed'
            : EVENT_FOR[input.action].event;
    await event(itemId, ev, prev?.status ?? null, now.status, prev?.rank ?? null, now.rank);

    await logActivity(q, 'update_focus', `${input.action} "${label}"`, {
      kind: 'restore_focus',
      items: snapshot,
      deleteItemId,
      eventIds,
      addedLinks: deleteItemId ? [] : addedLinks,
    });
    return `${verb}: ${label}${extra.length ? ` (${extra.join('; ')})` : ''}.`;
  });
}

/** Focus history for one item or the whole list, oldest first. */
export async function focusHistory(ctx: Ctx, item?: string, limit = 30): Promise<string> {
  let where = 'where f.user_id = $2';
  const params: unknown[] = [limit, uid(ctx.db)];
  if (item) {
    const r = await resolveFocusItem(ctx.db, item, true);
    if (!r.match) return describeMiss('focus item', item, r);
    where += ' and e.focus_item_id = $3';
    params.push(r.match.id);
  }
  const rows = (
    await ctx.db.query<{ at: string; label: string; event: string; to_rank: number | null }>(
      `select * from (
         select e.at::date::text as at, f.label, e.event, e.to_rank, e.id
         from focus_events e join focus_items f on f.id = e.focus_item_id ${where}
         order by e.id desc limit $1) x
       order by id`,
      params,
    )
  ).rows;
  if (!rows.length) return 'No focus history yet.';
  return rows.map(r => `${r.at} ${r.event}${r.to_rank ? ` (#${r.to_rank})` : ''}: ${r.label}`).join('\n');
}

/** The given ids of the signed-in person's techniques or notes (anything else is left out). */
async function ownIds(q: Queryable, table: 'techniques' | 'notes', ids: number[]): Promise<{ id: number; name: string }[]> {
  if (!ids.length) return [];
  const name = table === 'techniques' ? 'name' : "'#' || id";
  return (
    await q.query<{ id: number; name: string }>(`select id, ${name} as name from ${table} where id = any($1::int[]) and user_id = $2 order by id`, [
      [...new Set(ids)],
      uid(q),
    ])
  ).rows;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** A change to a focus item's title or description; null if there's no such item. */
async function editIn(q: Queryable, id: number, input: { label?: string; description?: string | null }) {
  const row = (
    await q.query<{ label: string; description: string | null }>('select label, description from focus_items where id = $1 and user_id = $2', [
      id,
      uid(q),
    ])
  ).rows[0];
  if (!row) return null;
  const label = input.label?.trim() || row.label;
  const description = input.description !== undefined ? input.description?.trim() || null : row.description;
  const changed = label !== row.label || description !== row.description;
  if (changed) {
    await q.query('update focus_items set label = $2, description = $3, updated_at = now() where id = $1 and user_id = $4', [
      id,
      label,
      description,
      uid(q),
    ]);
  }
  const undo: UndoOp | null = changed ? { kind: 'restore_focus_label', itemId: id, label: row.label, description: row.description } : null;
  return { before: row.label, label, undo };
}

export interface FocusLinkChange {
  add?: { techniqueIds?: number[]; noteIds?: number[] };
  remove?: { techniqueIds?: number[]; noteIds?: number[] };
}

/** Adds and removes an item's links; returns what changed (as words) and how to take it back. */
async function linkIn(q: Queryable, id: number, change: FocusLinkChange) {
  const me = uid(q);
  const added: FocusLinkIds = { techniques: [], notes: [] };
  const removed: FocusLinkIds = { techniques: [], notes: [] };
  const linkedNames: string[] = [];
  const unlinkedNames: string[] = [];

  for (const t of await ownIds(q, 'techniques', change.add?.techniqueIds ?? [])) {
    const { rows } = await q.query(
      'insert into focus_item_techniques (focus_item_id, technique_id, user_id) values ($1, $2, $3) on conflict do nothing returning technique_id',
      [id, t.id, me],
    );
    if (rows[0]) {
      added.techniques.push(t.id);
      linkedNames.push(t.name);
    }
  }
  for (const n of await ownIds(q, 'notes', change.add?.noteIds ?? [])) {
    const { rows } = await q.query(
      'insert into focus_item_notes (focus_item_id, note_id, user_id) values ($1, $2, $3) on conflict do nothing returning note_id',
      [id, n.id, me],
    );
    if (rows[0]) added.notes.push(n.id);
  }
  if (change.remove?.techniqueIds?.length) {
    const { rows } = await q.query<{ technique_id: number; name: string }>(
      `delete from focus_item_techniques ft using techniques t
       where ft.focus_item_id = $1 and ft.technique_id = any($2::int[]) and ft.user_id = $3 and t.id = ft.technique_id
       returning ft.technique_id, t.name`,
      [id, change.remove.techniqueIds, me],
    );
    for (const r of rows) {
      removed.techniques.push(r.technique_id);
      unlinkedNames.push(r.name);
    }
  }
  if (change.remove?.noteIds?.length) {
    const { rows } = await q.query<{ note_id: number }>(
      'delete from focus_item_notes where focus_item_id = $1 and note_id = any($2::int[]) and user_id = $3 returning note_id',
      [id, change.remove.noteIds, me],
    );
    removed.notes.push(...rows.map(r => r.note_id));
  }

  const parts: string[] = [];
  if (linkedNames.length || added.notes.length) {
    parts.push(`linked ${[...linkedNames, ...(added.notes.length ? [plural(added.notes.length, 'note')] : [])].join(', ')}`);
  }
  if (unlinkedNames.length || removed.notes.length) {
    parts.push(`unlinked ${[...unlinkedNames, ...(removed.notes.length ? [plural(removed.notes.length, 'note')] : [])].join(', ')}`);
  }
  const any = added.techniques.length + added.notes.length + removed.techniques.length + removed.notes.length > 0;
  const undo: UndoOp | null = any ? { kind: 'restore_focus_links', itemId: id, added, removed } : null;
  return { parts, undo };
}

const capitalise = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);

/** Changes a focus item's title or description (from the web app). */
export async function editFocusItem(ctx: Ctx, id: number, input: { label?: string; description?: string | null }): Promise<string> {
  return ctx.db.tx(async q => {
    const r = await editIn(q, id, input);
    if (!r) return `No focus item #${id}.`;
    // Logged even when nothing changed, so the Undo the app offers never reaches back to an earlier change.
    await logActivity(q, 'edit_focus', `edit to "${r.before}"`, r.undo ?? { kind: 'restore_focus_label', itemId: id, label: r.label });
    return `Updated ${r.label}.`;
  });
}

/** Links techniques and notes to a focus item, or unlinks them (from the web app). */
export async function linkFocus(ctx: Ctx, id: number, change: FocusLinkChange): Promise<string> {
  return ctx.db.tx(async q => {
    const item = (await q.query<{ label: string }>('select label from focus_items where id = $1 and user_id = $2', [id, uid(q)])).rows[0];
    if (!item) return `No focus item #${id}.`;
    const r = await linkIn(q, id, change);
    if (!r.undo) return `Nothing changed on ${item.label}.`;
    await logActivity(q, 'link_focus', `links on "${item.label}"`, r.undo);
    return `${capitalise(r.parts.join('; '))} on ${item.label}.`;
  });
}

export interface EditFocusInput {
  /** The item's title, or the name of a technique linked to it. */
  item: string;
  title?: string;
  description?: string | null;
  link_techniques?: string[];
  unlink_techniques?: string[];
  link_notes?: number[];
  unlink_notes?: number[];
}

/** One change to a focus item by name (for Claude): title, description and links, undone together. */
export async function editFocus(ctx: Ctx, input: EditFocusInput): Promise<string> {
  return ctx.db.tx(async q => {
    const found = await resolveFocusItem(q, input.item);
    if (!found.match) return describeMiss('focus item', input.item, found);
    const id = found.match.id;
    const misses: string[] = [];
    const techniqueIds = async (names: string[] | undefined) => {
      const ids: number[] = [];
      for (const n of names ?? []) {
        const r = await resolveTechnique(q, n);
        if (r.match) ids.push(r.match.id);
        else misses.push(describeMiss('technique', n, r).replace(/\.$/, ''));
      }
      return ids;
    };
    const ops: UndoOp[] = [];
    const parts: string[] = [];
    const edit = await editIn(q, id, { label: input.title, description: input.description });
    if (edit?.undo) {
      ops.push(edit.undo);
      if (edit.label !== edit.before) parts.push(`renamed to ${edit.label}`);
      if (input.description !== undefined) parts.push(input.description?.trim() ? 'description updated' : 'description cleared');
    }
    const links = await linkIn(q, id, {
      add: { techniqueIds: await techniqueIds(input.link_techniques), noteIds: input.link_notes },
      remove: { techniqueIds: await techniqueIds(input.unlink_techniques), noteIds: input.unlink_notes },
    });
    if (links.undo) ops.push(links.undo);
    parts.push(...links.parts);
    if (ops.length) {
      await logActivity(q, 'edit_focus', `edit to "${found.match.name}"`, ops.length === 1 ? ops[0]! : { kind: 'batch', ops });
    }
    const label = edit?.label ?? found.match.name;
    const said = parts.length ? `${label}: ${parts.join('; ')}` : `Nothing changed on ${label}`;
    return `${said}${misses.length ? ` (${misses.join('; ')})` : ''}.`;
  });
}

/** One focus item as text, for Claude: title, where it is, description, techniques and notes. */
export async function getFocusItem(ctx: Ctx, item: string): Promise<string> {
  const r = await resolveFocusItem(ctx.db, item, true);
  if (!r.match) return describeMiss('focus item', item, r);
  const v = (await focusItemView(ctx.db, r.match.id))!;
  const now = new Date(`${today(ctx)}T12:00:00Z`);
  const where =
    v.status === 'active' ? `#${v.rank} on the active focus list` : v.status === 'done' ? 'done' : v.status === 'dropped' ? 'dropped' : v.status;
  const lines = [`${v.label} (${where}; ${daysAgo(v.lastNoteOn, now)}).`];
  if (v.description) lines.push(v.description);
  lines.push(v.techniques.length ? `Techniques: ${v.techniques.map(t => t.name).join(', ')}.` : 'No techniques linked.');
  if (v.notes.length) {
    lines.push(`Linked notes (${v.notes.length}):`);
    for (const n of v.notes.slice(0, 15)) {
      const body = n.body.length > 160 ? `${n.body.slice(0, 157)}...` : n.body;
      lines.push(`- #${n.id} ${n.observedOn}${mediaTag(n.attachments)}: ${body}`);
    }
    if (v.notes.length > 15) lines.push(`- and ${v.notes.length - 15} more`);
  } else {
    lines.push('No notes linked.');
  }
  if (v.relatedCount) lines.push(`${plural(v.relatedCount, 'other note')} on its techniques.`);
  return lines.join('\n');
}
