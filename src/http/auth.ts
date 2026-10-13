import { randomBytes } from 'node:crypto';
import express, { type NextFunction, type Request, type Response, type Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import { secretsMatch, sha256 } from '../auth/provider.js';
import type { Db } from '../db.js';

const COOKIE = 'bjj_session';
const SESSION_DAYS = 90;
/** Mutating requests from the web app carry this header; a cross-site form or image can't set it. */
export const CSRF_HEADER = 'x-bjj-app';

function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return undefined;
}

export interface WebAuthOptions {
  db: Db;
  ownerPassword: string;
  apiToken: string;
  /** Set the Secure flag (true whenever the public URL is https). */
  secureCookies: boolean;
}

export function webAuth(opts: WebAuthOptions) {
  const { db } = opts;
  const cookie = (res: Response, value: string, maxAgeS: number) => {
    res.append(
      'Set-Cookie',
      `${COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeS}${opts.secureCookies ? '; Secure' : ''}`,
    );
  };

  /** Valid sessions slide forward: 90 days from last use. */
  async function sessionValid(token: string): Promise<boolean> {
    const { rows } = await db.query(
      `update web_sessions set last_used_at = now(), expires_at = now() + interval '${SESSION_DAYS} days'
       where token_hash = $1 and expires_at > now() returning 1 as ok`,
      [sha256(token)],
    );
    return rows.length > 0;
  }

  /** Signed in with the browser cookie, or a bearer API token (for scripts and Shortcuts). */
  const requireAuth = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const bearer = (req.get('authorization') ?? '').replace(/^Bearer\s+/i, '');
      if (bearer && secretsMatch(bearer, opts.apiToken)) return next();
      const token = readCookie(req, COOKIE);
      if (token && (await sessionValid(token))) {
        if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.get(CSRF_HEADER) !== '1') {
          res.status(403).json({ error: 'csrf', message: 'Missing app header.' });
          return;
        }
        return next();
      }
      res.status(401).json({ error: 'unauthorized', message: 'Sign in to continue.' });
    } catch (err) {
      next(err);
    }
  };

  const router: Router = express.Router();
  const limiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: true, legacyHeaders: false });

  router.get('/api/v1/session', async (req, res, next) => {
    try {
      const token = readCookie(req, COOKIE);
      const signedIn = !!token && (await sessionValid(token));
      if (signedIn) cookie(res, token, SESSION_DAYS * 86400); // the app checks this on start, so the cookie slides too
      res.set('Cache-Control', 'no-store').json({ signedIn });
    } catch (err) {
      next(err);
    }
  });

  router.post('/api/v1/session', limiter, express.json({ limit: '4kb' }), async (req, res, next) => {
    try {
      if (req.get(CSRF_HEADER) !== '1') {
        res.status(403).json({ error: 'csrf', message: 'Missing app header.' });
        return;
      }
      const password = typeof req.body?.password === 'string' ? req.body.password : '';
      if (!secretsMatch(password, opts.ownerPassword)) {
        res.status(401).json({ error: 'wrong_password', message: 'Wrong password.' });
        return;
      }
      const token = randomBytes(32).toString('base64url');
      await db.query(
        `insert into web_sessions (token_hash, expires_at, user_agent) values ($1, now() + interval '${SESSION_DAYS} days', $2)`,
        [sha256(token), (req.get('user-agent') ?? '').slice(0, 300)],
      );
      await db.query("delete from web_sessions where expires_at < now() - interval '1 day'");
      cookie(res, token, SESSION_DAYS * 86400);
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  router.delete('/api/v1/session', async (req, res, next) => {
    try {
      const token = readCookie(req, COOKIE);
      if (token) await db.query('delete from web_sessions where token_hash = $1', [sha256(token)]);
      cookie(res, '', 0);
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  return { router, requireAuth };
}
