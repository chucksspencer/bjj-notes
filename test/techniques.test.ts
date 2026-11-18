// Technique cards over the JSON API: listing and filtering, editing, linking, deleting with undo, and positions.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NoteCreateResult, NoteView, PositionListItem, PositionView, TechniqueListItem, TechniqueView } from '../src/shared/api.js';
import { personWithWorkingList, startServer, type Api, type Person, type TestServer } from './helpers.js';

let s: TestServer;

beforeAll(async () => {
  s = await startServer();
});
afterAll(async () => {
  await s.close();
});

describe('JSON API: listing and finding techniques', () => {
  let p: Person;
  const api: Api = (...a) => p.api(...a);
  beforeAll(async () => {
    ({ p } = await personWithWorkingList(s));
  });

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
    const ghost = all.find(t => t.name === 'Ghost escape')!;
    expect(ghost.edges).toEqual([{ from: 'Side control', fromRole: 'bottom', to: null, toRole: null }]);
    const subs = (await api<TechniqueListItem[]>('GET', '/api/v1/techniques?type=submission')).body;
    expect(subs.map(t => t.name)).toEqual(['Ankle lock', 'Baratoplata', 'Shoulder lock to paper cutter choke']);
    const fuzzy = (await api<TechniqueListItem[]>('GET', '/api/v1/techniques?q=barra%20toe%20plata')).body;
    expect(fuzzy[0]!.name).toBe('Baratoplata');
    expect((await api('GET', '/api/v1/techniques?type=nonsense')).status).toBe(400);
  });

  it('explores positions', async () => {
    const view = (await api<PositionView>('GET', '/api/v1/positions/side-control?role=bottom')).body;
    expect(view.position.name).toBe('Side control');
    expect(view.from.map(t => t.name)).toEqual(['Ghost escape', 'Shoulder lock to paper cutter choke']);
    expect(view.gaps).toEqual([]);
    expect((await api('GET', '/api/v1/positions/nowhere')).status).toBe(404);
  });
});

describe('JSON API: editing technique cards', () => {
  let p: Person;
  let ghost: TechniqueView;
  const api: Api = (...a) => p.api(...a);
  beforeAll(async () => {
    ({ p, ghost } = await personWithWorkingList(s));
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
  });
});
