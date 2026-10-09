import express, { type Express } from 'express';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { getOAuthProtectedResourceMetadataUrl, mcpAuthRouter } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { loginRouter } from './auth/login.js';
import { OwnerOAuthProvider } from './auth/provider.js';
import { captureRouter, type Structurer } from './capture.js';
import type { Config } from './config.js';
import { buildMcpServer } from './mcp/server.js';
import type { Ctx } from './services/context.js';

const SCOPES = ['notes'];

export function buildApp(opts: { ctx: Ctx; config: Config; structurer: Structurer | null }): Express {
  const { ctx, config, structurer } = opts;
  const app = express();
  app.set('trust proxy', 1); // Azure Container Apps terminates TLS in front of us
  app.disable('x-powered-by');

  const mcpUrl = new URL('/mcp', config.publicUrl);
  const provider = new OwnerOAuthProvider(ctx.db, mcpUrl);

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
  app.use(loginRouter(provider, config.ownerPassword));

  const bearer = requireBearerAuth({
    verifier: provider,
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(mcpUrl),
    expectedResource: mcpUrl,
  });

  // Stateless Streamable HTTP: a fresh server + transport per request, plain JSON responses.
  app.post('/mcp', bearer, express.json({ limit: '1mb' }), async (req, res) => {
    const server = buildMcpServer(ctx);
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

  // Liveness: cheap, does not touch the database (so probes don't keep Neon awake).
  app.get('/healthz', (_req, res) => {
    res.json({ ok: true });
  });
  app.get('/', (_req, res) => {
    res.type('text').send('BJJ Notes. Connect Claude to /mcp; Siri Shortcuts use /api/capture and /api/focus.');
  });

  return app;
}
