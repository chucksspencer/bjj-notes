// Routes for positions.
import type { Router } from 'express';
import { z } from 'zod';
import type { PositionListItem, PositionView } from '../../shared/api.js';
import { NotFoundError as NotFound } from '../../services/errors.js';
import { ROLES } from '../../services/vocab.js';
import { positionList, positionView } from '../../services/views/positions.js';
import type { Handle } from '../handler.js';

export function positionRoutes(r: Router, h: Handle): void {
  // Positions
  r.get('/api/v1/positions', h(async (ctx): Promise<PositionListItem[]> => positionList(ctx.db)));
  r.get(
    '/api/v1/positions/:slug',
    h(async (ctx, req): Promise<PositionView> => {
      const role = z.enum(ROLES).optional().parse(req.query.role || undefined);
      const pos = (await ctx.db.query<{ id: number }>('select id from positions where slug = $1', [String(req.params.slug)])).rows[0];
      if (!pos) throw new NotFound('No such position.');
      return (await positionView(ctx.db, pos.id, role))!;
    }),
  );
}
