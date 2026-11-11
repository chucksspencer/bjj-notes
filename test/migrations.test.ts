// Migrations that change what's already in a notebook, checked against data from before them.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate, pgliteDb, type Db } from '../src/db.js';

let db: Db;

beforeAll(async () => {
  db = await pgliteDb();
});
afterAll(async () => {
  await db.close();
});

/** Brings a fresh database up to just before `name`, so data can be put in place for that migration. */
async function migrateUpTo(name: string) {
  await db.exec('create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())');
  await db.query('insert into schema_migrations (name) values ($1)', [name]);
  await migrate(db);
  await db.query('delete from schema_migrations where name = $1', [name]);
}

describe('015: focus item descriptions', () => {
  it('folds goals into the new description and leaves the goal column alone', async () => {
    await migrateUpTo('015_focus_details.sql');
    // The owner's starter focus list (from 003) has no goals: give two items one, one of them blank.
    const items = (await db.query<{ id: number; label: string }>('select id, label from focus_items order by rank')).rows;
    expect(items.length).toBeGreaterThan(2);
    await db.query("update focus_items set goal = '  Hit it twice in live rounds ' where id = $1", [items[0]!.id]);
    await db.query("update focus_items set goal = '   ' where id = $1", [items[1]!.id]);

    expect(await migrate(db)).toEqual(['015_focus_details.sql']);
    const after = (await db.query<{ id: number; goal: string | null; description: string | null }>('select id, goal, description from focus_items order by rank'))
      .rows;
    expect(after[0]).toEqual({ id: items[0]!.id, goal: '  Hit it twice in live rounds ', description: 'Goal: Hit it twice in live rounds' });
    expect(after[1]!.description).toBeNull();
    expect(after.slice(2).every(r => r.description === null && r.goal === null)).toBe(true);
    expect((await db.query<{ c: number }>('select count(*)::int as c from focus_item_notes')).rows[0]!.c).toBe(0);
  });
});
