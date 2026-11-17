import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import pg from 'pg';
import { inject } from 'vitest';
import { buildApp } from '../src/app.js';
import { sha256 } from '../src/auth/provider.js';
import { hashPassword, importOwnerSecrets, type Belt } from '../src/auth/users.js';
import type { Structurer } from '../src/capture.js';
import { loadConfig } from '../src/config.js';
import { migrate, pgDb, pgliteDb, type Db } from '../src/db.js';
import type { Ctx } from '../src/services/context.js';
import { drafterFor } from '../src/services/gamePlanDrafts.js';
import { rewriterFor } from '../src/services/semantic.js';
import type { GamePlanDetail, GamePlanStepInput, NoteCreateResult, NoteView, Role, TechniqueType, TechniqueView } from '../src/shared/api.js';

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
 * A database of its own: embedded PGlite by default, or a new database on a real Postgres server when
 * TEST_PG_ADMIN_URL is set (exercises the production node-postgres adapter). Empty unless `migrated`; startServer
 * migrates it either way. An embedded one is a copy of the one test/globalSetup.ts made for the run, in a folder
 * of its own that `drop` removes.
 */
export async function freshDb(opts: { migrated?: boolean } = {}): Promise<{ db: Db; drop: () => Promise<void> }> {
  const admin = process.env.TEST_PG_ADMIN_URL;
  if (!admin) {
    const templates = inject('pgliteTemplates');
    if (!templates) return { db: await pgliteDb(), drop: async () => {} };
    const dir = mkdtempSync(path.join(templates, 'db-'));
    cpSync(path.join(templates, opts.migrated ? 'migrated' : 'empty'), dir, { recursive: true });
    return { db: await pgliteDb(dir), drop: async () => rmSync(dir, { recursive: true, force: true }) };
  }
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

export async function startServer(
  structurer: Structurer | null = null,
  webDir?: string,
  /** Extra settings, as environment variables (e.g. SHARE_SHORTCUT_URL). */
  env: Record<string, string> = {},
): Promise<TestServer> {
  const { db, drop } = await freshDb({ migrated: true });
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
    ...env,
  });
  // As src/server.ts does after migrating: the owner's first password and Siri token come from the settings, once.
  await importOwnerSecrets(db, { ownerPassword: config.ownerPassword, apiToken: config.apiToken });
  const ctx: Ctx = { db, timeZone: config.timeZone, rewriter: rewriterFor(config), gamePlanDrafter: drafterFor(config) };
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

/**
 * Runs the whole connector flow the way Claude does: register, authorize, log in, exchange the code.
 * Signs in as the owner unless given someone's email and password.
 */
export async function connect(s: TestServer, as: { email?: string; password: string } = { password: OWNER_PASSWORD }) {
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
      email: as.email ?? '',
      password: as.password,
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

// ---------- people, signed in ----------
//
// Each test file has one server and one database (startServer in the file's beforeAll; a block about what a first
// start leaves starts its own). Each top-level `describe` makes the people it needs in its own `beforeAll` and works in
// their notebooks, so blocks in a file can't see each other's notes, techniques or undo history, and any block can be
// run alone (`npx vitest run -t "<describe name>"`). A block uses the owner only for what is the owner's: their
// account, inviting, resetting and removing people, the original Siri token, and the notebook migration 003 imports
// for them. For a notebook like the owner's, use personWithWorkingList.

/** How a request signs in: a browser's session cookie or a token; `csrf: false` leaves the app header off. */
export type Auth = { cookie?: string; bearer?: string; csrf?: boolean };

export interface ApiResponse<T> {
  status: number;
  headers: Headers;
  body: T;
}

/** One request to the server, as whoever `auth` says; the body is parsed when it is JSON. */
export async function request<T = any>(s: TestServer, auth: Auth, method: string, p: string, body?: unknown): Promise<ApiResponse<T>> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (auth.csrf !== false) headers['x-bjj-app'] = '1';
  if (auth.cookie) headers.cookie = auth.cookie;
  if (auth.bearer) headers.authorization = `Bearer ${auth.bearer}`;
  const res = await fetch(`${s.base}${p}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  const json = text && res.headers.get('content-type')?.includes('json') ? JSON.parse(text) : text;
  return { status: res.status, headers: res.headers, body: json as T };
}

/** Signs in through the web app's form, as a browser does, and returns the session cookie. */
export async function signIn(s: TestServer, email: string, password: string): Promise<Auth & { cookie: string }> {
  const res = await request(s, {}, 'POST', '/api/v1/session', { email, password });
  if (res.status !== 200) throw new Error(`Signing in as ${email || 'the owner'} failed (${res.status}): ${JSON.stringify(res.body)}`);
  return { cookie: res.headers.get('set-cookie')!.split(';')[0]! };
}

/** Requests as one signed-in person: `api('GET', '/api/v1/focus')`; `auth: 'none'` sends no cookie. */
export type Api = <T = any>(method: string, p: string, body?: unknown, opts?: { csrf?: boolean; auth?: 'cookie' | 'none' }) => Promise<ApiResponse<T>>;

export interface Person {
  s: TestServer;
  id: number;
  name: string;
  email: string | null;
  /** Null unless the person was made with one (hashing a password takes a moment, so only for tests that sign in with it). */
  password: string | null;
  /** Their browser session, for `request`. */
  auth: Auth & { cookie: string };
  api: Api;
}

/** A browser session for someone, put straight in the database: no password needed, whatever their email is by now. */
async function signedIn(s: TestServer, user: { id: number; name: string; email: string | null; password: string | null }): Promise<Person> {
  const token = randomBytes(32).toString('base64url');
  await s.db.query("insert into web_sessions (token_hash, expires_at, user_agent, user_id) values ($1, now() + interval '1 day', 'test', $2)", [
    sha256(token),
    user.id,
  ]);
  const auth = { cookie: `bjj_session=${token}` };
  const api: Api = (method, p, body, opts = {}) => request(s, { ...(opts.auth === 'none' ? {} : auth), csrf: opts.csrf }, method, p, body);
  return { s, ...user, auth, api };
}

/** The owner, signed in. Their notebook starts with the working list migration 003 imports. */
export async function ownerPerson(s: TestServer): Promise<Person> {
  const row = (await s.db.query<{ id: number; name: string; email: string | null }>('select id, name, email from users where is_owner')).rows[0]!;
  return signedIn(s, { ...row, password: OWNER_PASSWORD });
}

let people = 0;

/**
 * Someone new with an empty notebook, signed in. Give a password only when the test signs in with it (the web form,
 * the Claude connector); the email defaults to one nobody else has.
 */
export async function newPerson(s: TestServer, opts: { name?: string; email?: string; belt?: Belt; password?: string } = {}): Promise<Person> {
  const name = opts.name ?? 'Pat';
  const email = opts.email ?? `person-${++people}-${randomBytes(4).toString('hex')}@example.com`;
  const hash = opts.password ? await hashPassword(opts.password) : null;
  const { rows } = await s.db.query<{ id: number }>('insert into users (email, name, password_hash, belt) values ($1, $2, $3, $4) returning id', [
    email,
    name,
    hash,
    opts.belt ?? 'white',
  ]);
  return signedIn(s, { id: rows[0]!.id, name, email, password: opts.password ?? null });
}

// ---------- seeding a notebook ----------
//
// Seeding goes through the JSON API, as the web app would, so a seeded notebook is one the app could have made.

/** Fails loudly when seeding didn't work, rather than in whichever assertion first misses the data. */
function seeded<T>(what: string, res: ApiResponse<T>): T {
  if (res.status >= 300) throw new Error(`Seeding ${what} failed (${res.status}): ${JSON.stringify(res.body)}`);
  return res.body;
}

export interface TechniqueSeed {
  name: string;
  type: TechniqueType;
  role?: Role | null;
  status?: TechniqueView['status'];
  aliases?: string[];
  /** Positions it starts from, by slug, with the role there. */
  from?: { slug: string; role: Role; toRole?: Role }[];
}

/** A technique card in someone's notebook. */
export async function seedTechnique(p: Person, t: TechniqueSeed): Promise<TechniqueView> {
  let card = seeded(t.name, await p.api<TechniqueView>('POST', '/api/v1/techniques', { name: t.name, type: t.type, role: t.role ?? null }));
  if (t.status || t.aliases?.length) {
    card = seeded(t.name, await p.api<TechniqueView>('PATCH', `/api/v1/techniques/${card.id}`, { status: t.status, aliases: t.aliases }));
  }
  for (const e of t.from ?? []) {
    const pos = seeded(e.slug, await p.api<{ position: { id: number } }>('GET', `/api/v1/positions/${e.slug}`)).position.id;
    card = seeded(t.name, await p.api<TechniqueView>('POST', `/api/v1/techniques/${card.id}/edges`, { fromPositionId: pos, fromRole: e.role, toRole: e.toRole }));
  }
  return card;
}

/** A note in someone's notebook, given as the web app's "+" sheet sends it (`text`, `techniqueIds`, `date`, …). */
export async function seedNote(p: Person, note: Record<string, unknown> & { text: string }): Promise<NoteView> {
  return seeded(`note "${note.text}"`, await p.api<NoteCreateResult>('POST', '/api/v1/notes', note)).note;
}

/** A game plan in someone's notebook: off focus unless given a position on it; with steps when given an outline. */
export async function seedGamePlan(
  p: Person,
  name: string,
  opts: { techniqueIds?: number[]; position?: number; steps?: GamePlanStepInput[] } = {},
): Promise<GamePlanDetail> {
  const made = seeded(
    name,
    await p.api<{ gamePlan: GamePlanDetail }>('POST', '/api/v1/game-plans', {
      name,
      techniqueIds: opts.techniqueIds ?? [],
      ...(opts.position === undefined ? { focus: false } : { position: opts.position }),
    }),
  ).gamePlan;
  if (!opts.steps) return made;
  return seeded(name, await p.api<{ gamePlan: GamePlanDetail }>('PATCH', `/api/v1/game-plans/${made.id}`, { steps: opts.steps })).gamePlan;
}

/** The working list as migration 003 gives it to the owner: seven cards, each with its game plan on focus, in this order. */
const WORKING_LIST: (TechniqueSeed & { gamePlan: string })[] = [
  { name: 'Baratoplata', aliases: ['barataplata'], type: 'submission', gamePlan: 'Baratoplata' },
  {
    name: 'Shoulder crunch',
    aliases: ['shoulder crunches'],
    type: 'control',
    role: 'bottom',
    from: [
      { slug: 'half-guard', role: 'bottom' },
      { slug: 'butterfly', role: 'bottom' },
    ],
    gamePlan: 'Shoulder crunches from butterfly guard and bottom half guard',
  },
  { name: 'Body lock pass', aliases: ['body lock passing', 'bodylock pass'], type: 'pass', role: 'top', gamePlan: 'Body lock passing' },
  {
    name: 'Shoulder lock to paper cutter choke',
    aliases: ['paper cutter combo'],
    type: 'submission',
    role: 'bottom',
    from: [{ slug: 'side-control', role: 'bottom' }],
    gamePlan: 'Shoulder lock and paper cutter choke combination from bottom side control',
  },
  { name: 'Ghost escape', type: 'escape', role: 'bottom', from: [{ slug: 'side-control', role: 'bottom' }], gamePlan: 'Ghost escape' },
  {
    name: 'Leg elevation',
    aliases: ['deep half leg elevation'],
    type: 'sweep',
    role: 'bottom',
    from: [{ slug: 'deep-half', role: 'bottom', toRole: 'top' }],
    gamePlan: 'Leg elevation from deep half guard',
  },
  { name: 'Ankle lock', aliases: ['straight ankle lock'], type: 'submission', gamePlan: 'Ankle lock adjustments' },
];

/**
 * Gives someone the notebook the owner starts with (the working list migration 003 imports): seven technique cards
 * in "learning", each linked to a game plan on the focus list, #1 to #7, and nothing to undo. The JSON API, the
 * focus list and Claude's tools read it exactly as they read the owner's. Returns the cards and game plans by name.
 */
export async function seedWorkingList(p: Person): Promise<{ techniques: Record<string, TechniqueView>; gamePlans: Record<string, GamePlanDetail> }> {
  const techniques: Record<string, TechniqueView> = {};
  const gamePlans: Record<string, GamePlanDetail> = {};
  for (const [i, { gamePlan, ...t }] of WORKING_LIST.entries()) {
    const card = await seedTechnique(p, { ...t, status: 'learning' });
    techniques[card.name] = card;
    gamePlans[gamePlan] = await seedGamePlan(p, gamePlan, { techniqueIds: [card.id], position: i + 1 });
  }
  await p.s.db.query('delete from activity_log where user_id = $1', [p.id]);
  return { techniques, gamePlans };
}

/** Someone new with the owner's starting notebook (seedWorkingList), and its Ghost escape card, which most blocks use. */
export async function personWithWorkingList(s: TestServer, opts: Parameters<typeof newPerson>[1] = {}) {
  const p = await newPerson(s, opts);
  const list = await seedWorkingList(p);
  return { p, ...list, ghost: list.techniques['Ghost escape']! };
}

// ---------- the Claude connector ----------

export interface McpSession {
  client: Client;
  /** Calls a tool and returns its text; throws what the tool said when it reports an error. */
  call(name: string, args?: Record<string, unknown>): Promise<string>;
}

/** An MCP client connected with an access token (from `connect`, or `accessTokenFor`). */
export async function mcpSession(s: TestServer, accessToken: string): Promise<McpSession> {
  const client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(s.mcpUrl), { requestInit: { headers: { Authorization: `Bearer ${accessToken}` } } }));
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const res = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
    const text = res.content.map(c => c.text).join('\n');
    if (res.isError) throw new Error(text);
    return text;
  };
  return { client, call };
}

/**
 * A connector access token for someone, put straight in the database as the OAuth provider stores one, so a block
 * needn't sign in through the connector's page (test/oauth.test.ts and `connect` cover that).
 */
export async function accessTokenFor(s: TestServer, userId: number): Promise<string> {
  const clientId = `test-${randomUUID()}`;
  await s.db.query('insert into oauth_clients (client_id, info) values ($1, $2)', [
    clientId,
    JSON.stringify({ client_id: clientId, client_name: 'Claude', redirect_uris: [REDIRECT_URI], token_endpoint_auth_method: 'none' }),
  ]);
  const token = randomBytes(32).toString('base64url');
  await s.db.query(
    "insert into oauth_tokens (token_hash, kind, client_id, scopes, resource, expires_at, user_id) values ($1, 'access', $2, '{notes}', $3, now() + interval '1 hour', $4)",
    [sha256(token), clientId, new URL(s.mcpUrl).href, userId],
  );
  return token;
}

/** Claude's connector, signed in as someone. */
export async function mcpFor(p: Person): Promise<McpSession> {
  return mcpSession(p.s, await accessTokenFor(p.s, p.id));
}
