// Several people on one server: invites, sign-in, and that nobody can see or change anyone else's notebook
// through any door (the web app's JSON API, Claude's MCP tools, Siri capture, undo).
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AccountView, FocusView, LabView, NoteCreateResult, NoteView, PositionListItem, TechniqueListItem, TechniqueView } from '../src/shared/api.js';
import { search } from '../src/services/explore.js';
import { API_TOKEN, connect, OWNER_PASSWORD, startServer, type TestServer } from './helpers.js';

let s: TestServer;

type Auth = { cookie?: string; bearer?: string; csrf?: boolean };

async function api<T = any>(auth: Auth, method: string, p: string, body?: unknown) {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (auth.csrf !== false) headers['x-bjj-app'] = '1';
  if (auth.cookie) headers.cookie = auth.cookie;
  if (auth.bearer) headers.authorization = `Bearer ${auth.bearer}`;
  const res = await fetch(`${s.base}${p}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  const json = text && res.headers.get('content-type')?.includes('json') ? JSON.parse(text) : text;
  return { status: res.status, headers: res.headers, body: json as T };
}

async function signIn(email: string, password: string): Promise<Auth> {
  const res = await api({}, 'POST', '/api/v1/session', { email, password });
  expect(res.status).toBe(200);
  return { cookie: res.headers.get('set-cookie')!.split(';')[0]! };
}

async function mcp(accessToken: string) {
  const client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(s.mcpUrl), { requestInit: { headers: { Authorization: `Bearer ${accessToken}` } } }),
  );
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const res = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
    const text = res.content.map(c => c.text).join('\n');
    if (res.isError) throw new Error(text);
    return text;
  };
  return { client, call };
}

/** A 1×1 JPEG, standing in for a still image. */
const JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=',
  'base64',
).toString('base64');

const SAM = { name: 'Sam', email: 'sam@example.com', password: 'sam-password-123' };

let owner: Auth;
let sam: Auth;
let samId: number;
let ownerGhost: TechniqueListItem;
let ownerNote: NoteView;

beforeAll(async () => {
  s = await startServer();
});
afterAll(async () => {
  await s.close();
});

describe('accounts', () => {
  it('signs the owner in with the password alone until an email is on file', async () => {
    owner = await signIn('', OWNER_PASSWORD);
    const me = await api<AccountView>(owner, 'GET', '/api/v1/account');
    expect(me.body.me).toEqual({ id: 1, name: 'Chuck', email: null, isOwner: true, belt: 'purple' });
    expect(me.body.people!.map(p => p.name)).toEqual(['Chuck']);

    const set = await api(owner, 'PATCH', '/api/v1/account', { email: 'Owner@Example.com' });
    expect(set.body).toMatchObject({ email: 'owner@example.com' });
    // Now the email is needed, and the password alone no longer works.
    expect((await api({}, 'POST', '/api/v1/session', { password: OWNER_PASSWORD })).status).toBe(401);
    expect((await api({}, 'POST', '/api/v1/session', { email: 'owner@example.com', password: 'wrong password!' })).status).toBe(401);
    owner = await signIn('OWNER@example.com', OWNER_PASSWORD);
  });

  it('invites someone with a one-time link', async () => {
    // Belts are checked; the owner picks the new person's.
    expect((await api(owner, 'POST', '/api/v1/invites', { name: SAM.name, belt: 'green' })).status).toBe(400);
    const made = await api<{ url: string; invite: { id: number; belt: string } }>(owner, 'POST', '/api/v1/invites', {
      name: SAM.name,
      email: SAM.email,
      belt: 'blue',
    });
    expect(made.status).toBe(201);
    expect(made.body.invite.belt).toBe('blue');
    expect(made.body.url).toMatch(new RegExp(`^${s.base}/join#[\\w-]{20,}$`));
    const token = made.body.url.split('#')[1]!;

    const check = await api({}, 'POST', '/api/v1/invites/check', { token });
    expect(check.body).toMatchObject({ purpose: 'join', name: 'Sam', email: SAM.email, belt: 'blue' });
    expect((await api({}, 'POST', '/api/v1/invites/check', { token: 'not-a-real-token-at-all' })).status).toBe(404);

    // The app header is required, the password must be long enough, and the email can't be taken.
    expect((await api({ csrf: false }, 'POST', '/api/v1/invites/accept', { token, ...SAM })).status).toBe(403);
    expect((await api({}, 'POST', '/api/v1/invites/accept', { token, ...SAM, password: 'short' })).body.message).toMatch(/at least 10/);
    expect((await api({}, 'POST', '/api/v1/invites/accept', { token, ...SAM, email: 'owner@example.com' })).body.message).toMatch(
      /already signs in/,
    );

    const joined = await api({}, 'POST', '/api/v1/invites/accept', { token, ...SAM });
    expect(joined.status).toBe(200);
    expect(joined.body).toMatchObject({ signedIn: true, user: { name: 'Sam', email: SAM.email, isOwner: false, belt: 'blue' } });
    samId = joined.body.user.id;
    sam = { cookie: joined.headers.get('set-cookie')!.split(';')[0]! };

    // Used once, then it's gone.
    expect((await api({}, 'POST', '/api/v1/invites/accept', { token, ...SAM, email: 'other@example.com' })).body.message).toMatch(/expired/);
    expect((await signIn(SAM.email, SAM.password)).cookie).toBeTruthy();
  });

  it('keeps the people list and invites to the owner', async () => {
    const mine = await api<AccountView>(sam, 'GET', '/api/v1/account');
    expect(mine.body.me).toMatchObject({ name: 'Sam', isOwner: false });
    expect(mine.body.people).toBeUndefined();
    expect((await api(sam, 'POST', '/api/v1/invites', {})).status).toBe(403);
    expect((await api(sam, 'POST', `/api/v1/people/1/reset`)).status).toBe(403);
    expect((await api(sam, 'DELETE', `/api/v1/people/1`)).status).toBe(403);
    const people = (await api<AccountView>(owner, 'GET', '/api/v1/account')).body.people!;
    expect(people.map(p => p.name)).toEqual(['Chuck', 'Sam']);
    expect((await api(owner, 'DELETE', '/api/v1/people/1')).status).toBe(404); // the owner can't be removed
  });
});

describe('belts', () => {
  it('lets each person change their own belt, and shows everyone\'s to the owner', async () => {
    expect((await api(sam, 'PATCH', '/api/v1/account', { belt: 'green' })).status).toBe(400);
    expect((await api(sam, 'PATCH', '/api/v1/account', { belt: 'purple' })).body).toMatchObject({ name: 'Sam', belt: 'purple' });
    expect((await api(sam, 'GET', '/api/v1/session')).body.user.belt).toBe('purple');
    // Changing the belt leaves the rest of the profile alone.
    expect((await api<AccountView>(sam, 'GET', '/api/v1/account')).body.me).toMatchObject({ name: 'Sam', email: SAM.email, belt: 'purple' });
    const people = (await api<AccountView>(owner, 'GET', '/api/v1/account')).body.people!;
    expect(people.map(p => [p.name, p.belt])).toEqual([
      ['Chuck', 'purple'],
      ['Sam', 'purple'],
    ]);
    // An invite without a belt is for a white belt; a reset link keeps the person's own.
    const plain = await api<{ url: string; invite: { belt: string } }>(owner, 'POST', '/api/v1/invites', {});
    expect(plain.body.invite.belt).toBe('white');
    expect((await api({}, 'POST', '/api/v1/invites/check', { token: plain.body.url.split('#')[1] })).body.belt).toBe('white');
    const reset = await api<{ url: string; invite: { belt: string | null } }>(owner, 'POST', `/api/v1/people/${samId}/reset`);
    expect(reset.body.invite.belt).toBeNull();
    expect((await api({}, 'POST', '/api/v1/invites/check', { token: reset.body.url.split('#')[1] })).body.belt).toBe('purple');
    for (const i of (await api<AccountView>(owner, 'GET', '/api/v1/account')).body.invites!) {
      await api(owner, 'DELETE', `/api/v1/invites/${i.id}`);
    }
    await api(sam, 'PATCH', '/api/v1/account', { belt: 'blue' });
  });
});

describe('separate notebooks over the JSON API', () => {
  it('starts a new person with an empty notebook and the shared positions', async () => {
    expect((await api<TechniqueListItem[]>(sam, 'GET', '/api/v1/techniques')).body).toEqual([]);
    const focus = (await api<FocusView>(sam, 'GET', '/api/v1/focus')).body;
    expect([...focus.active, ...focus.paused, ...focus.backlog]).toEqual([]);
    const positions = (await api<PositionListItem[]>(sam, 'GET', '/api/v1/positions')).body;
    expect(positions.length).toBeGreaterThan(20);
    expect(positions.every(p => p.techniqueCount === 0)).toBe(true);
    // The owner's are untouched.
    const ownerList = (await api<TechniqueListItem[]>(owner, 'GET', '/api/v1/techniques')).body;
    expect(ownerList).toHaveLength(7);
    ownerGhost = ownerList.find(t => t.name === 'Ghost escape')!;
    expect((await api<PositionListItem[]>(owner, 'GET', '/api/v1/positions')).body.find(p => p.slug === 'side-control')!.techniqueCount).toBe(2);
  });

  it("can't read or change someone else's techniques or notes by id", async () => {
    const created = await api<NoteCreateResult>(owner, 'POST', '/api/v1/notes', {
      text: 'Turn to the knees before the hips',
      techniqueIds: [ownerGhost.id],
      session: { kind: 'class' },
      starred: true,
    });
    ownerNote = created.body.note;

    expect((await api(sam, 'GET', `/api/v1/techniques/${ownerGhost.id}`)).status).toBe(404);
    expect((await api(sam, 'PATCH', `/api/v1/techniques/${ownerGhost.id}`, { status: 'reliable' })).status).toBe(404);
    expect((await api(sam, 'DELETE', `/api/v1/techniques/${ownerGhost.id}`)).body.message).toBe(`No technique #${ownerGhost.id}.`);
    expect((await api(sam, 'POST', '/api/v1/techniques/delete', { ids: [ownerGhost.id] })).body.message).toBe('Nothing to delete.');
    expect((await api(sam, 'PATCH', `/api/v1/notes/${ownerNote.id}`, { body: 'mine now' })).status).toBe(404);
    expect((await api(sam, 'POST', `/api/v1/notes/${ownerNote.id}/file`, { techniqueIds: [] })).status).toBe(404);
    expect((await api(sam, 'DELETE', `/api/v1/notes/${ownerNote.id}`)).body.message).toBe(`No note #${ownerNote.id}.`);
    expect((await api(sam, 'POST', '/api/v1/notes/delete', { ids: [ownerNote.id] })).body.message).toBe('Nothing to delete.');
    expect((await api(sam, 'POST', '/api/v1/notes/answered', { ids: [ownerNote.id] })).body.message).toBe('No open questions to mark.');
    expect((await api(sam, 'POST', `/api/v1/focus/1/actions`, { action: 'drop' })).body.message).toBe('No focus item #1.');
    expect((await api(sam, 'PATCH', `/api/v1/focus/1`, { label: 'hijacked' })).body.message).toBe('No focus item #1.');
    expect((await api(sam, 'POST', '/api/v1/stars/clear', {})).body.message).toBe('Nothing is starred.');

    // Everything of the owner's is as it was.
    const note = (await api<TechniqueView>(owner, 'GET', `/api/v1/techniques/${ownerGhost.id}`)).body;
    expect(note.notes.map(n => n.body)).toEqual(['Turn to the knees before the hips']);
    expect(note.notes[0]!.starred).toBe(true);
    const focus = (await api<FocusView>(owner, 'GET', '/api/v1/focus')).body;
    expect(focus.active[0]!.label).toBe('Baratoplata');
    expect(focus.active).toHaveLength(7);
  });

  it("won't link anything to someone else's cards, sessions or sources", async () => {
    // The same name is fine: names are unique per person.
    const mine = await api<TechniqueView>(sam, 'POST', '/api/v1/techniques', { name: 'Ghost escape', type: 'escape', role: 'bottom' });
    expect(mine.status).toBe(201);
    expect(mine.body.id).not.toBe(ownerGhost.id);

    // A note naming the owner's technique id isn't linked to it.
    const note = await api<NoteCreateResult>(sam, 'POST', '/api/v1/notes', { text: 'Elbow to knee', techniqueIds: [ownerGhost.id] });
    expect(note.body.note.techniques).toEqual([]);
    expect(note.body.note.inbox).toBe(true);
    // Nor a session, nor a related-technique link.
    expect((await api(sam, 'POST', '/api/v1/notes', { text: 'From their class', sessionId: ownerNote.sessionId })).status).toBe(404);
    const linked = await api<TechniqueView>(sam, 'POST', `/api/v1/techniques/${mine.body.id}/links`, { kind: 'related', techniqueId: ownerGhost.id });
    expect(linked.body.links).toEqual([]);
    expect((await api(sam, 'POST', '/api/v1/focus', { label: 'Escapes', techniqueIds: [ownerGhost.id] })).body.focus.active[0].techniques).toEqual([]);
    // Filing under it, or adding a position to it, does nothing either.
    const filed = await api<NoteView>(sam, 'POST', `/api/v1/notes/${note.body.note.id}/file`, { techniqueIds: [ownerGhost.id] });
    expect(filed.body.techniques).toEqual([]);
    expect((await api(sam, 'POST', `/api/v1/techniques/${ownerGhost.id}/edges`, { fromPositionId: 1 })).status).toBe(404);

    // The same video saved by both is a source for each, not shared.
    const url = 'https://www.instagram.com/reel/ABC123/';
    const a = await api<NoteCreateResult>(owner, 'POST', '/api/v1/notes', { text: 'Reel', source: { url, title: 'Owner title' }, toTry: true });
    const b = await api<NoteCreateResult>(sam, 'POST', '/api/v1/notes', { text: 'Reel', source: { url, title: 'Sam title' }, toTry: true });
    expect(a.body.note.source!.id).not.toBe(b.body.note.source!.id);
    expect(a.body.note.source!.title).toBe('Owner title');

    // The database itself refuses a cross-person link, whatever the code does.
    await expect(
      s.db.query('insert into note_techniques (note_id, technique_id, user_id) values ($1, $2, $3)', [note.body.note.id, ownerGhost.id, samId]),
    ).rejects.toThrow(/foreign key/);
    await expect(
      s.db.query('insert into note_techniques (note_id, technique_id, user_id) values ($1, $2, $3)', [note.body.note.id, ownerGhost.id, 1]),
    ).rejects.toThrow(/foreign key/);
  });

  it('keeps lists, search, the Lab and the inbox separate', async () => {
    const samNotes = (await api<NoteView[]>(sam, 'GET', '/api/v1/notes')).body;
    expect(samNotes.map(n => n.body).sort()).toEqual(['Elbow to knee', 'Reel']);
    expect((await api<NoteView[]>(sam, 'GET', '/api/v1/notes?q=hips')).body).toEqual([]);
    expect((await api<TechniqueListItem[]>(sam, 'GET', '/api/v1/techniques?q=baratoplata')).body).toEqual([]);
    expect((await api<NoteView[]>(owner, 'GET', '/api/v1/notes?q=elbow')).body).toEqual([]);
    const lab = (await api<LabView>(sam, 'GET', '/api/v1/lab')).body;
    expect(lab.starred.notes).toEqual([]);
    expect(lab.toTry.total).toBe(1);
    expect((await api<NoteView[]>(owner, 'GET', '/api/v1/notes?inbox=1')).body.map(n => n.body)).not.toContain('Elbow to knee');
    expect((await api(sam, 'GET', '/api/v1/sessions')).body).toEqual([]);
    const pos = (await api(sam, 'GET', '/api/v1/positions/side-control')).body;
    expect(pos.from).toEqual([]);
  });

  it('undoes only your own changes', async () => {
    await api(owner, 'POST', '/api/v1/notes', { text: 'Owner thought', techniqueIds: [ownerGhost.id] });
    await api(sam, 'POST', '/api/v1/notes', { text: 'Sam thought' });
    // Sam's undo removes Sam's note, then Sam's earlier changes; never the owner's newer one.
    expect((await api(sam, 'POST', '/api/v1/undo')).body.message).toMatch(/^Undid: note #\d+$/);
    expect((await api<NoteView[]>(sam, 'GET', '/api/v1/notes')).body.map(n => n.body)).not.toContain('Sam thought');
    expect((await api<NoteView[]>(owner, 'GET', '/api/v1/notes?q=owner%20thought')).body).toHaveLength(1);
    expect((await api(owner, 'POST', '/api/v1/undo')).body.message).toMatch(/on Ghost escape$/);
  });

  it("serves photos only to the person they belong to", async () => {
    const saved = await api(owner, 'POST', '/api/v1/capture', { text: 'Grip detail', attachments: [{ kind: 'photo', thumb: JPEG }] });
    const attachmentId = saved.body.attachments[0].id;
    expect((await fetch(`${s.base}/api/v1/attachments/${attachmentId}/thumb`, { headers: { cookie: owner.cookie! } })).status).toBe(200);
    expect((await fetch(`${s.base}/api/v1/attachments/${attachmentId}/thumb`, { headers: { cookie: sam.cookie! } })).status).toBe(404);
    expect((await api(sam, 'PATCH', `/api/v1/attachments/${attachmentId}`, { photosLocalId: 'stolen' })).status).toBe(404);
  });
});

describe('separate notebooks for Claude and Siri', () => {
  it('gives each person their own notebook over MCP', async () => {
    const samTokens = await connect(s, { email: SAM.email, password: SAM.password });
    const samMcp = await mcp(samTokens.access_token);
    const ownerMcp = await mcp((await connect(s, { email: 'owner@example.com', password: OWNER_PASSWORD })).access_token);
    try {
      expect(samMcp.client.getInstructions()).toMatch(/^Sam's personal Brazilian jiu-jitsu notebook/);
      expect(samMcp.client.getInstructions()).toContain('Sam is a blue belt.');
      expect(ownerMcp.client.getInstructions()).toMatch(/^Chuck's personal Brazilian jiu-jitsu notebook/);
      expect(ownerMcp.client.getInstructions()).toContain('Chuck is a purple belt.');
      expect(await samMcp.call('get_focus')).toContain('1. Escapes');
      expect(await samMcp.call('get_focus')).not.toContain('Baratoplata');
      expect(await samMcp.call('search', { query: 'baratoplata' })).toBe('Nothing found for "baratoplata".');
      expect(await samMcp.call('get_technique', { name: 'Baratoplata' })).toMatch(/^No (confident )?technique match/);

      expect(await samMcp.call('add_note', { text: 'Frame on the hip', techniques: ['ghost escape'] })).toMatch(/to Ghost escape/);
      expect(await ownerMcp.call('search', { query: 'frame' })).not.toContain('Frame on the hip');
      expect(await ownerMcp.call('get_technique', { name: 'ghost escape' })).not.toContain('Frame on the hip');
      expect(await samMcp.call('update_note', { note_id: ownerNote.id, body: 'mine' })).toBe(`No note #${ownerNote.id}.`);
      expect(await samMcp.call('file_note', { note_id: ownerNote.id, techniques: ['Ghost escape'] })).toBe(`No note #${ownerNote.id}.`);
      expect(await samMcp.call('update_focus', { action: 'drop', item: 'Baratoplata' })).toMatch(/^No (confident )?focus item match/);
      expect(await samMcp.call('review', { days: 30 })).not.toContain('Ghost escape (2)');

      // Undo over MCP is per person too.
      expect(await samMcp.call('undo_last')).toMatch(/^Undid: note #\d+ on Ghost escape$/);
      expect(await ownerMcp.call('get_lab')).toContain('Turn to the knees before the hips');
    } finally {
      await samMcp.client.close();
      await ownerMcp.client.close();
    }
  });

  it("gives each person their own Siri token", async () => {
    const made = await api<{ token: string; row: { id: number } }>(sam, 'POST', '/api/v1/account/tokens', { label: 'iPhone' });
    expect(made.body.token).toMatch(/^bjj_/);
    const samToken = made.body.token;
    expect((await api<AccountView>(sam, 'GET', '/api/v1/account')).body.tokens).toMatchObject([{ label: 'iPhone', lastUsedAt: null }]);

    const capture = async (token: string, text: string) =>
      fetch(`${s.base}/api/capture`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ text }),
      });
    expect((await capture(samToken, 'Siri note from Sam')).status).toBe(200);
    expect((await capture(API_TOKEN, 'Siri note from the owner')).status).toBe(200);
    const samNotes = (await api<NoteView[]>(sam, 'GET', '/api/v1/notes?inbox=1')).body.map(n => n.body);
    expect(samNotes).toContain('Siri note from Sam');
    expect(samNotes).not.toContain('Siri note from the owner');
    expect((await api<NoteView[]>(owner, 'GET', '/api/v1/notes?inbox=1')).body.map(n => n.body)).toContain('Siri note from the owner');

    const focus = await (await fetch(`${s.base}/api/focus`, { headers: { authorization: `Bearer ${samToken}` } })).json();
    expect(focus.speech).toBe('Your focus: 1. Escapes.');
    // A token also works for the JSON API, as that person.
    expect((await api<NoteView[]>({ bearer: samToken }, 'GET', '/api/v1/notes?inbox=1')).body.map(n => n.body)).toContain('Siri note from Sam');

    // Only Sam can remove Sam's token; then it stops working.
    expect((await api(owner, 'DELETE', `/api/v1/account/tokens/${made.body.row.id}`)).status).toBe(404);
    expect((await api(sam, 'DELETE', `/api/v1/account/tokens/${made.body.row.id}`)).status).toBe(200);
    expect((await capture(samToken, 'after revoking')).status).toBe(401);
  });

  it('refuses notebook queries made without a signed-in user', async () => {
    await expect(search(s.ctx, { query: 'ghost' })).rejects.toThrow('Notebook query without a signed-in user.');
  });
});

describe('passwords and removing people', () => {
  it('changes your own password', async () => {
    expect((await api(sam, 'POST', '/api/v1/account/password', { current: 'wrong-password', password: 'new-password-456' })).status).toBe(400);
    expect((await api(sam, 'POST', '/api/v1/account/password', { current: SAM.password, password: 'new-password-456' })).status).toBe(200);
    SAM.password = 'new-password-456';
    expect((await api(owner, 'POST', '/api/v1/account/password', { current: OWNER_PASSWORD, password: 'whatever-12345' })).status).toBe(400);
  });

  it('resets a password with a link from the owner, signing out the old sessions', async () => {
    const made = await api<{ url: string }>(owner, 'POST', `/api/v1/people/${samId}/reset`);
    expect(made.status).toBe(201);
    const token = made.body.url.split('#')[1]!;
    expect((await api({}, 'POST', '/api/v1/invites/check', { token })).body).toMatchObject({ purpose: 'reset', name: 'Sam', email: SAM.email });
    const reset = await api({}, 'POST', '/api/v1/invites/accept', { token, password: 'reset-password-789' });
    expect(reset.body).toMatchObject({ signedIn: true, user: { id: samId } });
    expect((await api(sam, 'GET', '/api/v1/focus')).status).toBe(401);
    expect((await api({}, 'POST', '/api/v1/session', { email: SAM.email, password: SAM.password })).status).toBe(401);
    sam = await signIn(SAM.email, 'reset-password-789');
  });

  it('removes a person and everything in their notebook', async () => {
    const samTokens = await connect(s, { email: SAM.email, password: 'reset-password-789' });
    const before = (await s.db.query<{ c: number }>('select count(*)::int as c from notes where user_id = $1', [samId])).rows[0]!.c;
    expect(before).toBeGreaterThan(0);

    expect((await api(owner, 'DELETE', `/api/v1/people/${samId}`)).body.message).toBe('Removed Sam and their notebook.');
    for (const table of ['techniques', 'notes', 'sessions', 'sources', 'focus_items', 'activity_log', 'web_sessions', 'oauth_tokens', 'api_tokens']) {
      const left = (await s.db.query<{ c: number }>(`select count(*)::int as c from ${table} where user_id = $1`, [samId])).rows[0]!.c;
      expect(left, table).toBe(0);
    }
    expect((await api(sam, 'GET', '/api/v1/focus')).status).toBe(401);
    const res = await fetch(s.mcpUrl, {
      method: 'POST',
      headers: { authorization: `Bearer ${samTokens.access_token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(res.status).toBe(401);
    // The owner's notebook is still all there.
    expect((await api<TechniqueListItem[]>(owner, 'GET', '/api/v1/techniques')).body).toHaveLength(7);
  });
});

describe('owner without an email yet', () => {
  let fresh: TestServer;
  beforeAll(async () => {
    fresh = await startServer();
  });
  afterAll(async () => {
    await fresh.close();
  });

  it('takes the first email the owner signs in with as theirs', async () => {
    const res = await fetch(`${fresh.base}/api/v1/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-bjj-app': '1' },
      body: JSON.stringify({ email: 'Me@Example.com', password: OWNER_PASSWORD }),
    });
    expect(await res.json()).toEqual({ signedIn: true, user: { id: 1, name: 'Chuck', email: 'me@example.com', isOwner: true, belt: 'purple' } });
    const pwOnly = await fetch(`${fresh.base}/api/v1/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-bjj-app': '1' },
      body: JSON.stringify({ password: OWNER_PASSWORD }),
    });
    expect(pwOnly.status).toBe(401);
  });
});
