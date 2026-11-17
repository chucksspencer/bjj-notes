// Migrations that change what's already in a notebook, checked against data from before them.
import { afterEach, describe, expect, it } from 'vitest';
import { forUser, migrate, type Db } from '../src/db.js';
import { undo } from '../src/services/activity.js';
import { freshDb } from './helpers.js';

let db: Db;
let drop: () => Promise<void>;

afterEach(async () => {
  await db.close();
  await drop();
});

/** A fresh database (PGlite, or Postgres with TEST_PG_ADMIN_URL), so each migration is checked on both. */
async function fresh() {
  ({ db, drop } = await freshDb());
}

/** A fresh database brought up to just before `name`, so data can be put in place for that migration. */
async function migrateUpTo(name: string) {
  await fresh();
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

describe('018: game plans', () => {
  const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows;

  it('renames areas to game plans and keeps everything in them', async () => {
    await migrateUpTo('018_game_plans.sql');
    const user = (await q<{ id: number }>('select id from users where is_owner'))[0]!.id;
    const area = (await q<{ id: number }>('select id from areas order by rank limit 1'))[0]!.id;
    const step = (
      await q<{ id: number }>("insert into area_steps (area_id, user_id, action) values ($1, $2, 'Shuck') returning id", [area, user])
    )[0]!.id;
    await db.query("insert into area_steps (area_id, user_id, parent_id, action, trigger) values ($1, $2, $3, 'Go to deep half', 'they post')", [area, user, step]);
    const note = (await q<{ id: number }>("insert into notes (body, user_id) values ('filed', $1) returning id", [user]))[0]!.id;
    await db.query('insert into area_notes (area_id, note_id, user_id) values ($1, $2, $3)', [area, note, user]);
    const before = {
      areas: await q('select id, name, rank from areas order by id'),
      steps: await q('select id, area_id, parent_id, action, trigger from area_steps order by id'),
      techniques: await q('select area_id, technique_id from area_techniques order by 1, 2'),
      notes: await q('select area_id, note_id from area_notes order by 1, 2'),
      events: await q('select id, area_id, event from focus_events order by id'),
    };

    expect(await migrate(db, { through: '018_game_plans.sql' })).toEqual(['018_game_plans.sql']);
    const rekey = (rows: Record<string, unknown>[]) => rows.map(({ area_id, ...r }) => ({ ...r, game_plan_id: area_id }));
    expect(await q('select id, name, rank from game_plans order by id')).toEqual(before.areas);
    expect(await q('select id, parent_id, action, trigger, game_plan_id from game_plan_steps order by id')).toEqual(rekey(before.steps));
    expect(await q('select technique_id, game_plan_id from game_plan_techniques order by game_plan_id, technique_id')).toEqual(rekey(before.techniques));
    expect(await q('select note_id, game_plan_id from game_plan_notes order by game_plan_id, note_id')).toEqual(rekey(before.notes));
    expect(await q('select id, event, game_plan_id from focus_events order by id')).toEqual(rekey(before.events));

    // New rows still get the next id from the renamed sequences.
    const maxPlan = Math.max(...before.areas.map(a => a.id as number));
    const fresh = (await q<{ id: number }>("insert into game_plans (name, user_id) values ('New', $1) returning id", [user]))[0]!.id;
    expect(fresh).toBeGreaterThan(maxPlan);
    const freshStep = (await q<{ id: number }>("insert into game_plan_steps (game_plan_id, user_id, action) values ($1, $2, 'A') returning id", [fresh, user]))[0]!
      .id;
    expect(freshStep).toBeGreaterThan(step);

    // And the constraints still hold: a step can't hang under another game plan's step; deleting cascades.
    await expect(
      db.query("insert into game_plan_steps (game_plan_id, user_id, parent_id, action) values ($1, $2, $3, 'B')", [fresh, user, step]),
    ).rejects.toThrow();
    await db.query('delete from game_plans where id = $1', [area]);
    expect(await q('select id from game_plan_steps where game_plan_id = $1', [area])).toEqual([]);
    expect(await q('select note_id from game_plan_notes where game_plan_id = $1', [area])).toEqual([]);
    expect(await q('select id from focus_events where game_plan_id = $1', [area])).toEqual([]);
  });

  it('leaves no names from areas or focus items in the schema', async () => {
    await fresh();
    await migrate(db);
    const old = '(^|_)(areas?|focus_items?)(_|$)';
    const names = [
      ...(await q<{ n: string }>(
        `select c.relname as n from pg_class c join pg_namespace s on s.oid = c.relnamespace where s.nspname = 'public' and c.relname ~ $1`,
        [old],
      )),
      ...(await q<{ n: string }>(
        `select c.conname as n from pg_constraint c join pg_namespace s on s.oid = c.connamespace where s.nspname = 'public' and c.conname ~ $1`,
        [old],
      )),
      ...(await q<{ n: string }>(
        `select table_name || '.' || column_name as n from information_schema.columns where table_schema = 'public' and column_name ~ $1`,
        [old],
      )),
    ].map(r => r.n);
    expect(names).toEqual([]);
  });
});

describe('019: cleanup', () => {
  const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows;
  const columns = async (table: string) =>
    (await q<{ column_name: string }>('select column_name from information_schema.columns where table_name = $1', [table])).map(c => c.column_name);

  it('drops what focus items and areas left behind, and keeps every notebook to itself', async () => {
    await migrateUpTo('019_cleanup.sql');
    const owner = (await q<{ id: number }>('select id from users where is_owner'))[0]!.id;
    const sam = (await q<{ id: number }>("insert into users (email, name) values ('sam@example.com', 'Sam') returning id"))[0]!.id;
    const plans = await q<{ id: number }>('select id from game_plans where user_id = $1 order by rank', [owner]);
    expect(plans.length).toBe(7);
    // An old goal (folded into the description by 015), and two game plans sharing a rank.
    await db.query("update game_plans set goal = 'Hit it live' where id = $1", [plans[0]!.id]);
    await db.query('update game_plans set rank = 2 where id = $1', [plans[2]!.id]);
    // Sam's list has gaps and a tie: 3, 3, 8.
    const samPlans: number[] = [];
    for (const [name, rank] of [['Sam A', 3], ['Sam B', 3], ['Sam C', 8], ['Sam off', null]] as const) {
      samPlans.push((await q<{ id: number }>('insert into game_plans (name, rank, user_id) values ($1, $2, $3) returning id', [name, rank, sam]))[0]!.id);
    }
    // One of each older focus event.
    const old = ['resumed', 'paused', 'completed', 'backlogged', 'dropped', 'moved', 'removed'];
    for (const event of old) {
      await db.query("insert into focus_events (game_plan_id, event, from_status, to_status) values ($1, $2, 'active', 'paused')", [plans[1]!.id, event]);
    }
    await db.query("insert into focus_events (game_plan_id, event) values ($1, 'added')", [samPlans[0]]);
    const samTech = (await q<{ id: number }>("insert into techniques (name, type, user_id) values ('Kimura', 'submission', $1) returning id", [sam]))[0]!.id;
    const pos = (await q<{ id: number }>("select id from positions where slug = 'half-guard'"))[0]!.id;
    await db.query("insert into technique_edges (technique_id, from_position_id, from_role) values ($1, $2, 'bottom')", [samTech, pos]);
    const ownerEdges = (await q<{ c: number }>('select count(*)::int as c from technique_edges e join techniques t on t.id = e.technique_id where t.user_id = $1', [owner]))[0]!.c;
    expect(ownerEdges).toBe(5);
    // An undo entry from before: deleting a game plan that had a goal and an older focus event.
    const deleted = {
      kind: 'restore_deleted_game_plan',
      row: { id: 9001, name: 'Old plan', aliases: [], description: null, start_position_id: null, start_role: null, premise: null, rank: 1,
             goal: 'An old goal', created_at: '2026-01-01 00:00:00+00', updated_at: '2026-01-01 00:00:00+00' },
      techniqueIds: [],
      noteIds: [],
      steps: [],
      events: [{ id: 9001, event: 'paused', from_status: 'active', to_status: 'paused', from_rank: 1, to_rank: null, at: '2026-01-02 00:00:00+00' }],
    };
    await db.query("insert into activity_log (action, summary, undo, user_id) values ('delete_game_plan', 'delete \"Old plan\"', $1, $2)", [JSON.stringify(deleted), owner]);

    expect(await migrate(db, { through: '019_cleanup.sql' })).toEqual(['019_cleanup.sql']);

    // Goals and the focus statuses are gone.
    expect(await columns('game_plans')).not.toContain('goal');
    expect(await columns('focus_events')).not.toContain('from_status');
    expect(await columns('focus_events')).not.toContain('to_status');
    // Older events read as what they meant, each with its owner.
    const events = await q<{ event: string; user_id: number }>('select event, user_id from focus_events where game_plan_id = $1 order by id', [plans[1]!.id]);
    expect(events.map(e => e.event)).toEqual(['added', 'added', 'removed', 'removed', 'removed', 'removed', 'moved', 'removed']);
    expect(events.every(e => e.user_id === owner)).toBe(true);
    expect(await q('select user_id from focus_events where game_plan_id = $1', [samPlans[0]])).toEqual([{ user_id: sam }]);
    await expect(db.query("insert into focus_events (game_plan_id, user_id, event) values ($1, $2, 'paused')", [plans[1]!.id, owner])).rejects.toThrow();
    // Edges know whose they are.
    expect((await q<{ c: number }>('select count(*)::int as c from technique_edges where user_id = $1', [owner]))[0]!.c).toBe(ownerEdges);
    expect(await q('select user_id from technique_edges where technique_id = $1', [samTech])).toEqual([{ user_id: sam }]);
    expect((await q<{ c: number }>('select count(*)::int as c from technique_edges e join techniques t on t.id = e.technique_id where e.user_id <> t.user_id'))[0]!.c).toBe(0);
    // Nothing can point at someone else's technique or game plan.
    const ownerTech = (await q<{ id: number }>("select id from techniques where user_id = $1 and name = 'Ghost escape'", [owner]))[0]!.id;
    await expect(db.query("insert into technique_edges (technique_id, user_id, from_position_id) values ($1, $2, $3)", [ownerTech, sam, pos])).rejects.toThrow();
    await expect(db.query("insert into focus_events (game_plan_id, user_id, event) values ($1, $2, 'added')", [plans[0]!.id, sam])).rejects.toThrow();
    // Deleting a technique still takes its edges with it.
    await db.query('delete from techniques where id = $1', [samTech]);
    expect(await q('select id from technique_edges where technique_id = $1', [samTech])).toEqual([]);

    // Each list runs 1, 2, 3... with ties kept in id order; game plans off focus stay off.
    const ranks = async (user: number) => (await q<{ id: number; rank: number | null }>('select id, rank from game_plans where user_id = $1 order by rank nulls last, id', [user]));
    expect((await ranks(owner)).map(r => r.rank)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect((await ranks(owner)).slice(1, 3).map(r => r.id)).toEqual([plans[1]!.id, plans[2]!.id]);
    expect(await ranks(sam)).toEqual([
      { id: samPlans[0], rank: 1 },
      { id: samPlans[1], rank: 2 },
      { id: samPlans[2], rank: 3 },
      { id: samPlans[3], rank: null },
    ]);
    // Two of a rank can't be committed, but a swap a row at a time inside one transaction can.
    await expect(db.tx(q => q.query('update game_plans set rank = 1 where id = $1', [samPlans[1]]))).rejects.toThrow(/game_plans_user_rank/);
    await expect(db.query('update game_plans set rank = 1 where id = $1', [samPlans[1]])).rejects.toThrow(/game_plans_user_rank/);
    await db.tx(async t => {
      await t.query('update game_plans set rank = 2 where id = $1', [samPlans[0]]);
      await t.query('update game_plans set rank = 1 where id = $1', [samPlans[1]]);
    });
    expect((await ranks(sam)).map(r => r.id)).toEqual([samPlans[1], samPlans[0], samPlans[2], samPlans[3]]);
    // Another person's list can have the same ranks.
    expect((await q<{ c: number }>('select count(*)::int as c from game_plans where rank = 1'))[0]!.c).toBe(2);

    // The single-user indexes are gone, and the per-person ones are there.
    const indexes = (await q<{ indexname: string }>("select indexname from pg_indexes where schemaname = 'public'")).map(r => r.indexname);
    for (const gone of ['notes_inbox', 'notes_observed_on', 'notes_open_questions', 'notes_starred', 'notes_to_try', 'sessions_date', 'sessions_date_kind', 'techniques_starred', 'focus_events_item']) {
      expect(indexes).not.toContain(gone);
    }
    expect(indexes).toEqual(
      expect.arrayContaining([
        'notes_user_inbox',
        'notes_user_to_try',
        'notes_user_starred',
        'notes_user_open_questions',
        'techniques_user_starred',
        'technique_edges_user',
        'focus_events_game_plan',
        'focus_events_user',
        'game_plans_user_rank',
      ]),
    );

    // The old undo entry still works: its goal and the older event's statuses are ignored.
    expect(await undo(forUser(db, owner))).toBe('Undid: delete "Old plan"');
    expect((await ranks(owner)).map(r => [r.id, r.rank])).toEqual([[9001, 1], ...plans.map((p, i) => [p.id, i + 2])]);
    expect(await q('select event, user_id from focus_events where id = 9001')).toEqual([{ event: 'removed', user_id: owner }]);
  });
});
