// Housekeeping: exactly the old rows go, in both directions across each cutoff; and the readiness check.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { housekeep } from '../src/services/housekeeping.js';
import { startServer, type TestServer } from './helpers.js';

let s: TestServer;
beforeAll(async () => {
  s = await startServer();
});
afterAll(async () => {
  await s.close();
});

const q = async <T = Record<string, any>>(sql: string, params: unknown[] = []) => (await s.db.query<T>(sql, params)).rows;
const ids = async (sql: string) => (await q<{ k: string | number }>(sql)).map(r => r.k).sort();
const ago = (days: number) => `now() - interval '${days} days'`;

describe('/readyz', () => {
  it('reaches the database and names the newest migration; /healthz still answers', async () => {
    const ready = await fetch(`${s.base}/readyz`);
    expect(ready.status).toBe(200);
    const body = (await ready.json()) as { ok: boolean; migration: string };
    const newest = (await q<{ name: string }>('select name from schema_migrations order by name desc limit 1'))[0]!.name;
    expect(body).toEqual({ ok: true, migration: newest });
    expect(body.migration).toMatch(/^\d{3}_/);
    expect(await (await fetch(`${s.base}/healthz`)).json()).toEqual({ ok: true });
  });
});

describe('housekeep', () => {
  it('prunes activity_log by age but keeps each person\'s newest 200', async () => {
    const owner = (await q<{ id: number }>('select id from users where is_owner'))[0]!.id;
    const other = (await q<{ id: number }>("insert into users (name, email) values ('B', 'b@example.com') returning id"))[0]!.id;
    const undo = JSON.stringify({ kind: 'noop' });
    // Owner: 3 old entries (the 3 oldest) and 2 recent. Few enough that the newest-200 rule alone keeps all 5 ...
    await q(`insert into activity_log (action, summary, undo, user_id, at) select 'x', 'old ' || g, $1, $2, ${ago(100)} + g * interval '1 minute' from generate_series(1, 3) g`, [undo, owner]);
    await q(`insert into activity_log (action, summary, undo, user_id, at) select 'x', 'new ' || g, $1, $2, ${ago(10)} from generate_series(1, 2) g`, [undo, owner]);
    expect((await housekeep(s.db)).activity_log).toBe(0);
    // ... so push 200 newer ones on top: now the 3 old ones fall outside the newest 200 and go.
    await q(`insert into activity_log (action, summary, undo, user_id, at) select 'x', 'fill ' || g, $1, $2, ${ago(1)} from generate_series(1, 200) g`, [undo, owner]);
    // The other person has one very old entry: it is within their newest 200, so it stays.
    await q(`insert into activity_log (action, summary, undo, user_id, at) values ('x', 'theirs', $1, $2, ${ago(400)})`, [undo, other]);
    const done = await housekeep(s.db);
    expect(done.activity_log).toBe(3);
    expect(await ids("select summary as k from activity_log where summary like 'old %'")).toEqual([]);
    expect(await ids("select summary as k from activity_log where summary in ('theirs', 'new 1', 'new 2')")).toEqual(['new 1', 'new 2', 'theirs']);
    await q('delete from activity_log');
  });

  it('prunes old orphan attachments unless a live undo entry still needs them', async () => {
    const owner = (await q<{ id: number }>('select id from users where is_owner'))[0]!.id;
    const att = async (label: string, days: number, note = false) => {
      const noteId = note
        ? (await q<{ id: number }>("insert into notes (body, user_id) values ('n', $1) returning id", [owner]))[0]!.id
        : null;
      return (
        await q<{ id: number }>(
          `insert into attachments (note_id, kind, filename, thumb, user_id, created_at) values ($1, 'photo', $2, '\\x00', $3, ${ago(days)}) returning id`,
          [noteId, label, owner],
        )
      )[0]!.id;
    };
    const restore = (attachmentIds: number[]) => ({ kind: 'restore_note', row: {}, techniqueIds: [], attachmentIds });
    const log = (undo: unknown, undone = false) =>
      q('insert into activity_log (action, summary, undo, undone, user_id) values (\'x\', \'y\', $1, $2, $3)', [JSON.stringify(undo), undone, owner]);

    const fresh = await att('fresh-orphan', 5); // too new
    const attached = await att('attached', 90, true); // has a note
    const plain = await att('old-plain', 60); // nothing refers to it
    const live = await att('old-live', 60); // live undo entry
    const nested = await att('old-nested', 60); // inside a batch
    const undone = await att('old-undone', 60); // only an undone entry
    const pruned = await att('old-pruned', 60); // only an entry that housekeeping removes
    await log(restore([live]));
    await log({ kind: 'batch', ops: [{ kind: 'noop' }, restore([nested])] });
    await log(restore([undone]), true);
    await q(`insert into activity_log (action, summary, undo, user_id, at) values ('x', 'ancient', $1, $2, ${ago(200)})`, [JSON.stringify(restore([pruned])), owner]);
    // Push the ancient entry out of the owner's newest 200.
    await q(`insert into activity_log (action, summary, undo, user_id) select 'x', 'f', '{"kind":"noop"}', $1 from generate_series(1, 200)`, [owner]);

    const done = await housekeep(s.db);
    expect(done.attachments).toBe(3);
    expect(await ids("select id as k from attachments where filename like 'fresh-%' or filename like 'attached' or filename like 'old-%'")).toEqual(
      [fresh, attached, live, nested].sort(),
    );
    expect(plain).toBeGreaterThan(0);
    await q('delete from activity_log');
    await q('delete from attachments');
    await q("delete from notes where body = 'n'");
  });

  it('prunes OAuth codes, tokens, clients, web sessions and invites at their cutoffs', async () => {
    const owner = (await q<{ id: number }>('select id from users where is_owner'))[0]!.id;
    const client = (id: string, days: number) => q(`insert into oauth_clients (client_id, info, created_at) values ($1, '{}', ${ago(days)})`, [id]);
    for (const [id, days] of [['c-old-empty', 10], ['c-new-empty', 2], ['c-old-token', 10], ['c-old-code', 10]] as const) await client(id, days);
    const code = (h: string, c: string, days: number) =>
      q(
        `insert into oauth_codes (code_hash, client_id, redirect_uri, code_challenge, user_id, expires_at) values ($1, $2, 'https://x', 'c', $3, now() - interval '${days} days')`,
        [h, c, owner],
      );
    await code('code-old', 'c-old-code', 2); // expired over a day ago
    await code('code-recent', 'c-old-code', 0); // expired moments ago
    // The old code's client is kept only while the recent code references it.
    const token = (h: string, c: string, days: number, revoked = false) =>
      q(
        `insert into oauth_tokens (token_hash, kind, client_id, user_id, expires_at, revoked) values ($1, 'refresh', $2, $3, now() - interval '${days} days', $4)`,
        [h, c, owner, revoked],
      );
    await token('tok-old', 'c-old-token', 8, true);
    await token('tok-old-live', 'c-old-token', 8);
    await token('tok-recent', 'c-old-token', 3, true);
    await token('tok-future', 'c-old-token', -80);
    const session = (h: string, days: number) =>
      q(`insert into web_sessions (token_hash, user_id, expires_at) values ($1, $2, now() - interval '${days} days')`, [h, owner]);
    await session('ws-expired', 1);
    await session('ws-valid', -5);
    const invite = (h: string, expires: number, used: number | null) =>
      q(
        `insert into invites (token_hash, purpose, created_by, expires_at, used_at) values ($1, 'join', $2, now() - interval '${expires} days', ${used === null ? 'null' : `now() - interval '${used} days'`})`,
        [h, owner],
      );
    await invite('inv-expired-old', 40, null);
    await invite('inv-used-old', -5, 40);
    await invite('inv-expired-recent', 5, null);
    await invite('inv-used-recent', -5, 5);
    await invite('inv-open', -5, null);

    const done = await housekeep(s.db);
    expect(done).toMatchObject({ oauth_codes: 1, oauth_tokens: 2, oauth_clients: 1, web_sessions: 1, invites: 2 });
    expect(await ids('select code_hash as k from oauth_codes')).toEqual(['code-recent']);
    expect(await ids('select token_hash as k from oauth_tokens')).toEqual(['tok-future', 'tok-recent']);
    expect(await ids("select client_id as k from oauth_clients where client_id like 'c-%'")).toEqual(['c-new-empty', 'c-old-code', 'c-old-token']);
    expect(await ids("select token_hash as k from web_sessions where token_hash like 'ws-%'")).toEqual(['ws-valid']);
    expect(await ids("select token_hash as k from invites where token_hash like 'inv-%'")).toEqual(['inv-expired-recent', 'inv-open', 'inv-used-recent']);
    expect(await housekeep(s.db)).toMatchObject({ oauth_codes: 0, oauth_tokens: 0, web_sessions: 0, invites: 0 });
  });
});
