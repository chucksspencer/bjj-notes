import { forUser, type Db } from '../db.js';
import type { GamePlanDrafter } from './gamePlanDrafts.js';
import type { Rewriter } from './semantic.js';
import { todayIn } from './vocab.js';

export interface Ctx {
  /** For services: a handle for one user's notebook (forUser). The app's base context holds the plain pool. */
  db: Db;
  /** IANA time zone used for "today" (e.g. America/Chicago). */
  timeZone: string;
  /** For search by meaning (Claude rewrites the search); without one, search is by words only. */
  rewriter?: Rewriter | null;
  /** For outlining a game plan described in plain words; without one, steps are written one at a time. */
  gamePlanDrafter?: GamePlanDrafter | null;
}

/** The context for one signed-in user's requests. `activityIds` collects the undo entries the request writes. */
export function userCtx(base: Ctx, userId: number, activityIds?: number[]): Ctx {
  return { ...base, db: forUser(base.db, userId, activityIds) };
}

export function today(ctx: Ctx): string {
  return todayIn(ctx.timeZone);
}
