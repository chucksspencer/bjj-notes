import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  AreaDetail,
  AreasView,
  FocusView,
  LabView,
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
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ signedIn: true, user: { id: 1, name: 'Chuck', email: null, isOwner: true, belt: 'purple' } });
    const setCookie = res.headers.get('set-cookie')!;
    expect(setCookie).toMatch(/^bjj_session=[\w-]{20,};/);
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Lax');
    expect(setCookie).not.toContain('Secure'); // http://localhost in tests
    cookie = setCookie.split(';')[0]!;
    expect((await api('GET', '/api/v1/session')).body).toMatchObject({ signedIn: true, user: { name: 'Chuck', isOwner: true } });
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
    const ghostItem = focus.active.find(f => f.name === 'Ghost escape')!;
    // label is the name again, for app builds from before areas.
    expect(ghostItem.label).toBe('Ghost escape');
    expect(ghostItem.techniques.map(t => t.name)).toEqual(['Ghost escape']);
    expect(ghostItem.lastNoteOn).toBe('2026-10-12');

    focus = (await api('POST', `/api/v1/focus/${ghostItem.id}/actions`, { action: 'move', position: 1 })).body.focus;
    expect(focus.active[0]!.name).toBe('Ghost escape');
    const off = await api('POST', `/api/v1/focus/${ghostItem.id}/actions`, { action: 'remove' });
    expect(off.body.message).toBe('Taken off focus: Ghost escape.');
    expect(off.body.focus.active.map((f: { rank: number }) => f.rank)).toEqual([1, 2, 3, 4, 5, 6]);
    // Off focus, the area is still there.
    const areas = (await api<AreasView>('GET', '/api/v1/areas')).body.areas;
    expect(areas.find(a => a.id === ghostItem.id)).toMatchObject({ name: 'Ghost escape', rank: null });
    expect(areas.slice(0, 6).map(a => a.rank)).toEqual([1, 2, 3, 4, 5, 6]);
    // The older action names still work: resume puts it back.
    const back = await api('POST', `/api/v1/focus/${ghostItem.id}/actions`, { action: 'resume', position: 3 });
    expect(back.body.message).toBe('On focus at #3: Ghost escape.');
    await api('POST', `/api/v1/focus/${ghostItem.id}/actions`, { action: 'pause' });

    const added = await api<{ message: string; area: AreaDetail }>('POST', '/api/v1/areas', { name: 'Kimura from guard', techniqueIds: [], position: 2 });
    expect(added.status).toBe(201);
    expect(added.body.message).toBe('New area, on focus at #2: Kimura from guard (linked to Kimura lock).');
    const item = added.body.area;
    expect(item.rank).toBe(2);
    const renamed = await api('PATCH', `/api/v1/areas/${item.id}`, { name: 'Kimura from closed guard', description: 'Hit it live' });
    expect(renamed.body.area).toMatchObject({ name: 'Kimura from closed guard', description: 'Hit it live' });
    expect(renamed.body.area).not.toHaveProperty('goal');
    expect((await api('POST', '/api/v1/undo')).body.message).toBe('Undid: edit to "Kimura from guard"');
    // An area made off focus stays off it.
    const quiet = await api<{ area: AreaDetail }>('POST', '/api/v1/areas', { name: 'Wrist locks', focus: false });
    expect(quiet.body.area.rank).toBeNull();
    expect((await api('POST', '/api/v1/undo')).body.message).toBe('Undid: new area "Wrist locks"');
    expect((await api('GET', `/api/v1/areas/${quiet.body.area.id}`)).status).toBe(404);
    expect((await api('POST', `/api/v1/focus/99999/actions`, { action: 'remove' })).status).toBe(404);
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

  it('gives each area its own page, with a description and linked notes', async () => {
    const item = async (id: number) => (await api<AreaDetail>('GET', `/api/v1/areas/${id}`)).body;
    const undo = async () => (await api('POST', '/api/v1/undo')).body.message as string;

    // A note with no technique, filed under a new area from the start (an id that isn't a note is skipped).
    const calm = (await api<NoteCreateResult>('POST', '/api/v1/notes', { text: 'Long exhale when pinned.', date: '2026-10-20' })).body.note;
    expect(calm.inbox).toBe(true);
    const created = await api<{ message: string; area: AreaDetail }>('POST', '/api/v1/areas', {
      name: 'Breathe and stay calm',
      description: 'Slow down under pressure.\nGoal: no panic taps.',
      noteIds: [calm.id, 999_999],
      position: 1,
    });
    expect(created.body.message).toBe('New area, on focus at #1: Breathe and stay calm (linked 1 note; not linked to a technique card yet).');
    expect(created.body.area).toMatchObject({
      name: 'Breathe and stay calm',
      rank: 1,
      description: 'Slow down under pressure.\nGoal: no panic taps.',
      techniques: [],
      stepCount: 0,
      noteCount: 1,
      lastNoteOn: '2026-10-20', // a linked note counts, with no technique in common
    });
    const id = created.body.area.id;

    let page = await item(id);
    expect(page).toMatchObject({ rank: 1, plan: [], relatedNotes: [], relatedCount: 0 });
    expect(page.notes.map(n => n.id)).toEqual([calm.id]);
    expect(page.notes[0]!.areas).toEqual([{ id, name: 'Breathe and stay calm', rank: 1 }]);
    expect(page.history.map(h => [h.event, h.toRank])).toEqual([['added', 1]]);
    expect(Date.parse(page.createdAt)).not.toBeNaN();
    expect((await api('GET', '/api/v1/areas/999999')).status).toBe(404);
    // Filed under an area, the note is filed: it's out of the inbox.
    expect((await api<NoteView[]>('GET', '/api/v1/notes?inbox=1&limit=200')).body.map(n => n.id)).not.toContain(calm.id);

    // Link a technique: its notes show as related until they're linked too.
    const ghostNotes = (await api<TechniqueView>('GET', `/api/v1/techniques/${ghost.id}`)).body.noteCount;
    let linked = await api('POST', `/api/v1/areas/${id}/links`, { add: { techniqueIds: [ghost.id] } });
    expect(linked.body.message).toBe('Linked Ghost escape on Breathe and stay calm.');
    page = linked.body.area;
    expect(page.techniques.map(t => t.name)).toEqual(['Ghost escape']);
    expect(page.relatedCount).toBe(ghostNotes);
    const pin = page.relatedNotes[0]!;
    linked = await api('POST', `/api/v1/areas/${id}/links`, { add: { noteIds: [pin.id] } });
    expect(linked.body.message).toBe('Linked 1 note on Breathe and stay calm.');
    expect(linked.body.area.notes.map((n: NoteView) => n.id).sort()).toEqual([calm.id, pin.id].sort());
    expect(linked.body.area.relatedCount).toBe(ghostNotes - 1);
    expect(linked.body.area.noteCount).toBe(2);
    expect((await api('POST', `/api/v1/areas/${id}/links`, { add: { noteIds: [pin.id] } })).body.message).toBe('Nothing changed on Breathe and stay calm.');
    expect((await api<TechniqueView>('GET', `/api/v1/techniques/${ghost.id}`)).body.areas.map(a => a.name)).toContain('Breathe and stay calm');

    // Unlinking, and undoing each step.
    linked = await api('POST', `/api/v1/areas/${id}/links`, { remove: { noteIds: [pin.id], techniqueIds: [ghost.id] } });
    expect(linked.body.message).toBe('Unlinked Ghost escape, 1 note on Breathe and stay calm.');
    expect(await undo()).toBe('Undid: links on "Breathe and stay calm"');
    expect((await item(id)).notes).toHaveLength(2);
    expect(await undo()).toBe('Undid: links on "Breathe and stay calm"'); // the note link
    expect(await undo()).toBe('Undid: links on "Breathe and stay calm"'); // the technique link
    page = await item(id);
    expect([page.techniques, page.notes.map(n => n.id)]).toEqual([[], [calm.id]]);

    // The name, aliases and description, undoably; an empty description clears it.
    let edited = await api('PATCH', `/api/v1/areas/${id}`, { description: 'Exhale.', aliases: ['calm', ' calm ', 'breathing'] });
    expect(edited.body.area).toMatchObject({ description: 'Exhale.', aliases: ['calm', 'breathing'] });
    expect(edited.body.message).toBe('Breathe and stay calm: aliases updated; description updated.');
    expect(await undo()).toBe('Undid: edit to "Breathe and stay calm"');
    expect(await item(id)).toMatchObject({ description: 'Slow down under pressure.\nGoal: no panic taps.', aliases: [] });
    edited = await api('PATCH', `/api/v1/areas/${id}`, { name: 'Stay calm', description: '' });
    expect(edited.body.area).toMatchObject({ name: 'Stay calm', description: null });
    await undo();

    // From the note's side: its areas are replaced, undoably. With none left, it's back in the inbox.
    let note = (await api<NoteView>('PATCH', `/api/v1/notes/${calm.id}`, { areaIds: [] })).body;
    expect([note.areas, note.inbox]).toEqual([[], true]);
    expect((await item(id)).noteCount).toBe(0);
    await undo();
    expect((await item(id)).notes.map(n => n.id)).toEqual([calm.id]);
    note = (await api<NoteCreateResult>('POST', '/api/v1/notes', { text: 'Breathe through the nose.', techniqueIds: [ghost.id], areaIds: [id, 999_999] }))
      .body.note;
    expect(note.areas.map(f => f.id)).toEqual([id]);

    // Deleting a note takes its link with it; undoing the delete brings both back.
    await api('DELETE', `/api/v1/notes/${calm.id}`);
    expect((await item(id)).notes.map(n => n.id)).toEqual([note.id]);
    expect(await undo()).toBe(`Undid: deleting note #${calm.id}`);
    expect((await item(id)).notes.map(n => n.id).sort()).toEqual([calm.id, note.id].sort());

    // Undo entries written before areas (and before goals were folded into descriptions) still work.
    const undoOld = async (op: object) => {
      await s.db.query("insert into activity_log (action, summary, undo, user_id) values ('edit_focus', 'old entry', $1, 1)", [JSON.stringify(op)]);
      return undo();
    };
    expect(await undoOld({ kind: 'restore_focus_label', itemId: id, label: 'Old title', goal: 'Old goal' })).toBe('Undid: old entry');
    let row = (await s.db.query<{ name: string; goal: string | null; description: string | null }>('select name, goal, description from areas where id = $1', [id]))
      .rows[0]!;
    expect(row).toEqual({ name: 'Old title', goal: 'Old goal', description: 'Slow down under pressure.\nGoal: no panic taps.' });
    // An old snapshot had every item on the list with its status: only active ones were ranked.
    const listed = (await api<FocusView>('GET', '/api/v1/focus')).body.active;
    const old = listed.map(f => (f.id === id ? { id, status: 'paused', rank: null, goal: null } : { id: f.id, status: 'active', rank: f.rank }));
    expect(await undoOld({ kind: 'restore_focus', items: old, deleteItemId: null, eventIds: [], addedLinks: [] })).toBe('Undid: old entry');
    row = (await s.db.query<{ name: string; goal: string | null; description: string | null }>('select name, goal, description from areas where id = $1', [id])).rows[0]!;
    expect(row.goal).toBeNull();
    expect((await item(id)).rank).toBeNull();
    expect((await api<FocusView>('GET', '/api/v1/focus')).body.active.map(f => f.id)).toEqual(listed.filter(f => f.id !== id).map(f => f.id));

    // Tidy up for later tests.
    await api('POST', '/api/v1/notes/delete', { ids: [calm.id, note.id] });
    await api('DELETE', `/api/v1/areas/${id}`);
  });

  it('keeps a plan on an area: steps that branch, linked to cards, handing off to other plans', async () => {
    const undo = async () => (await api('POST', '/api/v1/undo')).body.message as string;
    const pos = async (slug: string) => (await api<PositionView>('GET', `/api/v1/positions/${slug}`)).body.position.id;
    const card = async (name: string, type: string) =>
      (await api<TechniqueView>('POST', '/api/v1/techniques', { name, type, role: 'bottom', status: 'drilling' })).body;
    const jw = await card('John Wayne sweep', 'sweep');
    const shuck = await card('Shuck', 'transition');
    const half = await pos('half-guard');
    const deep = await pos('deep-half');

    const deepPlan = (await api<{ area: AreaDetail }>('POST', '/api/v1/areas', { name: 'Deep half sweeps', focus: false })).body.area;
    await api('PATCH', `/api/v1/areas/${deepPlan.id}`, { startPositionId: deep, startRole: 'bottom' });
    const area = (await api<{ area: AreaDetail }>('POST', '/api/v1/areas', { name: 'Bottom half: winning the underhook' })).body.area;
    const plan = [
      { depth: 0, action: 'John Wayne sweep', techniqueId: jw.id, note: 'Force them to post the underhook hand' },
      { depth: 0, action: 'Shuck', techniqueId: shuck.id },
      { depth: 1, trigger: 'they post the far leg', action: 'Go to deep half', toPositionId: deep, toRole: 'bottom' },
      { depth: 1, trigger: 'they base back', action: 'Octopus sweeps' },
    ];
    const saved = await api<{ message: string; area: AreaDetail }>('PATCH', `/api/v1/areas/${area.id}`, {
      startPositionId: half,
      startRole: 'bottom',
      premise: 'Top has the underhook and crossface',
      plan,
    });
    expect(saved.body.message).toBe('Bottom half: winning the underhook: start updated; premise updated; plan saved (4 steps).');
    const v = saved.body.area;
    expect(v).toMatchObject({ start: { slug: 'half-guard' }, startRole: 'bottom', premise: 'Top has the underhook and crossface', stepCount: 4 });
    expect(v.plan.map(st => [st.action, st.technique?.name ?? null, st.children.length])).toEqual([
      ['John Wayne sweep', 'John Wayne sweep', 0],
      ['Shuck', 'Shuck', 2],
    ]);
    expect(v.plan[1]!.children.map(c => [c.trigger, c.action, c.to?.slug ?? null])).toEqual([
      ['they post the far leg', 'Go to deep half', 'deep-half'],
      ['they base back', 'Octopus sweeps', null],
    ]);
    // The step into deep half hands off to the plan that starts there.
    expect(v.plan[1]!.children[0]!.continuesIn).toEqual([{ id: deepPlan.id, name: 'Deep half sweeps', rank: null }]);
    // Step cards are linked to the area, so their notes show up on it.
    expect(v.techniques.map(t => t.name)).toEqual(['John Wayne sweep', 'Shuck']);
    expect((await api<TechniqueView>('GET', `/api/v1/techniques/${shuck.id}`)).body.areas.map(a => a.name)).toEqual(['Bottom half: winning the underhook']);
    expect((await api<PositionView>('GET', '/api/v1/positions/half-guard?role=bottom')).body.plans.map(a => a.name)).toEqual([
      'Bottom half: winning the underhook',
    ]);
    expect((await api<PositionView>('GET', '/api/v1/positions/half-guard?role=top')).body.plans).toEqual([]);

    // A bad outline is refused whole.
    const bad = await api('PATCH', `/api/v1/areas/${area.id}`, { plan: [{ depth: 1, action: 'Orphan' }] });
    expect([bad.status, bad.body.message]).toEqual([400, 'The first step must be on the main line (depth 0).']);
    const jump = await api('PATCH', `/api/v1/areas/${area.id}`, { plan: [{ depth: 0, action: 'A' }, { depth: 2, action: 'B' }] });
    expect(jump.body.message).toBe('Step 2 is 2 levels deeper than the step before it.');

    // Undo puts the plan back as it was (empty), and takes back the card links the plan made.
    expect(await undo()).toBe('Undid: edit to "Bottom half: winning the underhook"');
    const before = (await api<AreaDetail>('GET', `/api/v1/areas/${area.id}`)).body;
    expect(before).toMatchObject({ plan: [], start: null, premise: null, techniques: [] });
    await api('PATCH', `/api/v1/areas/${area.id}`, { startPositionId: half, startRole: 'bottom', plan });

    // Deleting a card keeps its step's words; undoing the delete links it again.
    await api('DELETE', `/api/v1/techniques/${shuck.id}`);
    let now = (await api<AreaDetail>('GET', `/api/v1/areas/${area.id}`)).body;
    expect([now.plan[1]!.action, now.plan[1]!.technique]).toEqual(['Shuck', null]);
    await undo();
    now = (await api<AreaDetail>('GET', `/api/v1/areas/${area.id}`)).body;
    expect(now.plan[1]!.technique?.id).toBe(shuck.id);

    // Deleting the area takes it off focus; undo brings back its plan, links and place on the list.
    const rank = now.rank;
    expect((await api('DELETE', `/api/v1/areas/${area.id}`)).body.message).toBe('Deleted Bottom half: winning the underhook.');
    expect((await api<FocusView>('GET', '/api/v1/focus')).body.active.map(f => f.id)).not.toContain(area.id);
    expect(await undo()).toBe('Undid: delete "Bottom half: winning the underhook"');
    now = (await api<AreaDetail>('GET', `/api/v1/areas/${area.id}`)).body;
    expect([now.rank, now.stepCount, now.techniques.length, now.history.length]).toEqual([rank, 4, 2, 1]);
    expect(now.plan[1]!.children.map(c => c.trigger)).toEqual(['they post the far leg', 'they base back']);
    const ranks = (await api<FocusView>('GET', '/api/v1/focus')).body.active.map(f => f.rank);
    expect(ranks).toEqual(ranks.map((_, i) => i + 1));

    // Tidy up for later tests.
    await api('DELETE', `/api/v1/areas/${area.id}`);
    await api('DELETE', `/api/v1/areas/${deepPlan.id}`);
    await api('POST', '/api/v1/techniques/delete', { ids: [jw.id, shuck.id] });
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
