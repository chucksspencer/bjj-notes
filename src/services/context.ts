import { forUser, type Db } from '../db.js';
import { todayIn } from './vocab.js';

export interface Ctx {
  /** For services: a handle for one user's notebook (forUser). The app's base context holds the plain pool. */
  db: Db;
  /** IANA time zone used for "today" (e.g. America/Chicago). */
  timeZone: string;
}

/** The context for one signed-in user's requests. */
export function userCtx(base: Ctx, userId: number): Ctx {
  return { ...base, db: forUser(base.db, userId) };
}

export function today(ctx: Ctx): string {
  return todayIn(ctx.timeZone);
}
