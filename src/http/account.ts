// Your account (name, email, password, Siri tokens) and, for the owner, the people who can sign in.
import express, { type RequestHandler, type Request, type Response, type Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import type {
  AccountView,
  ApiTokenView,
  InviteCheck,
  InviteView,
  Me,
  MessageResult,
  SessionInfo,
} from '../shared/api.js';
import {
  acceptInvite,
  BELTS,
  changePassword,
  createApiToken,
  createInvite,
  getUser,
  listApiTokens,
  listPeople,
  lookupInvite,
  pendingInvites,
  removeUser,
  revokeApiToken,
  revokeInvite,
  updateProfile,
  type User,
} from '../auth/users.js';
import type { Ctx } from '../services/context.js';
import { ForbiddenError, NotFoundError, UserError } from '../services/errors.js';
import { apiErrors } from './api.js';
import { CSRF_HEADER, sessionInfo, userIdOf } from './auth.js';

const id = z.coerce.number().int().positive();
const token = z.string().trim().min(10).max(100);
const optional = (max: number) => z.string().trim().max(max).nullable().optional();

const toMe = (u: User): Me => ({ id: u.id, name: u.name, email: u.email, isOwner: u.isOwner, belt: u.belt });
const belt = z.enum(BELTS);

/** Wraps an async handler; the result is sent as JSON, errors go to the API error handler. */
const h =
  <T>(fn: (req: Request, res: Response) => Promise<T>): RequestHandler =>
  (req, res, next) => {
    fn(req, res)
      .then(body => {
        if (!res.headersSent) res.set('Cache-Control', 'no-store').json(body);
      })
      .catch(next);
  };

export interface AccountRouterOptions {
  base: Ctx;
  publicUrl: URL;
  requireAuth: RequestHandler;
  /** Signs the browser in as a user (sets the session cookie). */
  startSession: (req: Request, res: Response, userId: number) => Promise<void>;
  /** The sign-in rate limit (failed attempts), shared by password changes. */
  limiter: RequestHandler;
}

export function accountRouter(opts: AccountRouterOptions): Router {
  const { base, requireAuth } = opts;
  const db = base.db;
  const r = express.Router();
  const json = express.json({ limit: '16kb' });
  const linkFor = (t: string) => new URL(`/join#${t}`, opts.publicUrl).href;
  // Links are long random tokens, so this only stops someone hammering the endpoint.
  const linkLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 20,
    standardHeaders: true,
    legacyHeaders: false,
    skipSuccessfulRequests: true,
  });

  const me = async (res: Response): Promise<User> => {
    const user = await getUser(db, userIdOf(res));
    if (!user) throw new NotFoundError('Your account is gone.');
    return user;
  };
  const owner = async (res: Response): Promise<User> => {
    const user = await me(res);
    if (!user.isOwner) throw new ForbiddenError('Only the owner can do that.');
    return user;
  };
  const csrf: RequestHandler = (req, res, next) => {
    if (req.get(CSRF_HEADER) !== '1') {
      res.status(403).json({ error: 'csrf', message: 'Missing app header.' });
      return;
    }
    next();
  };

  // ---------- invite and reset links (no sign-in needed: the link is the permission) ----------

  r.post(
    '/api/v1/invites/check',
    linkLimiter,
    csrf,
    json,
    h(async (req): Promise<InviteCheck> => {
      const found = await lookupInvite(db, token.parse(req.body?.token));
      if (!found) throw new NotFoundError('This link has expired or was already used. Ask for a new one.');
      return {
        purpose: found.purpose,
        name: found.user?.name ?? found.name,
        email: found.user?.email ?? found.email,
        belt: found.user?.belt ?? found.belt ?? 'white',
        expiresAt: found.expiresAt,
      };
    }),
  );

  r.post(
    '/api/v1/invites/accept',
    linkLimiter,
    csrf,
    json,
    h(async (req, res): Promise<SessionInfo> => {
      const b = z
        .object({ token, name: optional(80), email: optional(254), password: z.string().max(200) })
        .parse(req.body);
      const user = await db.tx(q => acceptInvite(q, b.token, b));
      await opts.startSession(req, res, user.id);
      return sessionInfo(user);
    }),
  );

  // ---------- your account ----------

  r.get(
    '/api/v1/account',
    requireAuth,
    h(async (_req, res): Promise<AccountView> => {
      const user = await me(res);
      const view: AccountView = { me: toMe(user), tokens: await listApiTokens(db, user.id), ownerApiToken: user.isOwner };
      if (user.isOwner) {
        view.people = (await listPeople(db)).map(p => ({ ...toMe(p), createdAt: p.createdAt, lastActiveAt: p.lastActiveAt }));
        view.invites = await pendingInvites(db);
      }
      return view;
    }),
  );

  r.patch(
    '/api/v1/account',
    requireAuth,
    json,
    h(async (req, res): Promise<Me> => {
      const b = z.object({ name: optional(80), email: optional(254), belt: belt.optional() }).parse(req.body);
      return toMe(await updateProfile(db, await me(res), { name: b.name, email: b.email ?? undefined, belt: b.belt }));
    }),
  );

  r.post(
    '/api/v1/account/password',
    opts.limiter,
    requireAuth,
    json,
    h(async (req, res): Promise<MessageResult> => {
      const b = z.object({ current: z.string().max(200), password: z.string().max(200) }).parse(req.body);
      await changePassword(db, await me(res), b.current, b.password);
      return { message: 'Password changed.' };
    }),
  );

  r.post(
    '/api/v1/account/tokens',
    requireAuth,
    json,
    h(async (req, res): Promise<{ token: string; row: ApiTokenView }> => {
      const b = z.object({ label: optional(80) }).parse(req.body ?? {});
      return createApiToken(db, (await me(res)).id, b.label ?? null);
    }),
  );

  r.delete(
    '/api/v1/account/tokens/:id',
    requireAuth,
    h(async (req, res): Promise<MessageResult> => {
      if (!(await revokeApiToken(db, (await me(res)).id, id.parse(req.params.id)))) throw new NotFoundError('No such token.');
      return { message: 'Token removed. Shortcuts using it will stop working.' };
    }),
  );

  // ---------- people (owner only) ----------

  r.post(
    '/api/v1/invites',
    requireAuth,
    json,
    h(async (req, res): Promise<{ url: string; invite: InviteView }> => {
      const user = await owner(res);
      const b = z.object({ name: optional(80), email: optional(254), belt: belt.optional() }).parse(req.body ?? {});
      const made = await createInvite(db, { createdBy: user.id, purpose: 'join', name: b.name, email: b.email, belt: b.belt });
      res.status(201);
      return { url: linkFor(made.token), invite: made.invite };
    }),
  );

  r.delete(
    '/api/v1/invites/:id',
    requireAuth,
    h(async (req, res): Promise<MessageResult> => {
      await owner(res);
      if (!(await revokeInvite(db, id.parse(req.params.id)))) throw new NotFoundError('That link was already used or removed.');
      return { message: 'Link cancelled.' };
    }),
  );

  r.post(
    '/api/v1/people/:id/reset',
    requireAuth,
    h(async (req, res): Promise<{ url: string; invite: InviteView }> => {
      const user = await owner(res);
      const target = await getUser(db, id.parse(req.params.id));
      if (!target) throw new NotFoundError('No such person.');
      if (target.isOwner) throw new UserError('Your password is the OWNER_PASSWORD secret; change it in GitHub and redeploy.');
      const made = await createInvite(db, { createdBy: user.id, purpose: 'reset', userId: target.id });
      res.status(201);
      return { url: linkFor(made.token), invite: made.invite };
    }),
  );

  r.delete(
    '/api/v1/people/:id',
    requireAuth,
    h(async (req, res): Promise<MessageResult> => {
      await owner(res);
      const removed = await removeUser(db, id.parse(req.params.id));
      if (!removed) throw new NotFoundError('No such person (and the owner can’t be removed).');
      return { message: `Removed ${removed} and their notebook.` };
    }),
  );

  r.use(['/api/v1/account', '/api/v1/invites', '/api/v1/people'], apiErrors);
  return r;
}
