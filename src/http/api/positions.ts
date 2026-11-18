// Routes for positions: the starter ones everyone shares and the person's own, which they can add, change and delete.
import type { Router } from 'express';
import { z } from 'zod';
import type { MessageResult, PositionListItem, PositionView } from '../../shared/api.js';
import type { Ctx } from '../../services/context.js';
import { NotFoundError as NotFound } from '../../services/errors.js';
import { createPosition, deletePosition, positionIdBySlug, updatePosition } from '../../services/positions.js';
import { POSITION_CATEGORIES, ROLES } from '../../services/vocab.js';
import { positionList, positionView } from '../../services/views/positions.js';
import { strList } from './schemas.js';
import type { Handle } from '../handler.js';

const positionCreate = z.object({
  name: z.string().trim().min(1).max(120),
  category: z.enum(POSITION_CATEGORIES),
  aliases: strList.optional(),
  description: z.string().trim().max(5000).nullable().optional(),
});
const positionPatch = positionCreate.partial();

/** The position a slug names among the ones the person can see; someone else's is "No such position." like a missing one. */
async function idOf(ctx: Ctx, slug: string): Promise<number> {
  const id = await positionIdBySlug(ctx.db, slug);
  if (id === null) throw new NotFound('No such position.');
  return id;
}

export function positionRoutes(r: Router, h: Handle): void {
  const load = async (ctx: Ctx, id: number): Promise<PositionView> => (await positionView(ctx.db, id))!;
  r.get('/api/v1/positions', h(async (ctx): Promise<PositionListItem[]> => positionList(ctx.db)));
  r.post(
    '/api/v1/positions',
    h(async (ctx, req, res): Promise<PositionView> => {
      const saved = await createPosition(ctx, positionCreate.parse(req.body));
      res.status(201);
      return load(ctx, saved.id);
    }),
  );
  r.get(
    '/api/v1/positions/:slug',
    h(async (ctx, req): Promise<PositionView> => {
      const role = z.enum(ROLES).optional().parse(req.query.role || undefined);
      return (await positionView(ctx.db, await idOf(ctx, String(req.params.slug)), role))!;
    }),
  );
  r.patch(
    '/api/v1/positions/:slug',
    h(async (ctx, req): Promise<PositionView> => {
      const id = await idOf(ctx, String(req.params.slug));
      const saved = await updatePosition(ctx, id, positionPatch.parse(req.body));
      return load(ctx, saved.id);
    }),
  );
  r.delete(
    '/api/v1/positions/:slug',
    h(async (ctx, req): Promise<MessageResult> => ({ message: await deletePosition(ctx, await idOf(ctx, String(req.params.slug))) })),
  );
}
