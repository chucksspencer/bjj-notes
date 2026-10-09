import type { Db } from '../db.js';
import { todayIn } from './vocab.js';

export interface Ctx {
  db: Db;
  /** IANA time zone used for "today" (e.g. America/Chicago). */
  timeZone: string;
}

export function today(ctx: Ctx): string {
  return todayIn(ctx.timeZone);
}
