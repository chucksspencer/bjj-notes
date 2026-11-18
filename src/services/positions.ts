// Your own positions: adding, changing and deleting them, from the web app (by slug) and Claude (by name). The starter
// positions are shared by everyone and change only by migration; someone else's own positions are invisible.
import { uid, type Queryable } from '../db.js';
import { describeMiss, resolvePosition } from '../resolve.js';
import { logActivity, type PositionSnapshot } from './activity.js';
import type { Ctx } from './context.js';
import { NotFoundError, UserError } from './errors.js';
import type { PositionCategory } from './vocab.js';
import { visiblePosition } from './views/sql.js';
import { clean, plural } from './words.js';

export interface PositionFields {
  name?: string;
  category?: PositionCategory;
  /** Replace the aliases (or, with `appendAliases`, add to them). */
  aliases?: string[];
  /** null (or empty) clears it. */
  description?: string | null;
}

export interface SavedPosition {
  id: number;
  slug: string;
  message: string;
}

export const STARTERS_READ_ONLY = "Starter positions can't be changed.";
const STARTERS_KEPT = "Starter positions can't be deleted.";

const SNAPSHOT_COLS = 'id, slug, name, category, aliases, description';

/** Names compare as the name matching does (bjj_norm): case, spaces and punctuation don't count. */
const key = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/** A slug in the starter list's style: "De La Riva guard" -> "de-la-riva-guard". */
export function slugify(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .slice(0, 60)
    .replace(/^-+|-+$/g, '');
}

function cleanName(name: string | undefined): string {
  const n = (name ?? '').trim().replace(/\s+/g, ' ');
  if (!n) throw new UserError('A position needs a name.');
  if (!key(n)) throw new UserError("A position's name needs letters or numbers.");
  return n;
}

/** Aliases trimmed, without blanks, repeats, or the position's own name. */
function cleanAliases(aliases: string[], name: string): string[] {
  const seen = new Set([key(name)]);
  const out: string[] = [];
  for (const a of aliases.map(a => a.trim().replace(/\s+/g, ' '))) {
    if (!key(a) || seen.has(key(a))) continue;
    seen.add(key(a));
    out.push(a);
  }
  return out;
}

/** The person's position with this id, or the starter one; null when it's neither (someone else's, or not there). */
async function visibleRow(q: Queryable, id: number): Promise<(PositionSnapshot & { custom: boolean }) | null> {
  const row = (
    await q.query<PositionSnapshot & { user_id: number | null }>(`select ${SNAPSHOT_COLS}, user_id from positions p where p.id = $1 and ${visiblePosition('p', '$2')}`, [
      id,
      uid(q),
    ])
  ).rows[0];
  if (!row) return null;
  const { user_id, ...rest } = row;
  return { ...rest, custom: user_id !== null };
}

/** The id of the position with this slug among the ones the person can see (their own first). */
export async function positionIdBySlug(q: Queryable, slug: string): Promise<number | null> {
  const row = (
    await q.query<{ id: number }>(`select p.id from positions p where p.slug = $1 and ${visiblePosition('p', '$2')} order by p.user_id nulls last limit 1`, [
      slug,
      uid(q),
    ])
  ).rows[0];
  return row?.id ?? null;
}

/** Which of these position ids the person can use. */
export async function usablePositionIds(q: Queryable, ids: number[]): Promise<Set<number>> {
  if (!ids.length) return new Set();
  const { rows } = await q.query<{ id: number }>(`select p.id from positions p where p.id = any($1::int[]) and ${visiblePosition('p', '$2')}`, [ids, uid(q)]);
  return new Set(rows.map(r => r.id));
}

/** The names of the positions the person can see, for what Claude is told (Siri captures, Describe it, search by meaning). */
export async function positionNames(q: Queryable): Promise<string[]> {
  return (await q.query<{ name: string }>(`select p.name from positions p where ${visiblePosition('p', '$1')} order by p.name`, [uid(q)])).rows.map(r => r.name);
}

/** Throws the same "No position #N." for a position that isn't there and one that's someone else's. */
export async function assertUsablePosition(q: Queryable, id: number): Promise<void> {
  if (!(await usablePositionIds(q, [id])).has(id)) throw new UserError(`No position #${id}.`);
}

/**
 * Why these names can't be used: one already names a position the person can see (other than `self`), by its name,
 * slug or an alias. Null when they're all free.
 */
async function nameClash(q: Queryable, names: string[], self: number | null): Promise<string | null> {
  for (const n of names) {
    const row = (
      await q.query<{ name: string; how: 'name' | 'slug' | 'alias' }>(
        `select p.name,
                case when bjj_norm(p.name) = bjj_norm($1) then 'name' when bjj_norm(p.slug) = bjj_norm($1) then 'slug' else 'alias' end as how
         from positions p
         where ${visiblePosition('p', '$2')} and p.id <> $3
           and (bjj_norm(p.name) = bjj_norm($1) or bjj_norm(p.slug) = bjj_norm($1)
                or exists (select 1 from unnest(p.aliases) a where bjj_norm(a) = bjj_norm($1)))
         order by p.user_id nulls first, p.id
         limit 1`,
        [n, uid(q), self ?? 0],
      )
    ).rows[0];
    if (!row) continue;
    if (row.how === 'name') return `There's already a position called ${row.name}.`;
    return `${n} is already ${row.name}${row.how === 'alias' ? ' (as an alias)' : ''}.`;
  }
  return null;
}

/** Whether no other position the person can see has this slug. */
async function slugFree(q: Queryable, slug: string, self: number | null): Promise<boolean> {
  return !(await q.query(`select 1 from positions p where p.slug = $1 and ${visiblePosition('p', '$2')} and p.id <> $3`, [slug, uid(q), self ?? 0])).rows
    .length;
}

/** A slug for the name that no other position the person can see has: a number goes on the end if need be. */
async function freeSlug(q: Queryable, name: string, self: number | null): Promise<string> {
  const base = slugify(name) || 'position';
  for (let n = 1; ; n++) {
    const slug = n === 1 ? base : `${base}-${n}`;
    if (await slugFree(q, slug, self)) return slug;
  }
}

/** What in the person's notebook uses a position, as a refusal to show; null when nothing does. */
async function usedBy(q: Queryable, id: number): Promise<string | null> {
  const techniques = (
    await q.query<{ name: string }>(
      `select distinct t.name from technique_edges e join techniques t on t.id = e.technique_id and t.user_id = e.user_id
       where e.user_id = $2 and (e.from_position_id = $1 or e.to_position_id = $1) order by t.name`,
      [id, uid(q)],
    )
  ).rows.map(r => r.name);
  const gamePlans = (
    await q.query<{ name: string }>(
      `select a.name from game_plans a
       where a.user_id = $2
         and (a.start_position_id = $1
              or exists (select 1 from game_plan_steps st where st.game_plan_id = a.id and st.user_id = a.user_id and st.to_position_id = $1))
       order by lower(a.name)`,
      [id, uid(q)],
    )
  ).rows.map(r => r.name);
  if (!techniques.length && !gamePlans.length) return null;
  const counts = [techniques.length ? plural(techniques.length, 'technique') : null, gamePlans.length ? plural(gamePlans.length, 'game plan') : null];
  const names = [...techniques, ...gamePlans];
  const shown = names.length > 6 ? `${names.slice(0, 5).join(', ')} and ${names.length - 5} more` : names.join(', ');
  return `Used by ${counts.filter(Boolean).join(' and ')}: ${shown}. Change those first.`;
}

/** Adds a position of the person's own. Its names can't be ones a position they can see already goes by. */
export async function createPosition(ctx: Ctx, f: PositionFields & { name: string; category: PositionCategory }): Promise<SavedPosition> {
  return ctx.db.tx(async q => {
    const name = cleanName(f.name);
    const aliases = cleanAliases(f.aliases ?? [], name);
    const clash = await nameClash(q, [name, ...aliases], null);
    if (clash) throw new UserError(clash);
    const slug = await freeSlug(q, name, null);
    const id = (
      await q.query<{ id: number }>(
        'insert into positions (slug, name, category, aliases, description, user_id) values ($1, $2, $3, $4, $5, $6) returning id',
        [slug, name, f.category, aliases, clean(f.description), uid(q)],
      )
    ).rows[0]!.id;
    await logActivity(q, 'create_position', `new position "${name}"`, { kind: 'delete_position', positionId: id });
    return { id, slug, message: `Added ${name}.` };
  });
}

/** Loads a position to change: the person's own, or a refusal (a starter one), or not found (anyone else's). */
async function ownRow(q: Queryable, id: number, starter: string): Promise<PositionSnapshot> {
  const row = await visibleRow(q, id);
  if (!row) throw new NotFoundError('No such position.');
  if (!row.custom) throw new UserError(starter);
  const { custom: _, ...snapshot } = row;
  return snapshot;
}

/**
 * Changes one of the person's own positions. A new name keeps the old one as an alias, so it stays findable, and
 * gets a slug to match. Says so, and saves nothing, when nothing would change.
 */
export async function updatePosition(ctx: Ctx, id: number, f: PositionFields, opts: { appendAliases?: boolean } = {}): Promise<SavedPosition> {
  return ctx.db.tx(async q => {
    const before = await ownRow(q, id, STARTERS_READ_ONLY);
    const name = f.name !== undefined ? cleanName(f.name) : before.name;
    const renamed = key(name) !== key(before.name);
    let aliases = f.aliases === undefined ? before.aliases : opts.appendAliases ? [...before.aliases, ...f.aliases] : f.aliases;
    if (renamed) aliases = [...aliases, before.name];
    aliases = cleanAliases(aliases, name);
    const next: PositionSnapshot = {
      id,
      slug: renamed ? await freeSlug(q, name, id) : before.slug,
      name,
      category: f.category ?? before.category,
      aliases,
      description: f.description !== undefined ? clean(f.description) : before.description,
    };
    const same =
      next.name === before.name &&
      next.category === before.category &&
      next.description === before.description &&
      next.aliases.join('\n') === before.aliases.join('\n');
    if (same) return { id, slug: before.slug, message: `Nothing to change on ${before.name}.` };
    // Only names it didn't already have are checked: an old one that a newer starter position shares can stay.
    const had = new Set([before.name, ...before.aliases].map(key));
    const clash = await nameClash(q, [next.name, ...next.aliases].filter(n => !had.has(key(n))), id);
    if (clash) throw new UserError(clash);
    await q.query('update positions set slug = $2, name = $3, category = $4, aliases = $5, description = $6 where id = $1 and user_id = $7', [
      id,
      next.slug,
      next.name,
      next.category,
      next.aliases,
      next.description,
      uid(q),
    ]);
    await logActivity(q, 'update_position', `edit to position "${before.name}"`, { kind: 'restore_position', before });
    return { id, slug: next.slug, message: `Updated ${next.name}.` };
  });
}

/** Deletes one of the person's own positions, if nothing uses it. Undo puts it back. */
export async function deletePosition(ctx: Ctx, id: number): Promise<string> {
  return ctx.db.tx(async q => {
    const row = await ownRow(q, id, STARTERS_KEPT);
    const used = await usedBy(q, id);
    if (used) throw new UserError(used);
    await q.query('delete from positions where id = $1 and user_id = $2', [id, uid(q)]);
    await logActivity(q, 'delete_position', `deleted position "${row.name}"`, { kind: 'restore_deleted_position', row });
    return `Deleted ${row.name}.`;
  });
}

// ---------- undo ----------

/** Undoes adding a position: refused while something uses it (nothing should, as those changes come after it). */
export async function undoCreatePosition(q: Queryable, positionId: number): Promise<void> {
  const used = await usedBy(q, positionId);
  if (used) throw new UserError(used);
  await q.query('delete from positions where id = $1 and user_id = $2', [positionId, uid(q)]);
}

export async function restorePosition(q: Queryable, b: PositionSnapshot): Promise<void> {
  await q.query('update positions set slug = $2, name = $3, category = $4, aliases = $5, description = $6 where id = $1 and user_id = $7', [
    b.id,
    b.slug,
    b.name,
    b.category,
    b.aliases,
    b.description,
    uid(q),
  ]);
}

export async function restoreDeletedPosition(q: Queryable, r: PositionSnapshot): Promise<void> {
  const clash = await nameClash(q, [r.name], r.id);
  if (clash) throw new UserError(`${clash} Rename or delete that one first.`);
  await q.query('insert into positions (id, slug, name, category, aliases, description, user_id) values ($1, $2, $3, $4, $5, $6, $7)', [
    r.id,
    (await slugFree(q, r.slug, r.id)) ? r.slug : await freeSlug(q, r.name, r.id),
    r.name,
    r.category,
    r.aliases,
    r.description,
    uid(q),
  ]);
}

// ---------- by name, for Claude ----------

export interface SavePositionInput {
  /** The position to change, or the name of a new one. Matched fuzzily against the positions the person can see. */
  name: string;
  rename_to?: string;
  /** Needed to add a new one. */
  category?: PositionCategory;
  aliases?: string[];
  /** Replace the aliases instead of adding to them. */
  replace_aliases?: boolean;
  /** Replaces it; an empty string clears it. */
  description?: string;
}

/**
 * Claude's save_position: changes the person's own position that `name` names (exactly, or closely when no category is
 * given), or adds one with the category. A starter position named that way is refused; one that only looks like the
 * name doesn't stop a new position with a category, and is reported as similar.
 */
export async function savePosition(ctx: Ctx, input: SavePositionInput): Promise<string> {
  const name = input.name.trim();
  if (!name) return 'A position name is required.';
  const found = await resolvePosition(ctx.db, name);
  const match = found.match ? await visibleRow(ctx.db, found.match.id) : null;
  const fields: PositionFields = { name: input.rename_to, category: input.category, aliases: input.aliases, description: input.description };
  // The name says which one to change when it's exact, or when there's no category to make a new one with.
  if (match && (found.match!.exact || !input.category)) {
    if (!match.custom) return `${match.name} is a starter position, and ${STARTERS_READ_ONLY.charAt(0).toLowerCase()}${STARTERS_READ_ONLY.slice(1)}`;
    const r = await updatePosition(ctx, match.id, fields, { appendAliases: !input.replace_aliases });
    return found.match!.exact ? r.message : `${r.message.replace(/\.$/, '')} (matched "${name}" to ${match.name}).`;
  }
  if (!input.category) return `${describeMiss('position', name, found)} To add a new position, call again with a category.`;
  const r = await createPosition(ctx, { ...fields, name, category: input.category });
  // Only a close match is worth saying: most names share a word ("guard") with a few others.
  return found.match ? `${r.message.replace(/\.$/, '')} (similar existing: ${found.match.name}).` : r.message;
}

/** Claude's delete_position: deletes the person's own position that matches `name`, if nothing uses it. */
export async function deletePositionByName(ctx: Ctx, name: string): Promise<string> {
  const found = await resolvePosition(ctx.db, name);
  if (!found.match) return describeMiss('position', name, found);
  return deletePosition(ctx, found.match.id);
}
