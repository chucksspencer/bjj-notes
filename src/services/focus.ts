import type { Queryable } from '../db.js';
import { describeMiss, resolveFocusItem, resolveTechnique, techniquesMentionedIn } from '../resolve.js';
import { logActivity, type FocusSnapshot } from './activity.js';
import type { Ctx } from './context.js';
import { focusView } from './views.js';
import { daysAgo, type FocusAction } from './vocab.js';

export async function getFocus(ctx: Ctx): Promise<string> {
  const view = await focusView(ctx);
  const now = new Date(`${view.today}T12:00:00Z`);
  const lines: string[] = [];
  if (view.active.length) {
    lines.push('Active focus:');
    for (const i of view.active) {
      lines.push(`${i.rank}. ${i.label}${i.goal ? ` (goal: ${i.goal})` : ''} — ${daysAgo(i.lastNoteOn, now)}`);
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
  goal?: string;
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
        "select id, status, rank, goal from focus_items where status in ('active', 'paused', 'backlog')",
      )
    ).rows;
    const activeIds = (
      await q.query<{ id: number }>("select id from focus_items where status = 'active' order by rank nulls last, id")
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
        "insert into focus_items (label, goal, status) values ($1, $2, 'active') returning id",
        [label, input.goal ?? null],
      );
      itemId = rows[0]!.id;
      deleteItemId = itemId;
      activeIds.splice(pos - 1, 0, itemId);
      verb = `Added to focus at #${pos}`;
      const toLink: { id: number; name: string }[] = [];
      if (input.technique_ids?.length) {
        toLink.push(
          ...(await q.query<{ id: number; name: string }>('select id, name from techniques where id = any($1::int[])', [input.technique_ids]))
            .rows,
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
          'insert into focus_item_techniques values ($1, $2) on conflict do nothing returning technique_id',
          [itemId, t.id],
        );
        if (added[0]) addedLinks.push({ item: itemId, technique: t.id });
      }
      if (toLink.length && !input.techniques?.length && !input.technique_ids?.length) {
        extra.push(`linked to ${toLink.map(t => t.name).join(', ')}`);
      }
      if (!addedLinks.length) extra.push('not linked to a technique card yet');
    } else {
      if (input.item_id !== undefined) {
        const row = (await q.query<{ label: string }>('select label from focus_items where id = $1', [input.item_id])).rows[0];
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
          await q.query("update focus_items set status = 'active', updated_at = now() where id = $1", [itemId]);
        }
        verb = cur.status === 'active' ? `Moved to #${pos}` : `Back on the active list at #${pos}`;
      } else {
        const spec = EVENT_FOR[input.action];
        await q.query('update focus_items set status = $2, rank = null, updated_at = now() where id = $1', [itemId, spec.status]);
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
          'insert into focus_item_techniques values ($1, $2) on conflict do nothing returning focus_item_id',
          [itemId, t.match.id],
        );
        if (rows[0]) addedLinks.push({ item: itemId, technique: t.match.id });
      }
      if (input.goal !== undefined) await q.query('update focus_items set goal = $2 where id = $1', [itemId, input.goal]);
    }

    // Re-number the active list and record what changed.
    for (const [i, id] of activeIds.entries()) {
      await q.query('update focus_items set rank = $2 where id = $1 and rank is distinct from $2', [id, i + 1]);
    }
    const prev = snapshot.find(s => s.id === itemId);
    const now = (await q.query<{ status: string; rank: number | null }>('select status, rank from focus_items where id = $1', [itemId])).rows[0]!;
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
  let where = '';
  const params: unknown[] = [limit];
  if (item) {
    const r = await resolveFocusItem(ctx.db, item, true);
    if (!r.match) return describeMiss('focus item', item, r);
    where = 'where e.focus_item_id = $2';
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

/** Renames a focus item or changes its goal. */
export async function editFocusItem(ctx: Ctx, id: number, input: { label?: string; goal?: string | null }): Promise<string> {
  return ctx.db.tx(async q => {
    const row = (await q.query<{ label: string; goal: string | null }>('select label, goal from focus_items where id = $1', [id])).rows[0];
    if (!row) return `No focus item #${id}.`;
    const label = input.label?.trim() || row.label;
    const goal = input.goal !== undefined ? input.goal?.trim() || null : row.goal;
    await q.query('update focus_items set label = $2, goal = $3, updated_at = now() where id = $1', [id, label, goal]);
    await logActivity(q, 'edit_focus', `edit to "${row.label}"`, { kind: 'restore_focus_label', itemId: id, label: row.label, goal: row.goal });
    return `Updated ${label}.`;
  });
}
