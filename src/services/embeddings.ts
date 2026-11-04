// Embeddings: turning text into a list of numbers so that texts about the same thing end up close together,
// even when they share no words. Used for search by meaning (services/semantic.ts).

export type Purpose = 'document' | 'query';

export interface Embedder {
  /** Stored with each embedding: a different model means a different space, so rows are redone. */
  readonly model: string;
  embed(texts: string[], purpose: Purpose): Promise<number[][]>;
}

export class EmbeddingError extends Error {}

/** The most recent failure, shown to the owner on the Account page (null once a call succeeds again). */
export const embeddingHealth: { lastError: string | null; at: string | null } = { lastError: null, at: null };

const record = (err: string | null) => {
  embeddingHealth.lastError = err;
  embeddingHealth.at = new Date().toISOString();
};

/** Voyage AI (https://docs.voyageai.com): POST /v1/embeddings with up to 1,000 texts. */
export function voyageEmbedder(
  apiKey: string,
  model = 'voyage-4',
  opts: { baseUrl?: string; timeoutMs?: number; batch?: number } = {},
): Embedder {
  const url = `${(opts.baseUrl ?? 'https://api.voyageai.com').replace(/\/$/, '')}/v1/embeddings`;
  const batch = opts.batch ?? 64;
  async function call(input: string[], purpose: Purpose): Promise<number[][]> {
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ input, model, input_type: purpose }),
        signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
      });
    } catch (err) {
      throw new EmbeddingError(`Couldn't reach Voyage AI (${(err as Error).name === 'TimeoutError' ? 'timed out' : (err as Error).message}).`);
    }
    const body = (await res.json().catch(() => null)) as { data?: { embedding?: unknown; index?: number }[]; detail?: string } | null;
    if (!res.ok) {
      const why = res.status === 401 || res.status === 403 ? 'the API key was refused' : body?.detail || `HTTP ${res.status}`;
      throw new EmbeddingError(`Voyage AI: ${why}.`);
    }
    const data = body?.data;
    if (!Array.isArray(data) || data.length !== input.length) throw new EmbeddingError('Voyage AI sent an unexpected response.');
    const out: number[][] = new Array(input.length);
    data.forEach((d, i) => {
      const v = d.embedding;
      if (!Array.isArray(v) || !v.length || !v.every(x => typeof x === 'number' && Number.isFinite(x))) {
        throw new EmbeddingError('Voyage AI sent an unexpected response.');
      }
      out[typeof d.index === 'number' ? d.index : i] = v as number[];
    });
    if (out.some(v => !v)) throw new EmbeddingError('Voyage AI sent an unexpected response.');
    return out;
  }
  return {
    model,
    async embed(texts, purpose) {
      const out: number[][] = [];
      try {
        for (let i = 0; i < texts.length; i += batch) out.push(...(await call(texts.slice(i, i + batch), purpose)));
        record(null);
        return out;
      } catch (err) {
        record((err as Error).message);
        throw err;
      }
    },
  };
}

/** A query's embedding, remembered: the same search typed again, or paging, doesn't call the service again. */
const queryCache = new Map<string, number[]>();
export async function embedQuery(embedder: Embedder, query: string): Promise<number[]> {
  const key = `${embedder.model}\n${query.trim().toLowerCase()}`;
  const hit = queryCache.get(key);
  if (hit) {
    queryCache.delete(key);
    queryCache.set(key, hit); // most recently used last
    return hit;
  }
  const [v] = await embedder.embed([query.trim()], 'query');
  queryCache.set(key, v!);
  if (queryCache.size > 300) queryCache.delete(queryCache.keys().next().value!);
  return v!;
}

/** pgvector's text form: [0.1,0.2,…] */
export const toVector = (v: number[]) => `[${v.join(',')}]`;
