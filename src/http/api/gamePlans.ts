// Routes for the focus list, game plans, their steps, and "Describe it".
import type { Router } from 'express';
import { z } from 'zod';
import type { FocusView, GamePlanDetail, GamePlanDraft, GamePlanSpeech, GamePlansView, MessageResult } from '../../shared/api.js';
import { NotFoundError as NotFound } from '../../services/errors.js';
import type { Ctx } from '../../services/context.js';
import { updateFocus } from '../../services/focus.js';
import { createGamePlan, deleteGamePlan, editGamePlan, linkGamePlan } from '../../services/gamePlans.js';
import { addStep, deleteStep, gamePlanSpeech, moveStep, updateStep } from '../../services/steps.js';
import { MAX_DEPTH, MAX_STEPS } from '../../shared/steps.js';
import { draftGamePlan } from '../../services/gamePlanDrafts.js';
import { FOCUS_ACTIONS, ROLES } from '../../services/vocab.js';
import { gamePlansView, gamePlanView, focusView } from '../../services/views/gamePlans.js';
import { id, optLine, strList } from './schemas.js';
import type { Handle } from '../handler.js';

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
  action: z.enum(FOCUS_ACTIONS),
  position: z.number().int().min(1).optional(),
});
/** The game plan's updatedAt as the caller last saw it: the write is refused (409) if it has changed since. */
const expectedUpdatedAt = z.string().max(64).optional();
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
  expectedUpdatedAt,
});
const stepFields = {
  techniqueId: z.number().int().nullable().optional(),
  toPositionId: z.number().int().nullable().optional(),
  toRole: z.enum(ROLES).nullable().optional(),
  note: optLine(1000),
  expectedUpdatedAt,
};
const stepAction = z.string().trim().min(1).max(300);
const stepAdd = z.object({
  relation: z.enum(['then', 'if', 'or']),
  of: z.number().int().positive().optional(),
  trigger: optLine(300),
  action: stepAction,
  ...stepFields,
});
const stepPatch = z.object({ trigger: optLine(300), action: stepAction.optional(), ...stepFields });
const stepMove = z
  .object({
    to: z.enum(['up', 'down', 'first', 'last']).optional(),
    before: z.number().int().optional(),
    after: z.number().int().optional(),
    within: z.literal('choice').optional(),
    expectedUpdatedAt,
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

export function gamePlanRoutes(r: Router, h: Handle): void {
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

  // One step at a time: every other step keeps its id, and each change is one undo.
  r.post(
    '/api/v1/game-plans/:id/steps',
    h(async (ctx, req, res): Promise<MessageResult & { gamePlan: GamePlanDetail; stepId: number }> => {
      const gamePlanId = id.parse(req.params.id);
      const b = stepAdd.parse(req.body);
      const out = await addStep(ctx, gamePlanId, b);
      res.status(201);
      return { ...out, gamePlan: await loadGamePlan(ctx, gamePlanId) };
    }),
  );
  r.patch(
    '/api/v1/game-plans/:id/steps/:stepId',
    h(async (ctx, req): Promise<MessageResult & { gamePlan: GamePlanDetail }> => {
      const gamePlanId = id.parse(req.params.id);
      const message = await updateStep(ctx, gamePlanId, id.parse(req.params.stepId), stepPatch.parse(req.body));
      return { message, gamePlan: await loadGamePlan(ctx, gamePlanId) };
    }),
  );
  r.delete(
    '/api/v1/game-plans/:id/steps/:stepId',
    h(async (ctx, req): Promise<MessageResult & { gamePlan: GamePlanDetail }> => {
      const gamePlanId = id.parse(req.params.id);
      // What the caller last saw, in the body or (for clients that send no body with DELETE) the query.
      const expected = z.object({ expectedUpdatedAt }).parse({ ...req.query, ...(req.body as object | undefined) }).expectedUpdatedAt;
      const message = await deleteStep(ctx, gamePlanId, id.parse(req.params.stepId), expected);
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
}
