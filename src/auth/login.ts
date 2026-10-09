import express, { type Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import { redirectUriMatches } from '@modelcontextprotocol/sdk/server/auth/handlers/authorize.js';
import { loginHeaders, secretsMatch, type OwnerOAuthProvider } from './provider.js';

const esc = (s: string) =>
  s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export function loginPage(opts: { clientName: string; fields: Record<string, string>; error?: string }): string {
  const hidden = Object.entries(opts.fields)
    .map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`)
    .join('\n      ');
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Sign in · BJJ Notes</title>
  <style>
    :root { color-scheme: light dark; --bg: #f6f5f2; --card: #fff; --ink: #1c1b19; --muted: #6b6862; --accent: #1f4d3a; --err: #a12a1f; }
    @media (prefers-color-scheme: dark) { :root { --bg: #151514; --card: #1f1e1c; --ink: #ecebe7; --muted: #9b978f; --accent: #7cc5a2; --err: #ff8a7a; } }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 16px; background: var(--bg); color: var(--ink);
           font: 16px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    main { width: 100%; max-width: 360px; background: var(--card); border-radius: 14px; padding: 28px 24px; box-shadow: 0 1px 3px rgb(0 0 0 / .12); }
    h1 { font-size: 20px; margin: 0 0 4px; }
    p { margin: 0 0 20px; color: var(--muted); }
    label { display: block; font-weight: 600; margin-bottom: 6px; }
    input[type=password] { width: 100%; font-size: 17px; padding: 12px; border-radius: 10px; border: 1px solid var(--muted); background: transparent; color: inherit; }
    button { width: 100%; margin-top: 16px; padding: 12px; font-size: 17px; font-weight: 600; border: 0; border-radius: 10px; background: var(--accent); color: var(--card); }
    .error { color: var(--err); margin: 12px 0 0; }
  </style>
</head>
<body>
  <main>
    <h1>BJJ Notes</h1>
    <p>${esc(opts.clientName)} wants access to your notes.</p>
    <form method="post" action="/oauth/login">
      ${hidden}
      <label for="password">Password</label>
      <input id="password" name="password" type="password" autocomplete="current-password" autofocus required>
      ${opts.error ? `<p class="error" role="alert">${esc(opts.error)}</p>` : ''}
      <button type="submit">Allow access</button>
    </form>
  </main>
</body>
</html>`;
}

/** POST /oauth/login: checks the owner password and completes the authorization redirect. */
export function loginRouter(provider: OwnerOAuthProvider, ownerPassword: string): Router {
  const router = express.Router();
  const limiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: true, legacyHeaders: false });

  router.post('/oauth/login', limiter, express.urlencoded({ extended: false }), async (req, res) => {
    const f = req.body as Record<string, string | undefined>;
    const clientId = f.client_id ?? '';
    const redirectUri = f.redirect_uri ?? '';
    const client = clientId ? await provider.clientsStore.getClient(clientId) : undefined;
    // Re-validate: this endpoint is reachable directly, not only from the SDK's /authorize handler.
    if (!client || !client.redirect_uris.some(u => redirectUriMatches(redirectUri, String(u)))) {
      res.status(400).type('text').send('Invalid client or redirect URI.');
      return;
    }
    if (!f.code_challenge) {
      res.status(400).type('text').send('Missing code challenge.');
      return;
    }
    const fields = {
      client_id: clientId,
      redirect_uri: redirectUri,
      state: f.state ?? '',
      code_challenge: f.code_challenge,
      scope: f.scope ?? '',
      resource: f.resource ?? '',
    };
    if (!secretsMatch(f.password ?? '', ownerPassword)) {
      res
        .status(401)
        .type('html')
        .set(loginHeaders(redirectUri))
        .send(loginPage({ clientName: client.client_name ?? 'An app', fields, error: 'Wrong password.' }));
      return;
    }
    const code = await provider.issueCode({
      clientId,
      redirectUri,
      codeChallenge: f.code_challenge,
      scopes: (f.scope ?? '').split(' ').filter(Boolean),
      resource: f.resource || null,
    });
    const target = new URL(redirectUri);
    target.searchParams.set('code', code);
    if (f.state) target.searchParams.set('state', f.state);
    res.redirect(302, target.href);
  });

  return router;
}
