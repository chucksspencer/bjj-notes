import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connect, form, OWNER_PASSWORD, pkce, REDIRECT_URI, startServer, type TestServer } from './helpers.js';

let s: TestServer;
beforeAll(async () => {
  s = await startServer();
});
afterAll(async () => {
  await s.close();
});

describe('OAuth for the Claude connector', () => {
  it('advertises protected-resource and authorization-server metadata', async () => {
    const unauth = await fetch(s.mcpUrl, { method: 'POST' });
    expect(unauth.status).toBe(401);
    expect(unauth.headers.get('www-authenticate')).toContain(`${s.base}/.well-known/oauth-protected-resource/mcp`);

    const prm = (await (await fetch(`${s.base}/.well-known/oauth-protected-resource/mcp`)).json()) as any;
    expect(prm.resource).toBe(s.mcpUrl);
    expect(prm.authorization_servers).toEqual([`${s.base}/`]);

    const as = (await (await fetch(`${s.base}/.well-known/oauth-authorization-server`)).json()) as any;
    expect(as.authorization_endpoint).toBe(`${s.base}/authorize`);
    expect(as.registration_endpoint).toBe(`${s.base}/register`);
    expect(as.code_challenge_methods_supported).toContain('S256');
  });

  it('runs register → authorize → login → token → refresh, enforcing PKCE and one-time codes', async () => {
    const client = (await (
      await fetch(`${s.base}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          client_name: 'Claude',
          redirect_uris: [REDIRECT_URI],
          grant_types: ['authorization_code', 'refresh_token'],
          response_types: ['code'],
          token_endpoint_auth_method: 'none',
        }),
      })
    ).json()) as { client_id: string };
    expect(client.client_id).toBeTruthy();

    const { verifier, challenge } = pkce();
    const authorize = await fetch(
      `${s.base}/authorize?${form({
        response_type: 'code',
        client_id: client.client_id,
        redirect_uri: REDIRECT_URI,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        state: 'xyz',
        scope: 'notes',
        resource: s.mcpUrl,
      })}`,
      { redirect: 'manual' },
    );
    expect(authorize.status).toBe(200);
    const html = await authorize.text();
    expect(html).toContain('Claude wants access to your notes');
    expect(html).toContain(`value="${challenge}"`);
    expect(authorize.headers.get('content-security-policy')).toContain("form-action 'self' https://claude.ai");
    expect(authorize.headers.get('x-frame-options')).toBe('DENY');

    const fields = {
      client_id: client.client_id,
      redirect_uri: REDIRECT_URI,
      state: 'xyz',
      code_challenge: challenge,
      scope: 'notes',
      resource: s.mcpUrl,
    };
    const wrong = await fetch(`${s.base}/oauth/login`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form({ ...fields, password: 'nope' }),
    });
    expect(wrong.status).toBe(401);
    expect(await wrong.text()).toContain('Wrong password');

    const forged = await fetch(`${s.base}/oauth/login`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form({ ...fields, redirect_uri: 'https://evil.example/cb', password: OWNER_PASSWORD }),
    });
    expect(forged.status).toBe(400);

    const ok = await fetch(`${s.base}/oauth/login`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form({ ...fields, password: OWNER_PASSWORD }),
    });
    expect(ok.status).toBe(302);
    const location = new URL(ok.headers.get('location')!);
    expect(location.origin + location.pathname).toBe(REDIRECT_URI);
    expect(location.searchParams.get('state')).toBe('xyz');
    const code = location.searchParams.get('code')!;

    const exchange = (verifierToUse: string) =>
      fetch(`${s.base}/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: form({
          grant_type: 'authorization_code',
          code,
          code_verifier: verifierToUse,
          redirect_uri: REDIRECT_URI,
          client_id: client.client_id,
          resource: s.mcpUrl,
        }),
      });

    const badPkce = await exchange(pkce().verifier);
    expect(badPkce.status).toBe(400);

    const tokenRes = await exchange(verifier);
    expect(tokenRes.status).toBe(200);
    const tokens = (await tokenRes.json()) as any;
    expect(tokens.token_type).toBe('bearer');
    expect(tokens.expires_in).toBe(3600);
    expect(tokens.refresh_token).toBeTruthy();

    const replay = await exchange(verifier);
    expect(replay.status).toBe(400);
    expect(((await replay.json()) as any).error).toBe('invalid_grant');

    const refresh = (token: string) =>
      fetch(`${s.base}/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: form({ grant_type: 'refresh_token', refresh_token: token, client_id: client.client_id }),
      });
    const refreshed = await refresh(tokens.refresh_token);
    expect(refreshed.status).toBe(200);
    const next = (await refreshed.json()) as any;
    expect(next.access_token).not.toBe(tokens.access_token);
    const reused = await refresh(tokens.refresh_token);
    expect(reused.status).toBe(400);

    // The new access token works against /mcp; garbage does not.
    const ping = (token: string) =>
      fetch(s.mcpUrl, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
      });
    expect((await ping(next.access_token)).status).toBe(200);
    expect((await ping('not-a-token')).status).toBe(401);
  });

  it('rejects an authorization request for a different resource', async () => {
    const { clientId } = await connect(s);
    const res = await fetch(
      `${s.base}/authorize?${form({
        response_type: 'code',
        client_id: clientId,
        redirect_uri: REDIRECT_URI,
        code_challenge: pkce().challenge,
        code_challenge_method: 'S256',
        resource: 'https://other.example/mcp',
      })}`,
      { redirect: 'manual' },
    );
    expect(res.status).toBe(302);
    expect(new URL(res.headers.get('location')!).searchParams.get('error')).toBe('invalid_target');
  });
});
