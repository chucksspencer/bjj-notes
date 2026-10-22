// Clearing marks several at a time: stars that have done their job, questions that are settled.
import { uid } from '../db.js';
import { logActivity, type MarkSnapshot } from './activity.js';
import type { Ctx } from './context.js';

const plural = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`;

/**
 * Unstars techniques and notes: all of them, or only those starred more than `olderThanDays` days ago.
 * One change, so one undo puts every star back as it was.
 */
export async function clearStars(ctx: Ctx, olderThanDays?: number): Promise<string> {
  return ctx.db.tx(async q => {
    const cut = `user_id = $2 and starred_at is not null and ($1::int is null or starred_at < now() - make_interval(days => $1))`;
    const days = olderThanDays ?? null;
    const notes = (
      await q.query<MarkSnapshot>(`select id, starred_at::text as at from notes where ${cut}`, [days, uid(q)])
    ).rows;
    const techniques = (
      await q.query<MarkSnapshot>(`select id, starred_at::text as at from techniques where ${cut}`, [days, uid(q)])
    ).rows;
    const n = notes.length + techniques.length;
    if (!n) return olderThanDays ? `No stars older than ${plural(olderThanDays, 'day')}.` : 'Nothing is starred.';
    await q.query('update notes set starred_at = null where id = any($1::int[]) and user_id = $2', [notes.map(r => r.id), uid(q)]);
    await q.query('update techniques set starred_at = null where id = any($1::int[]) and user_id = $2', [techniques.map(r => r.id), uid(q)]);
    const what = plural(n, 'star');
    await logActivity(q, 'clear_stars', `clearing ${what}`, { kind: 'restore_marks', mark: 'starred', notes, techniques });
    return `Cleared ${what}.`;
  });
}

/** Marks several questions answered at once (they leave Ask coach); one undo opens them all again. */
export async function markAnswered(ctx: Ctx, ids: number[]): Promise<string> {
  return ctx.db.tx(async q => {
    const notes = (
      await q.query<MarkSnapshot>(
        `select id, answered_at::text as at from notes
         where id = any($1::int[]) and user_id = $2 and kind = 'question' and answered_at is null`,
        [[...new Set(ids)], uid(q)],
      )
    ).rows;
    if (!notes.length) return 'No open questions to mark.';
    await q.query('update notes set answered_at = now() where id = any($1::int[]) and user_id = $2', [notes.map(r => r.id), uid(q)]);
    const what = plural(notes.length, 'question');
    await logActivity(q, 'mark_answered', `marking ${what} answered`, { kind: 'restore_marks', mark: 'answered', notes, techniques: [] });
    return `Marked ${what} answered.`;
  });
}
