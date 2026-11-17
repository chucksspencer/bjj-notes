import express, { type RequestHandler, type Router } from 'express';
import { z } from 'zod';
import type { MessageResult } from '../shared/api.js';
import { undo } from '../services/undo.js';
import type { Ctx } from '../services/context.js';
import { apiErrors, handler } from './handler.js';
import { gamePlanRoutes } from './api/gamePlans.js';
import { techniqueRoutes } from './api/techniques.js';
import { noteRoutes } from './api/notes.js';
import { labRoutes } from './api/lab.js';
import { positionRoutes } from './api/positions.js';

export function apiRouter(base: Ctx, requireAuth: RequestHandler): Router {
  const r = express.Router();
  const h = handler(base);
  r.use('/api/v1', requireAuth, express.json({ limit: '256kb' }));

  gamePlanRoutes(r, h);
  techniqueRoutes(r, h);
  noteRoutes(r, h, base);
  labRoutes(r, h);
  positionRoutes(r, h);

  // Undo
  r.post(
    '/api/v1/undo',
    h(async (ctx, req): Promise<MessageResult> => ({ message: await undo(ctx.db, z.object({ id: z.number().int().optional() }).parse(req.body ?? {}).id) })),
  );

  r.use('/api/v1', (_req, res) => {
    res.status(404).json({ error: 'not_found', message: 'No such endpoint.' });
  });

  r.use('/api/v1', apiErrors);
  return r;
}
