import type { Db } from '../db.js';
import type { UndoOp } from './activity.js';

/** Activity log entries older than this many days are pruned... */
const ACTIVITY_DAYS = 90;
/** ...except each person's newest this many, whatever their age. */
const ACTIVITY_KEEP = 200;
/** Attachments left without a note (kept so undo can re-attach them) are pruned after this many days, if no live undo entry needs them. */
const ORPHAN_ATTACHMENT_DAYS = 30;
/** Authorization codes are pruned this many days after they expire. */
const CODE_DAYS = 1;
/** Access and refresh tokens are pruned this many days after they expire. */
const TOKEN_DAYS = 7;
/** Registered OAuth clients (registration is open to anyone) with no codes or tokens are pruned after this many days. */
const CLIENT_DAYS = 7;
/** Invites are pruned this many days after they were used or expired. */
const INVITE_DAYS = 30;
/** Wrong-password records (the sign-in limit only looks back 15 minutes) are pruned after this many days. */
const SIGN_IN_FAILURE_DAYS = 1;
/** How often the server runs housekeeping while it stays up (it also runs once at startup). */
export const HOUSEKEEPING_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** Runs a delete statement and returns how many rows it removed. */
async function count(db: Db, sql: string, params: unknown[] = []): Promise<number> {
  const { rows } = await db.query<{ n: number }>(`with gone as (${sql} returning 1) select count(*)::int as n from gone`, params);
  return rows[0]!.n;
}

/** Every attachment id a (possibly nested) undo operation would link back to a note. */
function attachmentIdsIn(op: UndoOp | null | undefined, into: Set<number>): void {
  if (!op || typeof op !== 'object') return;
  if (op.kind === 'restore_note') for (const id of op.attachmentIds ?? []) into.add(id);
  else if (op.kind === 'batch') for (const inner of op.ops ?? []) attachmentIdsIn(inner, into);
}

/**
 * Deletes what is no longer needed, across all people (so it takes the plain pool), and says how many
 * rows of each kind went. Safe to run at any time and as often as you like.
 */
export async function housekeep(db: Db): Promise<Record<string, number>> {
  const done: Record<string, number> = {};

  done.activity_log = await count(
    db,
    `delete from activity_log where at < now() - make_interval(days => $1)
       and id not in (select id from (select id, row_number() over (partition by user_id order by id desc) as n from activity_log) k where n <= $2)`,
    [ACTIVITY_DAYS, ACTIVITY_KEEP],
  );

  // Orphaned attachments that a live (not undone) undo entry still points at stay, whatever their age.
  const wanted = new Set<number>();
  const live = await db.query<{ undo: UndoOp | string }>("select undo from activity_log where not undone and undo::text like '%attachmentIds%'");
  for (const row of live.rows) attachmentIdsIn(typeof row.undo === 'string' ? (JSON.parse(row.undo) as UndoOp) : row.undo, wanted);
  done.attachments = await count(
    db,
    'delete from attachments where note_id is null and created_at < now() - make_interval(days => $1) and not (id = any($2::int[]))',
    [ORPHAN_ATTACHMENT_DAYS, [...wanted]],
  );

  done.oauth_codes = await count(db, 'delete from oauth_codes where expires_at < now() - make_interval(days => $1)', [CODE_DAYS]);
  done.oauth_tokens = await count(db, 'delete from oauth_tokens where expires_at < now() - make_interval(days => $1)', [TOKEN_DAYS]);
  done.oauth_clients = await count(
    db,
    `delete from oauth_clients where created_at < now() - make_interval(days => $1)
       and not exists (select 1 from oauth_tokens t where t.client_id = oauth_clients.client_id)
       and not exists (select 1 from oauth_codes c where c.client_id = oauth_clients.client_id)`,
    [CLIENT_DAYS],
  );
  done.web_sessions = await count(db, 'delete from web_sessions where expires_at < now()');
  done.invites = await count(
    db,
    'delete from invites where coalesce(used_at, expires_at) < now() - make_interval(days => $1)',
    [INVITE_DAYS],
  );
  done.sign_in_failures = await count(db, 'delete from sign_in_failures where at < now() - make_interval(days => $1)', [SIGN_IN_FAILURE_DAYS]);
  return done;
}
