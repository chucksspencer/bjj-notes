// Migrations that change what's already in a notebook, checked against data from before them.
import { afterEach, describe, expect, it } from 'vitest';
import { forUser, migrate, type Db } from '../src/db.js';
import { undo } from '../src/services/undo.js';
import { inboxWhere } from '../src/services/views/notes.js';
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

describe('020: steps as slots and options', () => {
  const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows;
  const columns = async (table: string) =>
    (await q<{ column_name: string }>('select column_name from information_schema.columns where table_name = $1', [table])).map(c => c.column_name);

  it('turns runs of alternatives into options of one slot, keeps ids, and enforces the shape', async () => {
    await migrateUpTo('020_step_options.sql');
    const owner = (await q<{ id: number }>('select id from users where is_owner'))[0]!.id;
    const plan = (await q<{ id: number }>("insert into game_plans (name, user_id) values ('Mixed', $1) returning id", [owner]))[0]!.id;
    const other = (await q<{ id: number }>("insert into game_plans (name, user_id) values ('Other', $1) returning id", [owner]))[0]!.id;
    // [id, game plan, parent, ordinal, alt, trigger, action]
    const rows: [number, number, number | null, number, boolean, string | null, string][] = [
      // The main line: a step with two alternatives, then two steps that share an ordinal (id decides).
      [110, plan, null, 1, false, null, 'A'],
      [111, plan, null, 2, true, null, 'A, plan B'],
      [112, plan, null, 3, true, null, 'A, plan C'],
      [113, plan, null, 4, false, null, 'B'],
      [114, plan, null, 4, false, null, 'C'],
      // Under B: an alternative with nothing before it (a slot of its own), a branch with a plan B after a gap, a then.
      [120, plan, 113, 1, true, null, 'Leading alternative'],
      [121, plan, 113, 2, false, 'they post', 'X'],
      [122, plan, 113, 5, true, null, 'X, plan B'],
      [123, plan, 113, 6, false, null, 'Y'],
      // Nested under an alternative, where plan B wrongly has a reaction of its own.
      [130, plan, 122, 1, false, 'they turn', 'Deep'],
      [131, plan, 122, 2, true, 'stray', 'Deep, plan B'],
      // Another game plan's steps are numbered on their own.
      [140, other, null, 3, false, null, 'Elsewhere'],
      [141, other, null, 7, true, null, 'Elsewhere, plan B'],
    ];
    for (const [id, gamePlan, , ordinal, alt, trigger, action] of rows) {
      await db.query('insert into game_plan_steps (id, game_plan_id, user_id, ordinal, alt, trigger, action) values ($1, $2, $3, $4, $5, $6, $7)', [
        id, gamePlan, owner, ordinal, alt, trigger, action,
      ]);
    }
    for (const [id, , parent] of rows) if (parent !== null) await db.query('update game_plan_steps set parent_id = $2 where id = $1', [id, parent]);
    // Undo entries from before: one that puts steps back (they say alt), and one that doesn't touch steps.
    const before = { id: plan, name: 'Mixed', aliases: [], description: null, start_position_id: null, start_role: null, premise: null };
    const oldSteps = [{ id: 110, parent_id: null, ordinal: 1, alt: false, trigger: null, action: 'A', technique_id: null, to_position_id: null, to_role: null, note: null }];
    const log = (summary: string, op: object) =>
      db.query("insert into activity_log (action, summary, undo, user_id) values ('edit_game_plan', $1, $2, $3)", [summary, JSON.stringify(op), owner]);
    await log('rename', { kind: 'restore_game_plan', before: { ...before, name: 'Was mixed' } });
    await log('old steps', { kind: 'batch', ops: [{ kind: 'restore_game_plan', before, steps: oldSteps }] });

    expect(await migrate(db, { through: '020_step_options.sql' })).toEqual(['020_step_options.sql']);

    expect(await columns('game_plan_steps')).toContain('option');
    expect(await columns('game_plan_steps')).not.toContain('alt');
    const after = await q<{ id: number; parent_id: number | null; ordinal: number; option: number; trigger: string | null; action: string }>(
      'select id, parent_id, ordinal, option, trigger, action from game_plan_steps order by id',
    );
    expect(after.map(r => [r.id, r.parent_id, r.ordinal, r.option, r.trigger])).toEqual([
      [110, null, 1, 0, null],
      [111, null, 1, 1, null],
      [112, null, 1, 2, null],
      [113, null, 2, 0, null],
      [114, null, 3, 0, null],
      [120, 113, 1, 0, null],
      [121, 113, 2, 0, 'they post'],
      [122, 113, 2, 1, null],
      [123, 113, 3, 0, null],
      [130, 122, 1, 0, 'they turn'],
      [131, 122, 1, 1, null],
      [140, null, 1, 0, null],
      [141, null, 1, 1, null],
    ]);
    expect(after.map(r => r.action)).toEqual(rows.map(r => r[6]));

    // One step per slot and option: on the main line (no parent) and under a step.
    const add = (parent: number | null, ordinal: number, option: number, trigger: string | null = null) =>
      db.query('insert into game_plan_steps (game_plan_id, user_id, parent_id, ordinal, option, trigger, action) values ($1, $2, $3, $4, $5, $6, $7)', [
        plan, owner, parent, ordinal, option, trigger, 'New',
      ]);
    await expect(add(null, 1, 1)).rejects.toThrow(/game_plan_steps_slot_option/);
    await expect(add(113, 2, 0)).rejects.toThrow(/game_plan_steps_slot_option/);
    await expect(db.tx(t => t.query('update game_plan_steps set option = 0 where id = 111'))).rejects.toThrow(/game_plan_steps_slot_option/);
    // It's checked at commit, so a swap a row at a time inside one transaction is fine.
    await db.tx(async t => {
      await t.query('update game_plan_steps set ordinal = 3 where id = 113');
      await t.query('update game_plan_steps set ordinal = 2 where id = 114');
    });
    expect(await q('select id from game_plan_steps where game_plan_id = $1 and parent_id is null and option = 0 order by ordinal', [plan])).toEqual([
      { id: 110 }, { id: 114 }, { id: 113 },
    ]);
    // Only plan A carries the slot's reaction; slots start at 1 and options at 0.
    await expect(add(113, 2, 2, 'they stall')).rejects.toThrow(/game_plan_steps_option_trigger_check/);
    await expect(db.query("update game_plan_steps set trigger = 'they stall' where id = 111")).rejects.toThrow(/game_plan_steps_option_trigger_check/);
    await expect(add(null, 0, 0)).rejects.toThrow(/game_plan_steps_ordinal_check/);
    await expect(add(null, 9, -1)).rejects.toThrow(/game_plan_steps_option_check/);
    await add(113, 2, 2);
    await add(null, 4, 0, 'they stall');
    // The same slot numbers in another game plan are its own.
    expect((await q<{ c: number }>('select count(*)::int as c from game_plan_steps where parent_id is null and ordinal = 1 and option = 0'))[0]!.c).toBe(2);

    // An undo entry whose steps are from before can't say where they'd go now: refused, and nothing changes.
    await expect(undo(forUser(db, owner))).rejects.toThrow('"old steps" was saved by an older version of the app and can\'t be undone.');
    expect((await q<{ c: number }>('select count(*)::int as c from game_plan_steps where game_plan_id = $1', [plan]))[0]!.c).toBe(13);
    // One that doesn't carry steps still works.
    await db.query("update activity_log set undone = true where summary = 'old steps'");
    expect(await undo(forUser(db, owner))).toBe('Undid: rename');
    expect(await q('select name from game_plans where id = $1', [plan])).toEqual([{ name: 'Was mixed' }]);
  });
});

describe('021: the owner as an ordinary account', () => {
  it('applies on top of everything before it, leaving the owner and their tokens alone', async () => {
    await migrateUpTo('021_owner_account.sql');
    const owner = (await db.query<{ id: number }>('select id from users where is_owner')).rows[0]!.id;
    await db.query("insert into api_tokens (user_id, token_hash, label) values ($1, 'h', 'Phone')", [owner]);
    expect(await migrate(db, { through: '021_owner_account.sql' })).toEqual(['021_owner_account.sql']);
    expect((await db.query('select password_hash, is_owner from users')).rows).toEqual([{ password_hash: null, is_owner: true }]);
    expect((await db.query('select label from api_tokens')).rows).toEqual([{ label: 'Phone' }]);
    await db.query("insert into app_state (key, value) values ('k', 'v')");
    await expect(db.query("insert into app_state (key, value) values ('k', 'w')")).rejects.toThrow();
    await db.query("insert into sign_in_failures (account) values ('a@example.com')");
    expect((await db.query<{ c: number }>("select count(*)::int as c from sign_in_failures where at > now() - interval '1 minute'")).rows[0]!.c).toBe(1);
  });
});

describe('022: derive the inbox and step cards', () => {
  const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows;
  const one = async (sql: string, params: unknown[] = []) => (await q<{ id: number }>(sql, params))[0]!.id;

  it('works the inbox out from what files a note, keeping only names that could not be placed', async () => {
    await migrateUpTo('022_derived.sql');
    const owner = await one('select id from users where is_owner');
    const tech = await one("insert into techniques (name, type, user_id) values ('Inbox card', 'sweep', $1) returning id", [owner]);
    const gp = await one("insert into game_plans (name, user_id) values ('Inbox plan', $1) returning id", [owner]);
    // [body, stored inbox flag, to_try, has a technique, filed under a game plan, in the inbox by the rule, unplaced after]
    const fixtures: [string, boolean, boolean, boolean, boolean, boolean, boolean][] = [
      ['nothing files it', true, false, false, false, true, false],
      ['stale: unfiled, flag off', false, false, false, false, true, false],
      ['filed, flag off', false, false, true, false, false, false],
      ['a name not placed', true, false, true, false, true, true],
      ['under a game plan, a name not placed', true, false, false, true, true, true],
      ['under a game plan', false, false, false, true, false, false],
      ['to try, stale flag on', true, true, false, false, false, false],
      ['to try', false, true, false, false, false, false],
    ];
    const ids: number[] = [];
    for (const [body, inbox, toTry, hasTech, hasPlan] of fixtures) {
      const id = await one('insert into notes (body, inbox, to_try, user_id) values ($1, $2, $3, $4) returning id', [body, inbox, toTry, owner]);
      if (hasTech) await db.query('insert into note_techniques (note_id, technique_id, user_id) values ($1, $2, $3)', [id, tech, owner]);
      if (hasPlan) await db.query('insert into game_plan_notes (game_plan_id, note_id, user_id) values ($1, $2, $3)', [gp, id, owner]);
      ids.push(id);
    }
    // An undo entry from before: an edit to the note with a name not placed, its snapshot saying `inbox`.
    const noteId = ids[3]!;
    const row = (await q(NOTE_SNAPSHOT_SQL_BEFORE_022, [noteId, owner]))[0]!;
    await db.query("insert into activity_log (action, summary, undo, user_id) values ('update_note', 'old edit', $1, $2)", [
      JSON.stringify({ kind: 'restore_note', row, techniqueIds: [tech] }),
      owner,
    ]);

    expect(await migrate(db, { through: '022_derived.sql' })).toEqual(['022_derived.sql']);
    const columns = (await q<{ column_name: string }>("select column_name from information_schema.columns where table_name = 'notes'")).map(c => c.column_name);
    expect(columns).not.toContain('inbox');
    expect(columns).toContain('unplaced');
    expect((await q("select indexname from pg_indexes where indexname = 'notes_user_inbox'")).length).toBe(0);

    // Whatever the stored flag said, the inbox is the rule.
    const derived = await q<{ id: number; inbox: boolean; unplaced: boolean }>(
      `select n.id, ${inboxWhere('n')} as inbox, n.unplaced from notes n where n.id = any($1::int[]) order by n.id`,
      [ids],
    );
    expect(derived.map(d => [d.inbox, d.unplaced])).toEqual(fixtures.map(f => [f[5], f[6]]));

    // The old entry still undoes: a note filed with a name not placed comes back still waiting on it.
    await db.query('update notes set unplaced = false where id = $1', [noteId]);
    await db.query('delete from note_techniques where note_id = $1', [noteId]);
    expect(await undo(forUser(db, owner))).toBe('Undid: old edit');
    expect(await q(`select n.unplaced, ${inboxWhere('n')} as inbox from notes n where n.id = $1`, [noteId])).toEqual([{ unplaced: true, inbox: true }]);
  });

  it("keeps only the links someone made, reads a game plan's cards through the view, and undoes older entries", async () => {
    await migrateUpTo('022_derived.sql');
    const owner = await one('select id from users where is_owner');
    const sam = await one("insert into users (email, name) values ('sam@example.com', 'Sam') returning id");
    const card = (name: string, user: number) => one("insert into techniques (name, type, user_id) values ($1, 'sweep', $2) returning id", [name, user]);
    const [stepCard, linkCard, elsewhere] = [await card('Step card', owner), await card('Link card', owner), await card('Elsewhere card', owner)];
    const samCard = await card('Step card', sam);
    const plan = await one("insert into game_plans (name, user_id) values ('Cards', $1) returning id", [owner]);
    const other = await one("insert into game_plans (name, user_id) values ('Other', $1) returning id", [owner]);
    const samPlan = await one("insert into game_plans (name, user_id) values ('Sam cards', $1) returning id", [sam]);
    const step = (gamePlan: number, user: number, ordinal: number, action: string, technique: number | null) =>
      one('insert into game_plan_steps (game_plan_id, user_id, ordinal, action, technique_id) values ($1, $2, $3, $4, $5) returning id', [
        gamePlan,
        user,
        ordinal,
        action,
        technique,
      ]);
    const stepId = await step(plan, owner, 1, 'Step', stepCard);
    await step(other, owner, 1, 'Elsewhere', elsewhere);
    await step(samPlan, sam, 1, 'Sam step', samCard);
    const link = (gamePlan: number, technique: number, user: number) =>
      db.query('insert into game_plan_techniques (game_plan_id, technique_id, user_id) values ($1, $2, $3)', [gamePlan, technique, user]);
    // Saved by step writes (stepCard), linked by hand (linkCard, and elsewhere: a card another plan's step uses), and Sam's.
    await link(plan, stepCard, owner);
    await link(plan, linkCard, owner);
    await link(plan, elsewhere, owner);
    await link(samPlan, samCard, sam);

    // Undo entries from before: adding a step that linked its card (batched), and deleting a game plan whose
    // techniques included its steps' card.
    const log = (summary: string, op: object) =>
      db.query("insert into activity_log (action, summary, undo, user_id) values ('x', $1, $2, $3)", [summary, JSON.stringify(op), owner]);
    const before = { id: plan, name: 'Cards', aliases: [], description: null, start_position_id: null, start_role: null, premise: null };
    const gone = { ...before, id: 7001, name: 'Gone', rank: null, created_at: '2026-01-01 00:00:00+00', updated_at: '2026-01-01 00:00:00+00' };
    const goneStep = { id: 7101, parent_id: null, ordinal: 1, option: 0, trigger: null, action: 'Gone step', technique_id: stepCard, to_position_id: null, to_role: null, note: null };
    await log('old delete', { kind: 'restore_deleted_game_plan', row: gone, techniqueIds: [stepCard, linkCard], noteIds: [], steps: [goneStep], events: [] });
    await log('old add step', {
      kind: 'batch',
      ops: [
        { kind: 'restore_game_plan', before, steps: [] },
        { kind: 'restore_game_plan_links', gamePlanId: plan, added: { techniques: [stepCard], notes: [] }, removed: { techniques: [], notes: [] } },
      ],
    });

    expect(await migrate(db, { through: '022_derived.sql' })).toEqual(['022_derived.sql']);
    const links = async () =>
      (
        await q<{ g: number; t: number }>(
          'select game_plan_id as g, technique_id as t from game_plan_techniques where game_plan_id = any($1::int[]) order by game_plan_id, technique_id',
          [[plan, other, samPlan]],
        )
      ).map(r => [r.g, r.t]);
    // Rows a step of the same game plan accounts for are gone (Sam's too); the rest stay.
    expect(await links()).toEqual([[plan, linkCard], [plan, elsewhere]]);
    const cards = async (gamePlan: number) =>
      (await q<{ technique_id: number; linked: boolean; in_steps: boolean }>(
        'select technique_id, linked, in_steps from game_plan_cards where game_plan_id = $1 order by technique_id',
        [gamePlan],
      )).map(r => [r.technique_id, r.linked, r.in_steps]);
    expect(await cards(plan)).toEqual([[stepCard, false, true], [linkCard, true, false], [elsewhere, true, false]]);
    expect(await cards(other)).toEqual([[elsewhere, false, true]]);
    expect(await cards(samPlan)).toEqual([[samCard, false, true]]);

    // The batched step entry undoes without error: the step goes, and its card with it.
    expect(await undo(forUser(db, owner))).toBe('Undid: old add step');
    expect(await q('select id from game_plan_steps where id = $1', [stepId])).toEqual([]);
    expect(await cards(plan)).toEqual([[linkCard, true, false], [elsewhere, true, false]]);
    // The deleted game plan comes back with its step; only the card its step doesn't use is linked again.
    expect(await undo(forUser(db, owner))).toBe('Undid: old delete');
    expect(await cards(7001)).toEqual([[stepCard, false, true], [linkCard, true, false]]);
  });
});

/** How undo entries snapshotted a note before 022. */
const NOTE_SNAPSHOT_SQL_BEFORE_022 = `select id, body, raw_text, kind, observed_on::text as observed_on, session_id, source_id,
  source_timestamp, inbox, to_try, starred_at::text as starred_at, answered_at::text as answered_at, created_via,
  created_at::text as created_at from notes where id = $1 and user_id = $2`;
