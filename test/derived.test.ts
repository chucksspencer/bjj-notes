// What's worked out rather than stored (022): whether a note is in the inbox, and the cards a game plan's steps use.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { GamePlanDetail, NoteView, TechniqueView } from '../src/shared/api.js';
import { hashPassword } from '../src/auth/users.js';
import { forUser } from '../src/db.js';
import { addNote, fileNote } from '../src/services/notes.js';
import { OWNER_PASSWORD, startServer, type TestServer } from './helpers.js';

let s: TestServer;
type Auth = { cookie: string };
let owner: Auth;
let sam: Auth;

async function api<T = any>(auth: Auth, method: string, p: string, body?: unknown) {
  const headers: Record<string, string> = { 'x-bjj-app': '1', cookie: auth.cookie };
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(`${s.base}${p}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, body: (text && res.headers.get('content-type')?.includes('json') ? JSON.parse(text) : text) as T };
}

async function signIn(email: string, password: string): Promise<Auth> {
  const res = await fetch(`${s.base}/api/v1/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-bjj-app': '1' },
    body: JSON.stringify({ email, password }),
  });
  expect(res.status).toBe(200);
  return { cookie: res.headers.get('set-cookie')!.split(';')[0]! };
}

const inboxIds = async (auth: Auth) => (await api<NoteView[]>(auth, 'GET', '/api/v1/notes?inbox=1')).body.map(n => n.id);
const card = async (auth: Auth, name: string) =>
  (await api<TechniqueView>(auth, 'POST', '/api/v1/techniques', { name, type: 'sweep', role: 'bottom' })).body;
const plan = async (auth: Auth, id: number) => (await api<GamePlanDetail>(auth, 'GET', `/api/v1/game-plans/${id}`)).body;
const undo = (auth: Auth) => api<{ message: string }>(auth, 'POST', '/api/v1/undo', {});

beforeAll(async () => {
  s = await startServer();
  owner = await signIn('', OWNER_PASSWORD);
  await s.db.query("insert into users (email, name, password_hash) values ('sam@example.com', 'Sam', $1)", [await hashPassword('sam-password-1')]);
  sam = await signIn('sam@example.com', 'sam-password-1');
});
afterAll(async () => {
  await s.close();
});

describe('the inbox, worked out', () => {
  it('moves a note in and out of the inbox as what files it changes, with nothing stored', async () => {
    const columns = (await s.db.query<{ column_name: string }>("select column_name from information_schema.columns where table_name = 'notes'")).rows.map(
      c => c.column_name,
    );
    expect(columns).not.toContain('inbox');

    const lever = await card(owner, 'Lever sweep');
    const note = (await api<{ note: NoteView }>(owner, 'POST', '/api/v1/notes', { text: 'Elbow inside first.' })).body.note;
    expect(note.inbox).toBe(true);
    expect(await inboxIds(owner)).toContain(note.id);

    // A technique files it.
    expect((await api<NoteView>(owner, 'PATCH', `/api/v1/notes/${note.id}`, { techniqueIds: [lever.id] })).body.inbox).toBe(false);
    expect(await inboxIds(owner)).not.toContain(note.id);
    // Taking it away sends it back.
    expect((await api<NoteView>(owner, 'PATCH', `/api/v1/notes/${note.id}`, { techniqueIds: [] })).body.inbox).toBe(true);

    // A game plan files it too, and unfiling it from there brings it back.
    const gp = (await api<{ gamePlan: GamePlanDetail }>(owner, 'POST', '/api/v1/game-plans', { name: 'Lever game', focus: false })).body.gamePlan;
    await api(owner, 'POST', `/api/v1/game-plans/${gp.id}/links`, { add: { noteIds: [note.id] } });
    expect(await inboxIds(owner)).not.toContain(note.id);
    await api(owner, 'POST', `/api/v1/game-plans/${gp.id}/links`, { remove: { noteIds: [note.id] } });
    expect(await inboxIds(owner)).toContain(note.id);

    // On the To try list it waits elsewhere; off it again with nothing filing it, it's back.
    expect((await api<NoteView>(owner, 'PATCH', `/api/v1/notes/${note.id}`, { toTry: true })).body).toMatchObject({ inbox: false, toTry: true });
    expect(await inboxIds(owner)).not.toContain(note.id);
    expect((await api<NoteView>(owner, 'PATCH', `/api/v1/notes/${note.id}`, { toTry: false })).body).toMatchObject({ inbox: true, toTry: false });

    // Deleting its only card sends it to the inbox (and undo takes it out again), all without a flag.
    await api(owner, 'PATCH', `/api/v1/notes/${note.id}`, { techniqueIds: [lever.id] });
    expect((await api<{ message: string }>(owner, 'DELETE', `/api/v1/techniques/${lever.id}`)).body.message).toBe('Deleted Lever sweep; 1 note moved to the inbox.');
    expect(await inboxIds(owner)).toContain(note.id);
    await undo(owner);
    expect(await inboxIds(owner)).not.toContain(note.id);
  });

  it('keeps a note with a name that couldn\'t be placed in the inbox, even when something else files it', async () => {
    const ctx = { ...s.ctx, db: forUser(s.db, 1) };
    const saved = await addNote(ctx, { text: 'Lever into the flying unicorn.', techniques: ['Lever sweep', 'Flying unicorn'] });
    expect(saved).toMatchObject({ linked: ['Lever sweep'], inbox: true });
    const listed = (await api<NoteView[]>(owner, 'GET', '/api/v1/notes?inbox=1')).body.find(n => n.id === saved.noteId);
    expect(listed).toMatchObject({ inbox: true, techniques: [expect.objectContaining({ name: 'Lever sweep' })] });
    // Filing it again with names that all match settles it.
    expect(await fileNote(ctx, saved.noteId, ['Lever sweep'])).toBe(`Filed note #${saved.noteId} under Lever sweep.`);
    expect(await inboxIds(owner)).not.toContain(saved.noteId);
    // Undo puts it back as it was: still waiting on the name.
    await undo(owner);
    expect(await inboxIds(owner)).toContain(saved.noteId);
    await api(owner, 'DELETE', `/api/v1/notes/${saved.noteId}`);
  });
});

describe('cards a game plan’s steps use', () => {
  let gp: GamePlanDetail;
  let shuck: TechniqueView;
  let lasso: TechniqueView;
  let stepId: number;

  it('lists a step’s card on the game plan and the plan on the card, without linking it', async () => {
    shuck = await card(owner, 'Arm drag shuck');
    lasso = await card(owner, 'Lasso guard');
    gp = (await api<{ gamePlan: GamePlanDetail }>(owner, 'POST', '/api/v1/game-plans', { name: 'Shuck game', focus: false, techniqueIds: [lasso.id] })).body.gamePlan;
    const added = await api<{ stepId: number; gamePlan: GamePlanDetail }>(owner, 'POST', `/api/v1/game-plans/${gp.id}/steps`, {
      relation: 'then',
      action: 'Shuck',
      techniqueId: shuck.id,
    });
    expect(added.status).toBe(201);
    stepId = added.body.stepId;
    expect(added.body.gamePlan.techniques.map(t => [t.name, t.linked, t.usedInSteps])).toEqual([
      ['Arm drag shuck', false, true],
      ['Lasso guard', true, false],
    ]);
    expect((await s.db.query('select technique_id from game_plan_techniques where game_plan_id = $1', [gp.id])).rows).toEqual([{ technique_id: lasso.id }]);
    expect((await api<TechniqueView>(owner, 'GET', `/api/v1/techniques/${shuck.id}`)).body.gamePlans.map(g => g.id)).toEqual([gp.id]);
  });

  it('won’t unlink a card a step uses, and says which step', async () => {
    const res = await api<{ message: string }>(owner, 'POST', `/api/v1/game-plans/${gp.id}/links`, { remove: { techniqueIds: [shuck.id] } });
    expect(res.status).toBe(400);
    expect(res.body.message).toBe('Arm drag shuck is on Shuck game because a step uses it ("Shuck"). Change or delete the step to take it off.');
    expect((await plan(owner, gp.id)).techniques.map(t => t.name)).toContain('Arm drag shuck');
  });

  it('takes the card off when the step goes, and leaves a link someone made', async () => {
    // A second step uses the linked card too: deleting it leaves the link.
    const lassoStep = (
      await api<{ stepId: number }>(owner, 'POST', `/api/v1/game-plans/${gp.id}/steps`, { relation: 'then', action: 'Lasso', techniqueId: lasso.id })
    ).body.stepId;
    expect((await plan(owner, gp.id)).techniques.find(t => t.id === lasso.id)).toMatchObject({ linked: true, usedInSteps: true });
    await api(owner, 'DELETE', `/api/v1/game-plans/${gp.id}/steps/${lassoStep}`);
    expect((await plan(owner, gp.id)).techniques.find(t => t.id === lasso.id)).toMatchObject({ linked: true, usedInSteps: false });

    const after = await api<{ gamePlan: GamePlanDetail }>(owner, 'DELETE', `/api/v1/game-plans/${gp.id}/steps/${stepId}`);
    expect(after.body.gamePlan.techniques.map(t => t.name)).toEqual(['Lasso guard']);
    expect((await api<TechniqueView>(owner, 'GET', `/api/v1/techniques/${shuck.id}`)).body.gamePlans).toEqual([]);
    expect((await api<TechniqueView>(owner, 'GET', `/api/v1/techniques/${lasso.id}`)).body.gamePlans.map(g => g.id)).toEqual([gp.id]);

    // Undo puts the step back, and with it the card.
    expect((await undo(owner)).body.message).toBe('Undid: edit to "Shuck game"');
    expect((await plan(owner, gp.id)).techniques.map(t => t.name)).toEqual(['Arm drag shuck', 'Lasso guard']);
  });

  it('makes a card a step uses an explicit link when someone links it, so it stays without the step', async () => {
    const linked = await api<{ message: string; gamePlan: GamePlanDetail }>(owner, 'POST', `/api/v1/game-plans/${gp.id}/links`, { add: { techniqueIds: [shuck.id] } });
    expect(linked.body.message).toBe('Linked Arm drag shuck on Shuck game.');
    expect(linked.body.gamePlan.techniques.find(t => t.id === shuck.id)).toMatchObject({ linked: true, usedInSteps: true });
    const steps = (await plan(owner, gp.id)).steps;
    await api(owner, 'DELETE', `/api/v1/game-plans/${gp.id}/steps/${steps[0]!.options[0]!.id}`);
    expect((await plan(owner, gp.id)).techniques.find(t => t.id === shuck.id)).toMatchObject({ linked: true, usedInSteps: false });
  });

  it('keeps each person’s cards to themselves', async () => {
    // Sam's steps use Sam's own cards; they never show up on the owner's game plans or cards, or the other way round.
    const samCard = await card(sam, 'Arm drag shuck');
    const samPlan = (await api<{ gamePlan: GamePlanDetail }>(sam, 'POST', '/api/v1/game-plans', { name: 'Shuck game', focus: false })).body.gamePlan;
    await api(sam, 'POST', `/api/v1/game-plans/${samPlan.id}/steps`, { relation: 'then', action: 'Shuck', techniqueId: samCard.id });
    // A card id that isn't Sam's is dropped from the step.
    const stray = await api<{ gamePlan: GamePlanDetail }>(sam, 'POST', `/api/v1/game-plans/${samPlan.id}/steps`, { relation: 'then', action: 'Lasso', techniqueId: lasso.id });
    expect(stray.body.gamePlan.techniques.map(t => t.id)).toEqual([samCard.id]);
    expect((await api<TechniqueView>(owner, 'GET', `/api/v1/techniques/${lasso.id}`)).body.gamePlans.map(g => g.id)).toEqual([gp.id]);
    expect((await api<TechniqueView>(sam, 'GET', `/api/v1/techniques/${samCard.id}`)).body.gamePlans.map(g => g.id)).toEqual([samPlan.id]);
    expect((await plan(owner, gp.id)).techniques.map(t => t.id).sort()).toEqual([shuck.id, lasso.id].sort());
    expect((await api(sam, 'GET', `/api/v1/game-plans/${gp.id}`)).status).toBe(404);
  });
});
