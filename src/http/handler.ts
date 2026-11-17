// What every JSON route is wrapped in, and how errors become responses.
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { z } from 'zod';
import { ConflictError, ForbiddenError as Forbidden, NotFoundError as NotFound, UserError } from '../services/errors.js';
import { userCtx, type Ctx } from '../services/context.js';
import { userIdOf } from './auth.js';

/**
 * Wraps an async handler: it gets the signed-in user's context (set up by requireAuth), its result is sent
 * as JSON, and errors reach the error middleware.
 */
export const handler =
  (base: Ctx) =>
  <T>(fn: (ctx: Ctx, req: Request, res: Response) => Promise<T>): RequestHandler =>
  (req, res, next) => {
    // The undo entries this request writes: the newest goes out as X-Activity-Id, so Undo can name the change it is for.
    const activityIds: number[] = [];
    Promise.resolve()
      .then(() => fn(userCtx(base, userIdOf(res), activityIds), req, res))
      .then(body => {
        if (res.headersSent) return;
        res.set('Cache-Control', 'no-store');
        if (activityIds.length) res.set('X-Activity-Id', String(activityIds[activityIds.length - 1]));
        res.json(body);
      })
      .catch(next);
  };

/** The wrapper for one person's routes: what `handler(base)` returns. */
export type Handle = ReturnType<typeof handler>;

/** Errors: validation and service messages are the caller's to fix; anything else is ours. */
export function apiErrors(err: unknown, _req: Request, res: Response, next: NextFunction) {
  if (res.headersSent) return next(err);
  if (err instanceof z.ZodError) {
    res.status(400).json({ error: 'invalid', message: err.issues.map(i => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ') });
  } else if (err instanceof Forbidden) {
    res.status(403).json({ error: 'forbidden', message: err.message });
  } else if (err instanceof NotFound) {
    res.status(404).json({ error: 'not_found', message: err.message });
  } else if (err instanceof ConflictError) {
    res.status(409).json({ error: 'conflict', message: err.message });
  } else if (err instanceof UserError) {
    res.status(400).json({ error: 'rejected', message: err.message });
  } else if ((err as { type?: string }).type === 'entity.parse.failed') {
    res.status(400).json({ error: 'invalid_json', message: 'Request body is not valid JSON.' });
  } else {
    console.error('api error', err);
    res.status(500).json({ error: 'server', message: 'Something went wrong on the server.' });
  }
}
