import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  FocusView,
  NoteCreateResult,
  NoteView,
  PositionListItem,
  PositionView,
  SessionView,
  TechniqueListItem,
  TechniqueView,
} from '../src/shared/api.js';
import { API_TOKEN, OWNER_PASSWORD, startServer, type TestServer } from './helpers.js';

let s: TestServer;
let cookie = '';
let webDir: string;

async function api<T = any>(method: string, p: string, body?: unknown, opts: { csrf?: boolean; auth?: 'cookie' | 'bearer' | 'none' } = {}) {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (opts.csrf !== false) headers['x-bjj-app'] = '1';
  const auth = opts.auth ?? 'cookie';
  if (auth === 'cookie' && cookie) headers.cookie = cookie;
  if (auth === 'bearer') headers.authorization = `Bearer ${API_TOKEN}`;
  const res = await fetch(`${s.base}${p}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, headers: res.headers, body: (text && res.headers.get('content-type')?.includes('json') ? JSON.parse(text) : text) as T };
}

beforeAll(async () => {
  webDir = mkdtempSync(path.join(tmpdir(), 'bjj-web-'));
  mkdirSync(path.join(webDir, 'assets'));
  writeFileSync(path.join(webDir, 'index.html'), '<!doctype html><title>BJJ Notes</title><div id="root"></div>');
  writeFileSync(path.join(webDir, 'assets', 'app-abc123.js'), 'console.log(1)');
  writeFileSync(path.join(webDir, 'manifest.webmanifest'), '{}');
  s = await startServer(null, webDir);
});
afterAll(async () => {
  await s.close();
});

describe('web sign-in', () => {
  it('rejects anonymous API calls and wrong passwords', async () => {
    expect((await api('GET', '/api/v1/focus', undefined, { auth: 'none' })).status).toBe(401);
    expect((await api('GET', '/api/v1/session', undefined, { auth: 'none' })).body).toEqual({ signedIn: false });
    expect((await api('POST', '/api/v1/session', { password: 'nope' }, { auth: 'none' })).status).toBe(401);
    expect((await api('POST', '/api/v1/session', { password: OWNER_PASSWORD }, { auth: 'none', csrf: false })).status).toBe(403);
  });

  it('signs in with the owner password and sets a locked-down cookie', async () => {
    const res = await api('POST', '/api/v1/session', { password: OWNER_PASSWORD }, { auth: 'none' });
    expect(res.status).toBe(204);
    const setCookie = res.headers.get('set-cookie')!;
    expect(setCookie).toMatch(/^bjj_session=[\w-]{20,};/);
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Lax');
    expect(setCookie).not.toContain('Secure'); // http://localhost in tests
    cookie = setCookie.split(';')[0]!;
    expect((await api('GET', '/api/v1/session')).body).toEqual({ signedIn: true });
  });

  it('requires the app header on writes made with the cookie, but not with the API token', async () => {
    expect((await api('POST', '/api/v1/undo', undefined, { csrf: false })).status).toBe(403);
    expect((await api('GET', '/api/v1/focus', undefined, { csrf: false })).status).toBe(200);
    expect((await api('GET', '/api/v1/focus', undefined, { auth: 'bearer', csrf: false })).status).toBe(200);
  });
});

describe('JSON API', () => {
  let ghost: TechniqueListItem;

  it('lists techniques with filters', async () => {
    const all = (await api<TechniqueListItem[]>('GET', '/api/v1/techniques')).body;
    expect(all.map(t => t.name)).toEqual([
      'Ankle lock',
      'Baratoplata',
      'Body lock pass',
      'Ghost escape',
      'Leg elevation',
      'Shoulder crunch',
      'Shoulder lock to paper cutter choke',
    ]);
    ghost = all.find(t => t.name === 'Ghost escape')!;
    expect(ghost.edges).toEqual([{ from: 'Side control', fromRole: 'bottom', to: null, toRole: null }]);
    const subs = (await api<TechniqueListItem[]>('GET', '/api/v1/techniques?type=submission')).body;
    expect(subs.map(t => t.name)).toEqual(['Ankle lock', 'Baratoplata', 'Shoulder lock to paper cutter choke']);
    const fuzzy = (await api<TechniqueListItem[]>('GET', '/api/v1/techniques?q=barra%20toe%20plata')).body;
    expect(fuzzy[0]!.name).toBe('Baratoplata');
    expect((await api('GET', '/api/v1/techniques?type=nonsense')).status).toBe(400);
  });

  it('creates, edits, links and deletes technique cards, with undo', async () => {
    const created = await api<TechniqueView>('POST', '/api/v1/techniques', { name: 'Kimura', type: 'submission', role: 'bottom' });
    expect(created.status).toBe(201);
    const kimura = created.body;
    expect(kimura).toMatchObject({ name: 'Kimura', type: 'submission', role: 'bottom', status: 'seen', noteCount: 0 });
    expect((await api('POST', '/api/v1/techniques', { name: 'kimura', type: 'submission' })).status).toBe(409);

    const patched = await api<TechniqueView>('PATCH', `/api/v1/techniques/${kimura.id}`, {
      status: 'drilling',
      keyDetails: ['Thumbless grip', 'Hip out first'],
      aliases: ['double wristlock'],
      name: 'Kimura lock',
    });
    expect(patched.body).toMatchObject({ name: 'Kimura lock', status: 'drilling', keyDetails: ['Thumbless grip', 'Hip out first'] });
    expect(patched.body.aliases).toEqual(['double wristlock', 'Kimura']);
    const cleared = await api<TechniqueView>('PATCH', `/api/v1/techniques/${kimura.id}`, { keyDetails: ['Hip out first'], role: null });
    expect(cleared.body).toMatchObject({ keyDetails: ['Hip out first'], role: null });

    const positions = (await api<PositionListItem[]>('GET', '/api/v1/positions')).body;
    const closedGuard = positions.find(p => p.slug === 'closed-guard')!;
    const withEdge = await api<TechniqueView>('POST', `/api/v1/techniques/${kimura.id}/edges`, {
      fromPositionId: closedGuard.id,
      fromRole: 'bottom',
    });
    expect(withEdge.body.edges).toEqual([
      { id: expect.any(Number), from: { id: closedGuard.id, slug: 'closed-guard', name: 'Closed guard' }, fromRole: 'bottom', to: null, toRole: null },
    ]);
    const withLink = await api<TechniqueView>('POST', `/api/v1/techniques/${kimura.id}/links`, { kind: 'counter', techniqueId: ghost.id });
    expect(withLink.body.links).toEqual([expect.objectContaining({ kind: 'counter', direction: 'out', technique: expect.objectContaining({ name: 'Ghost escape' }) })]);
    const ghostView = (await api<TechniqueView>('GET', `/api/v1/techniques/${ghost.id}`)).body;
    expect(ghostView.links).toEqual([expect.objectContaining({ kind: 'counter', direction: 'in', technique: expect.objectContaining({ name: 'Kimura lock' }) })]);

    const unlinked = await api<TechniqueView>('DELETE', `/api/v1/techniques/${ghost.id}/links/${kimura.id}/counter?direction=in`);
    expect(unlinked.body.links).toEqual([]);
    expect((await api('POST', '/api/v1/undo')).body.message).toBe('Undid: removed a counter link');
    const edgeId = withEdge.body.edges[0]!.id;
    expect((await api<TechniqueView>('DELETE', `/api/v1/techniques/${kimura.id}/edges/${edgeId}`)).body.edges).toEqual([]);

    // A note on Kimura alone goes to the inbox when Kimura is deleted, and comes back on undo.
    const note = (await api<NoteCreateResult>('POST', '/api/v1/notes', { text: 'Finish with the hips', techniqueIds: [kimura.id] })).body.note;
    expect((await api('DELETE', `/api/v1/techniques/${kimura.id}`)).body.message).toBe('Deleted Kimura lock; 1 note moved to the inbox.');
    expect((await api('GET', `/api/v1/techniques/${kimura.id}`)).status).toBe(404);
    expect((await api<NoteView[]>('GET', '/api/v1/notes?inbox=1')).body.map(n => n.id)).toContain(note.id);
    expect((await api('POST', '/api/v1/undo')).body.message).toBe('Undid: deleted Kimura lock');
    const restored = (await api<TechniqueView>('GET', `/api/v1/techniques/${kimura.id}`)).body;
    expect(restored).toMatchObject({ name: 'Kimura lock', noteCount: 1, links: [expect.objectContaining({ kind: 'counter' })] });
    expect((await api<NoteView[]>('GET', '/api/v1/notes?inbox=1')).body.map(n => n.id)).not.toContain(note.id);
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

  it('runs the focus list by id', async () => {
    let focus = (await api<FocusView>('GET', '/api/v1/focus')).body;
    expect(focus.active.map(f => f.rank)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    const ghostItem = focus.active.find(f => f.label === 'Ghost escape')!;
    expect(ghostItem.techniques.map(t => t.name)).toEqual(['Ghost escape']);
    expect(ghostItem.lastNoteOn).toBe('2026-10-12');

    focus = (await api('POST', `/api/v1/focus/${ghostItem.id}/actions`, { action: 'move', position: 1 })).body.focus;
    expect(focus.active[0]!.label).toBe('Ghost escape');
    focus = (await api('POST', `/api/v1/focus/${ghostItem.id}/actions`, { action: 'pause' })).body.focus;
    expect(focus.paused.map(f => f.label)).toEqual(['Ghost escape']);
    expect(focus.active.map(f => f.rank)).toEqual([1, 2, 3, 4, 5, 6]);

    const added = await api('POST', '/api/v1/focus', { label: 'Kimura from guard', techniqueIds: [], position: 2 });
    expect(added.body.message).toBe('Added to focus at #2: Kimura from guard (linked to Kimura lock).');
    const item = added.body.focus.active[1];
    const renamed = await api('PATCH', `/api/v1/focus/${item.id}`, { label: 'Kimura from closed guard', goal: 'Hit it live' });
    expect(renamed.body.focus.active[1]).toMatchObject({ label: 'Kimura from closed guard', goal: 'Hit it live' });
    expect((await api('POST', '/api/v1/undo')).body.message).toBe('Undid: edit to "Kimura from guard"');
    expect((await api('POST', `/api/v1/focus/99999/actions`, { action: 'pause' })).body.message).toBe('No focus item #99999.');
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

  it('deletes a selection of techniques or notes as one undoable change', async () => {
    const make = async (name: string) => (await api<TechniqueView>('POST', '/api/v1/techniques', { name, type: 'sweep' })).body;
    const [a, b, c] = [await make('Tornado roll'), await make('Lapel feed'), await make('Wrist ride')];
    const both = (await api<NoteCreateResult>('POST', '/api/v1/notes', { text: 'About A and B.', techniqueIds: [a.id, b.id] })).body.note;
    const ac = (await api<NoteCreateResult>('POST', '/api/v1/notes', { text: 'About A and C.', techniqueIds: [a.id, c.id] })).body.note;

    const res = await api('POST', '/api/v1/techniques/delete', { ids: [a.id, b.id, a.id] });
    expect(res.body.message).toBe('Deleted 2 techniques; 1 note moved to the inbox.');
    expect((await api('GET', `/api/v1/techniques/${a.id}`)).status).toBe(404);
    const inbox = (await api<NoteView[]>('GET', '/api/v1/notes?inbox=1&limit=200')).body;
    expect(inbox.find(n => n.id === both.id)).toBeTruthy();
    expect(inbox.find(n => n.id === ac.id)).toBeFalsy();

    expect((await api('POST', '/api/v1/undo')).body.message).toBe('Undid: deleting 2 techniques');
    expect((await api<TechniqueView>('GET', `/api/v1/techniques/${a.id}`)).body.notes.map(n => n.id).sort()).toEqual([both.id, ac.id].sort());
    expect((await api<TechniqueView>('GET', `/api/v1/techniques/${b.id}`)).body.name).toBe('Lapel feed');
    expect((await api<NoteView[]>('GET', '/api/v1/notes?inbox=1&limit=200')).body.find(n => n.id === both.id)).toBeFalsy();

    const n1 = (await api<NoteCreateResult>('POST', '/api/v1/notes', { text: 'Stray one.' })).body.note;
    const n2 = (await api<NoteCreateResult>('POST', '/api/v1/notes', { text: 'Stray two.' })).body.note;
    expect((await api('POST', '/api/v1/notes/delete', { ids: [n1.id, n2.id, 999_999] })).body.message).toBe('Deleted 2 notes.');
    expect((await api<NoteView[]>('GET', '/api/v1/notes?inbox=1&limit=200')).body.some(n => n.id === n1.id || n.id === n2.id)).toBe(false);
    expect((await api('POST', '/api/v1/undo')).body.message).toBe('Undid: deleting 2 notes');
    expect((await api<NoteView[]>('GET', '/api/v1/notes?inbox=1&limit=200')).body.filter(n => n.id === n1.id || n.id === n2.id)).toHaveLength(2);

    expect((await api('POST', '/api/v1/notes/delete', { ids: [] })).status).toBe(400);
    expect((await api('POST', '/api/v1/techniques/delete', { ids: [999_999] })).body.message).toBe('Nothing to delete.');
    await api('POST', '/api/v1/techniques/delete', { ids: [a.id, b.id, c.id] }); // tidy up for later tests
    await api('POST', '/api/v1/notes/delete', { ids: [n1.id, n2.id, both.id, ac.id] });
  });

  it('explores positions', async () => {
    const view = (await api<PositionView>('GET', '/api/v1/positions/side-control?role=bottom')).body;
    expect(view.position.name).toBe('Side control');
    expect(view.from.map(t => t.name)).toEqual(['Ghost escape', 'Shoulder lock to paper cutter choke']);
    expect(view.gaps).toEqual([]);
    expect((await api('GET', '/api/v1/positions/nowhere')).status).toBe(404);
  });

  it('answers unknown API paths with JSON', async () => {
    const res = await api('GET', '/api/v1/nope');
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ error: 'not_found' });
  });
});

describe('web app hosting', () => {
  it('serves the app shell for client routes, with a strict CSP', async () => {
    const res = await fetch(`${s.base}/t/12`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('<div id="root">');
    const csp = res.headers.get('content-security-policy')!;
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain('frame-src https://www.youtube-nocookie.com https://www.instagram.com');
    expect(res.headers.get('x-frame-options')).toBe('DENY');
  });

  it('serves hashed assets as immutable and 404s missing files', async () => {
    const asset = await fetch(`${s.base}/assets/app-abc123.js`);
    expect(asset.status).toBe(200);
    expect(asset.headers.get('cache-control')).toContain('immutable');
    expect((await fetch(`${s.base}/assets/missing.js`)).status).toBe(404);
    expect((await fetch(`${s.base}/favicon-missing.png`)).status).toBe(404);
    expect((await fetch(`${s.base}/manifest.webmanifest`)).status).toBe(200);
  });

  it('leaves server routes alone', async () => {
    expect((await fetch(`${s.base}/mcp`, { method: 'GET' })).status).toBe(401);
    expect((await fetch(`${s.base}/.well-known/oauth-authorization-server`)).headers.get('content-type')).toContain('json');
    expect((await fetch(`${s.base}/healthz`)).headers.get('content-type')).toContain('json');
  });
});
