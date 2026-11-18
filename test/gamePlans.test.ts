// The focus list and game plan pages over the JSON API: ranks, on and off focus, descriptions, linked cards and
// notes, with undo. Steps are in gamePlanSteps.test.ts.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FocusView, GamePlanDetail, GamePlansView, NoteCreateResult, NoteView, TechniqueView } from '../src/shared/api.js';
import { personWithWorkingList, seedNote, seedTechnique, startServer, type Api, type Person, type TestServer } from './helpers.js';

let s: TestServer;

beforeAll(async () => {
  s = await startServer();
});
afterAll(async () => {
  await s.close();
});

describe('JSON API: the focus list', () => {
  let p: Person;
  const api: Api = (...a) => p.api(...a);
  beforeAll(async () => {
    let ghost: TechniqueView;
    ({ p, ghost } = await personWithWorkingList(s));
    // The latest note on Ghost escape, and a card a new game plan's name can mention.
    await seedNote(p, { text: 'Frame on the hip first.', techniqueIds: [ghost.id], date: '2026-10-12' });
    await seedTechnique(p, { name: 'Kimura lock', type: 'submission', status: 'drilling', aliases: ['double wristlock', 'Kimura'] });
  });

  it('runs the focus list by id', async () => {
    let focus = (await api<FocusView>('GET', '/api/v1/focus')).body;
    expect(focus.active.map(f => f.rank)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    const ghostItem = focus.active.find(f => f.name === 'Ghost escape')!;
    // No second copy of the name under the old focus items' field.
    expect(ghostItem).not.toHaveProperty('label');
    expect(ghostItem.techniques.map(t => t.name)).toEqual(['Ghost escape']);
    expect(ghostItem.lastNoteOn).toBe('2026-10-12');

    focus = (await api('POST', `/api/v1/focus/${ghostItem.id}/actions`, { action: 'move', position: 1 })).body.focus;
    expect(focus.active[0]!.name).toBe('Ghost escape');
    const off = await api('POST', `/api/v1/focus/${ghostItem.id}/actions`, { action: 'remove' });
    expect(off.body.message).toBe('Taken off focus: Ghost escape.');
    expect(off.body.focus.active.map((f: { rank: number }) => f.rank)).toEqual([1, 2, 3, 4, 5, 6]);
    // Off focus, the game plan is still there.
    const gamePlans = (await api<GamePlansView>('GET', '/api/v1/game-plans')).body.gamePlans;
    expect(gamePlans.find(a => a.id === ghostItem.id)).toMatchObject({ name: 'Ghost escape', rank: null });
    expect(gamePlans.slice(0, 6).map(a => a.rank)).toEqual([1, 2, 3, 4, 5, 6]);
    // Only add, move and remove: the older names (resume, pause...) are gone.
    expect((await api('POST', `/api/v1/focus/${ghostItem.id}/actions`, { action: 'resume', position: 3 })).status).toBe(400);
    const back = await api('POST', `/api/v1/focus/${ghostItem.id}/actions`, { action: 'add', position: 3 });
    expect(back.body.message).toBe('On focus at #3: Ghost escape.');
    await api('POST', `/api/v1/focus/${ghostItem.id}/actions`, { action: 'remove' });

    const added = await api<{ message: string; gamePlan: GamePlanDetail }>('POST', '/api/v1/game-plans', { name: 'Kimura from guard', techniqueIds: [], position: 2 });
    expect(added.status).toBe(201);
    expect(added.body.message).toBe('New game plan, on focus at #2: Kimura from guard (linked to Kimura lock).');
    const item = added.body.gamePlan;
    expect(item.rank).toBe(2);
    const renamed = await api('PATCH', `/api/v1/game-plans/${item.id}`, { name: 'Kimura from closed guard', description: 'Hit it live' });
    expect(renamed.body.gamePlan).toMatchObject({ name: 'Kimura from closed guard', description: 'Hit it live' });
    expect(renamed.body.gamePlan).not.toHaveProperty('goal');
    expect((await api('POST', '/api/v1/undo')).body.message).toBe('Undid: edit to "Kimura from guard"');
    // A game plan made off focus stays off it.
    const quiet = await api<{ gamePlan: GamePlanDetail }>('POST', '/api/v1/game-plans', { name: 'Wrist locks', focus: false });
    expect(quiet.body.gamePlan.rank).toBeNull();
    expect((await api('POST', '/api/v1/undo')).body.message).toBe('Undid: new game plan "Wrist locks"');
    expect((await api('GET', `/api/v1/game-plans/${quiet.body.gamePlan.id}`)).status).toBe(404);
    expect((await api('POST', `/api/v1/focus/99999/actions`, { action: 'remove' })).status).toBe(404);
  });
});

describe('JSON API: game plan pages', () => {
  let p: Person;
  let ghost: TechniqueView;
  const api: Api = (...a) => p.api(...a);
  beforeAll(async () => {
    ({ p, ghost } = await personWithWorkingList(s));
    // Notes on Ghost escape, to show as related on a game plan it's linked to.
    await seedNote(p, { text: 'Frame on the hip first.', techniqueIds: [ghost.id], date: '2026-10-12' });
    await seedNote(p, { text: 'Hide the near arm before the turn.', techniqueIds: [ghost.id], date: '2024-02-03' });
  });

  it('gives each game plan its own page, with a description and linked notes', async () => {
    const item = async (id: number) => (await api<GamePlanDetail>('GET', `/api/v1/game-plans/${id}`)).body;
    const undo = async () => (await api('POST', '/api/v1/undo')).body.message as string;

    // A note with no technique, filed under a new game plan from the start (an id that isn't a note is skipped).
    const calm = (await api<NoteCreateResult>('POST', '/api/v1/notes', { text: 'Long exhale when pinned.', date: '2026-10-20' })).body.note;
    expect(calm.inbox).toBe(true);
    const created = await api<{ message: string; gamePlan: GamePlanDetail }>('POST', '/api/v1/game-plans', {
      name: 'Breathe and stay calm',
      description: 'Slow down under pressure.\nGoal: no panic taps.',
      noteIds: [calm.id, 999_999],
      position: 1,
    });
    expect(created.body.message).toBe('New game plan, on focus at #1: Breathe and stay calm (linked 1 note; not linked to a technique card yet).');
    expect(created.body.gamePlan).toMatchObject({
      name: 'Breathe and stay calm',
      rank: 1,
      description: 'Slow down under pressure.\nGoal: no panic taps.',
      techniques: [],
      stepCount: 0,
      noteCount: 1,
      lastNoteOn: '2026-10-20', // a linked note counts, with no technique in common
    });
    const id = created.body.gamePlan.id;

    let page = await item(id);
    expect(page).toMatchObject({ rank: 1, steps: [], relatedNotes: [], relatedCount: 0 });
    expect(page.notes.map(n => n.id)).toEqual([calm.id]);
    expect(page.notes[0]!.gamePlans).toEqual([{ id, name: 'Breathe and stay calm', rank: 1 }]);
    expect(page.history.map(h => [h.event, h.toRank])).toEqual([['added', 1]]);
    expect(Date.parse(page.createdAt)).not.toBeNaN();
    expect((await api('GET', '/api/v1/game-plans/999999')).status).toBe(404);
    // Filed under a game plan, the note is filed: it's out of the inbox.
    expect((await api<NoteView[]>('GET', '/api/v1/notes?inbox=1&limit=200')).body.map(n => n.id)).not.toContain(calm.id);

    // Link a technique: its notes show as related until they're linked too.
    const ghostNotes = (await api<TechniqueView>('GET', `/api/v1/techniques/${ghost.id}`)).body.noteCount;
    let linked = await api('POST', `/api/v1/game-plans/${id}/links`, { add: { techniqueIds: [ghost.id] } });
    expect(linked.body.message).toBe('Linked Ghost escape on Breathe and stay calm.');
    page = linked.body.gamePlan;
    expect(page.techniques.map(t => t.name)).toEqual(['Ghost escape']);
    expect(page.relatedCount).toBe(ghostNotes);
    const pin = page.relatedNotes[0]!;
    linked = await api('POST', `/api/v1/game-plans/${id}/links`, { add: { noteIds: [pin.id] } });
    expect(linked.body.message).toBe('Linked 1 note on Breathe and stay calm.');
    expect(linked.body.gamePlan.notes.map((n: NoteView) => n.id).sort()).toEqual([calm.id, pin.id].sort());
    expect(linked.body.gamePlan.relatedCount).toBe(ghostNotes - 1);
    expect(linked.body.gamePlan.noteCount).toBe(2);
    expect((await api('POST', `/api/v1/game-plans/${id}/links`, { add: { noteIds: [pin.id] } })).body.message).toBe('Nothing changed on Breathe and stay calm.');
    expect((await api<TechniqueView>('GET', `/api/v1/techniques/${ghost.id}`)).body.gamePlans.map(a => a.name)).toContain('Breathe and stay calm');

    // Unlinking, and undoing each step.
    linked = await api('POST', `/api/v1/game-plans/${id}/links`, { remove: { noteIds: [pin.id], techniqueIds: [ghost.id] } });
    expect(linked.body.message).toBe('Unlinked Ghost escape, 1 note on Breathe and stay calm.');
    expect(await undo()).toBe('Undid: links on "Breathe and stay calm"');
    expect((await item(id)).notes).toHaveLength(2);
    expect(await undo()).toBe('Undid: links on "Breathe and stay calm"'); // the note link
    expect(await undo()).toBe('Undid: links on "Breathe and stay calm"'); // the technique link
    page = await item(id);
    expect([page.techniques, page.notes.map(n => n.id)]).toEqual([[], [calm.id]]);

    // The name, aliases and description, undoably; an empty description clears it.
    let edited = await api('PATCH', `/api/v1/game-plans/${id}`, { description: 'Exhale.', aliases: ['calm', ' calm ', 'breathing'] });
    expect(edited.body.gamePlan).toMatchObject({ description: 'Exhale.', aliases: ['calm', 'breathing'] });
    expect(edited.body.message).toBe('Breathe and stay calm: aliases updated; description updated.');
    expect(await undo()).toBe('Undid: edit to "Breathe and stay calm"');
    expect(await item(id)).toMatchObject({ description: 'Slow down under pressure.\nGoal: no panic taps.', aliases: [] });
    edited = await api('PATCH', `/api/v1/game-plans/${id}`, { name: 'Stay calm', description: '' });
    expect(edited.body.gamePlan).toMatchObject({ name: 'Stay calm', description: null });
    await undo();

    // From the note's side: its game plans are replaced, undoably. With none left, it's back in the inbox.
    let note = (await api<NoteView>('PATCH', `/api/v1/notes/${calm.id}`, { gamePlanIds: [] })).body;
    expect([note.gamePlans, note.inbox]).toEqual([[], true]);
    expect((await item(id)).noteCount).toBe(0);
    await undo();
    expect((await item(id)).notes.map(n => n.id)).toEqual([calm.id]);
    note = (await api<NoteCreateResult>('POST', '/api/v1/notes', { text: 'Breathe through the nose.', techniqueIds: [ghost.id], gamePlanIds: [id, 999_999] }))
      .body.note;
    expect(note.gamePlans.map(f => f.id)).toEqual([id]);

    // Deleting a note takes its link with it; undoing the delete brings both back.
    await api('DELETE', `/api/v1/notes/${calm.id}`);
    expect((await item(id)).notes.map(n => n.id)).toEqual([note.id]);
    expect(await undo()).toBe(`Undid: deleting note #${calm.id}`);
    expect((await item(id)).notes.map(n => n.id).sort()).toEqual([calm.id, note.id].sort());

    // An entry saved by an older version, under an op that has since been renamed, is refused rather than skipped,
    // inside a batch too; nothing changes and it stays in the log.
    for (const op of [{ kind: 'restore_area', before: {} }, { kind: 'batch', ops: [{ kind: 'restore_focus_label', itemId: id }] }]) {
      await s.db.query("insert into activity_log (action, summary, undo, user_id) values ('edit_area', 'old entry', $1, $2)", [JSON.stringify(op), p.id]);
      const r = await api('POST', '/api/v1/undo');
      expect([r.status, r.body.message]).toEqual([400, '"old entry" was saved by an older version of the app and can\'t be undone.']);
      await s.db.query("delete from activity_log where summary = 'old entry'");
    }

  });
});
