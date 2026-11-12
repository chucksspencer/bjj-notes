import { forUser, type Db } from '../db.js';
import type { PlanDrafter } from './plans.js';
import type { Rewriter } from './semantic.js';
import { todayIn } from './vocab.js';

export interface Ctx {
  /** For services: a handle for one user's notebook (forUser). The app's base context holds the plain pool. */
  db: Db;
  /** IANA time zone used for "today" (e.g. America/Chicago). */
  timeZone: string;
  /** For search by meaning (Claude rewrites the search); without one, search is by words only. */
  rewriter?: Rewriter | null;
  /** For outlining a plan described in plain words; without one, plans are written step by step. */
  planDrafter?: PlanDrafter | null;
}

/** The context for one signed-in user's requests. */
export function userCtx(base: Ctx, userId: number): Ctx {
  return { ...base, db: forUser(base.db, userId) };
}

export function today(ctx: Ctx): string {
  return todayIn(ctx.timeZone);
}
