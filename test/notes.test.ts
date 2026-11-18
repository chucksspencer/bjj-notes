// Notes over the JSON API: adding, editing, filing and deleting them, the To try list, and where notes came from
// (sessions and sources).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NoteCreateResult, NoteView, SessionView, TechniqueListItem, TechniqueView } from '../src/shared/api.js';
import { personWithWorkingList, startServer, type Api, type Person, type TestServer } from './helpers.js';

let s: TestServer;

beforeAll(async () => {
  s = await startServer();
});
afterAll(async () => {
  await s.close();
});

describe('JSON API: notes', () => {
  let p: Person;
  let ghost: TechniqueView;
  const api: Api = (...a) => p.api(...a);
  beforeAll(async () => {
    ({ p, ghost } = await personWithWorkingList(s));
  });

  it('adds, edits, files and deletes notes', async () => {
    const created = await api<NoteCreateResult>('POST', '/api/v1/notes', {
      text: 'Frame on the hip, then turn to the knees.',
      techniqueIds: [ghost.id],
      kind: 'rolling',
      date: '2026-10-12',
      source: { url: 'https://youtu.be/abc123', timestamp: '1:05' },
    });
    expect(created.status).toBe(201);
    const n = created.body.note;
    expect(created.body.message).toBe(`Saved note #${n.id} to Ghost escape.`);
    expect(n).toMatchObject({
      kind: 'rolling',
      observedOn: '2026-10-12',
      createdVia: 'web',
      inbox: false,
      sourceTimestamp: '1:05',
      source: { kind: 'youtube', url: 'https://youtu.be/abc123' },
      techniques: [expect.objectContaining({ id: ghost.id, name: 'Ghost escape' })],
    });

    const byTechnique = (await api<NoteView[]>('GET', `/api/v1/notes?technique=${ghost.id}`)).body;
    expect(byTechnique.map(x => x.id)).toEqual([n.id]);
    expect((await api<NoteView[]>('GET', '/api/v1/notes?q=knees')).body.map(x => x.id)).toEqual([n.id]);

    const moved = (await api<NoteView>('PATCH', `/api/v1/notes/${n.id}`, { techniqueIds: [], body: 'Frame on the hip first.' })).body;
    expect(moved).toMatchObject({ inbox: true, techniques: [], body: 'Frame on the hip first.' });
    const filed = (await api<NoteView>('POST', `/api/v1/notes/${n.id}/file`, { techniqueIds: [ghost.id] })).body;
    expect(filed).toMatchObject({ inbox: false, techniques: [expect.objectContaining({ id: ghost.id })] });

    expect((await api('DELETE', `/api/v1/notes/${n.id}`)).body.message).toBe(`Deleted note #${n.id}.`);
    expect((await api<NoteView[]>('GET', `/api/v1/notes?technique=${ghost.id}`)).body).toEqual([]);
    expect((await api('POST', '/api/v1/undo')).body.message).toBe(`Undid: deleting note #${n.id}`);
    const back = (await api<NoteView[]>('GET', `/api/v1/notes?technique=${ghost.id}`)).body;
    expect(back).toEqual([expect.objectContaining({ id: n.id, body: 'Frame on the hip first.', sourceTimestamp: '1:05' })]);
    expect((await api('POST', '/api/v1/notes', { text: '   ' })).status).toBe(400);
    const sneaky = (await api<NoteCreateResult>('POST', '/api/v1/notes', { text: 'x', source: { url: 'javascript:alert(1)' } })).body;
    expect(sneaky.note.source).toBeNull();
    // Notes citing the same class notes or book share one source.
    const fromNotes = { kind: 'class', title: 'WIMAFC class notes' };
    const one = (await api<NoteCreateResult>('POST', '/api/v1/notes', { text: 'Clock armbar.', source: fromNotes })).body.note;
    const two = (await api<NoteCreateResult>('POST', '/api/v1/notes', { text: 'Flower sweep.', source: fromNotes })).body.note;
    expect(one.source).toMatchObject({ kind: 'class', title: 'WIMAFC class notes', url: null });
    expect(two.source!.id).toBe(one.source!.id);
  });

  it('keeps videos on the To try list until they are kept or tossed', async () => {
    const list = async (q: string) => (await api<NoteView[]>('GET', `/api/v1/notes?${q}&limit=200`)).body.map(n => n.id);
    const reel = (
      await api<NoteCreateResult>('POST', '/api/v1/notes', {
        text: 'Instagram reel to try.',
        source: { url: 'https://www.instagram.com/reel/TryMe123/?igsh=x' },
        toTry: true,
      })
    ).body;
    expect(reel.message).toBe(`Added note #${reel.note.id} to try.`);
    expect(reel.note).toMatchObject({ toTry: true, inbox: false });
    expect(await list('toTry=1')).toContain(reel.note.id);
    expect(await list('inbox=1')).not.toContain(reel.note.id); // not cluttering the inbox

    // One about a technique already: still waits on the list, and shows on the card marked as untried.
    const about = (await api<NoteCreateResult>('POST', '/api/v1/notes', { text: 'Ghost to darce.', techniqueIds: [ghost.id], toTry: true })).body
      .note;
    expect((await api<TechniqueView>('GET', `/api/v1/techniques/${ghost.id}`)).body.notes.find(n => n.id === about.id)?.toTry).toBe(true);

    // Kept: filed under a technique with a real takeaway, off the list.
    const kept = (
      await api<NoteView>('PATCH', `/api/v1/notes/${reel.note.id}`, { body: 'Hide the near arm.', techniqueIds: [ghost.id], toTry: false })
    ).body;
    expect(kept).toMatchObject({ toTry: false, inbox: false, body: 'Hide the near arm.' });
    expect(await list('toTry=1')).not.toContain(reel.note.id);
    // Undo puts it back on the list as it was.
    await api('POST', '/api/v1/undo');
    expect((await api<NoteView[]>('GET', '/api/v1/notes?toTry=1&limit=200')).body.find(n => n.id === reel.note.id)).toMatchObject({
      toTry: true,
      body: 'Instagram reel to try.',
      techniques: [],
    });
    // Taken off the list with nothing to file it under: it needs filing, so it goes to the inbox.
    expect((await api<NoteView>('PATCH', `/api/v1/notes/${reel.note.id}`, { toTry: false })).body).toMatchObject({ toTry: false, inbox: true });
    // Filing also keeps a to-try note.
    const filed = (await api<NoteView>('POST', `/api/v1/notes/${about.id}/file`, { techniqueIds: [ghost.id] })).body;
    expect(filed).toMatchObject({ toTry: false, inbox: false });
    // Kept under a technique that doesn't exist yet; undo takes the new card away again.
    const fresh = (await api<NoteCreateResult>('POST', '/api/v1/notes', { text: 'Chair sit gift wrap.', toTry: true })).body.note;
    const keptNew = (
      await api<NoteView>('PATCH', `/api/v1/notes/${fresh.id}`, {
        toTry: false,
        newTechniques: [{ name: 'Chair sit gift wrap', type: 'control', role: 'top' }],
      })
    ).body;
    expect(keptNew).toMatchObject({ toTry: false, inbox: false, techniques: [expect.objectContaining({ name: 'Chair sit gift wrap' })] });
    expect((await api('POST', '/api/v1/undo')).body.message).toBe(`Undid: keeping note #${fresh.id}`);
    expect((await api<TechniqueListItem[]>('GET', '/api/v1/techniques?q=chair%20sit%20gift')).body.map(t => t.name)).not.toContain(
      'Chair sit gift wrap',
    );
    await api('POST', '/api/v1/notes/delete', { ids: [reel.note.id, about.id, fresh.id] }); // tossed
  });
});

describe('JSON API: where notes came from', () => {
  let p: Person;
  let ghost: TechniqueView;
  const api: Api = (...a) => p.api(...a);
  beforeAll(async () => {
    ({ p, ghost } = await personWithWorkingList(s));
  });

  it('records where notes came from, reusing sessions and undoing cleanly', async () => {
    const note = async (noteId: number) => (await api<NoteView[]>('GET', '/api/v1/notes?limit=200')).body.find(x => x.id === noteId)!;
    const sessions = async () => (await api<SessionView[]>('GET', '/api/v1/sessions')).body;

    // A named seminar with an instructor; the note takes the seminar's date.
    const a = (
      await api<NoteCreateResult>('POST', '/api/v1/notes', {
        text: 'Hide the near arm before the turn.',
        techniqueIds: [ghost.id],
        session: { kind: 'seminar', name: 'Zen camp', instructor: 'Josh Jones', date: '2024-02-03' },
      })
    ).body;
    expect(a.message).toBe(`Saved note #${a.note.id} to Ghost escape (from Zen camp seminar by Josh Jones on 2024-02-03).`);
    expect(a.note.observedOn).toBe('2024-02-03');
    expect(a.note.session).toMatchObject({ kind: 'seminar', name: 'Zen camp', instructor: 'Josh Jones', date: '2024-02-03' });

    // The same seminar described differently is reused, and gains the detail it was missing.
    const b = (
      await api<NoteCreateResult>('POST', '/api/v1/notes', {
        text: 'Elbow to knee is everything.',
        date: '2024-02-03',
        session: { kind: 'seminar', instructor: 'josh jones', location: 'Austin', name: '' },
      })
    ).body;
    expect(b.note.session).toMatchObject({ id: a.note.session!.id, name: 'Zen camp', location: 'Austin' });
    // A different seminar the same day is a second session.
    const other = (
      await api<NoteCreateResult>('POST', '/api/v1/notes', { text: 'Wrestling ups.', date: '2024-02-03', session: { kind: 'seminar', name: 'Wrestling day' } })
    ).body;
    expect(other.note.session!.id).not.toBe(a.note.session!.id);
    await api('POST', '/api/v1/undo'); // takes the second seminar with it
    await api('POST', '/api/v1/undo'); // puts back the missing detail
    expect((await note(b.note.id)) ?? null).toBeNull();
    expect((await sessions()).find(x => x.id === a.note.session!.id)!.location).toBeNull();

    // Search finds notes by where they came from.
    expect((await api<NoteView[]>('GET', '/api/v1/notes?q=Josh Jones')).body.map(x => x.id)).toEqual([a.note.id]);

    // A class on another day; then moving a note between sessions, clearing it, and undo.
    const c = (await api<NoteCreateResult>('POST', '/api/v1/notes', { text: 'Class note.', date: '2026-10-12', session: { kind: 'class' } })).body;
    expect(c.message).toBe(`Saved note #${c.note.id} (from class on 2026-10-12); left in the inbox to file later.`);
    expect((await sessions()).map(x => [x.kind, x.date])).toEqual([
      ['class', '2026-10-12'],
      ['seminar', '2024-02-03'],
    ]);
    expect((await api<NoteView>('PATCH', `/api/v1/notes/${c.note.id}`, { sessionId: a.note.session!.id })).body.session!.name).toBe('Zen camp');
    expect((await api<NoteView>('PATCH', `/api/v1/notes/${c.note.id}`, { sessionId: null })).body.session).toBeNull();
    await api('POST', '/api/v1/undo');
    expect((await note(c.note.id)).session!.name).toBe('Zen camp');

    // A note left alone attaches to the day's only session; an explicit null doesn't.
    const d = (await api<NoteCreateResult>('POST', '/api/v1/notes', { text: 'Later that day.', date: '2026-10-12' })).body;
    expect(d.note.session).toMatchObject({ kind: 'class', date: '2026-10-12' });
    const e = (await api<NoteCreateResult>('POST', '/api/v1/notes', { text: 'Watched at home.', date: '2026-10-12', sessionId: null })).body;
    expect(e.note.session).toBeNull();

    expect((await api('POST', '/api/v1/notes', { text: 'x', sessionId: 999_999 })).status).toBe(404);
    expect((await api('POST', '/api/v1/notes', { text: 'x', session: { kind: 'party' } })).status).toBe(400);
  });

  it('finds techniques and notes by where the notes came from', async () => {
    const names = async (q: string) =>
      (await api<TechniqueListItem[]>('GET', `/api/v1/techniques?q=${encodeURIComponent(q)}`)).body.map(t => t.name);
    // Ghost escape has a note from the Zen camp seminar by Josh Jones (added above).
    expect(await names('zen camp')).toContain('Ghost escape');
    expect(await names('josh jon')).toContain('Ghost escape'); // partial words, as you type
    expect(await names('Jones seminar')).toContain('Ghost escape'); // any order, and the kind of session counts
    expect(await names('zen wrestling')).not.toContain('Ghost escape'); // every word has to match
    expect(await names('jo')).not.toContain('Ghost escape'); // too short to search origins
    await api('POST', '/api/v1/notes', { text: 'Frames first.', techniqueIds: [ghost.id], source: { kind: 'class', title: 'Fight Prime class notes' } });
    expect(await names('fight prime')).toContain('Ghost escape');
    expect((await api<NoteView[]>('GET', '/api/v1/notes?q=fight%20pri')).body.map(n => n.body)).toContain('Frames first.');
  });
});
