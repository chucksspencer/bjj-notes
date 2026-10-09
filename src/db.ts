import { readdir, readFile } from 'node:fs/promises';
import pg from 'pg';

/** Anything that can run a parameterised query: the pool, or a transaction. */
export interface Queryable {
  query<T = Record<string, any>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
  /** Run one or more statements without parameters (used for migrations). */
  exec(sql: string): Promise<void>;
}

export interface Db extends Queryable {
  tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

/** Production: node-postgres against Neon (or any Postgres 15+). */
export function pgDb(connectionString: string): Db {
  const pool = new pg.Pool({ connectionString, max: 5, idleTimeoutMillis: 30_000 });
  return {
    async query(sql, params) {
      return (await pool.query(sql, params as any[])) as any;
    },
    async exec(sql) {
      await pool.query(sql);
    },
    async tx(fn) {
      const client = await pool.connect();
      try {
        await client.query('begin');
        const result = await fn({
          query: async (sql, params) => (await client.query(sql, params as any[])) as any,
          exec: async sql => {
            await client.query(sql);
          },
        });
        await client.query('commit');
        return result;
      } catch (err) {
        await client.query('rollback');
        throw err;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}

/**
 * Local development and tests: embedded Postgres (PGlite), in memory or in a folder.
 * PGlite is a dev dependency, so it is imported lazily.
 */
export async function pgliteDb(dataDir?: string): Promise<Db> {
  const { PGlite } = await import('@electric-sql/pglite');
  const { pg_trgm } = await import('@electric-sql/pglite/contrib/pg_trgm');
  const { fuzzystrmatch } = await import('@electric-sql/pglite/contrib/fuzzystrmatch');
  const db = new PGlite({ dataDir, extensions: { pg_trgm, fuzzystrmatch } });
  await db.waitReady;
  return {
    async query(sql, params) {
      return db.query(sql, params as any[]) as any;
    },
    async exec(sql) {
      await db.exec(sql);
    },
    async tx(fn) {
      return db.transaction(async t =>
        fn({
          query: (sql, params) => t.query(sql, params as any[]) as any,
          exec: async sql => {
            await t.exec(sql);
          },
        }),
      );
    },
    close: () => db.close(),
  };
}

const MIGRATIONS_DIR = new URL('../db/migrations/', import.meta.url);

/** Applies db/migrations/*.sql in name order, each once, each in its own transaction. */
export async function migrate(db: Db): Promise<string[]> {
  await db.exec(`create table if not exists schema_migrations (
    name text primary key, applied_at timestamptz not null default now())`);
  const applied = new Set(
    (await db.query<{ name: string }>('select name from schema_migrations')).rows.map(r => r.name),
  );
  const files = (await readdir(MIGRATIONS_DIR)).filter(f => f.endsWith('.sql')).sort();
  const ran: string[] = [];
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = await readFile(new URL(file, MIGRATIONS_DIR), 'utf8');
    await db.tx(async q => {
      await q.exec(sql);
      await q.query('insert into schema_migrations (name) values ($1)', [file]);
    });
    ran.push(file);
  }
  return ran;
}
