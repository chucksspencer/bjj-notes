// "Describe it": Claude turns a game plan said in plain words ("from bottom side, if they have the underhook and
// crossface, John Wayne sweep to make them post...") into an outline the person checks before saving.
import Anthropic from '@anthropic-ai/sdk';
import type { Config } from '../config.js';
import { uid } from '../db.js';
import { resolvePosition } from '../resolve.js';
import type { GamePlanDraft, Role } from '../shared/api.js';
import { MAX_DEPTH, MAX_STEPS, resolveStepNames, type NamedStepInput } from './gamePlans.js';
import type { Ctx } from './context.js';
import { UserError } from './errors.js';
import { ROLES } from './vocab.js';

/** What Claude makes of a described game plan, before names are matched to cards and positions. */
export interface DraftedGamePlan {
  start?: string;
  start_role?: Role;
  premise?: string;
  steps: NamedStepInput[];
}

export type GamePlanDrafter = (text: string, known: { techniques: string[]; positions: string[] }) => Promise<DraftedGamePlan>;

const GAME_PLAN_TOOL = {
  name: 'outline_game_plan',
  description: 'Write down a jiu-jitsu game plan (a "system") as an outline of steps with branches.',
  input_schema: {
    type: 'object' as const,
    properties: {
      start: { type: 'string', description: 'The position the game plan starts from, from the known positions list.' },
      start_role: { type: 'string', enum: [...ROLES], description: 'Whose side the game plan is for: top or bottom.' },
      premise: {
        type: 'string',
        description: 'The situation it is for, if one is given, e.g. "top has the underhook and crossface". Short.',
      },
      steps: {
        type: 'array',
        description:
          'Every step in reading order. The main line is depth 0, in order. A branch (what to do if the opponent ' +
          'reacts a certain way) goes right after the step it follows, one level deeper, with "when" saying the reaction. ' +
          'An alternative ("do X, or Y"; "plan B is...") goes after the step it is an alternative to (and that step\'s own ' +
          'branches), at the same depth, with "or": true; the preferred one comes first. A step and its alternatives are ' +
          'branches side by side: what to do after each ("X, then W, or Y, then Z") goes right after it, one level deeper. ' +
          'A step after them at the same depth follows whichever was used.',
        items: {
          type: 'object',
          properties: {
            depth: { type: 'integer', minimum: 0, maximum: MAX_DEPTH },
            or: {
              type: 'boolean',
              description:
                'True when this is an alternative to the nearest step above it at the same depth. Leave out "when". What follows it goes one level deeper.',
            },
            when: { type: 'string', description: 'The reaction that leads to this step, e.g. "they post the far leg". Leave out for "then".' },
            do: { type: 'string', description: 'What to do, in their words, e.g. "shuck pass", "go to deep half", "octopus sweeps".' },
            technique: { type: 'string', description: 'The known technique this step is, spelled exactly as listed. Leave out if none clearly is.' },
            to: { type: 'string', description: 'The position this step leaves you in, if it is a different position.' },
            to_role: { type: 'string', enum: [...ROLES] },
            note: { type: 'string', description: 'The intent or a cue, if one is given, e.g. "to make them post the underhook hand".' },
          },
          required: ['depth', 'do'],
        },
      },
    },
    required: ['steps'],
  },
};

/** Asks Claude (via the Messages API) to outline a described game plan. */
export function claudeGamePlanDrafter(apiKey: string, model: string, opts: { baseURL?: string; timeoutMs?: number } = {}): GamePlanDrafter {
  const client = new Anthropic({ apiKey, baseURL: opts.baseURL, timeout: opts.timeoutMs ?? 30_000, maxRetries: 1 });
  return async (text, known) => {
    const msg = await client.messages.create({
      model,
      max_tokens: 2000,
      system:
        'You write down Brazilian jiu-jitsu game plans ("systems"): where they start, a main line of steps, and branches for ' +
        'how the opponent reacts, and alternatives (plan A, plan B) where they give more than one option. The description may be dictated, so names can be misheard ("barra toe plata" is ' +
        'Baratoplata). Keep the person\'s own words for steps; use known technique and position names where they ' +
        'clearly match. Leave out nothing they said, and add nothing they did not.\n\n' +
        `Known techniques: ${known.techniques.join('; ') || '(none yet)'}\n` +
        `Known positions: ${known.positions.join('; ')}`,
      tools: [GAME_PLAN_TOOL],
      tool_choice: { type: 'tool', name: GAME_PLAN_TOOL.name },
      messages: [{ role: 'user', content: text }],
    });
    const block = msg.content.find(b => b.type === 'tool_use');
    if (!block || block.type !== 'tool_use') throw new Error('Claude sent no outline.');
    return block.input as DraftedGamePlan;
  };
}

/** The drafter the config asks for: on whenever there's an Anthropic key (it uses the capture model). */
export function drafterFor(config: Config): GamePlanDrafter | null {
  if (!config.anthropicApiKey) return null;
  return claudeGamePlanDrafter(config.anthropicApiKey, config.captureModel, { baseURL: config.anthropicBaseUrl });
}

const isRole = (r: unknown): r is Role => typeof r === 'string' && (ROLES as readonly string[]).includes(r);

/**
 * Turns a described game plan into an outline to check and save, with cards and positions matched. Nothing is saved.
 * Steps Claude nested too deeply are pulled up so the outline is always valid.
 */
export async function draftGamePlan(ctx: Ctx, text: string): Promise<GamePlanDraft> {
  if (!ctx.gamePlanDrafter) throw new UserError("Describing a game plan needs Claude, and this server isn't set up with an Anthropic key.");
  const q = ctx.db;
  const techniques = (
    await q.query<{ name: string; aliases: string[] }>('select name, aliases from techniques where user_id = $1 order by name', [uid(q)])
  ).rows.map(r => (r.aliases.length ? `${r.name} (also: ${r.aliases.join(', ')})` : r.name));
  const positions = (await q.query<{ name: string }>('select name from positions order by name')).rows.map(r => r.name);
  let drafted: DraftedGamePlan;
  try {
    drafted = await ctx.gamePlanDrafter(text, { techniques, positions });
  } catch (err) {
    throw new UserError(`Couldn't outline that: ${(err as Error).message}`);
  }

  const raw = Array.isArray(drafted.steps) ? drafted.steps.filter(s => s && typeof s.do === 'string' && s.do.trim()) : [];
  let prev = -1;
  const has: boolean[] = [];
  const steps: NamedStepInput[] = raw.slice(0, MAX_STEPS).map(s => {
    const depth = Math.min(Math.max(0, Math.round(Number(s.depth) || 0)), prev + 1, MAX_DEPTH);
    prev = depth;
    // An "or" with nothing before it to be an alternative to is just a step.
    const or = s.or === true && has[depth] === true;
    has[depth] = true;
    has.length = depth + 1;
    return {
      depth,
      or,
      do: s.do.trim(),
      technique: typeof s.technique === 'string' && s.technique.trim() ? s.technique : undefined,
      when: typeof s.when === 'string' && !or ? s.when : undefined,
      to: typeof s.to === 'string' ? s.to : undefined,
      to_role: isRole(s.to_role) ? s.to_role : undefined,
      note: typeof s.note === 'string' ? s.note : undefined,
    };
  });
  const misses: string[] = [];
  const resolved = await resolveStepNames(q, steps, misses);

  const techniqueNames = new Map<number, string>();
  const positionNames = new Map<number, string>();
  const tIds = resolved.map(s => s.technique_id).filter((t): t is number => t !== null);
  if (tIds.length) {
    for (const r of (await q.query<{ id: number; name: string }>('select id, name from techniques where id = any($1::int[]) and user_id = $2', [tIds, uid(q)])).rows) {
      techniqueNames.set(r.id, r.name);
    }
  }
  let startPositionId: number | null = null;
  if (drafted.start?.trim()) {
    const r = await resolvePosition(q, drafted.start);
    if (r.match) startPositionId = r.match.id;
  }
  const pIds = [...resolved.map(s => s.to_position_id), startPositionId].filter((p): p is number => p !== null);
  if (pIds.length) {
    for (const r of (await q.query<{ id: number; name: string }>('select id, name from positions where id = any($1::int[])', [pIds])).rows) {
      positionNames.set(r.id, r.name);
    }
  }
  return {
    start: startPositionId ? { id: startPositionId, name: positionNames.get(startPositionId)! } : null,
    startRole: isRole(drafted.start_role) ? drafted.start_role : null,
    premise: drafted.premise?.trim() || null,
    steps: resolved.map(s => ({
      depth: s.depth,
      or: s.alt,
      trigger: s.trigger,
      action: s.action,
      techniqueId: s.technique_id,
      techniqueName: s.technique_id ? techniqueNames.get(s.technique_id)! : null,
      toPositionId: s.to_position_id,
      toName: s.to_position_id ? positionNames.get(s.to_position_id)! : null,
      toRole: s.to_role,
      note: s.note,
    })),
  };
}
