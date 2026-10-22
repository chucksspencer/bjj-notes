import { randomBytes } from 'node:crypto';
import express, { type NextFunction, type Request, type Response, type Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import { sha256 } from '../auth/provider.js';
import { authenticate, getUser, userForApiToken, type User } from '../auth/users.js';
import type { Db } from '../db.js';
import type { SessionInfo } from '../shared/api.js';

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

/** The signed-in user's id, set by requireAuth. */
export function userIdOf(res: Response): number {
  const id = res.locals.userId;
  if (typeof id !== 'number') throw new Error('Route reached without a signed-in user.');
  return id;
}

export const sessionInfo = (u: User): SessionInfo => ({
  signedIn: true,
  user: { id: u.id, name: u.name, email: u.email, isOwner: u.isOwner, belt: u.belt },
});

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

  /** Whose session this is. Valid sessions slide forward: 90 days from last use. */
  async function sessionUserId(token: string): Promise<number | null> {
    const { rows } = await db.query<{ user_id: number }>(
      `update web_sessions set last_used_at = now(), expires_at = now() + interval '${SESSION_DAYS} days'
       where token_hash = $1 and expires_at > now() returning user_id`,
      [sha256(token)],
    );
    return rows[0]?.user_id ?? null;
  }

  /** Signs this browser in as the user (a new session cookie). */
  async function startSession(req: Request, res: Response, userId: number) {
    const token = randomBytes(32).toString('base64url');
    await db.query(
      `insert into web_sessions (token_hash, expires_at, user_agent, user_id) values ($1, now() + interval '${SESSION_DAYS} days', $2, $3)`,
      [sha256(token), (req.get('user-agent') ?? '').slice(0, 300), userId],
    );
    await db.query("delete from web_sessions where expires_at < now() - interval '1 day'");
    cookie(res, token, SESSION_DAYS * 86400);
  }

  /** Signed in with the browser cookie, or a bearer API token (for scripts and Shortcuts). Sets res.locals.userId. */
  const requireAuth = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const bearer = (req.get('authorization') ?? '').replace(/^Bearer\s+/i, '').trim();
      if (bearer) {
        const userId = await userForApiToken(db, bearer, opts.apiToken);
        if (userId !== null) {
          res.locals.userId = userId;
          return next();
        }
      }
      const token = readCookie(req, COOKIE);
      const userId = token ? await sessionUserId(token) : null;
      if (userId !== null) {
        if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.get(CSRF_HEADER) !== '1') {
          res.status(403).json({ error: 'csrf', message: 'Missing app header.' });
          return;
        }
        res.locals.userId = userId;
        return next();
      }
      res.status(401).json({ error: 'unauthorized', message: 'Sign in to continue.' });
    } catch (err) {
      next(err);
    }
  };

  const router: Router = express.Router();
  // Wrong passwords count toward the limit; successful sign-ins don't, so several people behind one
  // network (a gym's wifi) aren't locked out by each other.
  const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    standardHeaders: true,
    legacyHeaders: false,
    skipSuccessfulRequests: true,
  });

  router.get('/api/v1/session', async (req, res, next) => {
    try {
      const token = readCookie(req, COOKIE);
      const userId = token ? await sessionUserId(token) : null;
      const user = userId !== null ? await getUser(db, userId) : null;
      if (user) cookie(res, token!, SESSION_DAYS * 86400); // the app checks this on start, so the cookie slides too
      res.set('Cache-Control', 'no-store').json(user ? sessionInfo(user) : ({ signedIn: false } satisfies SessionInfo));
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
      const email = typeof req.body?.email === 'string' ? req.body.email.slice(0, 254) : '';
      const user = await authenticate(db, email, password, opts.ownerPassword);
      if (!user) {
        res.status(401).json({ error: 'wrong_password', message: 'Wrong email or password.' });
        return;
      }
      await startSession(req, res, user.id);
      res.status(200).set('Cache-Control', 'no-store').json(sessionInfo(user));
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

  return { router, requireAuth, startSession, limiter };
}
