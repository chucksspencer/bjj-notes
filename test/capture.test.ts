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

describe('iPhone app capture', () => {
  const app = (server: TestServer, body: unknown, headers: Record<string, string> = { authorization: `Bearer ${API_TOKEN}` }) =>
    fetch(`${server.base}/api/v1/capture`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });

  it('signs in like the web app: session cookie with the app header, or the API token', async () => {
    s = await startServer();
    expect((await app(s, { text: 'hi' }, {})).status).toBe(401);
    const login = await fetch(`${s.base}/api/v1/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-bjj-app': '1' },
      body: JSON.stringify({ password: 'correct horse battery staple' }),
    });
    const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
    expect((await app(s, { text: 'Leg elevation: hook first.' }, { cookie })).status).toBe(403); // no app header
    const ok = await app(s, { text: 'Leg elevation: hook first.' }, { cookie, 'x-bjj-app': '1' });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ speech: 'Saved to Leg elevation.', duplicate: false });
  });

  it('saves a retried note once, keeps the day it was captured, and takes kind and star hints', async () => {
    s = await startServer();
    const note = { text: 'Leg elevation: lift with the hook, not the arms.', clientId: 'a1b2c3d4-0001', date: '2026-10-10', starred: true };
    const first = (await (await app(s, note)).json()) as any;
    expect(first).toMatchObject({ duplicate: false, speech: 'Saved to Leg elevation, starred.' });
    const again = (await (await app(s, note)).json()) as any;
    expect(again).toMatchObject({ duplicate: true, note_id: first.note_id, speech: 'Already saved.', linked: ['Leg elevation'] });
    const rows = (await s.db.query<{ observed_on: string; starred: boolean }>(
      "select observed_on::text, starred_at is not null as starred from notes where client_id = 'a1b2c3d4-0001'",
    )).rows;
    expect(rows).toEqual([{ observed_on: '2026-10-10', starred: true }]);

    const question = (await (await app(s, { text: 'When do I switch to the knee lever?', kind: 'question', clientId: 'a1b2c3d4-0002' })).json()) as any;
    expect(question.speech).toBe('Added to Ask coach.');
    expect((await s.db.query<{ kind: string }>("select kind from notes where client_id = 'a1b2c3d4-0002'")).rows[0]!.kind).toBe('question');
    // A made-up id that doesn't look like one is ignored rather than trusted.
    expect(((await (await app(s, { text: 'Grips first.', clientId: 'x' })).json()) as any).duplicate).toBe(false);
  });
});

describe('photos and videos from the share sheet', () => {
  // A 1×1 JPEG, standing in for a still image.
  const STILL = '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==';
  const app = (server: TestServer, body: unknown) =>
    fetch(`${server.base}/api/v1/capture`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${API_TOKEN}` },
      body: JSON.stringify(body),
    });
  const get = (server: TestServer, path: string) => fetch(`${server.base}${path}`, { headers: { authorization: `Bearer ${API_TOKEN}` } });

  it('saves a clip with no takeaway to the inbox, with its still and where the original is', async () => {
    s = await startServer();
    const res = (await (
      await app(s, {
        clientId: 'clip-0001-abcd',
        attachments: [{ kind: 'video', thumb: STILL, filename: 'IMG_1234.MOV', takenAt: '2026-10-19T01:30:00Z', durationS: 42.5, width: 1920, height: 1080 }],
      })
    ).json()) as any;
    expect(res).toMatchObject({ inbox: true, speech: 'Saved to your inbox.', attachments: [{ linked: false }] });
    const attachmentId = res.attachments[0].id;

    const note = ((await (await get(s, '/api/v1/notes?inbox=1')).json()) as any[]).find(n => n.id === res.note_id);
    expect(note.body).toBe('Video from Photos.');
    expect(note.attachments).toEqual([
      expect.objectContaining({ id: attachmentId, kind: 'video', photosLocalId: null, durationS: 42.5, width: 1920 }),
    ]);
    expect(Date.parse(note.attachments[0].takenAt)).toBe(Date.parse('2026-10-19T01:30:00Z'));

    // The still comes back as the same JPEG.
    const thumb = await get(s, `/api/v1/attachments/${attachmentId}/thumb`);
    expect(thumb.headers.get('content-type')).toBe('image/jpeg');
    expect(Buffer.from(await thumb.arrayBuffer()).toString('base64')).toBe(STILL);
    expect((await fetch(`${s.base}/api/v1/attachments/${attachmentId}/thumb`)).status).toBe(401);

    // The phone finds the original in Photos later and records it.
    const linked = (await (
      await fetch(`${s.base}/api/v1/attachments/${attachmentId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${API_TOKEN}` },
        body: JSON.stringify({ photosLocalId: 'ABC-123/L0/001', photosCloudId: 'ABC-123:001:xyz' }),
      })
    ).json()) as any;
    expect(linked).toMatchObject({ id: attachmentId, photosLocalId: 'ABC-123/L0/001', photosCloudId: 'ABC-123:001:xyz' });
  });

  it('files a clip with a takeaway, and keeps its clips through delete and undo', async () => {
    s = await startServer();
    const res = (await (
      await app(s, {
        text: 'Leg elevation: lift with the hook.',
        attachments: [
          { kind: 'video', thumb: STILL, photosLocalId: 'V1/L0/001' },
          { kind: 'photo', thumb: STILL, photosLocalId: 'P1/L0/001' },
        ],
      })
    ).json()) as any;
    expect(res).toMatchObject({ linked: ['Leg elevation'], attachments: [{ linked: true }, { linked: true }] });
    const card = async () => {
      const t = ((await (await get(s!, '/api/v1/techniques?q=leg+elevation')).json()) as any[])[0];
      return (await (await get(s!, `/api/v1/techniques/${t.id}`)).json()) as any;
    };
    expect((await card()).notes[0].attachments.map((a: any) => a.kind)).toEqual(['video', 'photo']);

    const del = await fetch(`${s.base}/api/v1/notes/${res.note_id}`, { method: 'DELETE', headers: { authorization: `Bearer ${API_TOKEN}` } });
    expect(del.status).toBe(200);
    await fetch(`${s.base}/api/v1/undo`, { method: 'POST', headers: { authorization: `Bearer ${API_TOKEN}` } });
    expect((await card()).notes[0].attachments.map((a: any) => a.photosLocalId)).toEqual(['V1/L0/001', 'P1/L0/001']);
  });

  it('refuses an oversized still and skips malformed entries', async () => {
    s = await startServer();
    const huge = 'A'.repeat(700_000);
    const tooBig = await app(s, { attachments: [{ kind: 'photo', thumb: huge }] });
    expect(tooBig.status).toBe(400);
    const junk = await app(s, { attachments: [{ kind: 'gif', thumb: STILL }, null, 'x'] });
    expect(junk.status).toBe(400); // nothing usable: no text, no link, no clip
    // Stills are served as image/jpeg, so anything else (an HTML page, say) is refused.
    const html = Buffer.from('<html><script>alert(1)</script></html>').toString('base64');
    const notJpeg = await app(s, { text: 'Grips.', attachments: [{ kind: 'photo', thumb: html }] });
    expect(notJpeg.status).toBe(400); // refused for good, so the phone doesn't keep retrying
    expect(((await notJpeg.json()) as any).speech).toBe("That photo's preview couldn't be read.");
    const headers = (await get(s, '/api/v1/notes')).headers;
    expect(headers.get('x-content-type-options')).toBe('nosniff');
    expect(headers.get('x-frame-options')).toBe('DENY');
  });
});
