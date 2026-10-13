import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connect, startServer, type TestServer } from './helpers.js';

let s: TestServer;
let client: Client;

async function call(name: string, args: Record<string, unknown> = {}): Promise<string> {
  const res = (await client.callTool({ name, arguments: args })) as { content: { type: string; text: string }[]; isError?: boolean };
  const text = res.content.map(c => c.text).join('\n');
  if (res.isError) throw new Error(text);
  return text;
}

beforeAll(async () => {
  s = await startServer();
  const { access_token } = await connect(s);
  client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(s.mcpUrl), {
      requestInit: { headers: { Authorization: `Bearer ${access_token}` } },
    }),
  );
});
afterAll(async () => {
  await client.close();
  await s.close();
});

describe('MCP tools over HTTP', () => {
  it('lists the tools and the server instructions', async () => {
    const { tools } = await client.listTools();
    expect(tools.map(t => t.name).sort()).toEqual(
      [
        'add_note',
        'file_note',
        'get_focus',
        'get_inbox',
        'get_position',
        'get_technique',
        'log_session',
        'review',
        'save_technique',
        'search',
        'undo_last',
        'update_focus',
        'update_note',
      ].sort(),
    );
    expect(client.getInstructions()).toContain('voice transcription');
  });

  it('starts with the imported working list as the focus list', async () => {
    const focus = await call('get_focus');
    expect(focus).toContain('1. Baratoplata — no notes yet');
    expect(focus).toContain('7. Ankle lock adjustments');
  });

  it('adds a note with a misheard technique name and shows it on the card', async () => {
    const saved = await call('add_note', {
      text: 'Turn to the knees before the hips; keep the far elbow tight so he cannot follow.',
      techniques: ['ghost'],
      kind: 'rolling',
    });
    expect(saved).toMatch(/^Saved note #\d+ to Ghost escape\.$/);

    const card = await call('get_technique', { name: 'ghost escape' });
    expect(card).toContain('Ghost escape (escape, bottom). Status: learning.');
    expect(card).toContain('Position: Side control (bottom)');
    expect(card).toContain('Focus: #5 on the active list');
    expect(card).toContain('keep the far elbow tight');

    const focus = await call('get_focus');
    expect(focus).toContain('5. Ghost escape — last note today');
  });

  it('records a video source with a timestamp', async () => {
    const saved = await call('add_note', {
      text: 'Lift with the bottom hook, then come up on the far side.',
      techniques: ['leg elevation'],
      source: { url: 'https://youtu.be/abc123', timestamp: '4:32', author: 'Some coach' },
    });
    expect(saved).toContain('Leg elevation');
    const card = await call('get_technique', { name: 'Leg elevation' });
    expect(card).toContain('[https://youtu.be/abc123 @4:32]');
  });

  it('creates a technique card in the graph with a chained follow-up', async () => {
    const created = await call('save_technique', {
      name: 'Kimura',
      type: 'submission',
      role: 'bottom',
      positions: [{ from: 'closed guard', from_role: 'bottom' }],
      key_details: ['Figure-four grip, thumbless', 'Hip out to the side before finishing'],
      links: [{ kind: 'chain', technique: 'Hip bump sweep' }],
    });
    expect(created).toBe('Created Kimura (created a new card for Hip bump sweep).');

    const updated = await call('save_technique', { name: 'kimora', mistakes: ['Finishing with the arms instead of the hips'] });
    expect(updated).toBe('Updated Kimura (matched "kimora" to Kimura).');

    const card = await call('get_technique', { name: 'Kimura' });
    expect(card).toContain('Position: Closed guard (bottom)');
    expect(card).toContain('- Figure-four grip, thumbless');
    expect(card).toContain('Common mistakes:\n- Finishing with the arms instead of the hips');
    expect(card).toContain('chain → Hip bump sweep');

    const missing = await call('save_technique', { name: 'Clock choke' });
    expect(missing).toContain('call again with a type');
  });

  it('explores a position and points out gaps', async () => {
    const pos = await call('get_position', { name: 'closed guard', role: 'bottom' });
    expect(pos).toContain('Closed guard (bottom) — guard.');
    expect(pos).toContain('submission: Kimura');
    expect(pos).toContain('Gaps: no bottom sweep, bottom retention logged.');

    const deepHalf = await call('get_position', { name: 'deep half' });
    expect(deepHalf).toContain('sweep: Leg elevation [bottom] → top');
  });

  it('searches by fuzzy name, filters and note text', async () => {
    expect(await call('search', { query: 'kimora' })).toContain('- Kimura (submission, bottom; seen; 0 notes)');
    const subs = await call('search', { type: 'submission' });
    expect(subs).toContain('Baratoplata');
    expect(subs).not.toContain('Ghost escape');
    const byPosition = await call('search', { position: 'side control' });
    expect(byPosition).toContain('Ghost escape');
    expect(byPosition).not.toContain('Kimura');
    const notes = await call('search', { query: 'elbow' });
    expect(notes).toContain('[Ghost escape]: Turn to the knees');
  });

  it('manages the focus list, with history and undo', async () => {
    expect(await call('update_focus', { action: 'add', item: 'Kimura from closed guard' })).toBe(
      'Added to focus at #1: Kimura from closed guard (linked to Kimura).',
    );
    let focus = await call('get_focus');
    expect(focus).toContain('1. Kimura from closed guard');
    expect(focus).toContain('2. Baratoplata');

    expect(await call('undo_last')).toBe('Undid: add "Kimura from closed guard"');
    focus = await call('get_focus');
    expect(focus).toContain('1. Baratoplata');
    expect(focus).not.toContain('Kimura');

    expect(await call('update_focus', { action: 'move', item: 'ghost', position: 1 })).toBe('Moved to #1: Ghost escape.');
    expect(await call('update_focus', { action: 'pause', item: 'ankle lock' })).toBe('Paused: Ankle lock adjustments.');
    focus = await call('get_focus');
    expect(focus).toContain('1. Ghost escape');
    expect(focus).toContain('2. Baratoplata');
    expect(focus).toContain('Paused: Ankle lock adjustments.');
    expect(focus).not.toContain('7.');

    expect(await call('update_focus', { action: 'resume', item: 'ankle lock', position: 3 })).toBe(
      'Back on the active list at #3: Ankle lock adjustments.',
    );
    const history = await call('get_focus', { history: true, item: 'ankle lock' });
    expect(history).toMatch(/added \(#7\): Ankle lock adjustments\n.*paused: Ankle lock adjustments\n.*resumed \(#3\): Ankle lock adjustments/);
  });

  it('sends unplaceable notes to the inbox and files them later', async () => {
    const saved = await call('add_note', { text: 'Armbar from mount: pinch the knees first.', techniques: ['armbar from mount'] });
    expect(saved).toContain('"armbar from mount" isn\'t a known technique');
    expect(saved).toContain('left in the inbox');
    const id = Number(saved.match(/#(\d+)/)![1]);

    expect(await call('get_inbox')).toContain(`#${id}`);
    const filed = await call('file_note', {
      note_id: id,
      techniques: [],
      new_techniques: [{ name: 'Armbar', type: 'submission', role: 'top' }],
    });
    expect(filed).toBe(`Filed note #${id} under Armbar.`);
    expect(await call('get_inbox')).toBe('Inbox is empty.');
  });

  it('logs a session, attaches the day\'s notes and reviews the week', async () => {
    const logged = await call('log_session', { kind: 'class', gi: 'nogi', instructor: 'Coach' });
    expect(logged).toMatch(/^Logged class by Coach on \d{4}-\d{2}-\d{2} and attached 3 notes from that day\.$/);
    // Saying it again updates the same class rather than logging a second one.
    expect(await call('log_session', { kind: 'class', summary: 'Lots of guard work' })).toMatch(/^Updated class by Coach on /);
    const r = await call('review', { days: 7 });
    expect(r).toContain('1 session (1 class), 3 notes.');
    expect(r).toContain('Most noted: Armbar (1), Ghost escape (1), Leg elevation (1).');
    expect(r).toContain('Quiet focus items');
    expect(r).not.toMatch(/Quiet focus items[^\n]*Ghost escape/);
  });

  it('records where a note came from and shows it on the card', async () => {
    const saved = await call('add_note', {
      text: 'Hide the near arm before you turn.',
      techniques: ['ghost escape'],
      session: { kind: 'seminar', name: 'Zen camp', instructor: 'Josh Jones', date: '2024-02-03' },
    });
    expect(saved).toMatch(/^Saved note #\d+ to Ghost escape \(from Zen camp seminar by Josh Jones on 2024-02-03\)\.$/);
    const id = Number(saved.match(/#(\d+)/)![1]);
    expect(await call('get_technique', { name: 'Ghost escape' })).toContain(
      `- 2024-02-03 instruction from Zen camp seminar by Josh Jones #${id}: Hide the near arm before you turn.`,
    );
    expect(await call('search', { query: 'Josh Jones' })).toContain(`#${id} 2024-02-03 from Zen camp seminar by Josh Jones`);
    expect(await call('get_technique', { name: 'Ghost escape', note_limit: 0 })).toMatch(/\n\d+ notes \(not shown\)\.$/);

    // Logging the seminar afterwards finds the same session.
    expect(await call('log_session', { kind: 'seminar', name: 'zen camp', date: '2024-02-03', location: 'Austin' })).toBe(
      'Updated Zen camp seminar by Josh Jones at Austin on 2024-02-03.',
    );
    expect(await call('undo_last')).toBe('Undid: Zen camp seminar by Josh Jones at Austin on 2024-02-03');

    // A client with an older copy of the schema sends the session as JSON text.
    const asText = await call('add_note', { text: 'Grip fighting first.', date: '2024-02-03', session: '{"kind": "seminar", "name": "Zen camp"}' });
    expect(asText).toContain('(from Zen camp seminar by Josh Jones on 2024-02-03)');
    await call('undo_last');
    await expect(call('add_note', { text: 'x', session: 'class' })).rejects.toThrow(/session should look like/);

    expect(await call('update_note', { note_id: id, clear_session: true })).toBe(`Updated note #${id} (no session).`);
    expect(await call('update_note', { note_id: id, session: { kind: 'private', instructor: 'Josh Jones' } })).toBe(
      `Updated note #${id} (from private lesson by Josh Jones on 2024-02-03).`,
    );
    expect(await call('undo_last')).toBe(`Undid: edit to note #${id}`);
    expect(await call('get_technique', { name: 'Ghost escape' })).toContain(`- 2024-02-03 instruction #${id}:`);
  });

  it('undoes a technique edit', async () => {
    await call('save_technique', { name: 'Baratoplata', status: 'drilling', summary: 'Omoplata variation' });
    expect(await call('get_technique', { name: 'Baratoplata' })).toContain('Status: drilling.');
    expect(await call('undo_last')).toBe('Undid: Updated Baratoplata');
    const card = await call('get_technique', { name: 'Baratoplata' });
    expect(card).toContain('Status: learning.');
    expect(card).not.toContain('Omoplata variation');
  });
});
