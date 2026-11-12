// Migrations that change what's already in a notebook, checked against data from before them.
import { afterEach, describe, expect, it } from 'vitest';
import { migrate, pgliteDb, type Db } from '../src/db.js';

let db: Db;

afterEach(async () => {
  await db.close();
});

/** A fresh database brought up to just before `name`, so data can be put in place for that migration. */
async function migrateUpTo(name: string) {
  db = await pgliteDb();
  await migrate(db, { before: name });
}

describe('015: focus item descriptions', () => {
  it('folds goals into the new description and leaves the goal column alone', async () => {
    await migrateUpTo('015_focus_details.sql');
    // The owner's starter focus list (from 003) has no goals: give two items one, one of them blank.
    const items = (await db.query<{ id: number; label: string }>('select id, label from focus_items order by rank')).rows;
    expect(items.length).toBeGreaterThan(2);
    await db.query("update focus_items set goal = '  Hit it twice in live rounds ' where id = $1", [items[0]!.id]);
    await db.query("update focus_items set goal = '   ' where id = $1", [items[1]!.id]);

    expect(await migrate(db, { through: '015_focus_details.sql' })).toEqual(['015_focus_details.sql']);
    const after = (await db.query<{ id: number; goal: string | null; description: string | null }>('select id, goal, description from focus_items order by rank'))
      .rows;
    expect(after[0]).toEqual({ id: items[0]!.id, goal: '  Hit it twice in live rounds ', description: 'Goal: Hit it twice in live rounds' });
    expect(after[1]!.description).toBeNull();
    expect(after.slice(2).every(r => r.description === null && r.goal === null)).toBe(true);
    expect((await db.query<{ c: number }>('select count(*)::int as c from focus_item_notes')).rows[0]!.c).toBe(0);
  });
});

describe('016: areas', () => {
  const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows;

  it('turns focus items into areas, ranked when they were active and off focus otherwise', async () => {
    await migrateUpTo('016_areas.sql');
    const user = (await q<{ id: number }>('select id from users where is_owner'))[0]!.id;
    const items = await q<{ id: number; label: string }>('select id, label from focus_items order by rank');
    expect(items.length).toBe(7);
    // One of each old state that came off the list, plus an active item that somehow had no rank.
    for (const [i, status] of ['paused', 'backlog', 'done', 'dropped'].entries()) {
      await db.query('update focus_items set status = $1, rank = null where id = $2', [status, items[i]!.id]);
    }
    await db.query('update focus_items set rank = null where id = $1', [items[4]!.id]);
    const note = (await q<{ id: number }>("insert into notes (body, user_id) values ('pinned', $1) returning id", [user]))[0]!.id;
    await db.query('insert into focus_item_notes (focus_item_id, note_id, user_id) values ($1, $2, $3)', [items[5]!.id, note, user]);
    const links = (await q<{ c: number }>('select count(*)::int as c from focus_item_techniques'))[0]!.c;
    const events = (await q<{ c: number }>('select count(*)::int as c from focus_events'))[0]!.c;

    expect(await migrate(db, { through: '016_areas.sql' })).toEqual(['016_areas.sql']);
    const areas = await q<{ id: number; name: string; rank: number | null }>('select id, name, rank from areas order by rank nulls last, id');
    // The two still active keep their order and close up to 1, 2; the unranked active one goes last.
    expect(areas.map(a => a.id)).toEqual([items[5]!.id, items[6]!.id, items[4]!.id, items[0]!.id, items[1]!.id, items[2]!.id, items[3]!.id]);
    expect(areas.map(a => a.rank)).toEqual([1, 2, 3, null, null, null, null]);
    expect(areas[0]!.name).toBe(items[5]!.label);
    // Nothing is lost: links, filed notes and history all carry over.
    expect((await q<{ c: number }>('select count(*)::int as c from area_techniques'))[0]!.c).toBe(links);
    expect(await q('select area_id, note_id from area_notes')).toEqual([{ area_id: items[5]!.id, note_id: note }]);
    expect((await q<{ c: number }>('select count(*)::int as c from focus_events'))[0]!.c).toBe(events);
    const cols = (await q<{ column_name: string }>("select column_name from information_schema.columns where table_name = 'areas'")).map(c => c.column_name);
    expect(cols).not.toContain('status');
    expect(cols).toEqual(expect.arrayContaining(['name', 'aliases', 'start_position_id', 'start_role', 'premise', 'goal']));
  });

  it('keeps plan steps inside their own area, and their words when a card goes', async () => {
    await migrateUpTo('016_areas.sql');
    await migrate(db, { through: '016_areas.sql' });
    const user = (await q<{ id: number }>('select id from users where is_owner'))[0]!.id;
    const [a, b] = (await q<{ id: number }>('select id from areas order by rank limit 2')).map(r => r.id);
    const tech = (await q<{ id: number }>("insert into techniques (name, type, user_id) values ('Shuck', 'transition', $1) returning id", [user]))[0]!.id;
    const step = async (area: number, parent: number | null, action: string, technique: number | null = null) =>
      (
        await q<{ id: number }>(
          'insert into area_steps (area_id, user_id, parent_id, action, technique_id) values ($1, $2, $3, $4, $5) returning id',
          [area, user, parent, action, technique],
        )
      )[0]!.id;
    const shuck = await step(a!, null, 'Shuck', tech);
    await step(a!, shuck, 'Go to deep half');
    await expect(step(b!, shuck, 'Not allowed')).rejects.toThrow();

    await db.query('delete from techniques where id = $1', [tech]);
    expect(await q('select action, technique_id from area_steps where id = $1', [shuck])).toEqual([{ action: 'Shuck', technique_id: null }]);
    await db.query('delete from areas where id = $1', [a]);
    expect((await q<{ c: number }>('select count(*)::int as c from area_steps'))[0]!.c).toBe(0);
  });
});
