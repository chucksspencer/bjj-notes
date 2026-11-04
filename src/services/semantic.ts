// Search by meaning: notes and technique cards found by what they're about, not only by the words in them.
// Embeddings are made lazily: when someone searches (and, opportunistically, after they change something),
// any of their notes or cards that are new or changed since they were last embedded get embedded first.
// Without an embeddings service, or if it fails, search is keyword search exactly as before.
import { uid } from '../db.js';
import type { NoteView, TechniqueListItem } from '../shared/api.js';
import { isPlaceholder } from '../shared/links.js';
import type { Ctx } from './context.js';
import { embeddingHealth, embedQuery, toVector } from './embeddings.js';
import { noteList, techniqueList, type NoteQuery, type TechniqueQuery } from './views.js';

/** Below this cosine similarity, a match by meaning isn't shown. */
export const MIN_SCORE = 0.4;
/** How long a search may spend catching up on embeddings before it searches with what's there. */
const SEARCH_BUDGET_MS = 3000;

// The text embedded for each note: what it says, what it's about, and where it came from.
const NOTE_TEXT = `concat_ws(E'\\n', n.body,
  'Techniques: ' || (select string_agg(t.name, ', ' order by t.name)
                     from note_techniques nt join techniques t on t.id = nt.technique_id where nt.note_id = n.id),
  'Source: ' || nullif(concat_ws(' by ', so.title, so.author), ''),
  'From: ' || nullif(concat_ws(', ', ss.name, ss.instructor), ''))`;

// …and for each technique card: everything on the card.
const TECHNIQUE_TEXT = `concat_ws(E'\\n', t.name,
  'Also called: ' || nullif(array_to_string(t.aliases, ', '), ''),
  'Type: ' || t.type || coalesce(', ' || t.role, ''),
  t.summary,
  'Key details: ' || nullif(array_to_string(t.key_details, '; '), ''),
  'Common mistakes: ' || nullif(array_to_string(t.mistakes, '; '), ''),
  'Positions: ' || (select string_agg(distinct p.name, ', ' order by p.name)
                    from technique_edges e join positions p on p.id in (e.from_position_id, e.to_position_id)
                    where e.technique_id = t.id))`;

interface Kind {
  table: string;
  key: string;
  /** Rows of this person's that are missing or out of date: id, the text to embed, its hash. */
  staleSql: string;
}

const NOTES: Kind = {
  table: 'note_embeddings',
  key: 'note_id',
  staleSql: `select n.id, n.body as head, ${NOTE_TEXT} as text, md5(${NOTE_TEXT}) as hash
             from notes n
             left join sources so on so.id = n.source_id
             left join sessions ss on ss.id = n.session_id
             left join note_embeddings e on e.note_id = n.id
             where n.user_id = $1 and (e.note_id is null or e.model <> $2 or e.content_hash <> md5(${NOTE_TEXT}))
             order by n.id desc limit $3`,
};

const TECHNIQUES: Kind = {
  table: 'technique_embeddings',
  key: 'technique_id',
  staleSql: `select t.id, null as head, ${TECHNIQUE_TEXT} as text, md5(${TECHNIQUE_TEXT}) as hash
             from techniques t
             left join technique_embeddings e on e.technique_id = t.id
             where t.user_id = $1 and (e.technique_id is null or e.model <> $2 or e.content_hash <> md5(${TECHNIQUE_TEXT}))
             order by t.id desc limit $3`,
};

/** What's worth embedding: a note that's only a placeholder ("Instagram reel to try.") counts only for the rest. */
function meaningful(head: string | null, text: string): string {
  if (head === null || !isPlaceholder(head)) return text.trim();
  return text.split('\n').slice(1).join('\n').trim();
}

async function refreshKind(ctx: Ctx, kind: Kind, deadline: number, batch: number): Promise<{ done: number; more: boolean }> {
  const embedder = ctx.embedder!;
  const me = uid(ctx.db);
  let done = 0;
  while (Date.now() < deadline) {
    const rows = (
      await ctx.db.query<{ id: number; head: string | null; text: string; hash: string }>(kind.staleSql, [me, embedder.model, batch])
    ).rows;
    if (!rows.length) return { done, more: false };
    const texts = rows.map(r => meaningful(r.head, r.text));
    const wanted = texts.map((t, i) => (t ? i : -1)).filter(i => i >= 0);
    const vectors = wanted.length ? await embedder.embed(wanted.map(i => texts[i]!), 'document') : [];
    const byRow = new Map(wanted.map((rowIndex, k) => [rowIndex, vectors[k]!]));
    for (const [i, r] of rows.entries()) {
      const v = byRow.get(i);
      await ctx.db.query(
        `insert into ${kind.table} (${kind.key}, user_id, model, content_hash, embedding, updated_at)
         values ($1, $2, $3, $4, $5::vector, now())
         on conflict (${kind.key}) do update set model = excluded.model, content_hash = excluded.content_hash,
           embedding = excluded.embedding, updated_at = now()`,
        [r.id, me, embedder.model, r.hash, v ? toVector(v) : null],
      );
    }
    done += rows.length;
    if (rows.length < batch) return { done, more: false };
  }
  return { done, more: true };
}

// One refresh at a time per person; a second caller waits for the one that's running.
const running = new Map<number, Promise<{ done: number; more: boolean }>>();

/**
 * Embeds this person's new and changed notes and cards, newest first, for up to budgetMs. Returns how many
 * it did and whether any are still waiting. Throws if the embeddings service fails.
 */
export async function refreshEmbeddings(ctx: Ctx, budgetMs = SEARCH_BUDGET_MS, batch = 64): Promise<{ done: number; more: boolean }> {
  if (!ctx.embedder) return { done: 0, more: false };
  const me = uid(ctx.db);
  const current = running.get(me);
  if (current) return current;
  const work = (async () => {
    const deadline = Date.now() + budgetMs;
    const notes = await refreshKind(ctx, NOTES, deadline, batch);
    const techniques = await refreshKind(ctx, TECHNIQUES, deadline, batch);
    return { done: notes.done + techniques.done, more: notes.more || techniques.more };
  })();
  running.set(me, work);
  try {
    return await work;
  } finally {
    running.delete(me);
  }
}

// After someone changes something, catch up in the background (shortly after, so a burst of edits is one go).
const kicks = new Map<number, ReturnType<typeof setTimeout>>();
export function refreshSoon(ctx: Ctx, delayMs = 1500): void {
  if (!ctx.embedder) return;
  const me = uid(ctx.db);
  clearTimeout(kicks.get(me));
  kicks.set(
    me,
    setTimeout(() => {
      kicks.delete(me);
      refreshEmbeddings(ctx, 20_000).catch(err => console.error('embeddings: refresh failed', (err as Error).message));
    }, delayMs).unref(),
  );
}

export interface Hit {
  id: number;
  score: number;
}

async function nearest(ctx: Ctx, table: string, key: string, query: string, limit: number): Promise<Hit[]> {
  const embedder = ctx.embedder!;
  const v = await embedQuery(embedder, query);
  const { rows } = await ctx.db.query<{ id: number; score: number }>(
    `select ${key} as id, 1 - (embedding <=> $2::vector) as score from ${table}
     where user_id = $1 and model = $3 and embedding is not null and vector_dims(embedding) = $5
     order by embedding <=> $2::vector limit $4`,
    [uid(ctx.db), toVector(v), embedder.model, limit, v.length],
  );
  return rows.map(r => ({ id: r.id, score: Number(r.score) })).filter(h => h.score >= MIN_SCORE);
}

/** How a search uses meaning: on any query (Claude), or only phrases of three or more words (typing in the app). */
export type MeaningMode = 'always' | 'phrase';

const wantsMeaning = (q: string, mode: MeaningMode) =>
  mode === 'always' ? q.trim().length >= 3 : q.trim().split(/\s+/).filter(Boolean).length >= 3;

/** Matches by meaning, or none (and a logged reason) when there's no service or it failed. */
async function meaningHits(ctx: Ctx, which: 'notes' | 'techniques', q: string, limit: number): Promise<Hit[]> {
  try {
    await refreshEmbeddings(ctx);
    return which === 'notes'
      ? await nearest(ctx, 'note_embeddings', 'note_id', q, limit)
      : await nearest(ctx, 'technique_embeddings', 'technique_id', q, limit);
  } catch (err) {
    console.error(`search by meaning failed; keyword results only: ${(err as Error).message}`);
    return [];
  }
}

/**
 * Two rankings merged (reciprocal rank fusion): something near the top of either list ranks high, and
 * something in both ranks higher. Keyword matches win ties, so exact words still come first.
 */
function fuse<T extends { id: number }>(keyword: T[], meaning: T[], limit: number): T[] {
  const score = new Map<number, number>();
  const items = new Map<number, T>();
  for (const list of [keyword, meaning]) {
    list.forEach((item, rank) => {
      score.set(item.id, (score.get(item.id) ?? 0) + 1 / (60 + rank));
      if (!items.has(item.id)) items.set(item.id, item);
    });
  }
  return [...items.values()].sort((a, b) => score.get(b.id)! - score.get(a.id)!).slice(0, limit);
}

/** Notes matching a query by their words or by their meaning, best first. Other filters still apply. */
export async function searchNotes(ctx: Ctx, query: NoteQuery & { q: string }, mode: MeaningMode): Promise<NoteView[]> {
  const keyword = await noteList(ctx.db, query);
  if (!ctx.embedder || !wantsMeaning(query.q, mode) || query.beforeId !== undefined) return keyword;
  const hits = await meaningHits(ctx, 'notes', query.q, 20);
  if (!hits.length) return keyword;
  const { q: _q, ...filters } = query;
  const pool = new Map((await noteList(ctx.db, { ...filters, ids: hits.map(h => h.id), limit: hits.length })).map(n => [n.id, n]));
  const meaning = hits.map(h => pool.get(h.id)).filter((n): n is NoteView => !!n);
  return fuse(keyword, meaning, Math.min(Math.max(query.limit ?? 30, 1), 200));
}

/** Technique cards matching a query by name, words or meaning, best first. Other filters still apply. */
export async function searchTechniques(ctx: Ctx, query: TechniqueQuery & { q: string }, mode: MeaningMode): Promise<TechniqueListItem[]> {
  const keyword = await techniqueList(ctx.db, query);
  if (!ctx.embedder || !wantsMeaning(query.q, mode)) return keyword;
  const hits = await meaningHits(ctx, 'techniques', query.q, 20);
  if (!hits.length) return keyword;
  const { q: _q, ...filters } = query;
  const pool = new Map((await techniqueList(ctx.db, { ...filters, ids: hits.map(h => h.id), limit: hits.length })).map(t => [t.id, t]));
  const meaning = hits.map(h => pool.get(h.id)).filter((t): t is TechniqueListItem => !!t);
  return fuse(keyword, meaning, Math.min(query.limit ?? 200, 500));
}

export interface EmbeddingStatus {
  enabled: boolean;
  model: string | null;
  /** Of this person's notes and cards, how many are embedded with the current model. */
  indexed: number;
  total: number;
  lastError: string | null;
}

export async function embeddingStatus(ctx: Ctx): Promise<EmbeddingStatus> {
  const me = uid(ctx.db);
  const model = ctx.embedder?.model ?? null;
  const { rows } = await ctx.db.query<{ total: number; indexed: number }>(
    `select (select count(*) from notes where user_id = $1)::int + (select count(*) from techniques where user_id = $1)::int as total,
            (select count(*) from note_embeddings where user_id = $1 and model = $2)::int
              + (select count(*) from technique_embeddings where user_id = $1 and model = $2)::int as indexed`,
    [me, model ?? ''],
  );
  return { enabled: !!ctx.embedder, model, indexed: rows[0]!.indexed, total: rows[0]!.total, lastError: embeddingHealth.lastError };
}
