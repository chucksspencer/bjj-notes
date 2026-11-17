// Routes for the Lab (the short-term working set) and clearing stars.
import type { Router } from 'express';
import { z } from 'zod';
import type { LabView, MessageResult } from '../../shared/api.js';
import { clearStars } from '../../services/marks.js';
import { labView } from '../../services/views/lab.js';
import type { Handle } from '../handler.js';

export function labRoutes(r: Router, h: Handle): void {
  // The Lab: the short-term working set
  r.get(
    '/api/v1/lab',
    h(async (ctx, req): Promise<LabView> => {
      const qs = z.object({ days: z.coerce.number().int().min(1).max(365).optional() }).parse(req.query);
      return labView(ctx, qs.days);
    }),
  );

  r.post(
    '/api/v1/stars/clear',
    h(async (ctx, req): Promise<MessageResult> => {
      const b = z.object({ olderThanDays: z.number().int().min(1).max(3650).optional() }).parse(req.body ?? {});
      return { message: await clearStars(ctx, b.olderThanDays) };
    }),
  );
}
