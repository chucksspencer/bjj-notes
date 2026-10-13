import express, { type NextFunction, type Request, type RequestHandler, type Response, type Router } from 'express';
import { z } from 'zod';
import type {
  FocusView,
  MessageResult,
  NoteCreateResult,
  NoteView,
  PositionListItem,
  PositionView,
  SessionView,
  TechniqueListItem,
  TechniqueView,
} from '../shared/api.js';
import { undoLast } from '../services/activity.js';
import { NotFoundError as NotFound, UserError } from '../services/errors.js';
import type { Ctx } from '../services/context.js';
import { editFocusItem, updateFocus } from '../services/focus.js';
import { addNote, deleteNote, fileNote, updateNote } from '../services/notes.js';
import { deleteTechnique, removeEdge, removeLink, saveTechniqueResult } from '../services/techniques.js';
import {
  GI,
  LINK_KINDS,
  NOTE_KINDS,
  ROLES,
  SESSION_KINDS,
  SOURCE_KINDS,
  STATUSES,
  TECHNIQUE_TYPES,
} from '../services/vocab.js';
import { sessionList } from '../services/sessions.js';
import { focusView, noteList, noteView, positionList, positionView, techniqueList, techniqueView } from '../services/views.js';

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const id = z.coerce.number().int().positive();
const newTechnique = z.object({ name: z.string().trim().min(1).max(120), type: z.enum(TECHNIQUE_TYPES), role: z.enum(ROLES).optional() });
const strList = z.array(z.string().trim().max(500)).max(100);

const optText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform(v => v || undefined);
const sessionInput = z.object({
  kind: z.enum(SESSION_KINDS),
  name: optText(120),
  instructor: optText(120),
  location: optText(120),
  date: date.optional(),
});
const noteCreate = z.object({
  text: z.string().trim().min(1).max(10_000),
  techniqueIds: z.array(z.number().int()).max(20).optional(),
  newTechniques: z.array(newTechnique).max(10).optional(),
  kind: z.enum(NOTE_KINDS).optional(),
  date: date.optional(),
  source: z
    .object({
      url: z.string().trim().url().max(2000).optional(),
      title: z.string().trim().max(300).optional(),
      author: z.string().trim().max(200).optional(),
      kind: z.enum(SOURCE_KINDS).optional(),
      timestamp: z.string().trim().max(20).optional(),
    })
    .optional(),
  sessionId: z.number().int().nullable().optional(),
  session: sessionInput.optional(),
});
const notePatch = z.object({
  body: z.string().trim().min(1).max(10_000).optional(),
  kind: z.enum(NOTE_KINDS).optional(),
  date: date.optional(),
  techniqueIds: z.array(z.number().int()).max(20).optional(),
  sessionId: z.number().int().nullable().optional(),
  session: sessionInput.optional(),
});
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
const focusCreate = z.object({
  label: z.string().trim().min(1).max(200),
  techniqueIds: z.array(z.number().int()).max(10).optional(),
  position: z.number().int().min(1).optional(),
  goal: z.string().trim().max(300).optional(),
});
const focusActionBody = z.object({
  action: z.enum(['move', 'resume', 'pause', 'backlog', 'complete', 'drop']),
  position: z.number().int().min(1).optional(),
});
const focusPatch = z.object({ label: z.string().trim().min(1).max(200).optional(), goal: z.string().trim().max(300).nullable().optional() });

/** Wraps an async handler so errors reach the error middleware. */
const h =
  <T>(fn: (req: Request, res: Response) => Promise<T>): RequestHandler =>
  (req, res, next) => {
    fn(req, res)
      .then(body => {
        if (!res.headersSent) res.set('Cache-Control', 'no-store').json(body);
      })
      .catch(next);
  };

export function apiRouter(ctx: Ctx, requireAuth: RequestHandler): Router {
  const r = express.Router();
  r.use('/api/v1', requireAuth, express.json({ limit: '256kb' }));

  const loadTechnique = async (techniqueId: number): Promise<TechniqueView> => {
    const t = await techniqueView(ctx.db, techniqueId, 50);
    if (!t) throw new NotFound(`No technique #${techniqueId}.`);
    return t;
  };

  // Focus list
  r.get('/api/v1/focus', h(async (): Promise<FocusView> => focusView(ctx)));
  r.post(
    '/api/v1/focus',
    h(async (req): Promise<MessageResult & { focus: FocusView }> => {
      const b = focusCreate.parse(req.body);
      const message = await updateFocus(ctx, {
        action: 'add',
        item: b.label,
        technique_ids: b.techniqueIds,
        position: b.position,
        goal: b.goal,
      });
      return { message, focus: await focusView(ctx) };
    }),
  );
  r.post(
    '/api/v1/focus/:id/actions',
    h(async (req): Promise<MessageResult & { focus: FocusView }> => {
      const b = focusActionBody.parse(req.body);
      const message = await updateFocus(ctx, { action: b.action, item: '', item_id: id.parse(req.params.id), position: b.position });
      return { message, focus: await focusView(ctx) };
    }),
  );
  r.patch(
    '/api/v1/focus/:id',
    h(async (req): Promise<MessageResult & { focus: FocusView }> => {
      const b = focusPatch.parse(req.body);
      const message = await editFocusItem(ctx, id.parse(req.params.id), b);
      return { message, focus: await focusView(ctx) };
    }),
  );

  // Techniques
  r.get(
    '/api/v1/techniques',
    h(async (req): Promise<TechniqueListItem[]> => {
      const qs = z
        .object({
          q: z.string().max(200).optional(),
          type: z.enum(TECHNIQUE_TYPES).optional(),
          role: z.enum(ROLES).optional(),
          status: z.enum(STATUSES).optional(),
          position: id.optional(),
          sort: z.enum(['name', 'recent']).optional(),
        })
        .parse(req.query);
      return techniqueList(ctx.db, { ...qs, positionId: qs.position });
    }),
  );
  r.post(
    '/api/v1/techniques',
    h(async (req, res): Promise<TechniqueView> => {
      const b = techniqueCreate.parse(req.body);
      const exists = (await ctx.db.query<{ id: number }>('select id from techniques where lower(name) = lower($1)', [b.name])).rows[0];
      if (exists) {
        res.status(409).json({ error: 'exists', message: `${b.name} already exists.`, id: exists.id });
        return undefined as never;
      }
      const saved = await saveTechniqueResult(ctx, { name: b.name, type: b.type, role: b.role, summary: b.summary });
      if (!saved.id) throw new UserError(saved.message);
      res.status(201);
      return loadTechnique(saved.id);
    }),
  );
  r.get('/api/v1/techniques/:id', h(async (req): Promise<TechniqueView> => loadTechnique(id.parse(req.params.id))));
  r.patch(
    '/api/v1/techniques/:id',
    h(async (req): Promise<TechniqueView> => {
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
      });
      if (!saved.id) throw new NotFound(saved.message);
      return loadTechnique(techniqueId);
    }),
  );
  r.delete(
    '/api/v1/techniques/:id',
    h(async (req): Promise<MessageResult> => ({ message: await deleteTechnique(ctx, id.parse(req.params.id)) })),
  );
  r.post(
    '/api/v1/techniques/:id/edges',
    h(async (req): Promise<TechniqueView> => {
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
      return loadTechnique(techniqueId);
    }),
  );
  r.delete(
    '/api/v1/techniques/:id/edges/:edgeId',
    h(async (req): Promise<TechniqueView> => {
      const techniqueId = id.parse(req.params.id);
      await removeEdge(ctx, techniqueId, id.parse(req.params.edgeId));
      return loadTechnique(techniqueId);
    }),
  );
  r.post(
    '/api/v1/techniques/:id/links',
    h(async (req): Promise<TechniqueView> => {
      const techniqueId = id.parse(req.params.id);
      const b = linkCreate.parse(req.body);
      if (b.techniqueId === undefined && !b.name) throw new UserError('Pick a technique to link.');
      await saveTechniqueResult(ctx, {
        id: techniqueId,
        links: [{ kind: b.kind, technique_id: b.techniqueId, technique: b.name, note: b.note }],
      });
      return loadTechnique(techniqueId);
    }),
  );
  r.delete(
    '/api/v1/techniques/:id/links/:otherId/:kind',
    h(async (req): Promise<TechniqueView> => {
      const techniqueId = id.parse(req.params.id);
      const otherId = id.parse(req.params.otherId);
      const kind = z.enum(LINK_KINDS).parse(req.params.kind);
      const incoming = req.query.direction === 'in';
      await removeLink(ctx, incoming ? otherId : techniqueId, incoming ? techniqueId : otherId, kind);
      return loadTechnique(techniqueId);
    }),
  );

  // Notes
  r.get(
    '/api/v1/notes',
    h(async (req): Promise<NoteView[]> => {
      const qs = z
        .object({
          inbox: z.enum(['1', '0']).optional(),
          technique: id.optional(),
          q: z.string().max(200).optional(),
          limit: z.coerce.number().int().min(1).max(200).optional(),
          before: id.optional(),
        })
        .parse(req.query);
      return noteList(ctx.db, {
        inbox: qs.inbox === undefined ? undefined : qs.inbox === '1',
        techniqueId: qs.technique,
        q: qs.q,
        limit: qs.limit,
        beforeId: qs.before,
      });
    }),
  );
  r.post(
    '/api/v1/notes',
    h(async (req, res): Promise<NoteCreateResult> => {
      const b = noteCreate.parse(req.body);
      const result = await addNote(ctx, {
        text: b.text,
        technique_ids: b.techniqueIds,
        new_techniques: b.newTechniques,
        kind: b.kind,
        date: b.date,
        source: b.source,
        session_id: b.sessionId,
        session: b.session,
        via: 'web',
      });
      res.status(201);
      return { message: result.message, note: (await noteView(ctx.db, result.noteId))! };
    }),
  );
  r.patch(
    '/api/v1/notes/:id',
    h(async (req): Promise<NoteView> => {
      const noteId = id.parse(req.params.id);
      const b = notePatch.parse(req.body);
      await updateNote(ctx, noteId, {
        body: b.body,
        kind: b.kind,
        observed_on: b.date,
        technique_ids: b.techniqueIds,
        session_id: b.sessionId,
        session: b.session,
      });
      const note = await noteView(ctx.db, noteId);
      if (!note) throw new NotFound(`No note #${noteId}.`);
      return note;
    }),
  );
  r.post(
    '/api/v1/notes/:id/file',
    h(async (req): Promise<NoteView> => {
      const noteId = id.parse(req.params.id);
      const b = z
        .object({ techniqueIds: z.array(z.number().int()).max(20).optional(), newTechniques: z.array(newTechnique).max(10).optional() })
        .parse(req.body);
      await fileNote(ctx, noteId, [], b.newTechniques ?? [], b.techniqueIds ?? []);
      const note = await noteView(ctx.db, noteId);
      if (!note) throw new NotFound(`No note #${noteId}.`);
      return note;
    }),
  );
  r.delete('/api/v1/notes/:id', h(async (req): Promise<MessageResult> => ({ message: await deleteNote(ctx, id.parse(req.params.id)) })));

  // Sessions: where notes came from
  r.get(
    '/api/v1/sessions',
    h(async (req): Promise<SessionView[]> => {
      const qs = z.object({ limit: z.coerce.number().int().min(1).max(100).optional(), date: date.optional() }).parse(req.query);
      return sessionList(ctx.db, { limit: qs.limit ?? 12, date: qs.date });
    }),
  );

  // Positions
  r.get('/api/v1/positions', h(async (): Promise<PositionListItem[]> => positionList(ctx.db)));
  r.get(
    '/api/v1/positions/:slug',
    h(async (req): Promise<PositionView> => {
      const role = z.enum(ROLES).optional().parse(req.query.role || undefined);
      const pos = (await ctx.db.query<{ id: number }>('select id from positions where slug = $1', [String(req.params.slug)])).rows[0];
      if (!pos) throw new NotFound('No such position.');
      return (await positionView(ctx.db, pos.id, role))!;
    }),
  );

  // Undo
  r.post('/api/v1/undo', h(async (): Promise<MessageResult> => ({ message: await undoLast(ctx.db) })));

  r.use('/api/v1', (_req, res) => {
    res.status(404).json({ error: 'not_found', message: 'No such endpoint.' });
  });

  // Errors: validation and service messages are the caller's to fix; anything else is ours.
  r.use('/api/v1', (err: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) return next(err);
    if (err instanceof z.ZodError) {
      res.status(400).json({ error: 'invalid', message: err.issues.map(i => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ') });
    } else if (err instanceof NotFound) {
      res.status(404).json({ error: 'not_found', message: err.message });
    } else if (err instanceof UserError) {
      res.status(400).json({ error: 'rejected', message: err.message });
    } else if ((err as { type?: string }).type === 'entity.parse.failed') {
      res.status(400).json({ error: 'invalid_json', message: 'Request body is not valid JSON.' });
    } else {
      console.error('api error', err);
      res.status(500).json({ error: 'server', message: 'Something went wrong on the server.' });
    }
  });

  return r;
}
