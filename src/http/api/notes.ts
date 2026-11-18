// Routes for notes, the photos and videos on them, and the sessions they came from.
import type { Router } from 'express';
import { z } from 'zod';
import type { AttachmentView, MessageResult, NoteCreateResult, NoteView, SessionView } from '../../shared/api.js';
import { NotFoundError as NotFound } from '../../services/errors.js';
import { userCtx, type Ctx } from '../../services/context.js';
import { userIdOf } from '../auth.js';
import { attachmentThumb, linkAttachment } from '../../services/attachments.js';
import { markAnswered } from '../../services/marks.js';
import { addNote, deleteNote, deleteNotes, fileNote, updateNote } from '../../services/notes.js';
import { NOTE_KINDS, SESSION_KINDS, SOURCE_KINDS } from '../../services/vocab.js';
import { sessionList } from '../../services/sessions.js';
import { searchNotes } from '../../services/semantic.js';
import { noteList, noteView } from '../../services/views/notes.js';
import { date, id, idList, newTechnique } from './schemas.js';
import type { Handle } from '../handler.js';

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

export function noteRoutes(r: Router, h: Handle, base: Ctx): void {
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
}
