// Stars, questions for the coach and the Lab over the JSON API.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { LabView, NoteCreateResult, NoteView, TechniqueListItem, TechniqueView } from '../src/shared/api.js';
import { personWithWorkingList, startServer, type Api, type Person, type TestServer } from './helpers.js';

let s: TestServer;

beforeAll(async () => {
  s = await startServer();
});
afterAll(async () => {
  await s.close();
});

describe('JSON API: stars and the Lab', () => {
  let p: Person;
  let ghost: TechniqueView;
  const api: Api = (...a) => p.api(...a);
  beforeAll(async () => {
    ({ p, ghost } = await personWithWorkingList(s));
  });

  it('stars notes and lists what is new for the Lab', async () => {
    const a = (await api<NoteCreateResult>('POST', '/api/v1/notes', { text: 'Star me first.', techniqueIds: [ghost.id], starred: true })).body.note;
    expect(a).toMatchObject({ starred: true });
    const b = (await api<NoteCreateResult>('POST', '/api/v1/notes', { text: 'Star me second.', techniqueIds: [ghost.id] })).body.note;
    expect(b.starred).toBe(false);
    expect((await api<NoteView>('PATCH', `/api/v1/notes/${b.id}`, { starred: true })).body.starred).toBe(true);
    // Most recently starred first.
    const starred = (await api<NoteView[]>('GET', '/api/v1/notes?starred=1')).body.map(n => n.id);
    expect(starred.slice(0, 2)).toEqual([b.id, a.id]);
    expect((await api<NoteView>('PATCH', `/api/v1/notes/${a.id}`, { starred: false })).body.starred).toBe(false);
    expect((await api<NoteView[]>('GET', '/api/v1/notes?starred=1')).body.map(n => n.id)).not.toContain(a.id);
    // Questions for the coach.
    const q = (await api<NoteCreateResult>('POST', '/api/v1/notes', { text: 'Ask about frames?', kind: 'question', techniqueIds: [ghost.id] })).body.note;
    expect((await api<NoteView[]>('GET', '/api/v1/notes?kind=question')).body.map(n => n.id)).toContain(q.id);

    // New in your notes: first noted on or after the date; a card only noted in an untried video doesn't count yet.
    const fresh = (await api<TechniqueView>('POST', '/api/v1/techniques', { name: 'Gogoplata', type: 'submission' })).body;
    await api('POST', '/api/v1/notes', { text: 'Gogo from rubber guard.', techniqueIds: [fresh.id], date: '2026-10-01', toTry: true });
    const newSince = async (d: string) =>
      (await api<TechniqueListItem[]>('GET', `/api/v1/techniques?sort=new&newSince=${d}`)).body.map(t => [t.name, t.firstNoteOn]);
    expect((await newSince('2026-09-01')).map(([n]) => n)).not.toContain('Gogoplata');
    await api('POST', '/api/v1/notes', { text: 'Hit the gogo in rolling.', techniqueIds: [fresh.id], date: '2026-10-02', kind: 'rolling' });
    expect(await newSince('2026-09-01')).toContainEqual(['Gogoplata', '2026-10-02']);
    expect((await newSince('2026-10-03')).map(([n]) => n)).not.toContain('Gogoplata');
    await api('POST', '/api/v1/techniques/delete', { ids: [fresh.id] });
  });

  it('stars techniques and serves the whole Lab in one call', async () => {
    const make = (name: string) => api<TechniqueView>('POST', '/api/v1/techniques', { name, type: 'pass', role: 'top' });
    const a = (await make('Leg drag')).body;
    const b = (await make('Long step')).body;
    expect(a.starred).toBe(false);

    const starredA = (await api<TechniqueView>('PATCH', `/api/v1/techniques/${a.id}`, { starred: true })).body;
    expect(starredA).toMatchObject({ starred: true, name: 'Leg drag' });
    expect(starredA.updatedAt).toBe(a.updatedAt); // starring isn't an edit
    await api('PATCH', `/api/v1/techniques/${b.id}`, { starred: true });
    // Most recently starred first; the list marks them too.
    const starred = (await api<TechniqueListItem[]>('GET', '/api/v1/techniques?starred=1')).body;
    expect(starred.map(t => t.name)).toEqual(['Long step', 'Leg drag']);
    expect((await api<TechniqueListItem[]>('GET', '/api/v1/techniques?q=leg+drag')).body[0]).toMatchObject({ name: 'Leg drag', starred: true });

    const note = (await api<NoteCreateResult>('POST', '/api/v1/notes', { text: 'Drag the leg across, then hip in.', techniqueIds: [a.id], starred: true })).body.note;
    const question = (await api<NoteCreateResult>('POST', '/api/v1/notes', { text: 'Leg drag or knee cut first?', kind: 'question', techniqueIds: [a.id] })).body.note;
    const lab = (await api<LabView>('GET', '/api/v1/lab')).body;
    expect(lab.days).toBe(30);
    expect(lab.today).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(lab.starred.techniques.map(t => t.name).slice(0, 2)).toEqual(['Long step', 'Leg drag']);
    expect(lab.starred.notes[0]!.id).toBe(note.id);
    expect(lab.fresh.find(t => t.id === a.id)).toMatchObject({ starred: true, firstNoteOn: lab.today });
    expect(lab.questions.map(n => n.id)).toContain(question.id);
    expect(lab.toTry.total).toBeGreaterThanOrEqual(lab.toTry.notes.length);

    // Unstar, and undo it.
    expect((await api<TechniqueView>('PATCH', `/api/v1/techniques/${b.id}`, { starred: false })).body.starred).toBe(false);
    expect((await api('POST', '/api/v1/undo')).body.message).toBe('Undid: unstarring Long step');
    expect((await api<TechniqueView>('GET', `/api/v1/techniques/${b.id}`)).body.starred).toBe(true);
    // Deleting a starred card and undoing it brings the star back too.
    await api('DELETE', `/api/v1/techniques/${a.id}`);
    await api('POST', '/api/v1/undo');
    expect((await api<TechniqueView>('GET', `/api/v1/techniques/${a.id}`)).body.starred).toBe(true);

    await api('POST', '/api/v1/notes/delete', { ids: [note.id, question.id] });
    await api('POST', '/api/v1/techniques/delete', { ids: [a.id, b.id] });
  });

  it('folds old stars and questions away in the Lab, clears stars, and marks questions answered', async () => {
    const t = (await api<TechniqueView>('POST', '/api/v1/techniques', { name: 'Wrestle up', type: 'transition', role: 'bottom' })).body;
    await api('PATCH', `/api/v1/techniques/${t.id}`, { starred: true });
    const fresh = (await api<NoteCreateResult>('POST', '/api/v1/notes', { text: 'Fresh star.', techniqueIds: [t.id], starred: true })).body.note;
    const stale = (await api<NoteCreateResult>('POST', '/api/v1/notes', { text: 'Stale star.', techniqueIds: [t.id], starred: true })).body.note;
    await s.db.query("update notes set starred_at = now() - interval '40 days' where id = $1", [stale.id]);
    await s.db.query("update techniques set starred_at = now() - interval '30 days' where id = $1", [t.id]);

    let lab = (await api<LabView>('GET', '/api/v1/lab')).body;
    expect(lab.starDays).toBe(28);
    expect(lab.starred.notes.map(n => n.id)).toContain(fresh.id);
    expect(lab.starred.notes.map(n => n.id)).not.toContain(stale.id);
    expect(lab.olderStarred.notes.map(n => n.id)).toEqual([stale.id]);
    expect(lab.olderStarred.techniques.map(x => x.id)).toEqual([t.id]);
    expect(Date.parse(lab.starred.notes.find(n => n.id === fresh.id)!.starredAt!)).toBeGreaterThan(Date.now() - 60_000); // ISO, parseable

    // Unstar just the older ones, then put them back with one undo.
    expect((await api('POST', '/api/v1/stars/clear', { olderThanDays: 28 })).body.message).toBe('Cleared 2 stars.');
    lab = (await api<LabView>('GET', '/api/v1/lab')).body;
    expect(lab.olderStarred).toEqual({ techniques: [], notes: [] });
    expect(lab.starred.notes.map(n => n.id)).toContain(fresh.id);
    expect((await api('POST', '/api/v1/undo')).body.message).toBe('Undid: clearing 2 stars');
    lab = (await api<LabView>('GET', '/api/v1/lab')).body;
    expect(lab.olderStarred.notes.map(n => n.id)).toEqual([stale.id]);
    // Clear everything.
    expect((await api('POST', '/api/v1/stars/clear', {})).body.message).toMatch(/^Cleared \d+ stars?\.$/);
    lab = (await api<LabView>('GET', '/api/v1/lab')).body;
    expect(lab.starred.notes.length + lab.starred.techniques.length + lab.olderStarred.notes.length).toBe(0);
    expect((await api('POST', '/api/v1/stars/clear', {})).body.message).toBe('Nothing is starred.');

    // Questions: recent ones in Ask coach, older ones folded away; answered ones leave and keep their kind.
    const ask = async (text: string, date?: string) =>
      (await api<NoteCreateResult>('POST', '/api/v1/notes', { text, kind: 'question', techniqueIds: [t.id], date })).body.note;
    const recentQ = await ask('Which hand posts first?');
    const oldQ1 = await ask('Old question one?', '2025-01-10');
    const oldQ2 = await ask('Old question two?', '2025-02-10');
    lab = (await api<LabView>('GET', '/api/v1/lab')).body;
    expect(lab.questions.map(n => n.id)).toContain(recentQ.id);
    expect(lab.olderQuestions.map(n => n.id)).toEqual(expect.arrayContaining([oldQ1.id, oldQ2.id]));
    expect(lab.questions.map(n => n.id)).not.toContain(oldQ1.id);

    const answered = (await api<NoteView>('PATCH', `/api/v1/notes/${recentQ.id}`, { body: 'Which hand posts first?\n\nAnswer: the near hand.', answered: true })).body;
    expect(answered).toMatchObject({ kind: 'question', answered: true });
    expect((await api('POST', '/api/v1/notes/answered', { ids: [oldQ1.id, oldQ2.id, recentQ.id] })).body.message).toBe('Marked 2 questions answered.');
    lab = (await api<LabView>('GET', '/api/v1/lab')).body;
    expect([...lab.questions, ...lab.olderQuestions].map(n => n.id)).not.toEqual(expect.arrayContaining([oldQ1.id]));
    expect((await api('POST', '/api/v1/undo')).body.message).toBe('Undid: marking 2 questions answered');
    lab = (await api<LabView>('GET', '/api/v1/lab')).body;
    expect(lab.olderQuestions.map(n => n.id)).toEqual(expect.arrayContaining([oldQ1.id, oldQ2.id]));
    expect(lab.questions.map(n => n.id)).not.toContain(recentQ.id); // answered on its own, before the batch

    await api('POST', '/api/v1/notes/delete', { ids: [fresh.id, stale.id, recentQ.id, oldQ1.id, oldQ2.id] });
    await api('POST', '/api/v1/techniques/delete', { ids: [t.id] });
  });
});
