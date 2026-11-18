// Undo over the JSON API: each change says which log entry it made (X-Activity-Id), and undo takes the id of the
// change it was shown for. Undoing particular kinds of change is tested with them, in the other files.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TechniqueView } from '../src/shared/api.js';
import { newPerson, startServer, type Api, type Person, type TestServer } from './helpers.js';

let s: TestServer;

beforeAll(async () => {
  s = await startServer();
});
afterAll(async () => {
  await s.close();
});

describe('JSON API: undo by id', () => {
  let p: Person;
  const api: Api = (...a) => p.api(...a);
  beforeAll(async () => {
    p = await newPerson(s);
  });

  it('undoes the change it was shown for, not whatever is newest', async () => {
    const created = await api<TechniqueView>('POST', '/api/v1/techniques', { name: 'Undo probe', type: 'submission' });
    const first = Number(created.headers.get('x-activity-id'));
    expect(first).toBeGreaterThan(0);
    const patched = await api<TechniqueView>('PATCH', `/api/v1/techniques/${created.body.id}`, { status: 'drilling' });
    const second = Number(patched.headers.get('x-activity-id'));
    expect(second).toBeGreaterThan(first);
    // Reads and writes that change nothing carry no id.
    expect((await api('GET', `/api/v1/techniques/${created.body.id}`)).headers.get('x-activity-id')).toBeNull();

    // The first change is no longer the newest, so it is refused and nothing moves.
    const refused = await api('POST', '/api/v1/undo', { id: first });
    expect(refused.status).toBe(400);
    expect(refused.body.message).toBe("Something else changed since then, so that can't be undone from here.");
    expect((await api<TechniqueView>('GET', `/api/v1/techniques/${created.body.id}`)).body.status).toBe('drilling');

    expect((await api('POST', '/api/v1/undo', { id: second })).status).toBe(200);
    expect((await api<TechniqueView>('GET', `/api/v1/techniques/${created.body.id}`)).body.status).not.toBe('drilling');
    // Once it is undone it can't be undone twice, and the one before it is the newest again.
    expect((await api('POST', '/api/v1/undo', { id: second })).status).toBe(400);
    expect((await api('POST', '/api/v1/undo', { id: first })).status).toBe(200);
    expect((await api('GET', `/api/v1/techniques/${created.body.id}`)).status).toBe(404);
  });
});
