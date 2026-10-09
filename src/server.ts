import { buildApp } from './app.js';
import { claudeStructurer } from './capture.js';
import { loadConfig } from './config.js';
import { migrate, pgDb, pgliteDb } from './db.js';

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
const app = buildApp({ ctx: { db, timeZone: config.timeZone }, config, structurer });

const server = app.listen(config.port, '0.0.0.0', () => {
  console.log(`BJJ Notes listening on :${config.port}; MCP endpoint ${new URL('/mcp', config.publicUrl).href}`);
});

const shutdown = () => {
  server.close(() => {
    void db.close().finally(() => process.exit(0));
  });
  setTimeout(() => process.exit(0), 10_000).unref();
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
