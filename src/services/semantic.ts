// Search by meaning. Claude (Haiku) reads a search like "how do I stop the knee cut" and says which of the
// person's technique cards it's about and which words a note about it would use ("knee slice", "frame",
// "crossface"). The ordinary keyword search then runs on those as well, and the results are merged, so a note
// that says "frame on the hip before they settle the crossface" turns up even though it shares no words with
// the search. Without an Anthropic key, or if the call fails, search is keyword search exactly as before.
import Anthropic from '@anthropic-ai/sdk';
import type { Config } from '../config.js';
import { uid } from '../db.js';
import type { NoteView, TechniqueListItem } from '../shared/api.js';
import type { Ctx } from './context.js';
import { noteList, techniqueList, type NoteQuery, type TechniqueQuery } from './views.js';

/** What to look for, according to Claude. */
export interface Rewrite {
  /** Cards from the person's list that the search is about, as named there. */
  techniques: string[];
  /** Words and short phrases a note about it would likely use, most specific first. */
  terms: string[];
}

export interface Known {
  /** Technique names, each with its other names: "Knee cut pass (also: knee slice)". */
  techniques: string[];
  positions: string[];
}

export interface Rewriter {
  readonly model: string;
  rewrite(query: string, known: Known): Promise<Rewrite>;
}

/** The most recent failure, shown to the owner on the Account page (null once a call succeeds again). */
export const rewriteHealth: { lastError: string | null; at: string | null } = { lastError: null, at: null };

const record = (err: string | null) => {
  rewriteHealth.lastError = err;
  rewriteHealth.at = new Date().toISOString();
};

const SEARCH_TOOL = {
  name: 'search_for',
  description: 'What to look for in the notebook.',
  input_schema: {
    type: 'object' as const,
    properties: {
      techniques: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Cards from the known technique list that the search is about or that answer it, spelled exactly as listed ' +
          '(without the "also" part). For a problem ("they keep passing my guard"), the techniques that deal with it. ' +
          'Empty when none fit.',
      },
      terms: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Up to 8 words or short phrases (one to three words each) that a note answering the search would likely ' +
          'contain: the move\'s other common names (knee cut, knee slice), its positions, and the key ideas (frame, ' +
          'underhook, crossface, posture). Most specific first. No generic words (jiu-jitsu, technique, move, how).',
      },
    },
    required: ['techniques', 'terms'],
  },
};

/** Short, distinct, non-empty strings from whatever came back. */
function strings(v: unknown, max: number): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const x of v) {
    if (typeof x !== 'string') continue;
    const s = x.trim().slice(0, 80);
    if (s && !out.some(o => o.toLowerCase() === s.toLowerCase())) out.push(s);
    if (out.length >= max) break;
  }
  return out;
}

function describe(err: unknown): string {
  if (err instanceof Anthropic.APIConnectionTimeoutError) return "Couldn't reach Claude (timed out).";
  if (err instanceof Anthropic.APIConnectionError) return "Couldn't reach Claude.";
  if (err instanceof Anthropic.APIError) {
    if (err.status === 401 || err.status === 403) return 'Claude: the API key was refused.';
    const detail = (err.error as { error?: { message?: string } } | undefined)?.error?.message;
    return `Claude: ${detail || `HTTP ${err.status ?? 'error'}`}.`;
  }
  return (err as Error).message || String(err);
}

/** Asks Claude (via the Messages API) what a search is looking for. */
export function claudeRewriter(apiKey: string, model: string, opts: { baseURL?: string; timeoutMs?: number } = {}): Rewriter {
  const client = new Anthropic({ apiKey, baseURL: opts.baseURL, timeout: opts.timeoutMs ?? 10_000, maxRetries: 1 });
  return {
    model,
    async rewrite(query, known) {
      try {
        const msg = await client.messages.create({
          model,
          max_tokens: 400,
          system:
            'You help someone search their Brazilian jiu-jitsu notebook: short notes written after class or rolling, ' +
            'and technique cards. Searches are often questions or plain descriptions ("how do I stop the knee cut", ' +
            '"they keep flattening me in half guard"), and may be dictated, so names can be misheard ' +
            '("barra toe plata" is Baratoplata). Say what to look for.\n\n' +
            `Known techniques: ${known.techniques.join('; ') || '(none yet)'}\n` +
            `Known positions: ${known.positions.join('; ')}`,
          tools: [SEARCH_TOOL],
          tool_choice: { type: 'tool', name: SEARCH_TOOL.name },
          messages: [{ role: 'user', content: query }],
        });
        const block = msg.content.find(b => b.type === 'tool_use');
        if (!block || block.type !== 'tool_use') throw new Error('Claude sent no search terms.');
        const input = block.input as Record<string, unknown>;
        const out = { techniques: strings(input.techniques, 10), terms: strings(input.terms, 8) };
        record(null);
        return out;
      } catch (err) {
        const why = describe(err);
        record(why);
        throw new Error(why);
      }
    },
  };
}

/** The rewriter the config asks for: on whenever there's an Anthropic key, unless SEARCH_MODEL=off. */
export function rewriterFor(config: Config): Rewriter | null {
  if (!config.anthropicApiKey || !config.searchModel) return null;
  return claudeRewriter(config.anthropicApiKey, config.searchModel, { baseURL: config.anthropicBaseUrl });
}

async function knownFor(ctx: Ctx): Promise<Known> {
  const techniques = (
    await ctx.db.query<{ name: string; aliases: string[] }>('select name, aliases from techniques where user_id = $1 order by name', [
      uid(ctx.db),
    ])
  ).rows.map(r => (r.aliases.length ? `${r.name} (also: ${r.aliases.join(', ')})` : r.name));
  const positions = (await ctx.db.query<{ name: string }>('select name from positions order by name')).rows.map(r => r.name);
  return { techniques, positions };
}

// The same search again (the web app asks for cards and notes separately, Claude often repeats itself) doesn't
// ask Claude again for a while; a rewrite already on its way is shared rather than asked for twice.
const CACHE_MS = 10 * 60_000;
const cache = new Map<string, { at: number; value: Promise<Rewrite> }>();

function rewriteFor(ctx: Ctx, q: string): Promise<Rewrite> {
  const rewriter = ctx.rewriter!;
  const text = q.trim().replace(/\s+/g, ' ');
  const key = `${uid(ctx.db)}\n${rewriter.model}\n${text.toLowerCase()}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) {
    cache.delete(key);
    cache.set(key, hit); // most recently used last
    return hit.value;
  }
  const entry = { at: Date.now(), value: knownFor(ctx).then(known => rewriter.rewrite(text, known)) };
  cache.set(key, entry);
  entry.value.catch(() => {
    if (cache.get(key) === entry) cache.delete(key);
  });
  while (cache.size > 300) cache.delete(cache.keys().next().value!);
  return entry.value;
}

/** For tests: forget remembered rewrites. */
export function clearRewriteCache(): void {
  cache.clear();
}

/** What Claude said to look for, or null (and a logged reason) when it couldn't be asked. */
async function rewriteOrNull(ctx: Ctx, q: string): Promise<Rewrite | null> {
  try {
    return await rewriteFor(ctx, q);
  } catch (err) {
    console.error(`search by meaning failed; keyword results only: ${(err as Error).message}`);
    return null;
  }
}

/** The person's techniques Claude named (by name or other name), in the order it named them. */
async function techniqueIds(ctx: Ctx, names: string[]): Promise<number[]> {
  if (!names.length) return [];
  const wanted = names.map(n => n.toLowerCase());
  const { rows } = await ctx.db.query<{ id: number; names: string[] }>(
    `select id, array_prepend(lower(name), (select coalesce(array_agg(lower(a)), '{}') from unnest(aliases) a)) as names
     from techniques t
     where user_id = $1 and (lower(name) = any($2::text[]) or exists (select 1 from unnest(aliases) a where lower(a) = any($2::text[])))`,
    [uid(ctx.db), wanted],
  );
  const rank = (r: { names: string[] }) => Math.min(...r.names.map(n => wanted.indexOf(n)).filter(i => i >= 0));
  return rows.sort((a, b) => rank(a) - rank(b)).map(r => r.id);
}

/** Terms as one keyword search that matches any of them (websearch syntax: a OR b OR c). */
function anyOf(terms: string[]): string {
  return terms
    .map(t => t.replace(/["\-]/g, ' ').replace(/\bor\b/gi, ' ').replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join(' OR ');
}

/**
 * How a search uses meaning. 'phrase' (typing in the app): only for three words or more, so typing a name stays
 * instant. 'always' (Claude's searches): also when the words alone found nothing.
 */
export type MeaningMode = 'always' | 'phrase';

function wantsMeaning(q: string, mode: MeaningMode, keywordHits: number): boolean {
  const text = q.trim();
  if (text.length < 3) return false;
  return text.split(/\s+/).length >= 3 || (mode === 'always' && keywordHits === 0);
}

/**
 * Several rankings merged (reciprocal rank fusion): something near the top of any list ranks high, and
 * something in more than one ranks higher. Earlier lists win ties, so the plain keyword matches come first.
 */
function fuse<T extends { id: number }>(lists: T[][], limit: number): T[] {
  const score = new Map<number, number>();
  const items = new Map<number, T>();
  for (const list of lists) {
    list.forEach((item, rank) => {
      score.set(item.id, (score.get(item.id) ?? 0) + 1 / (60 + rank));
      if (!items.has(item.id)) items.set(item.id, item);
    });
  }
  return [...items.values()].sort((a, b) => score.get(b.id)! - score.get(a.id)!).slice(0, limit);
}

/** Notes matching a query by their words or by what they're about, best first. Other filters still apply. */
export async function searchNotes(ctx: Ctx, query: NoteQuery & { q: string }, mode: MeaningMode): Promise<NoteView[]> {
  const keyword = await noteList(ctx.db, query);
  if (!ctx.rewriter || query.beforeId !== undefined || !wantsMeaning(query.q, mode, keyword.length)) return keyword;
  const r = await rewriteOrNull(ctx, query.q);
  if (!r) return keyword;
  const { q: _q, ...filters } = query;
  const limit = Math.min(Math.max(query.limit ?? 30, 1), 200);
  const ids = await techniqueIds(ctx, r.techniques);
  const words = anyOf(r.terms);
  const [worded, about] = await Promise.all([
    words ? noteList(ctx.db, { ...filters, q: words, limit }) : [],
    ids.length ? noteList(ctx.db, { ...filters, techniqueIds: ids, limit }) : [],
  ]);
  return fuse([keyword, worded, about], limit);
}

/** Technique cards matching a query by name, words or what they're about, best first. Other filters still apply. */
export async function searchTechniques(
  ctx: Ctx,
  query: TechniqueQuery & { q: string },
  mode: MeaningMode,
): Promise<TechniqueListItem[]> {
  const keyword = await techniqueList(ctx.db, query);
  if (!ctx.rewriter || !wantsMeaning(query.q, mode, keyword.length)) return keyword;
  const r = await rewriteOrNull(ctx, query.q);
  if (!r) return keyword;
  const { q: _q, ...filters } = query;
  const limit = Math.min(query.limit ?? 200, 500);
  const ids = await techniqueIds(ctx, r.techniques);
  const found = ids.length ? await techniqueList(ctx.db, { ...filters, ids, limit: ids.length }) : [];
  const named = ids.map(id => found.find(t => t.id === id)).filter((t): t is TechniqueListItem => !!t);
  // The most specific few terms, each as its own (fuzzy) search, since card names are matched one at a time.
  const byTerm = await Promise.all(r.terms.slice(0, 4).map(t => techniqueList(ctx.db, { ...filters, q: t, limit: 5 })));
  return fuse([keyword, named, ...byTerm], limit);
}

export interface SearchStatus {
  enabled: boolean;
  model: string | null;
  lastError: string | null;
}

export function searchStatus(ctx: Ctx): SearchStatus {
  return { enabled: !!ctx.rewriter, model: ctx.rewriter?.model ?? null, lastError: ctx.rewriter ? rewriteHealth.lastError : null };
}
