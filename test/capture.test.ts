import { afterEach, describe, expect, it } from 'vitest';
import type { Structurer } from '../src/capture.js';
import { API_TOKEN, startServer, type TestServer } from './helpers.js';

let s: TestServer | undefined;
afterEach(async () => {
  await s?.close();
  s = undefined;
});

const post = (server: TestServer, body: unknown, token = API_TOKEN) =>
  fetch(`${server.base}/api/capture`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

describe('Siri capture API', () => {
  it('requires the API token', async () => {
    s = await startServer();
    expect((await post(s, { text: 'hi' }, 'wrong')).status).toBe(401);
    expect((await fetch(`${s.base}/api/focus`)).status).toBe(401);
  });

  it('also takes the token as a JSON field, for Shortcuts without headers', async () => {
    s = await startServer();
    const send = (body: unknown) =>
      fetch(`${s!.base}/api/capture`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    expect((await send({ text: 'Leg elevation: hook first.', token: API_TOKEN })).status).toBe(200);
    const wrong = await send({ text: 'hi', token: 'wrong' });
    expect(wrong.status).toBe(401);
    expect(((await wrong.json()) as any).speech).toBe("BJJ Notes didn't accept that token. Check the token in the shortcut.");
    const nothing = await send({ text: '', url: '', token: API_TOKEN });
    expect(nothing.status).toBe(400);
    expect(((await nothing.json()) as any).speech).toBe('Nothing to save. Say a takeaway or share a link.');
    const garbled = await fetch(`${s.base}/api/capture`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{not json' });
    expect(garbled.status).toBe(400);
    expect(((await garbled.json()) as any).speech).toContain("couldn't read what the shortcut sent");
    expect((await send({ text: 'hi' })).status).toBe(401);
    const saved = (await s.db.query<{ body: string; raw_text: string }>('select body, raw_text from notes')).rows;
    expect(JSON.stringify(saved)).not.toContain(API_TOKEN);
  });

  it('without a parser, links techniques named in the text and inboxes the rest', async () => {
    s = await startServer();
    const res = await post(s, { text: 'Leg elevation from deep half: hook first, then lift.' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ inbox: false, parsed: false, speech: 'Saved to Leg elevation.' });
    const vague = (await (await post(s, { text: 'tired today, worked on grips' })).json()) as any;
    expect(vague).toMatchObject({ inbox: true, parsed: false, speech: 'Saved to your inbox.' });
  });

  it('puts shared reels on the To try list, and knows the same reel when it comes back', async () => {
    s = await startServer();
    // Shared from Instagram with no takeaway.
    const bare = (await (await post(s, { url: 'https://www.instagram.com/reel/DAbc123xyz/?igsh=MTc4MmM1' })).json()) as any;
    expect(bare).toMatchObject({ inbox: false, to_try: true, speech: 'Added to your to-try list.' });
    // The same reel again, handed over as caption text with the link inside, plus a takeaway naming a technique.
    const withTakeaway = (await (
      await post(s, { text: 'Leg elevation: hook first, then lift.', url: 'So clean 🔥 https://instagram.com/reels/DAbc123xyz' })
    ).json()) as any;
    expect(withTakeaway).toMatchObject({ inbox: false, to_try: true, speech: 'Added to your to-try list, about Leg elevation.' });
    // A link dictated into the note itself becomes the note's source, and it's something to try too.
    await post(s, { text: 'Leg elevation, watch this https://youtu.be/abc123?si=XyZ' });
    // No link: a plain dictated note, filed as usual.
    expect(((await (await post(s, { text: 'Leg elevation: hips first.' })).json()) as any).to_try).toBe(false);

    const rows = (
      await s.db.query<{ body: string; url: string; kind: string; source_id: number; to_try: boolean; inbox: boolean }>(
        'select n.body, s.url, s.kind, n.source_id, n.to_try, n.inbox from notes n join sources s on s.id = n.source_id order by n.id',
      )
    ).rows;
    expect(rows.map(({ source_id: _, ...r }) => r)).toEqual([
      { body: 'Instagram reel to try.', url: 'https://www.instagram.com/reel/DAbc123xyz/', kind: 'instagram', to_try: true, inbox: false },
      { body: 'Leg elevation: hook first, then lift.', url: 'https://www.instagram.com/reel/DAbc123xyz/', kind: 'instagram', to_try: true, inbox: false },
      { body: 'Leg elevation, watch this', url: 'https://youtu.be/abc123', kind: 'youtube', to_try: true, inbox: false },
    ]);
    expect(rows[0]!.source_id).toBe(rows[1]!.source_id);
  });

  it('files a parsed note and reads back the focus list', async () => {
    let seen: { text: string; known: { techniques: string[] } } | undefined;
    const structurer: Structurer = async (text, known) => {
      seen = { text, known };
      return {
        note: 'Elevate the far leg with the bottom hook, then come up on the far side.',
        techniques: ['Leg elevation'],
        new_techniques: [{ name: 'Waiter sweep', type: 'sweep', role: 'bottom' }],
        kind: 'instruction',
        source: { kind: 'class' },
      };
    };
    s = await startServer(structurer);
    const res = await post(s, { text: 'um so in class we did leg elevation from deep half and a waiter sweep' });
    const body = (await res.json()) as any;
    expect(body.parsed).toBe(true);
    expect(body.inbox).toBe(false);
    expect(body.speech).toBe('Saved to Waiter sweep and Leg elevation. New card: Waiter sweep.');
    expect(seen?.known.techniques).toContain('Baratoplata');

    const row = (
      await s.db.query<{ body: string; raw_text: string; created_via: string }>('select body, raw_text, created_via from notes')
    ).rows[0]!;
    expect(row.body).toContain('Elevate the far leg');
    expect(row.raw_text).toContain('um so in class');
    expect(row.created_via).toBe('capture');

    const focus = (await (await fetch(`${s.base}/api/focus`, { headers: { authorization: `Bearer ${API_TOKEN}` } })).json()) as any;
    expect(focus.speech).toBe(
      'Your focus: 1. Baratoplata. 2. Shoulder crunches from butterfly guard and bottom half guard. 3. Body lock passing. 4. Shoulder lock and paper cutter choke combination from bottom side control. 5. Ghost escape.',
    );
  });

  it('falls back to keyword linking if the parser fails', async () => {
    s = await startServer(async () => {
      throw new Error('API down');
    });
    const body = (await (await post(s, { text: 'baratoplata grip detail' })).json()) as any;
    expect(body).toMatchObject({ parsed: false, inbox: false, speech: 'Saved to Baratoplata.' });
  });

  it('keeps a shared link as the note source', async () => {
    s = await startServer();
    const body = (await (await post(s, { text: 'great body lock pass detail', url: 'https://www.instagram.com/reel/xyz/' })).json()) as any;
    const row = (await s.db.query<{ kind: string; url: string }>('select kind, url from sources')).rows[0]!;
    expect(row).toEqual({ kind: 'instagram', url: 'https://www.instagram.com/reel/xyz/' });
    expect(body.note_id).toBeGreaterThan(0);
  });
});
