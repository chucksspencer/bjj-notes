import { createHash, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { buildApp } from '../src/app.js';
import type { Structurer } from '../src/capture.js';
import { loadConfig } from '../src/config.js';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { migrate, pgDb, pgliteDb, type Db } from '../src/db.js';
import type { Ctx } from '../src/services/context.js';

export const OWNER_PASSWORD = 'correct horse battery staple';
export const API_TOKEN = 'test-api-token-0123456789abcdefghijklmnop';
export const REDIRECT_URI = 'https://claude.ai/api/mcp/auth_callback';

export interface TestServer {
  base: string;
  mcpUrl: string;
  db: Db;
  ctx: Ctx;
  close(): Promise<void>;
}

/**
 * Each test server gets a fresh database: embedded PGlite by default, or a new database on a real
 * Postgres server when TEST_PG_ADMIN_URL is set (exercises the production node-postgres adapter).
 */
async function freshDb(): Promise<{ db: Db; drop: () => Promise<void> }> {
  const admin = process.env.TEST_PG_ADMIN_URL;
  if (!admin) return { db: await pgliteDb(), drop: async () => {} };
  const name = `bjj_test_${randomUUID().replace(/-/g, '')}`;
  const run = async (sql: string) => {
    const c = new pg.Client({ connectionString: admin });
    await c.connect();
    try {
      await c.query(sql);
    } finally {
      await c.end();
    }
  };
  await run(`create database ${name}`);
  const url = new URL(admin);
  url.pathname = `/${name}`;
  return { db: pgDb(url.href), drop: () => run(`drop database ${name} with (force)`) };
}

export async function startServer(structurer: Structurer | null = null, webDir?: string): Promise<TestServer> {
  const { db, drop } = await freshDb();
  await migrate(db);
  const http: Server = createServer();
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  const port = (http.address() as AddressInfo).port;
  const base = `http://localhost:${port}`;
  const config = loadConfig({
    PORT: String(port),
    PUBLIC_URL: base,
    OWNER_PASSWORD,
    API_TOKEN,
    TIME_ZONE: 'America/Chicago',
  });
  const ctx: Ctx = { db, timeZone: config.timeZone };
  http.on('request', buildApp({ ctx, config, structurer, webDir: webDir ?? '/nonexistent-web-dir' }));
  return {
    base,
    mcpUrl: `${base}/mcp`,
    db,
    ctx,
    close: async () => {
      await new Promise<void>(resolve => http.close(() => resolve()));
      await db.close();
      await drop();
    },
  };
}

export function pkce() {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

export const form = (data: Record<string, string>) => new URLSearchParams(data).toString();

/** Runs the whole connector flow the way Claude does: register, authorize, log in, exchange the code. */
export async function connect(s: TestServer) {
  const reg = await fetch(`${s.base}/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_name: 'Claude',
      redirect_uris: [REDIRECT_URI],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    }),
  });
  const client = (await reg.json()) as { client_id: string };
  const { verifier, challenge } = pkce();
  const login = await fetch(`${s.base}/oauth/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form({
      client_id: client.client_id,
      redirect_uri: REDIRECT_URI,
      state: 's1',
      code_challenge: challenge,
      scope: 'notes',
      resource: s.mcpUrl,
      password: OWNER_PASSWORD,
    }),
  });
  const code = new URL(login.headers.get('location')!).searchParams.get('code')!;
  const tok = await fetch(`${s.base}/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form({
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      redirect_uri: REDIRECT_URI,
      client_id: client.client_id,
      resource: s.mcpUrl,
    }),
  });
  const tokens = (await tok.json()) as { access_token: string; refresh_token: string };
  return { clientId: client.client_id, ...tokens };
}
