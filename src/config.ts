export interface Config {
  port: number;
  /** Public base URL, e.g. https://bjj.example.com. Used as the OAuth issuer; the MCP endpoint is <publicUrl>/mcp. */
  publicUrl: URL;
  /** Postgres connection string (Neon). If unset, an embedded PGlite database is used. */
  databaseUrl?: string;
  /** Folder for the embedded database; in memory if unset (development only). */
  pgliteDir?: string;
  /** Password for the OAuth login page shown when connecting Claude. */
  ownerPassword: string;
  /** Bearer token for the Siri Shortcut endpoints under /api. */
  apiToken: string;
  /** Enables Claude-powered parsing of dictated notes in /api/capture. */
  anthropicApiKey?: string;
  captureModel: string;
  /** IANA zone used to date notes ("today"). */
  timeZone: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const problems: string[] = [];
  const port = Number(env.PORT ?? 8080);
  const publicUrl = new URL(env.PUBLIC_URL ?? `http://localhost:${port}`);
  if (publicUrl.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(publicUrl.hostname)) {
    problems.push('PUBLIC_URL must use https (except localhost).');
  }
  const ownerPassword = env.OWNER_PASSWORD ?? '';
  if (ownerPassword.length < 12) problems.push('OWNER_PASSWORD must be at least 12 characters.');
  const apiToken = env.API_TOKEN ?? '';
  if (apiToken.length < 32) problems.push('API_TOKEN must be at least 32 characters (try: openssl rand -base64 32).');
  const timeZone = env.TIME_ZONE ?? 'America/Chicago';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
  } catch {
    problems.push(`TIME_ZONE "${timeZone}" is not a valid IANA time zone.`);
  }
  if (problems.length) throw new Error(`Configuration problems:\n- ${problems.join('\n- ')}`);

  return {
    port,
    publicUrl,
    databaseUrl: env.DATABASE_URL || undefined,
    pgliteDir: env.PGLITE_DIR || undefined,
    ownerPassword,
    apiToken,
    anthropicApiKey: env.ANTHROPIC_API_KEY || undefined,
    captureModel: env.CAPTURE_MODEL || 'claude-haiku-5-5',
    timeZone,
  };
}
