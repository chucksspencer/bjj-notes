// Positions of your own over the JSON API: adding, changing and deleting them with undo, what's refused, and that
// nobody else can see or use them, down to the database.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { forUser } from '../src/db.js';
import { resolvePosition } from '../src/resolve.js';
import type { GamePlanDetail, MessageResult, PositionListItem, PositionView, TechniqueView } from '../src/shared/api.js';
import { stepsIn } from '../src/shared/steps.js';
import { newPerson, ownerPerson, seedGamePlan, seedTechnique, startServer, type Api, type Person, type TestServer } from './helpers.js';

let s: TestServer;

beforeAll(async () => {
  s = await startServer();
});
afterAll(async () => {
  await s.close();
});

const undoIt = async (p: Person, res: { headers: Headers }) =>
  (await p.api<MessageResult>('POST', '/api/v1/undo', { id: Number(res.headers.get('x-activity-id')) })).body.message;

describe('JSON API: positions of your own', () => {
  let p: Person;
  const api: Api = (...a) => p.api(...a);
  beforeAll(async () => {
    p = await newPerson(s);
  });

  it('lists the 32 starter positions, none of them yours', async () => {
    const list = (await api<PositionListItem[]>('GET', '/api/v1/positions')).body;
    expect(list).toHaveLength(32);
    expect(list.every(x => !x.custom)).toBe(true);
    expect((await api<PositionView>('GET', '/api/v1/positions/mount')).body.position).toMatchObject({ name: 'Mount', custom: false });
  });

  it('adds one, with a slug from its name, and undoes it', async () => {
    const res = await api<PositionView>('POST', '/api/v1/positions', {
      name: '  Rubber   guard ',
      category: 'guard',
      aliases: ['mission control', ' ', 'rubber guard', 'Mission Control'],
      description: 'High guard, the shin across the back.',
    });
    expect(res.status).toBe(201);
    expect(res.headers.get('x-activity-id')).toBeTruthy();
    expect(res.body.position).toEqual({
      id: res.body.position.id,
      slug: 'rubber-guard',
      name: 'Rubber guard',
      category: 'guard',
      aliases: ['mission control'],
      description: 'High guard, the shin across the back.',
      custom: true,
    });
    const list = (await api<PositionListItem[]>('GET', '/api/v1/positions')).body;
    expect(list).toHaveLength(33);
    expect(list.find(x => x.slug === 'rubber-guard')).toMatchObject({ name: 'Rubber guard', custom: true, techniqueCount: 0 });

    expect(await undoIt(p, res)).toBe('Undid: new position "Rubber guard"');
    expect((await api('GET', '/api/v1/positions/rubber-guard')).status).toBe(404);
    expect((await api<PositionListItem[]>('GET', '/api/v1/positions')).body).toHaveLength(32);
  });

  it('refuses names a position already goes by: a starter name, alias or slug, or one of your own', async () => {
    const refused = async (body: object) => {
      const res = await api<{ message: string }>('POST', '/api/v1/positions', { category: 'guard', ...body });
      expect(res.status).toBe(400);
      return res.body.message;
    };
    expect(await refused({ name: 'mount' })).toBe("There's already a position called Mount.");
    expect(await refused({ name: 'Z guard' })).toBe('Z guard is already Knee shield half guard (as an alias).');
    expect(await refused({ name: 'Worm guard', aliases: ['DLR'] })).toBe('DLR is already De La Riva guard (as an alias).');
    expect(await refused({ name: 'side-control' })).toBe("There's already a position called Side control.");
    expect(await refused({ name: 'Reverse de la Riva' })).toBe('Reverse de la Riva is already Reverse De La Riva guard.'); // its slug
    expect(await refused({ name: '!!!' })).toBe("A position's name needs letters or numbers.");
    expect((await api('POST', '/api/v1/positions', { name: 'Worm guard', category: 'nonsense' })).status).toBe(400);

    expect((await api('POST', '/api/v1/positions', { name: 'Worm guard', category: 'guard', aliases: ['lapel worm'] })).status).toBe(201);
    expect(await refused({ name: 'worm  GUARD' })).toBe("There's already a position called Worm guard.");
    expect(await refused({ name: 'Lapel worm' })).toBe('Lapel worm is already Worm guard (as an alias).');
    expect(await refused({ name: 'wormguard' })).toBe("There's already a position called Worm guard.");
  });

  it("edits your own (a new name keeps the old one as an alias), with undo, and leaves starter positions alone", async () => {
    const res = await api<PositionView>('PATCH', '/api/v1/positions/worm-guard', {
      name: 'Lapel worm guard',
      category: 'leg',
      aliases: ['worm'],
      description: 'Lapel fed under the leg.',
    });
    expect(res.status).toBe(200);
    expect(res.body.position).toMatchObject({
      slug: 'lapel-worm-guard',
      name: 'Lapel worm guard',
      category: 'leg',
      aliases: ['worm', 'Worm guard'],
      description: 'Lapel fed under the leg.',
      custom: true,
    });
    expect((await api('GET', '/api/v1/positions/worm-guard')).status).toBe(404);
    // An unchanged save changes nothing, and logs nothing to undo.
    const same = await api('PATCH', '/api/v1/positions/lapel-worm-guard', { category: 'leg' });
    expect(same.status).toBe(200);
    expect(same.headers.get('x-activity-id')).toBeNull();
    // A name or alias another position has is refused here too.
    expect((await api<{ message: string }>('PATCH', '/api/v1/positions/lapel-worm-guard', { aliases: ['worm', 'half'] })).body.message).toBe(
      'half is already Half guard (as an alias).',
    );
    const cleared = await api<PositionView>('PATCH', '/api/v1/positions/lapel-worm-guard', { description: null });
    expect(cleared.body.position.description).toBeNull();

    expect(await undoIt(p, cleared)).toBe('Undid: edit to position "Lapel worm guard"');
    expect(await undoIt(p, res)).toBe('Undid: edit to position "Worm guard"');
    expect((await api<PositionView>('GET', '/api/v1/positions/worm-guard')).body.position).toMatchObject({
      name: 'Worm guard',
      category: 'guard',
      aliases: ['lapel worm'],
      description: null,
    });

    for (const [method, body] of [
      ['PATCH', { name: 'Full mount' }],
      ['DELETE', undefined],
    ] as const) {
      const r = await api<{ message: string }>(method, '/api/v1/positions/mount', body);
      expect(r.status).toBe(400);
      expect(r.body.message).toBe(method === 'PATCH' ? "Starter positions can't be changed." : "Starter positions can't be deleted.");
    }
    expect((await api('PATCH', '/api/v1/positions/nowhere', { name: 'X' })).status).toBe(404);
  });

  it('uses your own position for techniques, game plans and steps, and refuses to delete it while it is used', async () => {
    const worm = (await api<PositionView>('GET', '/api/v1/positions/worm-guard')).body.position;
    const sweep = await seedTechnique(p, { name: 'Worm sweep', type: 'sweep', role: 'bottom', from: [{ slug: 'worm-guard', role: 'bottom', toRole: 'top' }] });
    expect(sweep.edges.map(e => e.from?.name)).toEqual(['Worm guard']);
    const plan = await seedGamePlan(p, 'Worm guard game');
    const started = await api<GamePlanDetail>('PATCH', `/api/v1/game-plans/${plan.id}`, { startPositionId: worm.id, startRole: 'bottom' });
    expect(started.status).toBe(200);
    const withStep = await api<{ gamePlan: GamePlanDetail }>('POST', `/api/v1/game-plans/${plan.id}/steps`, {
      relation: 'then',
      action: 'Feed the lapel',
      toPositionId: worm.id,
    });
    expect(stepsIn(withStep.body.gamePlan.steps).map(st => st.to?.name)).toEqual(['Worm guard']);
    const view = (await api<PositionView>('GET', '/api/v1/positions/worm-guard?role=bottom')).body;
    expect(view.from.map(t => t.name)).toEqual(['Worm sweep']);
    expect(view.gamePlans.map(a => a.name)).toEqual(['Worm guard game']);

    const refused = await api<{ message: string }>('DELETE', '/api/v1/positions/worm-guard');
    expect(refused.status).toBe(400);
    expect(refused.body.message).toBe('Used by 1 technique and 1 game plan: Worm sweep, Worm guard game. Change those first.');

    // Take it off each of them, then it goes, and undo brings it back.
    await api('DELETE', `/api/v1/techniques/${sweep.id}/edges/${sweep.edges[0]!.id}`);
    await api('PATCH', `/api/v1/game-plans/${plan.id}`, { startPositionId: null });
    expect((await api<{ message: string }>('DELETE', '/api/v1/positions/worm-guard')).body.message).toBe(
      'Used by 1 game plan: Worm guard game. Change those first.',
    );
    await api('PATCH', `/api/v1/game-plans/${plan.id}`, { steps: [] });
    const deleted = await api<MessageResult>('DELETE', '/api/v1/positions/worm-guard');
    expect(deleted.body.message).toBe('Deleted Worm guard.');
    expect((await api('GET', '/api/v1/positions/worm-guard')).status).toBe(404);
    expect(await undoIt(p, deleted)).toBe('Undid: deleted position "Worm guard"');
    expect((await api<PositionView>('GET', '/api/v1/positions/worm-guard')).body.position).toMatchObject({ id: worm.id, name: 'Worm guard', aliases: ['lapel worm'] });
  });

  it('refuses undoing an add while something uses the position', async () => {
    const made = await api<PositionView>('POST', '/api/v1/positions', { name: 'Crab ride', category: 'back' });
    // Written straight to the database, so no undo entry stands between the two.
    await s.db.query('insert into game_plans (name, start_position_id, user_id) values ($1, $2, $3)', ['Crab ride entries', made.body.position.id, p.id]);
    const res = await api<{ message: string }>('POST', '/api/v1/undo', { id: Number(made.headers.get('x-activity-id')) });
    expect(res.status).toBe(400);
    expect(res.body.message).toBe('Used by 1 game plan: Crab ride entries. Change those first.');
    expect((await api('GET', '/api/v1/positions/crab-ride')).status).toBe(200);
  });
});

describe('JSON API: nobody else sees your positions', () => {
  let a: Person;
  let b: Person;
  let mine: PositionView['position'];
  beforeAll(async () => {
    a = await newPerson(s, { name: 'Ana' });
    b = await newPerson(s, { name: 'Bo' });
    mine = (await a.api<PositionView>('POST', '/api/v1/positions', { name: 'Williams guard', category: 'guard', aliases: ['shawn williams'] })).body.position;
  });

  it("doesn't show someone else's position in the list, by slug, or to name matching", async () => {
    expect((await b.api<PositionListItem[]>('GET', '/api/v1/positions')).body.map(x => x.slug)).not.toContain('williams-guard');
    const bySlug = await b.api<{ message: string }>('GET', '/api/v1/positions/williams-guard');
    const missing = await b.api<{ message: string }>('GET', '/api/v1/positions/no-such-guard');
    expect(bySlug).toMatchObject({ status: 404, body: missing.body });
    expect((await b.api('PATCH', '/api/v1/positions/williams-guard', { name: 'Mine now' })).status).toBe(404);
    expect((await b.api('DELETE', '/api/v1/positions/williams-guard')).status).toBe(404);

    const forB = forUser(s.db, b.id);
    for (const name of ['Williams guard', 'shawn williams']) {
      const r = await resolvePosition(forB, name);
      expect(r.match?.id).not.toBe(mine.id);
      expect(r.candidates.map(c => c.id)).not.toContain(mine.id);
    }
    expect((await resolvePosition(forUser(s.db, a.id), 'williams guard')).match).toMatchObject({ id: mine.id, exact: true });
  });

  it("refuses someone else's position id exactly as one that isn't there: edges, a game plan's start, a step", async () => {
    const card = await seedTechnique(b, { name: 'Bo sweep', type: 'sweep' });
    const edge = (positionId: number) => b.api<{ message: string }>('POST', `/api/v1/techniques/${card.id}/edges`, { fromPositionId: positionId });
    const [theirs, none] = [await edge(mine.id), await edge(999_999)];
    expect(theirs).toMatchObject({ status: 400, body: { message: `No position #${mine.id}.` } });
    expect(none).toMatchObject({ status: 400, body: { message: 'No position #999999.' } });
    const to = await b.api<{ message: string }>('POST', `/api/v1/techniques/${card.id}/edges`, { toPositionId: mine.id });
    expect(to.body.message).toBe(`No position #${mine.id}.`);
    expect((await b.api<TechniqueView>('GET', `/api/v1/techniques/${card.id}`)).body.edges).toEqual([]);

    const plan = await seedGamePlan(b, 'Bo game');
    const start = await b.api<{ message: string }>('PATCH', `/api/v1/game-plans/${plan.id}`, { startPositionId: mine.id });
    expect(start).toMatchObject({ status: 400, body: { message: `No position #${mine.id}.` } });
    expect((await b.api<{ message: string }>('PATCH', `/api/v1/game-plans/${plan.id}`, { startPositionId: 999_999 })).body.message).toBe('No position #999999.');

    // A step's position by id is dropped when it isn't one you can use, whether it's someone else's or not there at all.
    for (const toPositionId of [mine.id, 999_999]) {
      const step = await b.api<{ gamePlan: GamePlanDetail }>('POST', `/api/v1/game-plans/${plan.id}/steps`, { relation: 'then', action: `Step to ${toPositionId}`, toPositionId });
      expect(step.status).toBe(201);
    }
    const outline = await b.api<{ gamePlan: GamePlanDetail }>('PATCH', `/api/v1/game-plans/${plan.id}`, {
      steps: [{ depth: 0, action: 'Outline step', toPositionId: mine.id }],
    });
    expect(stepsIn(outline.body.gamePlan.steps).map(st => [st.action, st.to])).toEqual([['Outline step', null]]);
    expect((await s.db.query('select 1 from game_plan_steps where to_position_id = $1', [mine.id])).rows).toEqual([]);
  });

  it('lets someone else add a position with the same name as yours', async () => {
    const theirs = await b.api<PositionView>('POST', '/api/v1/positions', { name: 'Williams guard', category: 'guard', aliases: ['shawn williams'] });
    expect(theirs.status).toBe(201);
    expect(theirs.body.position).toMatchObject({ slug: 'williams-guard', custom: true });
    expect(theirs.body.position.id).not.toBe(mine.id);
    expect((await a.api<PositionView>('GET', '/api/v1/positions/williams-guard')).body.position.id).toBe(mine.id);
    expect((await b.api<PositionView>('GET', '/api/v1/positions/williams-guard')).body.position.id).toBe(theirs.body.position.id);
  });

  it("rejects a write that names someone else's position even when it skips the code", async () => {
    const card = (await s.db.query<{ id: number }>("insert into techniques (name, type, user_id) values ('Direct', 'sweep', $1) returning id", [b.id])).rows[0]!.id;
    const plan = (await s.db.query<{ id: number }>("insert into game_plans (name, user_id) values ('Direct plan', $1) returning id", [b.id])).rows[0]!.id;
    const attempts = [
      ['insert into technique_edges (technique_id, user_id, from_position_id) values ($1, $2, $3)', [card, b.id, mine.id]],
      ['insert into technique_edges (technique_id, user_id, to_position_id) values ($1, $2, $3)', [card, b.id, mine.id]],
      ['update game_plans set start_position_id = $3 where id = $1 and user_id = $2', [plan, b.id, mine.id]],
      ["insert into game_plan_steps (game_plan_id, user_id, ordinal, action, to_position_id) values ($1, $2, 1, 'x', $3)", [plan, b.id, mine.id]],
    ] as const;
    for (const [sql, params] of attempts) {
      await expect(s.db.query(sql, [...params])).rejects.toThrow(`position ${mine.id} is not one user ${b.id} can use`);
    }
    // A shared position, and the owner's own row using their own position, are fine.
    await s.db.query('insert into technique_edges (technique_id, user_id, from_position_id) values ($1, $2, 1)', [card, b.id]);
    const aCard = (await s.db.query<{ id: number }>("insert into techniques (name, type, user_id) values ('Direct', 'sweep', $1) returning id", [a.id])).rows[0]!.id;
    await s.db.query('insert into technique_edges (technique_id, user_id, from_position_id) values ($1, $2, $3)', [aCard, a.id, mine.id]);
  });

  // Uses the owner only to remove Ana.
  it('removing someone takes their positions with them, even ones in use', async () => {
    const owner = await ownerPerson(s);
    const used = (await a.api<{ message: string }>('DELETE', '/api/v1/positions/williams-guard')).body.message;
    expect(used).toBe('Used by 1 technique: Direct. Change those first.');
    expect((await owner.api<MessageResult>('DELETE', `/api/v1/people/${a.id}`)).body.message).toBe('Removed Ana and their notebook.');
    expect((await s.db.query('select 1 from positions where id = $1', [mine.id])).rows).toEqual([]);
    expect((await s.db.query<{ c: number }>('select count(*)::int as c from positions where user_id is null')).rows[0]!.c).toBe(32);
  });
});
