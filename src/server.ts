import { buildApp } from './app.js';
import { claudeStructurer } from './capture.js';
import { loadConfig } from './config.js';
import { migrate, pgDb, pgliteDb } from './db.js';
import { housekeep, HOUSEKEEPING_INTERVAL_MS } from './services/housekeeping.js';
import { drafterFor } from './services/gamePlanDrafts.js';
import { rewriterFor } from './services/semantic.js';

try {
  process.loadEnvFile(); // local development: read .env if present
} catch {
  // no .env file; rely on the real environment
}

const config = loadConfig();
const db = config.databaseUrl ? pgDb(config.databaseUrl) : await pgliteDb(config.pgliteDir);
if (!config.databaseUrl) {
  console.warn(`Using embedded PGlite ${config.pgliteDir ? `at ${config.pgliteDir}` : 'in memory (data is lost on exit)'}.`);
}

const ran = await migrate(db);
if (ran.length) console.log(`Applied migrations: ${ran.join(', ')}`);

const structurer = config.anthropicApiKey ? claudeStructurer(config.anthropicApiKey, config.captureModel) : null;
const rewriter = rewriterFor(config);
if (!rewriter) console.log(`Search by meaning is off (${config.anthropicApiKey ? 'SEARCH_MODEL=off' : 'no ANTHROPIC_API_KEY'}).`);
const app = buildApp({ ctx: { db, timeZone: config.timeZone, rewriter, gamePlanDrafter: drafterFor(config) }, config, structurer });

const server = app.listen(config.port, '0.0.0.0', () => {
  console.log(`BJJ Notes listening on :${config.port}; MCP endpoint ${new URL('/mcp', config.publicUrl).href}`);
});

/** Prunes old rows; runs after the server is listening, and a failure is logged, never fatal. */
const tidy = async () => {
  try {
    const done = await housekeep(db);
    const gone = Object.entries(done).filter(([, n]) => n > 0);
    if (gone.length) console.log(`Housekeeping removed ${gone.map(([k, n]) => `${n} ${k}`).join(', ')}.`);
  } catch (err) {
    console.error(`Housekeeping failed: ${err instanceof Error ? err.message : err}`);
  }
};
void tidy(); // the service scales to zero, so startup is the main trigger
setInterval(() => void tidy(), HOUSEKEEPING_INTERVAL_MS).unref();

const shutdown = () => {
  server.close(() => {
    void db.close().finally(() => process.exit(0));
  });
  setTimeout(() => process.exit(0), 10_000).unref();
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
