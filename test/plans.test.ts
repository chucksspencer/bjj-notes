// "Describe it": Claude outlines a plan from plain words. Claude is a stand-in here, answering with a fixed outline.
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PlanDraft, TechniqueView } from '../src/shared/api.js';
import { OWNER_PASSWORD, startServer, type TestServer } from './helpers.js';

const DESCRIBED =
  'From bottom side, if the top player has the underhook and cross face, use the john wayne sweep to force them to post ' +
  'their underhook hand so you can win that underhook. Try to do a shuck pass. If they post their far leg, go to deep half. ' +
  'If they base back, go to octopus sweeps.';

/** What Claude sends back for DESCRIBED: one step nested too deep and one blank, to check the outline is made valid. */
const OUTLINE = {
  start: 'side control',
  start_role: 'bottom',
  premise: 'Top has the underhook and crossface',
  steps: [
    { depth: 0, do: 'John Wayne sweep', note: 'force them to post the underhook hand, win the underhook' },
    { depth: 0, do: 'Shuck pass', technique: 'Shuck' },
    { depth: 1, when: 'they post the far leg', do: 'Go to deep half', to: 'deep half', to_role: 'bottom' },
    { depth: 3, when: 'they base back', do: 'Octopus sweeps' },
    { depth: 0, do: '   ' },
  ],
};

async function fakeClaude() {
  const systems: string[] = [];
  const http: Server = createServer((req, res) => {
    let raw = '';
    req.on('data', c => (raw += c));
    req.on('end', () => {
      const body = JSON.parse(raw) as { model: string; system: string; tool_choice: { name: string } };
      systems.push(body.system);
      res.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({
          id: 'msg_1',
          type: 'message',
          role: 'assistant',
          model: body.model,
          content: [{ type: 'tool_use', id: 'toolu_1', name: body.tool_choice.name, input: OUTLINE }],
          stop_reason: 'tool_use',
          stop_sequence: null,
          usage: { input_tokens: 100, output_tokens: 100 },
        }),
      );
    });
  });
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${(http.address() as AddressInfo).port}`,
    systems,
    close: () => new Promise<void>(resolve => http.close(() => resolve())),
  };
}

let claude: Awaited<ReturnType<typeof fakeClaude>>;
let s: TestServer;
let plain: TestServer;

async function signIn(server: TestServer) {
  const res = await fetch(`${server.base}/api/v1/session`, {
    method: 'POST',
    headers: { 'x-bjj-app': '1', 'content-type': 'application/json' },
    body: JSON.stringify({ password: OWNER_PASSWORD }),
  });
  const cookie = res.headers.get('set-cookie')!.split(';')[0]!;
  return async <T = any>(method: string, p: string, body?: unknown) => {
    const r = await fetch(`${server.base}${p}`, {
      method,
      headers: { 'x-bjj-app': '1', cookie, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: r.status, body: (await r.json().catch(() => null)) as T };
  };
}

beforeAll(async () => {
  claude = await fakeClaude();
  s = await startServer(null, undefined, { ANTHROPIC_API_KEY: 'test-key', ANTHROPIC_BASE_URL: claude.url, SEARCH_MODEL: 'off' });
  plain = await startServer();
});
afterAll(async () => {
  await s.close();
  await plain.close();
  await claude.close();
});

describe('describing a plan', () => {
  it('outlines it with cards and positions matched, and saves nothing', async () => {
    const api = await signIn(s);
    const jw = (await api<TechniqueView>('POST', '/api/v1/techniques', { name: 'John Wayne sweep', type: 'sweep', role: 'bottom' })).body;
    const shuck = (await api<TechniqueView>('POST', '/api/v1/techniques', { name: 'Shuck', type: 'transition', role: 'bottom' })).body;
    const areasBefore = (await api('GET', '/api/v1/areas')).body.areas.length;
    const draft = await api<PlanDraft>('POST', '/api/v1/plans/draft', { text: DESCRIBED });
    expect(draft.status).toBe(200);
    // Claude is told this person's cards, so it can use their names.
    expect(claude.systems.at(-1)).toMatch(/Known techniques: .*John Wayne sweep; .*Shuck/);
    const d = draft.body;
    expect(d.start).toMatchObject({ name: 'Side control' });
    expect([d.startRole, d.premise]).toEqual(['bottom', 'Top has the underhook and crossface']);
    expect(d.plan.map(p => [p.depth, p.trigger, p.action, p.techniqueId, p.toName])).toEqual([
      [0, null, 'John Wayne sweep', jw.id, null],
      [0, null, 'Shuck pass', shuck.id, null],
      [1, 'they post the far leg', 'Go to deep half', null, 'Deep half guard'],
      [2, 'they base back', 'Octopus sweeps', null, null], // pulled up from 3 to one below the step before; the blank step left out
    ]);
    expect(d.plan[0]!.note).toBe('force them to post the underhook hand, win the underhook');
    expect((await api('GET', '/api/v1/areas')).body.areas).toHaveLength(areasBefore);
  });

  it('says so when the server has no Claude', async () => {
    const api = await signIn(plain);
    const r = await api('POST', '/api/v1/plans/draft', { text: DESCRIBED });
    expect([r.status, r.body.message]).toEqual([400, "Describing a plan needs Claude, and this server isn't set up with an Anthropic key."]);
  });
});
