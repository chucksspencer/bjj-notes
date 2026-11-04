// Search by meaning, against a stand-in for the Claude Messages API that runs in the test. Like Claude would,
// it reads the search and the person's technique list and answers with the search_for tool: which of their
// cards it's about, and the words a note about it would use.
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import type { AccountView, NoteCreateResult, NoteView, TechniqueListItem } from '../src/shared/api.js';
import { claudeRewriter, clearRewriteCache, rewriteHealth, rewriterFor } from '../src/services/semantic.js';
import { connect, OWNER_PASSWORD, startServer, type TestServer } from './helpers.js';

/** What the stand-in says to look for: the first rule whose pattern the search matches. */
const RULES: { match: RegExp; techniques: string[]; terms: string[] }[] = [
  {
    match: /knee (cut|slice)/i,
    // Card names as Claude would give them: one by its other name, one the person doesn't have.
    techniques: ['Knee shield retention', 'half butterfly', 'Knee cut defense (made up)'],
    terms: ['knee slice', '"knee-cut"', 'frame', 'crossface', 'or', 'knee shield'],
  },
  { match: /leg ?lock|foot ?lock/i, techniques: ['Ankle lock'], terms: ['ankle lock', 'heel hook', 'toes'] },
];

interface Call {
  apiKey: string | undefined;
  model: string;
  system: string;
  query: string;
  toolChoice: unknown;
}

/** The stand-in for Claude: answers POST /v1/messages in the Messages API's shape, and records each call. */
async function fakeClaude() {
  const calls: Call[] = [];
  let failWith: number | null = null;
  const http: Server = createServer((req, res) => {
    let raw = '';
    req.on('data', c => (raw += c));
    req.on('end', () => {
      if (req.method !== 'POST' || !req.url?.startsWith('/v1/messages')) {
        res.writeHead(404).end();
        return;
      }
      const body = JSON.parse(raw) as { model: string; system: string; messages: { content: string }[]; tool_choice: unknown };
      const query = body.messages[0]!.content;
      calls.push({ apiKey: req.headers['x-api-key'] as string, model: body.model, system: body.system, query, toolChoice: body.tool_choice });
      if (failWith) {
        const message = failWith === 401 ? 'invalid x-api-key' : 'Something broke';
        res
          .writeHead(failWith, { 'content-type': 'application/json' })
          .end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message } }));
        return;
      }
      const rule = RULES.find(r => r.match.test(query));
      // Only cards that are on this person's list (Claude is told the list), by name or other name.
      const known = /Known techniques: (.*)/.exec(body.system)![1]!.toLowerCase();
      const input = {
        techniques: (rule?.techniques ?? []).filter(t => known.includes(t.toLowerCase())),
        terms: rule?.terms ?? [],
      };
      res.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({
          id: `msg_${calls.length}`,
          type: 'message',
          role: 'assistant',
          model: body.model,
          content: [{ type: 'tool_use', id: `toolu_${calls.length}`, name: 'search_for', input }],
          stop_reason: 'tool_use',
          stop_sequence: null,
          usage: { input_tokens: 100, output_tokens: 20 },
        }),
      );
    });
  });
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${(http.address() as AddressInfo).port}`,
    calls,
    queries: () => calls.map(c => c.query),
    fail: (status: number | null) => (failWith = status),
    reset: () => void calls.splice(0),
    close: () => new Promise<void>(resolve => http.close(() => resolve())),
  };
}

let claudeApi: Awaited<ReturnType<typeof fakeClaude>>;
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
const HEAVY = 'Stay on my side and keep the top knee pointed at the ceiling';
const KNEE_CUT_QUESTION = 'how do I stop the knee cut';
const notes = async (q: string, as = cookie) =>
  (await api<NoteView[]>('GET', `/api/v1/notes?q=${encodeURIComponent(q)}`, undefined, as)).body.map(n => n.body);

beforeAll(async () => {
  claudeApi = await fakeClaude();
  s = await startServer(null, undefined, { ANTHROPIC_API_KEY: 'test-anthropic-key', ANTHROPIC_BASE_URL: claudeApi.url, SEARCH_MODEL: 'claude-test' });
  const signIn = await api('POST', '/api/v1/session', { password: OWNER_PASSWORD }, '');
  cookie = signIn.headers.get('set-cookie')!.split(';')[0]!;
  // A card of this person's own, with another name, and a note about it that shares no words with the search.
  const card = await api('POST', '/api/v1/techniques', { name: 'Knee shield retention', type: 'retention', role: 'bottom' });
  await api('PATCH', `/api/v1/techniques/${card.body.id}`, { aliases: ['Half butterfly'], summary: 'Keep the shin across their hips.' });
  await api('POST', '/api/v1/notes', { text: HEAVY, techniqueIds: [card.body.id] });
});
afterAll(async () => {
  await s.close();
  await claudeApi.close();
});
beforeEach(() => {
  claudeApi.fail(null);
  claudeApi.reset();
  clearRewriteCache();
});

describe('search by meaning', () => {
  it("finds notes by what they're about in Claude's search", async () => {
    const claude = await mcp(s);
    try {
      expect(await claude.call('add_note', { text: FRAME, techniques: ['Ghost escape'] })).toMatch(/^Saved note/);
      expect(await claude.call('add_note', { text: ANKLE, techniques: ['Ankle lock'] })).toMatch(/^Saved note/);
      const found = await claude.call('search', { query: KNEE_CUT_QUESTION });
      expect(found).toContain(FRAME); // by the words Claude suggested
      expect(found).toContain(HEAVY); // about the card Claude named (by its other name)
      expect(found).toContain('Knee shield retention');
      expect(found).not.toContain(ANKLE);
    } finally {
      await claude.client.close();
    }
    // One question to Claude for both cards and notes, with this person's cards and the right settings.
    expect(claudeApi.queries()).toEqual([KNEE_CUT_QUESTION]);
    const call = claudeApi.calls[0]!;
    expect(call).toMatchObject({ apiKey: 'test-anthropic-key', model: 'claude-test', toolChoice: { type: 'tool', name: 'search_for' } });
    expect(call.system).toContain('Knee shield retention (also: Half butterfly)');
    expect(call.system).toMatch(/Known positions: .*Half guard/);
  });

  it('asks Claude once for the same search', async () => {
    const q = 'stopping a knee slice pass';
    expect(await notes(q)).toEqual(expect.arrayContaining([FRAME, HEAVY]));
    await api('GET', `/api/v1/techniques?q=${encodeURIComponent(q)}`);
    expect(await notes(`  Stopping a KNEE slice   pass `)).toEqual(expect.arrayContaining([FRAME, HEAVY]));
    expect(claudeApi.queries()).toEqual([q]);
  });

  it('uses meaning in the app only for phrases, and in Claude when the words find nothing', async () => {
    // One or two words in the app are usually a name: keyword and fuzzy name matching, without asking Claude.
    expect(await notes('crossface')).toEqual([FRAME]);
    expect(await notes('knee cut')).toEqual([]);
    expect(claudeApi.calls).toHaveLength(0);
    // Claude's search: words first; Claude is asked only if they find nothing.
    const claude = await mcp(s);
    try {
      expect(await claude.call('search', { query: 'crossface' })).toContain(FRAME);
      expect(claudeApi.calls).toHaveLength(0);
      expect(await claude.call('search', { query: 'knee slice' })).toContain(FRAME);
      expect(claudeApi.queries()).toEqual(['knee slice']);
    } finally {
      await claude.client.close();
    }
  });

  it('finds technique cards by meaning, and still applies the filters', async () => {
    const q = encodeURIComponent('how to stop the knee cut pass');
    const all = (await api<TechniqueListItem[]>('GET', `/api/v1/techniques?q=${q}`)).body.map(t => t.name);
    expect(all[0]).toBe('Knee shield retention');
    const subs = (await api<TechniqueListItem[]>('GET', `/api/v1/techniques?q=${q}&type=submission`)).body.map(t => t.name);
    expect(subs).not.toContain('Knee shield retention');
    // A search Claude has nothing more for gives the keyword results.
    const plain = (await api<TechniqueListItem[]>('GET', `/api/v1/techniques?q=${encodeURIComponent('something else entirely')}`)).body;
    expect(plain).toEqual([]);
  });

  it("never mixes up people's notebooks", async () => {
    const invite = await api<{ url: string }>('POST', '/api/v1/invites', { name: 'Sam' });
    const joined = await api(
      'POST',
      '/api/v1/invites/accept',
      { token: invite.body.url.split('#')[1], email: 'sam@example.com', password: 'sam-password-123' },
      '',
    );
    const sam = joined.headers.get('set-cookie')!.split(';')[0]!;
    const samNote = await api<NoteCreateResult>('POST', '/api/v1/notes', { text: 'Crossface first, then frame against the knee slice' }, sam);
    const q = 'stopping a knee slice pass';
    expect(await notes(q)).not.toContain(samNote.body.note.body);
    expect(await notes(q, sam)).toEqual([samNote.body.note.body]);
    // Each person's search is asked with their own cards.
    expect(claudeApi.calls).toHaveLength(2);
    expect(claudeApi.calls[0]!.system).toContain('Knee shield retention');
    expect(claudeApi.calls[1]!.system).not.toContain('Knee shield retention');
  });

  it('falls back to keyword search when Claude fails, and tells the owner', async () => {
    claudeApi.fail(400);
    await api('POST', '/api/v1/notes', { text: 'Triangle from closed guard: angle out before you lock it' });
    const found = await api<NoteView[]>('GET', `/api/v1/notes?q=${encodeURIComponent('triangle from closed guard')}`);
    expect(found.status).toBe(200);
    expect(found.body.map(n => n.body)).toEqual(['Triangle from closed guard: angle out before you lock it']);
    expect((await api<AccountView>('GET', '/api/v1/account')).body.search).toEqual({
      enabled: true,
      model: 'claude-test',
      lastError: 'Claude: Something broke.',
    });
    // A failed answer isn't remembered: the next try asks again, and success clears the error.
    claudeApi.fail(null);
    expect(await notes('triangle from closed guard')).toHaveLength(1);
    expect(claudeApi.queries().filter(q => q === 'triangle from closed guard')).toHaveLength(2);
    expect((await api<AccountView>('GET', '/api/v1/account')).body.search!.lastError).toBeNull();
  });
});

describe('without an Anthropic key', () => {
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
    expect(account.search).toEqual({ enabled: false, model: null, lastError: null });
  });
});

describe('the Claude client', () => {
  const env = { OWNER_PASSWORD: 'x'.repeat(12), API_TOKEN: 'y'.repeat(32), ANTHROPIC_API_KEY: 'k' };

  it('is on with an Anthropic key unless SEARCH_MODEL=off', () => {
    expect(rewriterFor(loadConfig(env))?.model).toBe('claude-haiku-5-5');
    expect(rewriterFor(loadConfig({ ...env, SEARCH_MODEL: 'claude-sonnet-5-5' }))?.model).toBe('claude-sonnet-5-5');
    expect(rewriterFor(loadConfig({ ...env, SEARCH_MODEL: 'OFF' }))).toBeNull();
    expect(rewriterFor(loadConfig({ ...env, ANTHROPIC_API_KEY: '' }))).toBeNull();
  });

  it('turns failures into plain errors', async () => {
    const known = { techniques: [], positions: [] };
    claudeApi.fail(401);
    await expect(claudeRewriter('wrong', 'claude-test', { baseURL: claudeApi.url }).rewrite('x', known)).rejects.toThrow(
      'Claude: the API key was refused.',
    );
    expect(rewriteHealth.lastError).toBe('Claude: the API key was refused.');
    claudeApi.fail(null);
    await expect(
      claudeRewriter('k', 'claude-test', { baseURL: 'http://127.0.0.1:9', timeoutMs: 2000 }).rewrite('x', known),
    ).rejects.toThrow("Couldn't reach Claude.");
  });
});
