// A game plan's steps over the JSON API: a whole outline, branches and alternatives, hand-offs to other game plans,
// moving steps, changing one step at a time, and refusing stale writes. Siri reading them aloud too.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FocusView, GamePlanDetail, PositionView, TechniqueView } from '../src/shared/api.js';
import { stepsIn, toOutline } from '../src/shared/steps.js';
import { personWithWorkingList, startServer, type Api, type Person, type TestServer } from './helpers.js';

let s: TestServer;

beforeAll(async () => {
  s = await startServer();
});
afterAll(async () => {
  await s.close();
});

describe('JSON API: steps on a game plan', () => {
  let p: Person;
  const api: Api = (...a) => p.api(...a);
  beforeAll(async () => {
    ({ p } = await personWithWorkingList(s));
  });

  it('keeps steps on a game plan: a main line that branches, linked to cards, handing off to other game plans', async () => {
    const undo = async () => (await api('POST', '/api/v1/undo')).body.message as string;
    const pos = async (slug: string) => (await api<PositionView>('GET', `/api/v1/positions/${slug}`)).body.position.id;
    const card = async (name: string, type: string) =>
      (await api<TechniqueView>('POST', '/api/v1/techniques', { name, type, role: 'bottom', status: 'drilling' })).body;
    const jw = await card('John Wayne sweep', 'sweep');
    const shuck = await card('Shuck', 'transition');
    const half = await pos('half-guard');
    const deep = await pos('deep-half');

    const deepHalf = (await api<{ gamePlan: GamePlanDetail }>('POST', '/api/v1/game-plans', { name: 'Deep half sweeps', focus: false })).body.gamePlan;
    await api('PATCH', `/api/v1/game-plans/${deepHalf.id}`, { startPositionId: deep, startRole: 'bottom' });
    const gamePlan = (await api<{ gamePlan: GamePlanDetail }>('POST', '/api/v1/game-plans', { name: 'Bottom half: winning the underhook' })).body.gamePlan;
    const steps = [
      { depth: 0, action: 'John Wayne sweep', techniqueId: jw.id, note: 'Force them to post the underhook hand' },
      { depth: 0, action: 'Shuck', techniqueId: shuck.id },
      { depth: 1, trigger: 'they post the far leg', action: 'Go to deep half', toPositionId: deep, toRole: 'bottom' },
      { depth: 1, trigger: 'they base back', action: 'Octopus sweeps' },
    ];
    const saved = await api<{ message: string; gamePlan: GamePlanDetail }>('PATCH', `/api/v1/game-plans/${gamePlan.id}`, {
      startPositionId: half,
      startRole: 'bottom',
      premise: 'Top has the underhook and crossface',
      steps,
    });
    expect(saved.body.message).toBe('Bottom half: winning the underhook: start updated; premise updated; steps saved (4 steps).');
    const v = saved.body.gamePlan;
    expect(v).toMatchObject({ start: { slug: 'half-guard' }, startRole: 'bottom', premise: 'Top has the underhook and crossface', stepCount: 4 });
    // The main line is a list of slots, each a choice between its options (here, one each); what follows an option is its own slots.
    expect(v.steps.map(slot => [slot.ordinal, slot.trigger, slot.options.map(st => [st.option, st.action, st.technique?.name ?? null, st.slots.length])])).toEqual([
      [1, null, [[0, 'John Wayne sweep', 'John Wayne sweep', 0]]],
      [2, null, [[0, 'Shuck', 'Shuck', 2]]],
    ]);
    const afterShuck = (d: GamePlanDetail) => d.steps[1]!.options[0]!.slots;
    expect(afterShuck(v).map(c => [c.ordinal, c.trigger, c.options[0]!.action, c.options[0]!.to?.slug ?? null])).toEqual([
      [1, 'they post the far leg', 'Go to deep half', 'deep-half'],
      [2, 'they base back', 'Octopus sweeps', null],
    ]);
    // The step into deep half hands off to the game plan that starts there.
    expect(afterShuck(v)[0]!.options[0]!.continuesIn).toEqual([{ id: deepHalf.id, name: 'Deep half sweeps', rank: null }]);
    // Step cards are linked to the game plan, so their notes show up on it.
    expect(v.techniques.map(t => t.name)).toEqual(['John Wayne sweep', 'Shuck']);
    expect((await api<TechniqueView>('GET', `/api/v1/techniques/${shuck.id}`)).body.gamePlans.map(a => a.name)).toEqual(['Bottom half: winning the underhook']);
    expect((await api<PositionView>('GET', '/api/v1/positions/half-guard?role=bottom')).body.gamePlans.map(a => a.name)).toEqual([
      'Bottom half: winning the underhook',
    ]);
    expect((await api<PositionView>('GET', '/api/v1/positions/half-guard?role=top')).body.gamePlans).toEqual([]);

    // Siri reads a game plan aloud, found by name or by where it starts.
    const said = (q: string) => api('GET', `/api/v1/game-plans/speech?q=${encodeURIComponent(q)}`).then(r => r.body.speech as string);
    expect(await said('winning the underhook')).toBe(
      'Bottom half: winning the underhook. When top has the underhook and crossface: John Wayne sweep, to force them to post the underhook hand. Then shuck. If they post the far leg, go to deep half. If they base back, octopus sweeps.',
    );
    expect(await said('bottom half guard')).toMatch(/^Bottom half: winning the underhook\./);
    expect(await said('half guard top')).toBe("You don't have a game plan from Half guard on top yet.");
    expect(await said('qwxz zzyq')).toBe("I couldn't find a game plan called qwxz zzyq.");

    // Alternatives ("or"): plan B for a step, after it and its branches, at the same depth. Undone with the rest.
    const withOr = await api<{ message: string; gamePlan: GamePlanDetail }>('PATCH', `/api/v1/game-plans/${gamePlan.id}`, {
      steps: [
        steps[0],
        { depth: 0, or: true, trigger: 'ignored', action: 'Knee lever' },
        { depth: 1, action: 'Come up on the single' },
        steps[1],
        steps[2],
        { depth: 1, or: true, action: 'Underhook to dogfight' },
        steps[3],
      ],
    });
    expect(withOr.body.message).toBe('Bottom half: winning the underhook: steps saved (7 steps).');
    // An alternative is one more option in its plan A's slot: the main line is still two slots.
    expect(withOr.body.gamePlan.steps.map(slot => [slot.trigger, slot.options.map(st => [st.option, st.action, st.slots.length])])).toEqual([
      [null, [[0, 'John Wayne sweep', 0], [1, 'Knee lever', 1]]],
      [null, [[0, 'Shuck', 2]]],
    ]);
    expect(afterShuck(withOr.body.gamePlan).map(c => [c.trigger, c.options.map(st => st.action)])).toEqual([
      ['they post the far leg', ['Go to deep half', 'Underhook to dogfight']],
      ['they base back', ['Octopus sweeps']],
    ]);
    expect(await said('winning the underhook')).toBe(
      'Bottom half: winning the underhook. When top has the underhook and crossface: John Wayne sweep, to force them to post the underhook hand. Or instead, knee lever, then come up on the single. Then shuck. If they post the far leg, go to deep half. Or underhook to dogfight. If they base back, octopus sweeps.',
    );
    for (const orphan of [[{ depth: 0, or: true, action: 'A' }], [{ depth: 0, action: 'A' }, { depth: 1, or: true, action: 'B' }]]) {
      const r = await api('PATCH', `/api/v1/game-plans/${gamePlan.id}`, { steps: orphan });
      expect([r.status, r.body.message]).toEqual([400, `Step ${orphan.length}: "or" needs a step before it at the same level to be an alternative to.`]);
    }
    expect(await undo()).toBe('Undid: edit to "Bottom half: winning the underhook"');
    expect((await api<GamePlanDetail>('GET', `/api/v1/game-plans/${gamePlan.id}`)).body.steps.map(slot => slot.options.map(st => st.action))).toEqual([
      ['John Wayne sweep'],
      ['Shuck'],
    ]);

    // A bad outline is refused whole.
    const bad = await api('PATCH', `/api/v1/game-plans/${gamePlan.id}`, { steps: [{ depth: 1, action: 'Orphan' }] });
    expect([bad.status, bad.body.message]).toEqual([400, 'The first step must be on the main line (depth 0).']);
    const jump = await api('PATCH', `/api/v1/game-plans/${gamePlan.id}`, { steps: [{ depth: 0, action: 'A' }, { depth: 2, action: 'B' }] });
    expect(jump.body.message).toBe('Step 2 is 2 levels deeper than the step before it.');

    // Undo puts the steps back as they were (none), and takes back the card links the steps made.
    expect(await undo()).toBe('Undid: edit to "Bottom half: winning the underhook"');
    const before = (await api<GamePlanDetail>('GET', `/api/v1/game-plans/${gamePlan.id}`)).body;
    expect(before).toMatchObject({ steps: [], start: null, premise: null, techniques: [] });
    await api('PATCH', `/api/v1/game-plans/${gamePlan.id}`, { startPositionId: half, startRole: 'bottom', steps });

    // Deleting a card keeps its step's words; undoing the delete links it again.
    await api('DELETE', `/api/v1/techniques/${shuck.id}`);
    let now = (await api<GamePlanDetail>('GET', `/api/v1/game-plans/${gamePlan.id}`)).body;
    expect([now.steps[1]!.options[0]!.action, now.steps[1]!.options[0]!.technique]).toEqual(['Shuck', null]);
    await undo();
    now = (await api<GamePlanDetail>('GET', `/api/v1/game-plans/${gamePlan.id}`)).body;
    expect(now.steps[1]!.options[0]!.technique?.id).toBe(shuck.id);

    // Deleting the game plan takes it off focus; undo brings back its steps, links and place on the list.
    const rank = now.rank;
    expect((await api('DELETE', `/api/v1/game-plans/${gamePlan.id}`)).body.message).toBe('Deleted Bottom half: winning the underhook.');
    expect((await api<FocusView>('GET', '/api/v1/focus')).body.active.map(f => f.id)).not.toContain(gamePlan.id);
    expect(await undo()).toBe('Undid: delete "Bottom half: winning the underhook"');
    now = (await api<GamePlanDetail>('GET', `/api/v1/game-plans/${gamePlan.id}`)).body;
    expect([now.rank, now.stepCount, now.techniques.length, now.history.length]).toEqual([rank, 4, 2, 1]);
    expect(afterShuck(now).map(c => c.trigger)).toEqual(['they post the far leg', 'they base back']);
    const ranks = (await api<FocusView>('GET', '/api/v1/focus')).body.active.map(f => f.rank);
    expect(ranks).toEqual(ranks.map((_, i) => i + 1));
  });
});

describe('JSON API: moving steps', () => {
  let p: Person;
  const api: Api = (...a) => p.api(...a);
  beforeAll(async () => {
    ({ p } = await personWithWorkingList(s));
  });

  it('moves a step among the steps next to it, with its alternatives, or among its alternatives', async () => {
    const undo = async () => (await api('POST', '/api/v1/undo')).body.message as string;
    const gamePlan = (await api<{ gamePlan: GamePlanDetail }>('POST', '/api/v1/game-plans', { name: 'Closed guard attacks', focus: false })).body.gamePlan;
    await api('PATCH', `/api/v1/game-plans/${gamePlan.id}`, {
      steps: [
        { depth: 0, action: 'Hip bump' },
        { depth: 0, or: true, action: 'Kimura' },
        { depth: 0, action: 'Guillotine' },
        { depth: 1, trigger: 'they posture up', action: 'Sit up' },
        { depth: 1, trigger: 'they post a hand', action: 'Kimura grip' },
        { depth: 1, or: true, action: 'Hip bump again' },
        { depth: 0, action: 'Armbar' },
      ],
    });
    const read = async () => (await api<GamePlanDetail>('GET', `/api/v1/game-plans/${gamePlan.id}`)).body;
    // Each list read option by option: [is an alternative, the reaction (on plan A), what to do].
    const mainLine = (v: GamePlanDetail) => v.steps.flatMap(slot => slot.options.map((s, k) => `${k > 0 ? 'or ' : ''}${s.action}`));
    const branches = (v: GamePlanDetail) =>
      stepsIn(v.steps)
        .find(s => s.action === 'Guillotine')!
        .slots.flatMap(slot => slot.options.map((s, k) => [k > 0, k === 0 ? slot.trigger : null, s.action]));
    const idOf = (v: GamePlanDetail, action: string) => stepsIn(v.steps).find(s => s.action === action)!.id;
    const start = await read();
    const ids = Object.fromEntries(['Hip bump', 'Kimura', 'Guillotine', 'Sit up', 'Kimura grip', 'Hip bump again', 'Armbar'].map(a => [a, idOf(start, a)]));
    const move = (step: string, body: object) => api<{ message: string; gamePlan: GamePlanDetail }>('POST', `/api/v1/game-plans/${gamePlan.id}/steps/${ids[step]}/move`, body);

    // A step moves with its alternatives; the steps under it go with it.
    let r = await move('Armbar', { to: 'up' });
    expect(r.body.message).toBe('Moved Armbar up.');
    expect(mainLine(r.body.gamePlan)).toEqual(['Hip bump', 'or Kimura', 'Armbar', 'Guillotine']);
    r = await move('Guillotine', { to: 'first' });
    expect(r.body.message).toBe('Moved Guillotine to first.');
    expect(mainLine(r.body.gamePlan)).toEqual(['Guillotine', 'Hip bump', 'or Kimura', 'Armbar']);
    expect(branches(r.body.gamePlan)).toEqual([
      [false, 'they posture up', 'Sit up'],
      [false, 'they post a hand', 'Kimura grip'],
      [true, null, 'Hip bump again'],
    ]);
    r = await move('Hip bump', { after: ids['Armbar'] });
    expect(r.body.message).toBe('Moved Hip bump after Armbar.');
    expect(mainLine(r.body.gamePlan)).toEqual(['Guillotine', 'Armbar', 'Hip bump', 'or Kimura']);
    r = await move('Hip bump', { before: ids['Guillotine'] });
    expect(mainLine(r.body.gamePlan)).toEqual(['Hip bump', 'or Kimura', 'Guillotine', 'Armbar']);
    // Moving the first step of a choice by one of its alternatives' ids moves the same choice.
    r = await move('Kimura', { to: 'last' });
    expect(mainLine(r.body.gamePlan)).toEqual(['Guillotine', 'Armbar', 'Hip bump', 'or Kimura']);

    // Among its alternatives: plan B becomes plan A, and takes over the reaction it answers.
    r = await move('Hip bump again', { within: 'choice', to: 'up' });
    expect(r.body.message).toBe('Hip bump again is now plan A.');
    expect(branches(r.body.gamePlan)).toEqual([
      [false, 'they posture up', 'Sit up'],
      [false, 'they post a hand', 'Hip bump again'],
      [true, null, 'Kimura grip'],
    ]);
    // Read back and said aloud in the new order.
    const said = (await api('GET', `/api/v1/game-plans/speech?q=${encodeURIComponent('closed guard attacks')}`)).body.speech as string;
    expect(said).toBe(
      'Closed guard attacks. Guillotine. If they posture up, sit up. If they post a hand, hip bump again. Or kimura grip. Then armbar. Then hip bump. Or instead, kimura.',
    );

    // Things that don't move anything are said, not logged.
    expect((await move('Guillotine', { to: 'up' })).body.message).toBe('Guillotine is already first.');
    expect((await move('Hip bump again', { within: 'choice', to: 'first' })).body.message).toBe('Hip bump again is already plan A.');
    expect((await move('Armbar', { within: 'choice', to: 'up' })).body.message).toBe('Armbar has no alternatives to move among.');
    expect((await move('Hip bump', { before: ids['Kimura'] })).body.message).toMatch(/alternatives to each other/);
    // Steps move among the steps next to them, not across the tree.
    let bad = await move('Sit up', { before: ids['Armbar'] });
    expect([bad.status, bad.body.message]).toEqual([400, 'That step is somewhere else in the game plan: steps move among the steps next to them.']);
    bad = await move('Armbar', { to: 'up', before: ids['Guillotine'] });
    expect(bad.status).toBe(400);
    bad = await move('Armbar', { within: 'choice', before: ids['Guillotine'] });
    expect(bad.status).toBe(400);
    expect((await api('POST', `/api/v1/game-plans/${gamePlan.id}/steps/999999/move`, { to: 'up' })).status).toBe(404);

    // Each move is one undo; ids stay the same throughout.
    expect(await undo()).toBe('Undid: move in "Closed guard attacks"');
    expect(branches(await read())).toEqual([
      [false, 'they posture up', 'Sit up'],
      [false, 'they post a hand', 'Kimura grip'],
      [true, null, 'Hip bump again'],
    ]);
    for (let i = 0; i < 5; i++) await undo();
    const back = await read();
    expect(mainLine(back)).toEqual(mainLine(start));
    expect(back.steps).toEqual(start.steps);

    // A step and its alternative are branches side by side, each said with what comes after it.
    const sided = (await api<{ gamePlan: GamePlanDetail }>('POST', '/api/v1/game-plans', { name: 'Side by side', focus: false })).body.gamePlan;
    await api('PATCH', `/api/v1/game-plans/${sided.id}`, {
      steps: [
        { depth: 0, action: 'Do A' },
        { depth: 1, action: 'Step one of A' },
        { depth: 1, action: 'Step two of A' },
        { depth: 0, or: true, action: 'Do B' },
        { depth: 1, action: 'Step one of B' },
        { depth: 1, trigger: 'they stall', action: 'Step two of B' },
        { depth: 0, action: 'Get up' },
      ],
    });
    expect((await api('GET', `/api/v1/game-plans/speech?q=${encodeURIComponent('side by side')}`)).body.speech).toBe(
      'Side by side. Do A, then step one of A, then step two of A. Or instead, do B, then step one of B; if they stall, step two of B. Then get up.',
    );
  });
});

describe('JSON API: one step at a time', () => {
  let p: Person;
  const api: Api = (...a) => p.api(...a);
  beforeAll(async () => {
    ({ p } = await personWithWorkingList(s));
  });

  it('changes one step at a time: add, edit, delete, each leaving every other step its id, and refuses a stale write', async () => {
    const undo = async () => (await api('POST', '/api/v1/undo')).body.message as string;
    const gamePlan = (await api<{ gamePlan: GamePlanDetail }>('POST', '/api/v1/game-plans', { name: 'One at a time', focus: false })).body.gamePlan;
    const card = (await api<TechniqueView>('POST', '/api/v1/techniques', { name: 'Scissor sweep', type: 'sweep' })).body;
    const url = `/api/v1/game-plans/${gamePlan.id}`;
    type Changed = { message: string; gamePlan: GamePlanDetail; stepId: number };
    const read = async () => (await api<GamePlanDetail>('GET', url)).body;
    // The outline as indented lines, and each step's id by what it says.
    const flat = (v: GamePlanDetail) => toOutline(v.steps, s => ({ id: s.id, action: s.action }));
    const shape = (v: GamePlanDetail) => flat(v).map(s => `${'  '.repeat(s.depth)}${s.or ? 'or ' : s.trigger ? `if ${s.trigger}: ` : ''}${s.action}`);
    const idsOf = (v: GamePlanDetail) => Object.fromEntries(flat(v).map(s => [s.action, s.id]));
    const add = (body: object) => api<Changed>('POST', `${url}/steps`, body);

    // Adding: at the end of the main line, under a step ("then", "if"), and beside one ("or").
    let r = await add({ relation: 'then', action: 'Break posture' });
    expect([r.status, r.body.message]).toEqual([201, 'Added Break posture.']);
    expect(r.headers.get('x-activity-id')).toBeTruthy();
    const posture = r.body.stepId;
    expect(idsOf(r.body.gamePlan)).toEqual({ 'Break posture': posture });
    r = await add({ relation: 'then', action: 'Scissor sweep', techniqueId: card.id, note: 'Kick the far leg' });
    // A step's card is linked to the game plan, as when a whole outline is saved.
    expect(r.body.gamePlan.techniques.map(t => t.name)).toEqual(['Scissor sweep']);
    r = await add({ relation: 'if', of: posture, trigger: 'they posture up', action: 'Hip bump' });
    const hipBump = r.body.stepId;
    r = await add({ relation: 'or', of: hipBump, action: 'Guillotine' });
    const guillotine = r.body.stepId;
    r = await add({ relation: 'then', of: guillotine, action: 'Finish' });
    r = await add({ relation: 'then', of: posture, action: 'Climb the guard' });
    r = await add({ relation: 'or', of: hipBump, action: 'Kimura' });
    const built = r.body.gamePlan;
    expect(shape(built)).toEqual([
      'Break posture',
      '  if they posture up: Hip bump',
      '  or Guillotine',
      '    Finish',
      '  or Kimura',
      '  Climb the guard',
      'Scissor sweep',
    ]);
    const ids = idsOf(built);
    expect(ids).toMatchObject({ 'Break posture': posture, 'Hip bump': hipBump, Guillotine: guillotine });
    expect(new Set(Object.values(ids)).size).toBe(7);
    expect(built.stepCount).toBe(7);
    // Slots and options are numbered with no gaps, and only plan A carries the reaction.
    const underPosture = built.steps[0]!.options[0]!.slots;
    expect(underPosture.map(slot => [slot.ordinal, slot.trigger, slot.options.map(o => o.option)])).toEqual([
      [1, 'they posture up', [0, 1, 2]],
      [2, null, [0]],
    ]);

    // What can't be added says why, and changes nothing.
    for (const [body, status, message] of [
      [{ relation: 'if', of: posture, action: 'X' }, 400, 'An "if they…" step needs the reaction that leads to it.'],
      [{ relation: 'then', of: posture, trigger: 'they stall', action: 'X' }, 400, 'A "then" step has no reaction. Add it as an "if they…" step instead.'],
      [{ relation: 'or', action: 'X' }, 400, 'An alternative needs the step it is an alternative to.'],
      [{ relation: 'or', of: hipBump, trigger: 'they stall', action: 'X' }, 400, 'An alternative answers the same reaction as its plan A, so it has none of its own. Change the reaction on plan A.'],
      [{ relation: 'then', of: 999_999, action: 'X' }, 404, 'No step #999999 in that game plan.'],
    ] as const) {
      const bad = await add(body);
      expect([bad.status, bad.body.message]).toEqual([status, message]);
    }
    expect((await api('POST', '/api/v1/game-plans/999999/steps', { relation: 'then', action: 'X' })).status).toBe(404);
    expect((await api('POST', `${url}/steps`, { relation: 'then', action: ' ' })).status).toBe(400);
    // A step of another game plan isn't found through this one.
    const other = (await api<{ gamePlan: GamePlanDetail }>('POST', '/api/v1/game-plans', { name: 'Another plan', focus: false })).body.gamePlan;
    const theirs = (await api<Changed>('POST', `/api/v1/game-plans/${other.id}/steps`, { relation: 'then', action: 'Elsewhere' })).body.stepId;
    expect((await add({ relation: 'then', of: theirs, action: 'X' })).status).toBe(404);
    expect((await api('PATCH', `${url}/steps/${theirs}`, { action: 'X' })).status).toBe(404);
    expect((await api('DELETE', `${url}/steps/${theirs}`)).status).toBe(404);
    expect((await api('POST', `${url}/steps/${theirs}/move`, { to: 'up' })).status).toBe(404);
    expect((await api<GamePlanDetail>('GET', `/api/v1/game-plans/${other.id}`)).body.steps[0]!.options[0]!.action).toBe('Elsewhere');
    await api('DELETE', `/api/v1/game-plans/${other.id}`);
    expect((await read()).steps).toEqual(built.steps);

    // Editing one step: its own fields. The reaction belongs to the slot, so only plan A can change it.
    let e = await api<Changed>('PATCH', `${url}/steps/${hipBump}`, { trigger: 'they sit back', note: 'Fast' });
    expect([e.status, e.body.message]).toEqual([200, 'Saved Hip bump.']);
    expect(shape(e.body.gamePlan)[1]).toBe('  if they sit back: Hip bump');
    expect(stepsIn(e.body.gamePlan.steps).find(s => s.id === hipBump)!.note).toBe('Fast');
    expect(idsOf(e.body.gamePlan)).toEqual(ids);
    e = await api<Changed>('PATCH', `${url}/steps/${guillotine}`, { trigger: 'they stall' });
    expect([e.status, e.body.message]).toEqual([400, 'An alternative answers the same reaction as its plan A, so it has none of its own. Change the reaction on plan A.']);
    e = await api<Changed>('PATCH', `${url}/steps/${guillotine}`, { action: 'Guillotine', trigger: null });
    expect([e.body.message, e.headers.get('x-activity-id')]).toEqual(['Nothing changed on Guillotine.', null]);
    e = await api<Changed>('PATCH', `${url}/steps/${guillotine}`, { action: 'Arm-in guillotine', techniqueId: card.id });
    expect(e.body.message).toBe('Saved Arm-in guillotine.');
    expect(stepsIn(e.body.gamePlan.steps).find(s => s.id === guillotine)!.technique?.id).toBe(card.id);
    expect(await undo()).toBe('Undid: edit to "One at a time"');
    expect(shape(await read())[2]).toBe('  or Guillotine');
    expect((await api('PATCH', `${url}/steps/999999`, { action: 'X' })).status).toBe(404);
    const edited = await read();

    // Deleting plan A: plan B is the plan now, and takes over the reaction. Everything else keeps its id.
    let d = await api<Changed>('DELETE', `${url}/steps/${hipBump}`);
    expect([d.status, d.body.message]).toEqual([200, 'Deleted Hip bump.']);
    expect(shape(d.body.gamePlan)).toEqual(['Break posture', '  if they sit back: Guillotine', '    Finish', '  or Kimura', '  Climb the guard', 'Scissor sweep']);
    expect(d.body.gamePlan.steps[0]!.options[0]!.slots[0]!.options.map(o => [o.option, o.id])).toEqual([[0, guillotine], [1, ids['Kimura']]]);
    const { 'Hip bump': _gone, ...rest } = ids;
    expect(idsOf(d.body.gamePlan)).toEqual(rest);
    // Undo puts it back exactly: ids, slots, options and the reaction on plan A.
    expect(await undo()).toBe('Undid: edit to "One at a time"');
    expect((await read()).steps).toEqual(edited.steps);
    // Deleting a later option closes the gap; deleting a step takes what's under it, and the slots after it move up.
    d = await api<Changed>('DELETE', `${url}/steps/${guillotine}`);
    expect(d.body.message).toBe('Deleted Guillotine and the 1 step after it.');
    expect(d.body.gamePlan.steps[0]!.options[0]!.slots[0]!.options.map(o => [o.option, o.action])).toEqual([[0, 'Hip bump'], [1, 'Kimura']]);
    await undo();
    d = await api<Changed>('DELETE', `${url}/steps/${posture}`);
    expect(d.body.message).toBe('Deleted Break posture and the 5 steps after it.');
    expect(d.body.gamePlan.steps.map(slot => [slot.ordinal, slot.options[0]!.id])).toEqual([[1, ids['Scissor sweep']]]);
    await undo();
    expect((await read()).steps).toEqual(edited.steps);
    expect((await api('DELETE', `${url}/steps/999999`)).status).toBe(404);

    // Moving keeps ids too, and its undo is exact.
    const m = await api<Changed>('POST', `${url}/steps/${ids['Kimura']}/move`, { within: 'choice', to: 'first' });
    expect(m.body.message).toBe('Kimura is now plan A.');
    expect(shape(m.body.gamePlan).slice(1, 5)).toEqual(['  if they sit back: Kimura', '  or Hip bump', '  or Guillotine', '    Finish']);
    expect(idsOf(m.body.gamePlan)).toEqual(ids);
    expect(await undo()).toBe('Undid: move in "One at a time"');
    expect((await read()).steps).toEqual(edited.steps);

    // A write can say what it last saw. If the game plan changed since, nothing is saved.
    const seen = (await read()).updatedAt;
    e = await api<Changed>('PATCH', `${url}/steps/${hipBump}`, { note: 'Faster', expectedUpdatedAt: seen });
    expect(e.status).toBe(200);
    expect(e.body.gamePlan.updatedAt).not.toBe(seen);
    const current = await read();
    const stale = { error: 'conflict', message: 'This game plan changed somewhere else. Reload to see it.' };
    for (const res of [
      await add({ relation: 'then', action: 'Stale', expectedUpdatedAt: seen }),
      await api('PATCH', `${url}/steps/${hipBump}`, { note: 'Stale', expectedUpdatedAt: seen }),
      await api('DELETE', `${url}/steps/${hipBump}`, { expectedUpdatedAt: seen }),
      await api('DELETE', `${url}/steps/${hipBump}?expectedUpdatedAt=${encodeURIComponent(seen)}`),
      await api('POST', `${url}/steps/${hipBump}/move`, { within: 'choice', to: 'down', expectedUpdatedAt: seen }),
      await api('PATCH', url, { steps: [{ depth: 0, action: 'Stale' }], expectedUpdatedAt: seen }),
      await api('PATCH', url, { name: 'Stale', expectedUpdatedAt: seen }),
    ]) {
      expect([res.status, res.body]).toEqual([409, stale]);
      expect(res.headers.get('x-activity-id')).toBeNull();
    }
    expect(await read()).toEqual(current);
    // With what's there now, or without saying, a whole outline replaces the steps (and they get new ids).
    let whole = await api<Changed>('PATCH', url, { steps: [{ depth: 0, action: 'Fresh' }, { depth: 0, or: true, action: 'Or this' }], expectedUpdatedAt: current.updatedAt });
    expect([whole.status, shape(whole.body.gamePlan)]).toEqual([200, ['Fresh', 'or Or this']]);
    expect(whole.body.gamePlan.updatedAt).not.toBe(current.updatedAt);
    whole = await api<Changed>('PATCH', url, { steps: [{ depth: 0, action: 'Fresher' }] });
    expect([whole.status, shape(whole.body.gamePlan)]).toEqual([200, ['Fresher']]);
    // Undo marks the game plan as changed as well, so a page that saw it before the undo is told.
    const beforeUndo = whole.body.gamePlan.updatedAt;
    await undo();
    expect((await add({ relation: 'then', action: 'Stale', expectedUpdatedAt: beforeUndo })).status).toBe(409);
    expect(shape(await read())).toEqual(['Fresh', 'or Or this']);
  });
});
