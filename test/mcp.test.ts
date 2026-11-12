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
        'clear_stars',
        'file_note',
        'get_area',
        'get_focus',
        'get_inbox',
        'get_lab',
        'get_position',
        'get_technique',
        'log_session',
        'review',
        'save_area',
        'save_technique',
        'search',
        'undo_last',
        'update_focus',
        'update_note',
      ].sort(),
    );
    expect(client.getInstructions()).toContain('voice transcription');
    expect(client.getInstructions()).toContain('"System" and "game plan" mean an area with a plan.');
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
    expect(card).toContain('In areas: Ghost escape (#5 on focus).');
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
      'New area, on focus at #1: Kimura from closed guard (linked to Kimura).',
    );
    let focus = await call('get_focus');
    expect(focus).toContain('1. Kimura from closed guard');
    expect(focus).toContain('2. Baratoplata');

    expect(await call('undo_last')).toBe('Undid: add "Kimura from closed guard"');
    focus = await call('get_focus');
    expect(focus).toContain('1. Baratoplata');
    expect(focus).not.toContain('Kimura');

    expect(await call('update_focus', { action: 'move', item: 'ghost', position: 1 })).toBe('Moved to #1: Ghost escape.');
    expect(await call('update_focus', { action: 'remove', item: 'ankle lock' })).toBe('Taken off focus: Ankle lock adjustments.');
    focus = await call('get_focus');
    expect(focus).toContain('1. Ghost escape');
    expect(focus).toContain('2. Baratoplata');
    expect(focus).toContain('1 other area off focus');
    expect(focus).not.toContain('7.');
    expect(await call('get_area')).toContain('Ankle lock adjustments');
    expect(await call('update_focus', { action: 'remove', item: 'ankle lock' })).toBe('Already off focus: Ankle lock adjustments.');

    // Older action names still work: resume puts it back on, pause takes it off.
    expect(await call('update_focus', { action: 'resume', item: 'ankle lock', position: 3 })).toBe('On focus at #3: Ankle lock adjustments.');
    // Adding what's already there doesn't make a second one.
    expect(await call('update_focus', { action: 'add', item: 'ankle lock adjustments' })).toBe('Already #3 on focus: Ankle lock adjustments.');
    const history = await call('get_focus', { history: true, item: 'ankle lock' });
    expect(history).toMatch(/added \(#7\): Ankle lock adjustments\n.*removed: Ankle lock adjustments\n.*added \(#3\): Ankle lock adjustments/);
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
    expect(r).toContain('Quiet on your focus');
    expect(r).not.toMatch(/Quiet on your focus[^\n]*Ghost escape/);
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

  it('keeps "silly Instagram bullshit" on the To try list until it is kept', async () => {
    const saved = await call('add_note', {
      text: 'Reverse De La Riva back take. Looks fake but maybe.',
      techniques: ['ghost escape'],
      source: { url: 'https://www.instagram.com/reel/SIB12345/' },
      to_try: true,
    });
    expect(saved).toMatch(/^Added note #\d+ to try \(about Ghost escape\)\.$/);
    const id = Number(saved.match(/#(\d+)/)![1]);
    const waiting = await call('get_inbox', { to_try: true });
    expect(waiting).toContain(`#${id}`);
    expect(waiting).toContain('<https://www.instagram.com/reel/SIB12345/>');
    expect(await call('get_inbox')).not.toContain(`#${id}`);
    expect(await call('get_technique', { name: 'Ghost escape' })).toContain(`[to try] #${id}:`);
    expect(await call('file_note', { note_id: id, techniques: ['Ghost escape'] })).toBe(`Kept note #${id}, filed under Ghost escape.`);
    expect(await call('get_inbox', { to_try: true })).not.toContain(`#${id}`);
    expect(await call('undo_last')).toBe(`Undid: keeping note #${id}`);
    expect(await call('get_inbox', { to_try: true })).toContain(`#${id}`);
    expect(await call('update_note', { note_id: id, to_try: false })).toBe(`Updated note #${id}, off the To try list.`);
    // A client with an older copy of the schema sends yes/no options as text.
    expect(await call('update_note', { note_id: id, to_try: 'true' })).toBe(`Updated note #${id}, now on the To try list.`);
    expect(await call('get_inbox', { to_try: 'true' })).toContain(`#${id}`);
  });

  it('stars notes and sums up the Lab', async () => {
    const saved = await call('add_note', { text: 'Keep the elbow tight before the ghost.', techniques: ['Ghost escape'], starred: true });
    expect(saved).toMatch(/^Saved note #\d+ to Ghost escape, starred\.$/);
    const id = Number(saved.match(/#(\d+)/)![1]);
    const question = await call('add_note', { text: 'How early do I underhook the far leg?', techniques: ['Ghost escape'], kind: 'question' });
    const qid = Number(question.match(/#(\d+)/)![1]);

    const lab = await call('get_lab');
    expect(lab).toContain(`Starred (1):\n- #${id} `);
    expect(lab).toContain('[Ghost escape]: Keep the elbow tight before the ghost.');
    expect(lab).toMatch(/To try \(\d+\):/);
    expect(lab).toMatch(/New in your notes \(last 30 days\):\n- /);
    expect(lab).toContain(`#${qid} `);
    expect(await call('get_technique', { name: 'Ghost escape' })).toContain(`[starred] #${id}:`);

    expect(await call('update_note', { note_id: id, starred: false })).toBe(`Updated note #${id}, unstarred.`);
    expect(await call('get_lab')).toContain('Starred (0):\n- nothing starred');
    expect(await call('undo_last')).toBe(`Undid: unstarring note #${id}`);
    expect(await call('get_lab')).toContain(`Starred (1):\n- #${id} `);
  });

  it('stars techniques for the Lab', async () => {
    expect(await call('save_technique', { name: 'Baratoplata', starred: 'true' })).toBe('Starred Baratoplata.');
    expect(await call('save_technique', { name: 'Baratoplata', starred: true })).toBe('Baratoplata is already starred.');
    expect(await call('get_technique', { name: 'Baratoplata', note_limit: 0 })).toMatch(/Status: \w+\. Starred\./);
    expect(await call('get_lab')).toMatch(/Starred \(\d+\):\n- Baratoplata \(submission/);
    expect(await call('search', { query: 'baratoplata' })).toMatch(/Baratoplata \([^)]*; starred\)/);
    expect(await call('save_technique', { name: 'Baratoplata', starred: false })).toBe('Unstarred Baratoplata.');
    expect(await call('undo_last')).toBe('Undid: unstarring Baratoplata');
    expect(await call('save_technique', { name: 'Baratoplata', starred: false, summary: 'Omoplata cousin' })).toBe('Updated Baratoplata, unstarred.');
    expect(await call('undo_last')).toBe('Undid: Updated Baratoplata');
    expect(await call('save_technique', { name: 'Baratoplata', starred: false })).toBe('Unstarred Baratoplata.');
  });

  it('folds away old stars and questions, clears stars, and marks questions answered', async () => {
    const old = await call('add_note', { text: 'Old star: frames before hips.', techniques: ['Ghost escape'], starred: true });
    const oldId = Number(old.match(/#(\d+)/)![1]);
    await s.db.query("update notes set starred_at = now() - interval '40 days' where id = $1", [oldId]);
    const lab = await call('get_lab');
    expect(lab).not.toContain('Old star: frames before hips.');
    expect(lab).toMatch(/- plus 1 older star \(starred over 4 weeks ago\)/);

    expect(await call('clear_stars', { older_than_days: 28 })).toBe('Cleared 1 star.');
    expect(await call('get_lab')).not.toContain('older star');
    expect(await call('undo_last')).toBe('Undid: clearing 1 star');
    expect(await call('get_lab')).toContain('plus 1 older star');
    expect(await call('clear_stars', { older_than_days: 28 })).toBe('Cleared 1 star.');
    expect(await call('clear_stars', { older_than_days: 28 })).toBe('No stars older than 28 days.');

    const q = await call('add_note', { text: 'Do I hide the arm first?', techniques: ['Ghost escape'], kind: 'question', date: '2024-03-01' });
    const qid = Number(q.match(/#(\d+)/)![1]);
    expect(await call('get_lab')).toMatch(/- plus \d+ older open questions? \(noted over 60 days ago\)/);
    expect(await call('update_note', { note_id: qid, answered: 'true' })).toBe(`Updated note #${qid}, marked answered.`);
    expect(await call('undo_last')).toBe(`Undid: answering note #${qid}`);
    expect(await call('update_note', { note_id: qid, answered: true, text: 'Do I hide the arm first?\n\nAnswer: yes.' })).toBe(
      `Updated note #${qid}, marked answered.`,
    );
  });

  it('keeps a description and filed notes on an area', async () => {
    const edited = await call('save_area', {
      name: 'ghost',
      description: 'Escape before the pin settles.\nGoal: out in under ten seconds.',
      techniques: ['leg elevation', 'qwxz zzyq'],
    });
    expect(edited).toMatch(/^Ghost escape: description updated; linked Leg elevation \(No .*technique.*"qwxz zzyq".*\)\.$/);
    let item = await call('get_area', { name: 'ghost' });
    expect(item).toContain('Ghost escape. #1 on your focus list; last note today.\nEscape before the pin settles.\nGoal: out in under ten seconds.');
    expect(item).toContain('No plan yet.');
    expect(item).toMatch(/Techniques: Ghost escape \(\w+\), Leg elevation \(\w+\)\./);
    expect(item).toMatch(/\d+ other notes? on its techniques\./);
    // The list stays short for reading aloud.
    expect(await call('get_focus')).not.toContain('Escape before');
    // get_focus with an item still reads it, for clients that learned that.
    expect(await call('get_focus', { item: 'ghost' })).toContain('Escape before the pin settles.');

    const saved = await call('add_note', { text: 'Shrimp early, before the crossface.', techniques: ['ghost escape'], area: 'ghost' });
    expect(saved).toMatch(/^Saved note #\d+ to Ghost escape, under Ghost escape\.$/);
    const id = Number(saved.match(/#(\d+)/)![1]);
    item = await call('get_area', { name: 'ghost escape' });
    expect(item).toMatch(new RegExp(`Notes filed here \\(1\\):\\n- #${id} \\d{4}-\\d{2}-\\d{2}: Shrimp early, before the crossface\\.`));
    // focus: is the older name for area.
    const older = await call('add_note', { text: 'Frame first.', area: undefined, focus: 'ghost' });
    expect(older).toMatch(/under Ghost escape\.$/);
    await call('undo_last');

    expect(await call('save_area', { name: 'ghost', rename_to: 'Ghost escape from side control', aliases: ['ghosting'] })).toBe(
      'Ghost escape from side control: renamed to Ghost escape from side control; aliases updated.',
    );
    expect(await call('get_area', { name: 'ghosting' })).toMatch(/^Ghost escape from side control\. /);
    // One undo takes back the whole edit.
    expect(await call('undo_last')).toBe('Undid: edit to "Ghost escape"');
    item = await call('get_area', { name: 'ghost' });
    expect(item).toMatch(/^Ghost escape\. /);
    expect(item).toContain(`- #${id} `);

    expect(await call('undo_last')).toMatch(new RegExp(`^Undid: note #${id}`));
    expect(await call('undo_last')).toBe('Undid: edit to "Ghost escape"');
    item = await call('get_area', { name: 'ghost' });
    expect(item).not.toContain('Escape before');
    expect(item).toMatch(/Techniques: Ghost escape \(\w+\)\./);

    const missed = await call('add_note', { text: 'Breathe.', techniques: ['ghost escape'], area: 'qwxz zzyq' });
    expect(missed).toMatch(/^Saved note #\d+ to Ghost escape; No .*area.*"qwxz zzyq"/);
    await call('undo_last');
    expect(await call('save_area', { name: 'ghost' })).toBe('Nothing changed on Ghost escape.');
  });

  it('saves a system as an area with a plan, and reads it back as if/then', async () => {
    await call('save_technique', { name: 'John Wayne sweep', type: 'sweep', role: 'bottom', status: 'drilling' });
    await call('save_technique', { name: 'Shuck', type: 'transition', role: 'bottom', status: 'learning' });
    const saved = await call('save_area', {
      name: 'Bottom half: winning the underhook',
      start: 'half guard',
      start_role: 'bottom',
      premise: 'Top has the underhook and crossface',
      steps: [
        { depth: 0, do: 'John Wayne sweep', note: 'force them to post the underhook hand, then win the underhook' },
        { depth: 0, do: 'shuck pass', technique: 'shuck' },
        { depth: 1, when: 'they post the far leg', do: 'Go to deep half', to: 'deep half', to_role: 'bottom' },
        { depth: 1, when: 'they base back', do: 'Octopus sweeps' },
      ],
    });
    expect(saved).toBe(
      'New area: Bottom half: winning the underhook: starts in Half guard (bottom); plan saved (4 steps) (no technique card for: Go to deep half; Octopus sweeps).',
    );
    // A new area isn't on focus unless asked.
    expect(await call('get_focus')).not.toContain('underhook');

    const read = await call('get_area', { name: 'winning the underhook' });
    expect(read).toContain('Bottom half: winning the underhook. off focus;');
    expect(read).toContain('Starts in Half guard, bottom, when top has the underhook and crossface.');
    expect(read).toContain(
      [
        'Plan:',
        '1. John Wayne sweep (drilling): force them to post the underhook hand, then win the underhook.',
        '2. shuck pass (learning).',
        '   If they post the far leg: go to deep half → Deep half guard (bottom).',
        '   If they base back: octopus sweeps.',
        'Weakest step: Shuck (learning).',
      ].join('\n'),
    );
    expect(await call('get_technique', { name: 'shuck' })).toContain('In areas: Bottom half: winning the underhook.');
    expect(await call('get_position', { name: 'half guard', role: 'bottom' })).toContain('Plans from here: Bottom half: winning the underhook');
    expect(await call('search', { query: 'what do I do when they post the far leg' })).toContain(
      '- Bottom half: winning the underhook: if they post the far leg: Go to deep half',
    );

    // A plan for deep half: the branch into it now says where it continues.
    await call('save_area', { name: 'Deep half sweeps', start: 'deep half', start_role: 'bottom', steps: [{ depth: 0, do: 'Waiter sweep' }] });
    expect(await call('get_area', { name: 'winning the underhook' })).toContain('go to deep half → Deep half guard (bottom). Continues in: Deep half sweeps.');
    expect(await call('get_area')).toMatch(/Deep half guard \(bottom\): Deep half sweeps \[1 step\]\nHalf guard \(bottom\): Bottom half: winning the underhook \[4 steps\]/);

    // Putting it on focus, and a bad outline.
    expect(await call('save_area', { name: 'winning the underhook', focus: true })).toBe('Bottom half: winning the underhook: on focus at #1.');
    await expect(call('save_area', { name: 'winning the underhook', steps: [{ depth: 0, do: 'a' }, { depth: 2, do: 'b' }] })).rejects.toThrow(
      'Error: Step 2 is 2 levels deeper than the step before it.',
    );
    expect(await call('update_focus', { action: 'remove', item: 'winning the underhook' })).toBe('Taken off focus: Bottom half: winning the underhook.');

    // Deleting is for good, but undoable.
    expect(await call('save_area', { name: 'Deep half sweeps', delete: true })).toBe('Deleted Deep half sweeps.');
    expect(await call('get_area', { name: 'winning the underhook' })).not.toContain('Continues in');
    expect(await call('undo_last')).toBe('Undid: delete "Deep half sweeps"');
    expect(await call('get_area', { name: 'winning the underhook' })).toContain('Continues in: Deep half sweeps.');
    await call('save_area', { name: 'Deep half sweeps', delete: true });
    await call('save_area', { name: 'winning the underhook', delete: true });
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
