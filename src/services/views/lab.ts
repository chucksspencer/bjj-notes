// The Lab: what's starred, what's new, videos to try and open questions.
import type { LabView } from '../../shared/api.js';
import { uid } from '../../db.js';
import { today, type Ctx } from '../context.js';
import { minusDays } from '../vocab.js';
import { noteList } from './notes.js';
import { techniqueList } from './techniques.js';

/** How far back "new in your notes" looks, unless asked otherwise. */
export const LAB_DAYS = 30;
/** Stars are for what's pertinent now: after this many days they fold away as older stars. */
export const STAR_DAYS = 28;
/** Open questions noted longer ago than this fold away as older questions. */
export const QUESTION_DAYS = 60;

/**
 * What's in the Lab, for the web app and Claude alike: starred techniques and notes (recent ones, and
 * older ones folded away), the newest videos to try, techniques first noted in the last `days` days,
 * and open questions for the coach (recent ones, and older ones folded away).
 */
export async function labView(ctx: Ctx, days = LAB_DAYS, tryLimit = 10): Promise<LabView> {
  const q = ctx.db;
  const now = today(ctx);
  const [techniques, notes, toTry, toTryTotal, fresh, questions] = await Promise.all([
    techniqueList(q, { starred: true, limit: 200 }),
    noteList(q, { starred: true, limit: 200 }),
    noteList(q, { toTry: true, limit: tryLimit }),
    q.query<{ c: number }>('select count(*)::int as c from notes where user_id = $1 and to_try', [uid(q)]),
    techniqueList(q, { sort: 'new', newSince: minusDays(now, days), limit: 25 }),
    noteList(q, { kind: 'question', toTry: false, answered: false, limit: 200 }),
  ]);
  const starCutoff = Date.now() - STAR_DAYS * 86_400_000;
  const recent = (x: { starredAt: string | null }) => x.starredAt !== null && Date.parse(x.starredAt) >= starCutoff;
  const questionCutoff = minusDays(now, QUESTION_DAYS);
  return {
    today: now,
    days,
    starDays: STAR_DAYS,
    questionDays: QUESTION_DAYS,
    starred: { techniques: techniques.filter(recent), notes: notes.filter(recent) },
    olderStarred: { techniques: techniques.filter(t => !recent(t)), notes: notes.filter(n => !recent(n)) },
    toTry: { total: toTryTotal.rows[0]!.c, notes: toTry },
    fresh,
    questions: questions.filter(n => n.observedOn >= questionCutoff),
    olderQuestions: questions.filter(n => n.observedOn < questionCutoff),
  };
}
