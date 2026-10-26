import express, { type Express } from 'express';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { getOAuthProtectedResourceMetadataUrl, mcpAuthRouter } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { loginRouter } from './auth/login.js';
import { NotesOAuthProvider } from './auth/provider.js';
import { getUser } from './auth/users.js';
import { appCaptureRouter, captureRouter, type Structurer } from './capture.js';
import type { Config } from './config.js';
import { buildMcpServer } from './mcp/server.js';
import { userCtx, type Ctx } from './services/context.js';
import { accountRouter } from './http/account.js';
import { apiRouter } from './http/api.js';
import { webAuth } from './http/auth.js';
import { webAppRouter } from './http/static.js';

const SCOPES = ['notes'];

/**
 * The whole server. `ctx` is the base context (the plain database pool): each request is given a
 * context for the person it's signed in as, and only that person's notebook is read or written.
 */
export function buildApp(opts: { ctx: Ctx; config: Config; structurer: Structurer | null; webDir?: string }): Express {
  const { ctx, config, structurer } = opts;
  const app = express();
  app.set('trust proxy', 1); // Cloud Run terminates TLS in front of us
  app.disable('x-powered-by');
  // On every response, not just the web page: no MIME sniffing (stills are served as stored), no
  // framing, no cross-site embedding of API responses, and HTTPS only from here on.
  const https = config.publicUrl.protocol === 'https:';
  app.use((_req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'same-origin',
      'Cross-Origin-Resource-Policy': 'same-origin',
      ...(https ? { 'Strict-Transport-Security': 'max-age=31536000' } : {}),
    });
    next();
  });

  const mcpUrl = new URL('/mcp', config.publicUrl);
  const provider = new NotesOAuthProvider(ctx.db, mcpUrl);

  // OAuth: /.well-known/*, /authorize, /token, /register, /revoke
  app.use(
    mcpAuthRouter({
      provider,
      issuerUrl: config.publicUrl,
      scopesSupported: SCOPES,
      resourceName: 'BJJ Notes',
      resourceServerUrl: mcpUrl,
    }),
  );
  // Some clients look for resource metadata at the root as well as at /mcp.
  app.get('/.well-known/oauth-protected-resource', (_req, res) => {
    res.json({
      resource: mcpUrl.href,
      authorization_servers: [config.publicUrl.href],
      scopes_supported: SCOPES,
      resource_name: 'BJJ Notes',
    });
  });
  app.use(loginRouter(provider, ctx.db, config.ownerPassword));

  const bearer = requireBearerAuth({
    verifier: provider,
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(mcpUrl),
    expectedResource: mcpUrl,
  });

  // Stateless Streamable HTTP: a fresh server + transport per request, plain JSON responses.
  app.post('/mcp', bearer, express.json({ limit: '1mb' }), async (req, res) => {
    const userId = Number(req.auth?.extra?.userId);
    const user = Number.isInteger(userId) ? await getUser(ctx.db, userId) : null;
    if (!user) {
      res.status(401).json({ jsonrpc: '2.0', error: { code: -32001, message: 'Sign in again.' }, id: null });
      return;
    }
    const server = buildMcpServer(userCtx(ctx, user.id), user);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });
  app.all('/mcp', bearer, (_req, res) => {
    res.status(405).set('Allow', 'POST').json({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Method not allowed: this server is stateless; use POST.' },
      id: null,
    });
  });

  app.use(captureRouter(ctx, config.apiToken, structurer));

  // The web app: browser sign-in, its JSON API, and the built front end.
  const web = webAuth({
    db: ctx.db,
    ownerPassword: config.ownerPassword,
    apiToken: config.apiToken,
    secureCookies: config.publicUrl.protocol === 'https:',
  });
  app.use(web.router);
  app.use(
    accountRouter({
      base: ctx,
      publicUrl: config.publicUrl,
      requireAuth: web.requireAuth,
      startSession: web.startSession,
      limiter: web.limiter,
      shareShortcutUrl: config.shareShortcutUrl,
    }),
  );
  app.use(appCaptureRouter(ctx, structurer, web.requireAuth));
  app.use(apiRouter(ctx, web.requireAuth));

  // Liveness: cheap, does not touch the database (so probes don't keep Neon awake).
  app.get('/healthz', (_req, res) => {
    res.json({ ok: true });
  });
  app.use(webAppRouter(opts.webDir));

  return app;
}
