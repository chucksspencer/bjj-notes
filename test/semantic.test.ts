// Search by meaning, against a stand-in for Voyage AI that runs in the test: it places texts by which topics
// they mention, so "how do I stop the knee cut" lands near "frame on the hip before they settle the crossface".
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AccountView, NoteCreateResult, NoteView, TechniqueListItem } from '../src/shared/api.js';
import { EmbeddingError, embeddingHealth, voyageEmbedder } from '../src/services/embeddings.js';
import { connect, OWNER_PASSWORD, startServer, type TestServer } from './helpers.js';

const TOPICS = [
  ['knee cut', 'knee slice', 'frame', 'crossface', 'knee shield'],
  ['ankle lock', 'heel hook', 'leg lock', 'toes'],
  ['choke', 'strangle', 'triangle', 'collar'],
  ['sweep', 'off balance', 'butterfly'],
];

/** A topic vector: one dimension per topic, plus a small constant so no text is all zeros. */
function embed(text: string): number[] {
  const t = text.toLowerCase();
  const v = TOPICS.map(words => words.filter(w => t.includes(w)).length);
  v.push(0.05);
  const norm = Math.hypot(...v);
  return v.map(x => x / norm);
}

interface Call {
  auth: string | undefined;
  model: string;
  inputType: string;
  input: string[];
}

/** The stand-in for Voyage AI: answers POST /v1/embeddings in its documented shape, and records each call. */
async function fakeVoyage() {
  const calls: Call[] = [];
  let failWith: number | null = null;
  const http: Server = createServer((req, res) => {
    let raw = '';
    req.on('data', c => (raw += c));
    req.on('end', () => {
      if (req.method !== 'POST' || req.url !== '/v1/embeddings') {
        res.writeHead(404).end();
        return;
      }
      const body = JSON.parse(raw) as { input: string[]; model: string; input_type: string };
      calls.push({ auth: req.headers.authorization, model: body.model, inputType: body.input_type, input: body.input });
      if (failWith) {
        res.writeHead(failWith, { 'content-type': 'application/json' }).end(JSON.stringify({ detail: 'Something broke' }));
        return;
      }
      // Answer out of order, as an API may: each item says which input it belongs to.
      const data = body.input.map((text, index) => ({ object: 'embedding', embedding: embed(text), index })).reverse();
      res
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ object: 'list', data, model: body.model, usage: { total_tokens: 10 } }));
    });
  });
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${(http.address() as AddressInfo).port}`,
    calls,
    documents: () => calls.filter(c => c.inputType === 'document').flatMap(c => c.input),
    queries: () => calls.filter(c => c.inputType === 'query').flatMap(c => c.input),
    fail: (status: number | null) => (failWith = status),
    close: () => new Promise<void>(resolve => http.close(() => resolve())),
  };
}

let voyage: Awaited<ReturnType<typeof fakeVoyage>>;
let s: TestServer;
let cookie = '';

async function api<T = any>(method: string, p: string, body?: unknown, as = cookie) {
  const res = await fetch(`${s.base}${p}`, {
    method,
    headers: { 'x-bjj-app': '1', cookie: as, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json().catch(() => null)) as T, headers: res.headers };
}

async function mcp(server: TestServer) {
  const { access_token } = await connect(server);
  const client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(server.mcpUrl), { requestInit: { headers: { Authorization: `Bearer ${access_token}` } } }),
  );
  return {
    client,
    call: async (name: string, args: Record<string, unknown> = {}) => {
      const r = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
      const text = r.content.map(c => c.text).join('\n');
      if (r.isError) throw new Error(text);
      return text;
    },
  };
}

const FRAME = 'Frame on the hip before they settle the crossface';
const ANKLE = 'Point the toes and finish the ankle lock with the hips';
const KNEE_CUT_QUESTION = 'how do I stop the knee cut';

beforeAll(async () => {
  voyage = await fakeVoyage();
  s = await startServer(null, undefined, { VOYAGE_API_KEY: 'test-voyage-key', VOYAGE_BASE_URL: voyage.url, EMBEDDING_MODEL: 'voyage-test' });
  const signIn = await api('POST', '/api/v1/session', { password: OWNER_PASSWORD }, '');
  cookie = signIn.headers.get('set-cookie')!.split(';')[0]!;
});
afterAll(async () => {
  await s.close();
  await voyage.close();
});
beforeEach(() => voyage.fail(null));

describe('search by meaning', () => {
  let frameId: number;

  it("finds notes by what they're about in Claude's search", async () => {
    const claude = await mcp(s);
    try {
      expect(await claude.call('add_note', { text: FRAME, techniques: ['Ghost escape'] })).toMatch(/^Saved note/);
      expect(await claude.call('add_note', { text: ANKLE, techniques: ['Ankle lock'] })).toMatch(/^Saved note/);
      const found = await claude.call('search', { query: KNEE_CUT_QUESTION });
      expect(found).toContain(FRAME);
      expect(found).not.toContain(ANKLE);
      frameId = Number(/#(\d+) [^\n]*Frame on the hip/.exec(found)![1]);
    } finally {
      await claude.client.close();
    }
    // What went to the service: the notes as documents (with what they're about), the question as a query.
    const docs = voyage.documents();
    expect(docs).toContain(`${FRAME}\nTechniques: Ghost escape`);
    expect(docs.some(d => d.startsWith('Ghost escape\nAlso called:') || d.startsWith('Ghost escape\nType: escape'))).toBe(true);
    expect(voyage.queries()).toEqual([KNEE_CUT_QUESTION]);
    expect(voyage.calls.every(c => c.auth === 'Bearer test-voyage-key' && c.model === 'voyage-test')).toBe(true);
  });

  it('embeds only what changed since the last search', async () => {
    const before = voyage.documents().length;
    await api('GET', `/api/v1/notes?q=${encodeURIComponent('stopping a knee slice pass')}`);
    expect(voyage.documents().length).toBe(before); // nothing new to embed
    await api('PATCH', `/api/v1/notes/${frameId}`, { body: `${FRAME}, then turn to the knees` });
    const found = await api<NoteView[]>('GET', `/api/v1/notes?q=${encodeURIComponent('stopping a knee slice pass')}`);
    expect(found.body.map(n => n.body)).toContain(`${FRAME}, then turn to the knees`);
    expect(voyage.documents().slice(before)).toEqual([`${FRAME}, then turn to the knees\nTechniques: Ghost escape`]);
    // The same search again doesn't ask the service to embed the question again.
    const queries = voyage.queries().length;
    await api('GET', `/api/v1/notes?q=${encodeURIComponent('stopping a knee slice pass')}`);
    expect(voyage.queries().length).toBe(queries);
  });

  it('uses meaning in the app only for phrases, where names alone fall short', async () => {
    const queries = voyage.queries().length;
    // One or two words are usually a name: fuzzy name matching handles those, without the service.
    expect((await api<NoteView[]>('GET', '/api/v1/notes?q=crossface')).body.map(n => n.body)).toEqual([
      `${FRAME}, then turn to the knees`,
    ]);
    expect((await api<NoteView[]>('GET', `/api/v1/notes?q=${encodeURIComponent('knee cut')}`)).body).toEqual([]);
    expect(voyage.queries().length).toBe(queries);
  });

  it('finds technique cards by meaning, and still applies the filters', async () => {
    const card = await api('POST', '/api/v1/techniques', { name: 'Knee shield retention', type: 'retention', role: 'bottom' });
    await api('PATCH', `/api/v1/techniques/${card.body.id}`, { summary: 'Keep the knee shield up so they cannot knee slice through.' });
    const q = encodeURIComponent('how to stop the knee cut pass');
    const all = (await api<TechniqueListItem[]>('GET', `/api/v1/techniques?q=${q}`)).body.map(t => t.name);
    expect(all).toContain('Knee shield retention');
    const subs = (await api<TechniqueListItem[]>('GET', `/api/v1/techniques?q=${q}&type=submission`)).body.map(t => t.name);
    expect(subs).not.toContain('Knee shield retention');
  });

  it("leaves out notes that are only a link, and never mixes up people's notebooks", async () => {
    await api('POST', '/api/v1/capture', { url: 'https://www.instagram.com/reel/PLACEHOLDER1/' });
    // A second person with a note on the same subject.
    const invite = await api<{ url: string }>('POST', '/api/v1/invites', { name: 'Sam' });
    const joined = await api('POST', '/api/v1/invites/accept', {
      token: invite.body.url.split('#')[1],
      email: 'sam@example.com',
      password: 'sam-password-123',
    }, '');
    const sam = joined.headers.get('set-cookie')!.split(';')[0]!;
    const samNote = await api<NoteCreateResult>('POST', '/api/v1/notes', { text: 'Crossface first, then frame against the knee cut' }, sam);
    const q = encodeURIComponent('stopping a knee slice pass');
    const mine = (await api<NoteView[]>('GET', `/api/v1/notes?q=${q}`)).body.map(n => n.id);
    const theirs = (await api<NoteView[]>('GET', `/api/v1/notes?q=${q}`, undefined, sam)).body.map(n => n.id);
    expect(mine).not.toContain(samNote.body.note.id);
    expect(theirs).toEqual([samNote.body.note.id]);

    const rows = (
      await s.db.query<{ user_id: number; empty: boolean; body: string }>(
        `select e.user_id, e.embedding is null as empty, n.body from note_embeddings e join notes n on n.id = e.note_id order by e.note_id`,
      )
    ).rows;
    expect(rows.find(r => r.body === 'Instagram reel to try.')).toMatchObject({ empty: true }); // only a link: nothing to embed
    expect(rows.find(r => r.body.startsWith('Crossface first'))).toMatchObject({ user_id: joined.body.user.id, empty: false });
  });

  it('falls back to keyword search when the service fails, and tells the owner', async () => {
    voyage.fail(500);
    await api('POST', '/api/v1/notes', { text: 'Triangle from closed guard: angle out before you lock it' });
    const found = await api<NoteView[]>('GET', `/api/v1/notes?q=${encodeURIComponent('triangle from closed guard')}`);
    expect(found.status).toBe(200);
    expect(found.body.map(n => n.body)).toEqual(['Triangle from closed guard: angle out before you lock it']);
    const status = (await api<AccountView>('GET', '/api/v1/account')).body.search!;
    expect(status).toMatchObject({ enabled: true, model: 'voyage-test', lastError: 'Voyage AI: Something broke.' });
    expect(status.indexed).toBeLessThan(status.total);

    voyage.fail(null);
    await api('GET', `/api/v1/notes?q=${encodeURIComponent('choke from the guard')}`);
    const after = (await api<AccountView>('GET', '/api/v1/account')).body.search!;
    expect(after.lastError).toBeNull();
    expect(after.indexed).toBe(after.total);
  });
});

describe('without an embeddings service', () => {
  let plain: TestServer;
  beforeAll(async () => {
    plain = await startServer();
  });
  afterAll(async () => {
    await plain.close();
  });

  it('searches by words as before, and says how to turn meaning on', async () => {
    const claude = await mcp(plain);
    try {
      await claude.call('add_note', { text: FRAME, techniques: ['Ghost escape'] });
      expect(await claude.call('search', { query: KNEE_CUT_QUESTION })).not.toContain(FRAME);
      expect(await claude.call('search', { query: 'crossface' })).toContain(FRAME);
    } finally {
      await claude.client.close();
    }
    const res = await fetch(`${plain.base}/api/v1/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-bjj-app': '1' },
      body: JSON.stringify({ password: OWNER_PASSWORD }),
    });
    const account = (await (await fetch(`${plain.base}/api/v1/account`, { headers: { cookie: res.headers.get('set-cookie')!.split(';')[0]! } })).json()) as AccountView;
    expect(account.search).toMatchObject({ enabled: false, model: null });
  });
});

describe('the Voyage AI client', () => {
  it('sends long lists in batches and puts answers back in order', async () => {
    const before = voyage.calls.length;
    const texts = Array.from({ length: 70 }, (_, i) => (i % 2 ? `choke ${i}` : `sweep ${i}`));
    const out = await voyageEmbedder('test-voyage-key', 'voyage-test', { baseUrl: voyage.url, batch: 32 }).embed(texts, 'document');
    expect(voyage.calls.length - before).toBe(3);
    expect(out).toEqual(texts.map(embed));
  });

  it('turns failures into plain errors', async () => {
    voyage.fail(401);
    await expect(voyageEmbedder('wrong', 'voyage-test', { baseUrl: voyage.url }).embed(['x'], 'query')).rejects.toThrow(
      new EmbeddingError('Voyage AI: the API key was refused.'),
    );
    expect(embeddingHealth.lastError).toBe('Voyage AI: the API key was refused.');
    voyage.fail(null);
    await expect(voyageEmbedder('k', 'voyage-test', { baseUrl: 'http://127.0.0.1:9', timeoutMs: 2000 }).embed(['x'], 'query')).rejects.toThrow(
      /Couldn't reach Voyage AI/,
    );
  });
});
