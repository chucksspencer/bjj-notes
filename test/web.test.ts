// The web app's front door: signing in with a cookie, the app header, and serving the built app and its assets.
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { API_TOKEN, newPerson, OWNER_PASSWORD, request, startServer, type Person, type TestServer } from './helpers.js';

let s: TestServer;

beforeAll(async () => {
  const webDir = mkdtempSync(path.join(tmpdir(), 'bjj-web-'));
  mkdirSync(path.join(webDir, 'assets'));
  writeFileSync(path.join(webDir, 'index.html'), '<!doctype html><title>BJJ Notes</title><div id="root"></div>');
  writeFileSync(path.join(webDir, 'assets', 'app-abc123.js'), 'console.log(1)');
  writeFileSync(path.join(webDir, 'manifest.webmanifest'), '{}');
  s = await startServer(null, webDir);
});
afterAll(async () => {
  await s.close();
});

// The owner as a first start leaves them: no email yet, OWNER_PASSWORD and API_TOKEN.
describe('web sign-in', () => {
  let cookie = '';

  it('rejects anonymous API calls and wrong passwords', async () => {
    expect((await request(s, {}, 'GET', '/api/v1/focus')).status).toBe(401);
    expect((await request(s, {}, 'GET', '/api/v1/session')).body).toEqual({ signedIn: false });
    expect((await request(s, {}, 'POST', '/api/v1/session', { password: 'nope' })).status).toBe(401);
    expect((await request(s, { csrf: false }, 'POST', '/api/v1/session', { password: OWNER_PASSWORD })).status).toBe(403);
  });

  it('signs in with the owner password and sets a locked-down cookie', async () => {
    const res = await request(s, {}, 'POST', '/api/v1/session', { password: OWNER_PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ signedIn: true, user: { id: 1, name: 'Chuck', email: null, isOwner: true, belt: 'purple' } });
    const setCookie = res.headers.get('set-cookie')!;
    expect(setCookie).toMatch(/^bjj_session=[\w-]{20,};/);
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Lax');
    expect(setCookie).not.toContain('Secure'); // http://localhost in tests
    cookie = setCookie.split(';')[0]!;
    expect((await request(s, { cookie }, 'GET', '/api/v1/session')).body).toMatchObject({ signedIn: true, user: { name: 'Chuck', isOwner: true } });
  });

  it('requires the app header on writes made with the cookie, but not with the API token', async () => {
    expect((await request(s, { cookie, csrf: false }, 'POST', '/api/v1/undo')).status).toBe(403);
    expect((await request(s, { cookie, csrf: false }, 'GET', '/api/v1/focus')).status).toBe(200);
    expect((await request(s, { bearer: API_TOKEN, csrf: false }, 'GET', '/api/v1/focus')).status).toBe(200);
  });
});

describe('web app hosting', () => {
  let p: Person;
  beforeAll(async () => {
    p = await newPerson(s);
  });

  it('serves the app shell for client routes, with a strict CSP', async () => {
    const res = await fetch(`${s.base}/t/12`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('<div id="root">');
    const csp = res.headers.get('content-security-policy')!;
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain('frame-src https://www.youtube-nocookie.com https://www.instagram.com');
    expect(res.headers.get('x-frame-options')).toBe('DENY');
  });

  it('serves hashed assets as immutable and 404s missing files', async () => {
    const asset = await fetch(`${s.base}/assets/app-abc123.js`);
    expect(asset.status).toBe(200);
    expect(asset.headers.get('cache-control')).toContain('immutable');
    expect((await fetch(`${s.base}/assets/missing.js`)).status).toBe(404);
    expect((await fetch(`${s.base}/favicon-missing.png`)).status).toBe(404);
    expect((await fetch(`${s.base}/manifest.webmanifest`)).status).toBe(200);
  });

  it('leaves server routes alone', async () => {
    expect((await fetch(`${s.base}/mcp`, { method: 'GET' })).status).toBe(401);
    expect((await fetch(`${s.base}/.well-known/oauth-authorization-server`)).headers.get('content-type')).toContain('json');
    expect((await fetch(`${s.base}/healthz`)).headers.get('content-type')).toContain('json');
  });

  it('answers unknown API paths with JSON', async () => {
    const res = await p.api('GET', '/api/v1/nope');
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ error: 'not_found' });
  });
});
