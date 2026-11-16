import express, { type NextFunction, type Request, type RequestHandler, type Response, type Router } from 'express';
import { z } from 'zod';
import type {
  GamePlanDetail,
  GamePlansView,
  AttachmentView,
  GamePlanDraft,
  GamePlanSpeech,
  FocusView,
  LabView,
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
import { ForbiddenError as Forbidden, NotFoundError as NotFound, UserError } from '../services/errors.js';
import { userCtx, type Ctx } from '../services/context.js';
import { uid } from '../db.js';
import { userIdOf } from './auth.js';
import { createGamePlan, deleteGamePlan, editGamePlan, gamePlanSpeech, linkGamePlan, MAX_DEPTH, MAX_STEPS, moveStep, updateFocus } from '../services/gamePlans.js';
import { draftGamePlan } from '../services/gamePlanDrafts.js';
import { attachmentThumb, linkAttachment } from '../services/attachments.js';
import { clearStars, markAnswered } from '../services/marks.js';
import { addNote, deleteNote, deleteNotes, fileNote, updateNote } from '../services/notes.js';
import { deleteTechnique, deleteTechniques, removeEdge, removeLink, saveTechniqueResult } from '../services/techniques.js';
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
import { searchNotes, searchTechniques } from '../services/semantic.js';
import { gamePlansView, gamePlanView, focusView, labView, noteList, noteView, positionList, positionView, techniqueList, techniqueView } from '../services/views.js';

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const id = z.coerce.number().int().positive();
const newTechnique = z.object({ name: z.string().trim().min(1).max(120), type: z.enum(TECHNIQUE_TYPES), role: z.enum(ROLES).optional() });
const strList = z.array(z.string().trim().max(500)).max(100);
/** A selection to act on at once. */
const idList = z.object({ ids: z.array(z.number().int().positive()).min(1).max(500) });

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
  toTry: z.boolean().optional(),
  starred: z.boolean().optional(),
  gamePlanIds: z.array(z.number().int()).max(20).optional(),
});
const notePatch = z.object({
  body: z.string().trim().min(1).max(10_000).optional(),
  kind: z.enum(NOTE_KINDS).optional(),
  date: date.optional(),
  techniqueIds: z.array(z.number().int()).max(20).optional(),
  sessionId: z.number().int().nullable().optional(),
  session: sessionInput.optional(),
  toTry: z.boolean().optional(),
  starred: z.boolean().optional(),
  answered: z.boolean().optional(),
  newTechniques: z.array(newTechnique).max(10).optional(),
  gamePlanIds: z.array(z.number().int()).max(20).optional(),
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
const gamePlanDescription = z.string().trim().max(4000);
const gamePlanName = z.string().trim().min(1).max(200);
const gamePlanCreate = z.object({
  name: gamePlanName,
  description: gamePlanDescription.optional(),
  techniqueIds: z.array(z.number().int()).max(10).optional(),
  noteIds: z.array(z.number().int()).max(50).optional(),
  focus: z.boolean().optional(),
  position: z.number().int().min(1).optional(),
});
const focusActionBody = z.object({
  // resume, pause, backlog, complete and drop are the older names (resume = add; the rest = remove).
  action: z.enum(['add', 'move', 'remove', 'resume', 'pause', 'backlog', 'complete', 'drop']),
  position: z.number().int().min(1).optional(),
});
const optLine = (max: number) => z.string().trim().max(max).nullable().optional();
const gamePlanStep = z.object({
  depth: z.number().int().min(0).max(MAX_DEPTH),
  or: z.boolean().optional(),
  trigger: optLine(300),
  action: z.string().trim().min(1).max(300),
  techniqueId: z.number().int().nullable().optional(),
  toPositionId: z.number().int().nullable().optional(),
  toRole: z.enum(ROLES).nullable().optional(),
  note: optLine(1000),
});
const gamePlanPatch = z.object({
  name: gamePlanName.optional(),
  description: gamePlanDescription.nullable().optional(),
  aliases: strList.optional(),
  startPositionId: z.number().int().nullable().optional(),
  startRole: z.enum(ROLES).nullable().optional(),
  premise: optLine(1000),
  steps: z.array(gamePlanStep).max(MAX_STEPS).optional(),
});
const stepMove = z
  .object({
    to: z.enum(['up', 'down', 'first', 'last']).optional(),
    before: z.number().int().optional(),
    after: z.number().int().optional(),
    within: z.literal('choice').optional(),
  })
  .refine(m => [m.to, m.before, m.after].filter(v => v !== undefined).length === 1, {
    message: 'Say where to move it: to (up, down, first or last), before, or after.',
  })
  .refine(m => m.within === undefined || m.to !== undefined, { message: 'Among its alternatives, a step moves up, down, first or last.' });
const linkIds = z.object({
  techniqueIds: z.array(z.number().int()).max(50).optional(),
  noteIds: z.array(z.number().int()).max(200).optional(),
});
const gamePlanLinks = z.object({ add: linkIds.optional(), remove: linkIds.optional() });

/**
 * Wraps an async handler: it gets the signed-in user's context (set up by requireAuth), its result is sent
 * as JSON, and errors reach the error middleware.
 */
export const handler =
  (base: Ctx) =>
  <T>(fn: (ctx: Ctx, req: Request, res: Response) => Promise<T>): RequestHandler =>
  (req, res, next) => {
    Promise.resolve()
      .then(() => fn(userCtx(base, userIdOf(res)), req, res))
      .then(body => {
        if (!res.headersSent) res.set('Cache-Control', 'no-store').json(body);
      })
      .catch(next);
  };

export function apiRouter(base: Ctx, requireAuth: RequestHandler): Router {
  const r = express.Router();
  const h = handler(base);
  r.use('/api/v1', requireAuth, express.json({ limit: '256kb' }));

  const loadTechnique = async (ctx: Ctx, techniqueId: number): Promise<TechniqueView> => {
    const t = await techniqueView(ctx.db, techniqueId, 50);
    if (!t) throw new NotFound(`No technique #${techniqueId}.`);
    return t;
  };

  const loadGamePlan = async (ctx: Ctx, gamePlanId: number): Promise<GamePlanDetail> => {
    const gamePlan = await gamePlanView(ctx.db, gamePlanId);
    if (!gamePlan) throw new NotFound(`No game plan #${gamePlanId}.`);
    return gamePlan;
  };

  // The focus list: game plans being worked on now, in order
  r.get('/api/v1/focus', h(async (ctx): Promise<FocusView> => focusView(ctx)));
  r.post(
    '/api/v1/focus/:id/actions',
    h(async (ctx, req): Promise<MessageResult & { focus: FocusView }> => {
      const b = focusActionBody.parse(req.body);
      const gamePlanId = id.parse(req.params.id);
      await loadGamePlan(ctx, gamePlanId);
      const message = await updateFocus(ctx, { action: b.action, item: '', game_plan_id: gamePlanId, position: b.position });
      return { message, focus: await focusView(ctx) };
    }),
  );

  // Game plans: parts of the game, with their steps
  r.get('/api/v1/game-plans', h(async (ctx): Promise<GamePlansView> => gamePlansView(ctx)));
  // One read aloud, for Siri ("what's my game plan from bottom half"). Before /:id, which would take "speech" for an id.
  const speechQuery = z.object({ q: z.string().trim().max(200) });
  r.get(
    '/api/v1/game-plans/speech',
    h(async (ctx, req): Promise<GamePlanSpeech> => gamePlanSpeech(ctx, speechQuery.parse(req.query).q)),
  );
  r.post(
    '/api/v1/game-plans',
    h(async (ctx, req, res): Promise<MessageResult & { gamePlan: GamePlanDetail }> => {
      const b = gamePlanCreate.parse(req.body);
      const out = await createGamePlan(ctx, b);
      res.status(201);
      return { message: out.message, gamePlan: await loadGamePlan(ctx, out.id) };
    }),
  );
  r.get('/api/v1/game-plans/:id', h(async (ctx, req): Promise<GamePlanDetail> => loadGamePlan(ctx, id.parse(req.params.id))));
  r.patch(
    '/api/v1/game-plans/:id',
    h(async (ctx, req): Promise<MessageResult & { gamePlan: GamePlanDetail }> => {
      const gamePlanId = id.parse(req.params.id);
      const b = gamePlanPatch.parse(req.body);
      await loadGamePlan(ctx, gamePlanId);
      const message = await editGamePlan(ctx, gamePlanId, b);
      return { message, gamePlan: await loadGamePlan(ctx, gamePlanId) };
    }),
  );
  r.delete(
    '/api/v1/game-plans/:id',
    h(async (ctx, req): Promise<MessageResult> => {
      const gamePlanId = id.parse(req.params.id);
      await loadGamePlan(ctx, gamePlanId);
      return { message: await deleteGamePlan(ctx, { id: gamePlanId }) };
    }),
  );
  r.post(
    '/api/v1/game-plans/:id/links',
    h(async (ctx, req): Promise<MessageResult & { gamePlan: GamePlanDetail }> => {
      const gamePlanId = id.parse(req.params.id);
      const b = gamePlanLinks.parse(req.body);
      await loadGamePlan(ctx, gamePlanId);
      const message = await linkGamePlan(ctx, gamePlanId, b);
      return { message, gamePlan: await loadGamePlan(ctx, gamePlanId) };
    }),
  );

  r.post(
    '/api/v1/game-plans/:id/steps/:stepId/move',
    h(async (ctx, req): Promise<MessageResult & { gamePlan: GamePlanDetail }> => {
      const gamePlanId = id.parse(req.params.id);
      const stepId = id.parse(req.params.stepId);
      const b = stepMove.parse(req.body);
      await loadGamePlan(ctx, gamePlanId);
      const message = await moveStep(ctx, gamePlanId, stepId, b);
      return { message, gamePlan: await loadGamePlan(ctx, gamePlanId) };
    }),
  );

  // "Describe it": Claude outlines a game plan from plain words; nothing is saved until the outline is.
  r.post(
    '/api/v1/game-plans/draft',
    h(async (ctx, req): Promise<GamePlanDraft> => draftGamePlan(ctx, z.object({ text: z.string().trim().min(1).max(5000) }).parse(req.body).text)),
  );

  // ---------- legacy routes ----------
  // For iPhone app builds from before game plans had that name (1.1 and older). Remove once everyone's on a
  // newer TestFlight build (docs/operations.md, "Legacy routes").
  r.get(
    '/api/v1/plan',
    h(async (ctx, req) => {
      const out = await gamePlanSpeech(ctx, speechQuery.parse(req.query).q);
      return { ...out, areaId: out.gamePlanId };
    }),
  );

  // Photos and videos: the still image, and recording where the original is in Photos
  r.get('/api/v1/attachments/:id/thumb', async (req, res, next) => {
    try {
      const ctx = userCtx(base, userIdOf(res));
      const thumb = await attachmentThumb(ctx.db, id.parse(req.params.id));
      if (!thumb) throw new NotFound('No such photo or video.');
      res.type('image/jpeg').set('Cache-Control', 'private, max-age=31536000, immutable').send(thumb);
    } catch (err) {
      next(err);
    }
  });
  r.patch(
    '/api/v1/attachments/:id',
    h(async (ctx, req): Promise<AttachmentView> => {
      const b = z
        .object({ photosLocalId: z.string().trim().min(1).max(300).optional(), photosCloudId: z.string().trim().min(1).max(600).optional() })
        .parse(req.body);
      return linkAttachment(ctx, id.parse(req.params.id), b);
    }),
  );

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

  // Notes
  r.get(
    '/api/v1/notes',
    h(async (ctx, req): Promise<NoteView[]> => {
      const qs = z
        .object({
          inbox: z.enum(['1', '0']).optional(),
          toTry: z.enum(['1', '0']).optional(),
          starred: z.enum(['1', '0']).optional(),
          kind: z.enum(NOTE_KINDS).optional(),
          technique: id.optional(),
          q: z.string().max(200).optional(),
          limit: z.coerce.number().int().min(1).max(200).optional(),
          before: id.optional(),
        })
        .parse(req.query);
      const f = {
        inbox: qs.inbox === undefined ? undefined : qs.inbox === '1',
        toTry: qs.toTry === undefined ? undefined : qs.toTry === '1',
        starred: qs.starred === undefined ? undefined : qs.starred === '1',
        kind: qs.kind,
        techniqueId: qs.technique,
        q: qs.q,
        limit: qs.limit,
        beforeId: qs.before,
      };
      return f.q?.trim() ? searchNotes(ctx, { ...f, q: f.q }, 'phrase') : noteList(ctx.db, f);
    }),
  );
  r.post(
    '/api/v1/notes',
    h(async (ctx, req, res): Promise<NoteCreateResult> => {
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
        to_try: b.toTry,
        starred: b.starred,
        game_plan_ids: b.gamePlanIds,
        via: 'web',
      });
      res.status(201);
      return { message: result.message, note: (await noteView(ctx.db, result.noteId))! };
    }),
  );
  r.patch(
    '/api/v1/notes/:id',
    h(async (ctx, req): Promise<NoteView> => {
      const noteId = id.parse(req.params.id);
      const b = notePatch.parse(req.body);
      await updateNote(ctx, noteId, {
        body: b.body,
        kind: b.kind,
        observed_on: b.date,
        technique_ids: b.techniqueIds,
        session_id: b.sessionId,
        session: b.session,
        to_try: b.toTry,
        starred: b.starred,
        answered: b.answered,
        new_techniques: b.newTechniques,
        game_plan_ids: b.gamePlanIds,
      });
      const note = await noteView(ctx.db, noteId);
      if (!note) throw new NotFound(`No note #${noteId}.`);
      return note;
    }),
  );
  r.post(
    '/api/v1/notes/:id/file',
    h(async (ctx, req): Promise<NoteView> => {
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
  r.post(
    '/api/v1/notes/answered',
    h(async (ctx, req): Promise<MessageResult> => ({ message: await markAnswered(ctx, idList.parse(req.body).ids) })),
  );
  r.post(
    '/api/v1/notes/delete',
    h(async (ctx, req): Promise<MessageResult> => ({ message: await deleteNotes(ctx, idList.parse(req.body).ids) })),
  );
  r.delete('/api/v1/notes/:id', h(async (ctx, req): Promise<MessageResult> => ({ message: await deleteNote(ctx, id.parse(req.params.id)) })));

  // Sessions: where notes came from
  r.get(
    '/api/v1/sessions',
    h(async (ctx, req): Promise<SessionView[]> => {
      const qs = z.object({ limit: z.coerce.number().int().min(1).max(100).optional(), date: date.optional() }).parse(req.query);
      return sessionList(ctx.db, { limit: qs.limit ?? 12, date: qs.date });
    }),
  );

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

  // Undo
  r.post('/api/v1/undo', h(async (ctx): Promise<MessageResult> => ({ message: await undoLast(ctx.db) })));

  r.use('/api/v1', (_req, res) => {
    res.status(404).json({ error: 'not_found', message: 'No such endpoint.' });
  });

  r.use('/api/v1', apiErrors);
  return r;
}

/** Errors: validation and service messages are the caller's to fix; anything else is ours. */
export function apiErrors(err: unknown, _req: Request, res: Response, next: NextFunction) {
  if (res.headersSent) return next(err);
  if (err instanceof z.ZodError) {
    res.status(400).json({ error: 'invalid', message: err.issues.map(i => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ') });
  } else if (err instanceof Forbidden) {
    res.status(403).json({ error: 'forbidden', message: err.message });
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
}
