// Routes for technique cards: the library's lists, a card, its moves between positions and its links.
import type { Router } from 'express';
import { z } from 'zod';
import type { MessageResult, TechniqueListItem, TechniqueView } from '../../shared/api.js';
import { NotFoundError as NotFound, UserError } from '../../services/errors.js';
import type { Ctx } from '../../services/context.js';
import { uid } from '../../db.js';
import { deleteTechnique, deleteTechniques, removeEdge, removeLink, saveTechniqueResult } from '../../services/techniques.js';
import { GI, LINK_KINDS, ROLES, STATUSES, TECHNIQUE_TYPES } from '../../services/vocab.js';
import { searchTechniques } from '../../services/semantic.js';
import { techniqueList, techniqueView } from '../../services/views/techniques.js';
import { date, id, idList, strList } from './schemas.js';
import type { Handle } from '../handler.js';

const techniqueCreate = z.object({
  name: z.string().trim().min(1).max(120),
  type: z.enum(TECHNIQUE_TYPES),
  role: z.enum(ROLES).nullable().optional(),
  summary: z.string().trim().max(5000).nullable().optional(),
});
const techniquePatch = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  type: z.enum(TECHNIQUE_TYPES).optional(),
  role: z.enum(ROLES).nullable().optional(),
  gi: z.enum(GI).optional(),
  status: z.enum(STATUSES).optional(),
  summary: z.string().trim().max(5000).nullable().optional(),
  aliases: strList.optional(),
  keyDetails: strList.optional(),
  mistakes: strList.optional(),
  starred: z.boolean().optional(),
});
const edgeCreate = z.object({
  fromPositionId: z.number().int().nullable().optional(),
  fromRole: z.enum(ROLES).nullable().optional(),
  toPositionId: z.number().int().nullable().optional(),
  toRole: z.enum(ROLES).nullable().optional(),
});
const linkCreate = z.object({
  kind: z.enum(LINK_KINDS),
  techniqueId: z.number().int().optional(),
  name: z.string().trim().min(1).max(120).optional(),
  note: z.string().trim().max(500).optional(),
});

export function techniqueRoutes(r: Router, h: Handle): void {
  const loadTechnique = async (ctx: Ctx, techniqueId: number): Promise<TechniqueView> => {
    const t = await techniqueView(ctx.db, techniqueId, 50);
    if (!t) throw new NotFound(`No technique #${techniqueId}.`);
    return t;
  };
  // Techniques
  r.get(
    '/api/v1/techniques',
    h(async (ctx, req): Promise<TechniqueListItem[]> => {
      const qs = z
        .object({
          q: z.string().max(200).optional(),
          type: z.enum(TECHNIQUE_TYPES).optional(),
          role: z.enum(ROLES).optional(),
          status: z.enum(STATUSES).optional(),
          position: id.optional(),
          sort: z.enum(['name', 'recent', 'new']).optional(),
          newSince: date.optional(),
          starred: z.enum(['1', '0']).optional(),
          limit: z.coerce.number().int().min(1).max(500).optional(),
        })
        .parse(req.query);
      const f = { ...qs, positionId: qs.position, starred: qs.starred === undefined ? undefined : qs.starred === '1' };
      // Typing a phrase (three words or more) also finds cards by what they're about.
      return f.q?.trim() ? searchTechniques(ctx, { ...f, q: f.q }, 'phrase') : techniqueList(ctx.db, f);
    }),
  );
  r.post(
    '/api/v1/techniques',
    h(async (ctx, req, res): Promise<TechniqueView> => {
      const b = techniqueCreate.parse(req.body);
      const exists = (
        await ctx.db.query<{ id: number }>('select id from techniques where lower(name) = lower($1) and user_id = $2', [b.name, uid(ctx.db)])
      ).rows[0];
      if (exists) {
        res.status(409).json({ error: 'exists', message: `${b.name} already exists.`, id: exists.id });
        return undefined as never;
      }
      const saved = await saveTechniqueResult(ctx, { name: b.name, type: b.type, role: b.role, summary: b.summary });
      if (!saved.id) throw new UserError(saved.message);
      res.status(201);
      return loadTechnique(ctx, saved.id);
    }),
  );
  r.get('/api/v1/techniques/:id', h(async (ctx, req): Promise<TechniqueView> => loadTechnique(ctx, id.parse(req.params.id))));
  r.patch(
    '/api/v1/techniques/:id',
    h(async (ctx, req): Promise<TechniqueView> => {
      const techniqueId = id.parse(req.params.id);
      const b = techniquePatch.parse(req.body);
      const saved = await saveTechniqueResult(ctx, {
        id: techniqueId,
        rename_to: b.name,
        type: b.type,
        role: b.role,
        gi: b.gi,
        status: b.status,
        summary: b.summary,
        aliases: b.aliases,
        replace_aliases: b.aliases !== undefined,
        key_details: b.keyDetails,
        mistakes: b.mistakes,
        replace_lists: b.keyDetails !== undefined || b.mistakes !== undefined,
        starred: b.starred,
      });
      if (!saved.id) throw new NotFound(saved.message);
      return loadTechnique(ctx, techniqueId);
    }),
  );
  r.delete(
    '/api/v1/techniques/:id',
    h(async (ctx, req): Promise<MessageResult> => ({ message: await deleteTechnique(ctx, id.parse(req.params.id)) })),
  );
  r.post(
    '/api/v1/techniques/delete',
    h(async (ctx, req): Promise<MessageResult> => ({ message: await deleteTechniques(ctx, idList.parse(req.body).ids) })),
  );
  r.post(
    '/api/v1/techniques/:id/edges',
    h(async (ctx, req): Promise<TechniqueView> => {
      const techniqueId = id.parse(req.params.id);
      const b = edgeCreate.parse(req.body);
      if (!b.fromPositionId && !b.toPositionId) throw new UserError('Pick a starting or ending position.');
      await saveTechniqueResult(ctx, {
        id: techniqueId,
        positions: [
          {
            from_id: b.fromPositionId ?? undefined,
            from_role: b.fromRole ?? undefined,
            to_id: b.toPositionId ?? undefined,
            to_role: b.toRole ?? undefined,
          },
        ],
      });
      return loadTechnique(ctx, techniqueId);
    }),
  );
  r.delete(
    '/api/v1/techniques/:id/edges/:edgeId',
    h(async (ctx, req): Promise<TechniqueView> => {
      const techniqueId = id.parse(req.params.id);
      await removeEdge(ctx, techniqueId, id.parse(req.params.edgeId));
      return loadTechnique(ctx, techniqueId);
    }),
  );
  r.post(
    '/api/v1/techniques/:id/links',
    h(async (ctx, req): Promise<TechniqueView> => {
      const techniqueId = id.parse(req.params.id);
      const b = linkCreate.parse(req.body);
      if (b.techniqueId === undefined && !b.name) throw new UserError('Pick a technique to link.');
      await saveTechniqueResult(ctx, {
        id: techniqueId,
        links: [{ kind: b.kind, technique_id: b.techniqueId, technique: b.name, note: b.note }],
      });
      return loadTechnique(ctx, techniqueId);
    }),
  );
  r.delete(
    '/api/v1/techniques/:id/links/:otherId/:kind',
    h(async (ctx, req): Promise<TechniqueView> => {
      const techniqueId = id.parse(req.params.id);
      const otherId = id.parse(req.params.otherId);
      const kind = z.enum(LINK_KINDS).parse(req.params.kind);
      const incoming = req.query.direction === 'in';
      await removeLink(ctx, incoming ? otherId : techniqueId, incoming ? techniqueId : otherId, kind);
      return loadTechnique(ctx, techniqueId);
    }),
  );
}
