import { createContext, Fragment, useContext, useState } from 'react';
import { Link } from 'react-router';
import type { GamePlanDetail, GamePlanDraft, GamePlanRef, GamePlanSlot, GamePlanStepInput, PositionRef, Role, StepMove, TechniqueRef } from '../../../src/shared/api';
import { countSteps, findStep, fromOutline, toOutline, type Option, type Slot } from '../../../src/shared/steps';
import { useAddStep, useDeleteStep, useDraftGamePlan, useEditGamePlan, useGamePlanFetching, useMoveStep, usePositions, useUpdateStep } from '../api';
import { CATEGORY_LABEL, CATEGORY_ORDER, ROLE_LABEL, ROLES } from '../lib/format';
import { RankBar } from './Belt';
import { Icon } from './Icon';
import { Sheet } from './Sheet';
import { TechniquePicker } from './TechniquePicker';
import { useToast } from './Toast';

// ---------- the steps as a tree of slots (see src/shared/steps.ts) ----------

/** A step's own fields in the step sheet, and in a drafted outline: what's stored, plus names to show. */
export interface StepForm {
  action: string;
  technique: TechniqueRef | null;
  toPositionId: number | null;
  toName: string | null;
  toRole: Role | null;
  note: string | null;
}

/** One step of a drafted outline: nothing is saved yet, so it has no id. */
export type DraftStep = Option<StepForm>;

/** A step the outline draws: a saved one (`GamePlanStep`), or one of a draft (`DraftStep`). */
interface AnyStep {
  id?: number;
  option: number;
  action: string;
  technique: TechniqueRef | null;
  note: string | null;
  toRole: Role | null;
  slots: Slot<AnyStep>[];
  /** Saved steps: where it leaves you, and the game plans that start there. */
  to?: PositionRef | null;
  continuesIn?: GamePlanRef[];
  /** Drafted steps: the name of where it leaves you. */
  toName?: string | null;
}

/** A drafted outline (flat, with depths) as a tree. */
export const fromDraft = (draft: GamePlanDraft): Slot<DraftStep>[] =>
  fromOutline(draft.steps, s => ({
    action: s.action,
    technique: s.techniqueId && s.techniqueName ? ({ id: s.techniqueId, name: s.techniqueName, type: 'concept', role: null, status: 'seen' } satisfies TechniqueRef) : null,
    toPositionId: s.toPositionId ?? null,
    toName: s.toName,
    toRole: s.toRole ?? null,
    note: s.note ?? null,
  }));

/** A drafted tree as the flat outline the server takes. */
export const toInput = (slots: Slot<DraftStep>[]): GamePlanStepInput[] =>
  toOutline(slots, n => ({ action: n.action, techniqueId: n.technique?.id ?? null, toPositionId: n.toPositionId, toRole: n.toRole, note: n.note }));

/** Where a step can move: up or down with its alternatives, and earlier or later among them. */
export type Moves = { up: StepMove | null; down: StepMove | null; earlier: StepMove | null; later: StepMove | null };

/**
 * The moves a step has, among its neighbours as the outline draws them. Under a step inside a branch, the
 * branches ("if they…") and what follows ("then", at the same indent) show as two runs, so a slot moves within
 * its own run. On the main line, and under one of several alternatives, everything under a step is one run.
 */
export function movesAt(steps: GamePlanSlot[], stepId: number): Moves {
  const none: Moves = { up: null, down: null, earlier: null, later: null };
  const place = findStep(steps, s => s.id === stepId);
  if (!place) return none;
  const { slot, siblings, trail } = place;
  const k = slot.options.indexOf(place.step);
  const parent = trail.at(-1);
  const split = trail.length >= 2 && findStep(steps, s => s === parent)!.slot.options.length === 1;
  const run = siblings.filter(s => !split || !!s.trigger === !!slot.trigger);
  const at = run.indexOf(slot);
  const leader = k === 0;
  return {
    up: leader && at > 0 ? { before: run[at - 1]!.options[0]!.id } : null,
    down: leader && at < run.length - 1 ? { after: run[at + 1]!.options[0]!.id } : null,
    earlier: k > 0 ? { within: 'choice', to: 'up' } : null,
    later: k < slot.options.length - 1 ? { within: 'choice', to: 'down' } : null,
  };
}

// ---------- reading ----------

interface Outline {
  /** Given while editing: tapping a step edits it, and each step offers what can come next. Steps go by id. */
  onEdit?: {
    step: (stepId: number) => void;
    add: (stepId: number, kind: 'then' | 'branch' | 'or') => void;
    /** Where the step can move, and moving it. */
    moves: (stepId: number) => Moves;
    move: (stepId: number, move: StepMove) => void;
    /** A change is being saved: moving waits. */
    busy: boolean;
  };
  /** Opens one step's part of the tree on its own. Without it (a draft), everything shows in place. */
  zoom?: (stepId: number) => void;
  /** Every step showing, however many there are. */
  all: boolean;
  /** A drafted outline: no card links or rank bars, since nothing is saved yet. */
  draft: boolean;
}

const OutlineContext = createContext<Outline>({ all: true, draft: false });

/** How far branches indent before a branch opens on its own instead. */
const MAX_LEVEL = 3;
/** This few steps show whole; more start with their branches folded. */
const SMALL_STEPS = 10;

/** A step in a few words, for the trail back up the tree. */
const crumb = (steps: Slot<AnyStep>[], step: AnyStep) => {
  const slot = findStep(steps, s => s === step)!.slot;
  return `${slot.trigger && step.option === 0 ? `If ${slot.trigger}: ` : ''}${step.action}`;
};

/**
 * A game plan's steps as an outline. The main line is numbered. A step and its alternatives ("or": plan A, B…)
 * sit side by side, each a branch with its own steps nested under it. Under a step hang its "if they…" branches
 * and what comes next ("then"); inside a branch, a step that isn't one of several alternatives keeps what comes
 * next at the same indent, so a long sequence doesn't creep sideways. Anything under a step folds away, and a
 * branch that's deep in the tree opens on its own, with a trail back.
 */
export function StepsOutline({ steps, onEdit, draft = false }: { steps: Slot<AnyStep>[]; onEdit?: Outline['onEdit']; draft?: boolean }) {
  // The step the view is opened on, by id: it may have been deleted since, and then everything shows.
  const [rootId, setRoot] = useState<number | null>(null);
  const [all, setAll] = useState(false);
  const total = countSteps(steps);
  const small = total <= SMALL_STEPS;
  const root = rootId === null ? null : findStep(steps, s => s.id === rootId);
  const foldable = steps.some(slot => slot.options.some(s => s.slots.length > 0));
  const ctx: Outline = { onEdit, zoom: draft ? undefined : setRoot, all: all || small || draft, draft };
  return (
    <OutlineContext.Provider value={ctx}>
      {root && (
        <nav className="steps-trail" aria-label="Where this is in the game plan">
          <button type="button" className="btn ghost small" onClick={() => setRoot(null)}>
            <Icon name="back" size={16} />
            All steps
          </button>
          {root.trail.map(above => (
            <button key={above.id} type="button" className="steps-crumb" onClick={() => setRoot(above.id!)}>
              {crumb(steps, above)}
            </button>
          ))}
        </nav>
      )}
      {/* Remounted when everything is opened or folded, so each step starts from the new default. */}
      <ol key={`${all}-${root ? rootId : ''}`} className={`steps${onEdit ? ' editing' : ''}${root ? ' zoomed' : ''}`} aria-label={draft ? 'Outline' : 'Steps'}>
        {root ? (
          <li className="step level-0">
            {(root.step.option > 0 || root.slot.trigger) && <span className="step-when">{root.step.option > 0 ? 'Or' : `If ${root.slot.trigger}`}</span>}
            <StepOption step={root.step} level={0} marker={null} choice root />
          </li>
        ) : (
          <Slots slots={steps} level={0} numbered />
        )}
      </ol>
      {!onEdit && !small && !draft && foldable && (
        <button type="button" className="btn ghost small steps-all" aria-pressed={all} onClick={() => setAll(!all)}>
          {all ? 'Fold the branches' : `Show all ${total} steps`}
        </button>
      )}
    </OutlineContext.Provider>
  );
}

/** The slots in a list, each with its options side by side. `only` picks which slots to draw. */
function Slots({ slots, level, numbered = false, only }: { slots: Slot<AnyStep>[]; level: number; numbered?: boolean; only?: (slot: Slot<AnyStep>) => boolean }) {
  return (
    <>
      {slots.map((slot, n) => {
        if (only && !only(slot)) return null;
        const choice = slot.options.length > 1;
        return (
          <li key={slot.options[0]!.id ?? n} className={`step level-${Math.min(level, MAX_LEVEL)}${numbered ? ' numbered' : ''}${choice ? ' choice' : ''}`}>
            {!numbered && <span className="step-when">{slot.trigger ? `If ${slot.trigger}` : 'Then'}</span>}
            {slot.options.map((step, k) => (
              <Fragment key={step.id ?? k}>
                {k > 0 && <span className="step-or">Or</span>}
                <StepOption step={step} level={level} marker={numbered ? (k === 0 ? String(n + 1) : '') : null} choice={choice} />
              </Fragment>
            ))}
          </li>
        );
      })}
    </>
  );
}

/** One step (one option of its slot): its line, and everything under it. */
function StepOption({
  step,
  level,
  marker,
  choice = false,
  root = false,
}: {
  step: AnyStep;
  level: number;
  /** Its number on the main line (empty for an alternative there, so it lines up). */
  marker: string | null;
  /** One of several alternatives: a branch of its own, with what comes after it nested under it. */
  choice?: boolean;
  /** The step the view is opened on: always unfolded. */
  root?: boolean;
}) {
  const { onEdit: editing, zoom, all, draft } = useContext(OutlineContext);
  // Only saved steps are edited: they go by id.
  const id = step.id;
  const onEdit = id === undefined ? undefined : editing;
  // The main line shows its branches; deeper ones wait behind a tap unless there are only a few steps.
  const [unfolded, setOpen] = useState(all || level === 0);
  const under = countSteps(step.slots);
  // Deep in the tree there's no room left to indent: what's under this step opens on its own instead.
  const elsewhere = !!zoom && id !== undefined && !root && under > 0 && level >= MAX_LEVEL;
  // While editing, every step shows, so each can be tapped.
  const open = !elsewhere && (root || unfolded || !!onEdit);
  const body = (
    <>
      <span className="step-do">{step.action}</span>
      {!draft && (step.to || (step.continuesIn?.length ?? 0) > 0) && (
        <span className="step-meta">
          {step.to && `→ ${step.to.name}${step.toRole ? ` (${ROLE_LABEL[step.toRole].toLowerCase()})` : ''}`}
          {step.continuesIn?.map(a => (
            <span key={a.id}>
              {' '}
              · continues in <Link to={`/game-plans/${a.id}`}>{a.name}</Link>
            </span>
          ))}
        </span>
      )}
      {draft && (step.technique || step.toName) && (
        <span className="step-meta">
          {step.technique && step.technique.name.toLowerCase() !== step.action.toLowerCase() ? `Card: ${step.technique.name} ` : ''}
          {step.toName ? `→ ${step.toName}` : ''}
        </span>
      )}
      {step.note && <span className="step-note">{step.note}</span>}
    </>
  );
  // Inside a branch, what comes next stays at this indent; one of several alternatives keeps its steps under it.
  const flat = level >= 1 && !choice;
  const reactions = step.slots.some(s => s.trigger);
  const thens = step.slots.some(s => !s.trigger);
  return (
    <div className="step-option" data-step-id={id}>
      <div className="step-line">
        {marker !== null && <span className="step-num">{marker}</span>}
        {onEdit ? (
          <button type="button" className="step-body" aria-label={`Edit step: ${step.action}`} onClick={() => onEdit.step(id!)}>
            {body}
          </button>
        ) : step.technique && !draft ? (
          <Link className="step-body" to={`/t/${step.technique.id}`}>
            {body}
          </Link>
        ) : (
          <div className="step-body">{body}</div>
        )}
        {step.technique && !draft && <RankBar status={step.technique.status} />}
        {under > 0 && !root && (elsewhere || !onEdit) && (
          <button
            type="button"
            className="step-fold"
            aria-expanded={elsewhere ? undefined : open}
            aria-label={`${elsewhere ? 'Open' : open ? 'Fold' : 'Show'} the ${under} step${under === 1 ? '' : 's'} after ${step.action}`}
            onClick={() => (elsewhere ? zoom?.(id!) : setOpen(!open))}
          >
            {!open && <span>{under}</span>}
            <Icon name={elsewhere ? 'forward' : 'chevron'} size={18} />
          </button>
        )}
      </div>
      {onEdit && (
        <div className="step-add">
          <button type="button" className="btn ghost small" onClick={() => onEdit.add(id!, 'then')}>
            <Icon name="plus" size={16} />
            Then
          </button>
          <button type="button" className="btn ghost small" onClick={() => onEdit.add(id!, 'branch')}>
            <Icon name="plus" size={16} />
            If they…
          </button>
          <button type="button" className="btn ghost small" onClick={() => onEdit.add(id!, 'or')}>
            <Icon name="plus" size={16} />
            Or
          </button>
          <MoveButtons action={step.action} moves={onEdit.moves(id!)} busy={onEdit.busy} onMove={m => onEdit.move(id!, m)} />
        </div>
      )}
      {open && (reactions || (thens && !flat)) && (
        <ol className="step-branches">
          {/* Nested (on the main line, and for alternatives): everything under it, in order. Flat: the branches. */}
          <Slots slots={step.slots} level={level + 1} only={flat ? slot => !!slot.trigger : undefined} />
        </ol>
      )}
      {open && flat && thens && (
        <ol className="step-then">
          <Slots slots={step.slots} level={level} only={slot => !slot.trigger} />
        </ol>
      )}
    </div>
  );
}

/**
 * While editing, at the end of a step's row: up and down move the step (with its alternatives) past the step
 * next to it. Which alternative is plan A, B… changes in the step's sheet.
 */
function MoveButtons({ action, moves, busy, onMove }: { action: string; moves: Moves; busy: boolean; onMove: (m: StepMove) => void }) {
  if (!moves.up && !moves.down) return null;
  return (
    <span className="step-move">
      {(['up', 'down'] as const).map(dir => (
        <button
          key={dir}
          type="button"
          className="btn ghost small icon-only"
          aria-label={`Move ${action} ${dir}`}
          disabled={busy || !moves[dir]}
          onClick={() => onMove(moves[dir]!)}
        >
          <Icon name={dir} size={16} />
        </button>
      ))}
    </span>
  );
}

// ---------- editing ----------

/** Editing state on a game plan's page: which step's sheet is open (by the step's id), if any. */
type StepEdit = { stepId: number; mode: 'edit' } | { stepId: number; mode: 'then' | 'branch' | 'or' } | { stepId: null; mode: 'first' | 'end' };

const TITLES: Record<StepEdit['mode'], string> = { edit: 'Edit step', branch: 'If they…', or: 'Or…', first: 'First step', end: 'Next step', then: 'Then…' };

/**
 * The steps section of a game plan's page: the outline, and editing it a step at a time. Each change saves that
 * one step (the others keep their ids), with Undo; it's refused if the game plan changed somewhere else since
 * this page read it.
 */
export function StepsSection({ gamePlan }: { gamePlan: GamePlanDetail }) {
  const [editing, setEditing] = useState(false);
  const [step, setStep] = useState<StepEdit | null>(null);
  const [describing, setDescribing] = useState(false);
  const [startOpen, setStartOpen] = useState(false);
  const addStep = useAddStep();
  const updateStep = useUpdateStep();
  const deleteStep = useDeleteStep();
  const moveStep = useMoveStep();
  const toast = useToast();
  // While the page is being read again (after an undo, say), what's here may be out of date: writes wait.
  const fetching = useGamePlanFetching(gamePlan.id);
  const busy = addStep.isPending || updateStep.isPending || deleteStep.isPending || moveStep.isPending || fetching;
  const at = { gamePlanId: gamePlan.id, expectedUpdatedAt: gamePlan.updatedAt };
  /** After a write: say so (with Undo, if it changed anything), then close the sheet. */
  const done = (said: string | null) => ({
    onSuccess: (r: { message: string; activityId?: number }) => {
      toast.show(said !== null && r.activityId !== undefined ? said : r.message, { undoId: r.activityId });
      setStep(null);
    },
    // Including "changed somewhere else": the page is read again, and the sheet stays to try once more.
    onError: toast.error,
  });
  const move = (stepId: number, m: StepMove) => moveStep.mutate({ ...at, stepId, ...m }, done(null));

  // The step being edited may have been deleted somewhere else since its sheet opened.
  const current = step?.mode === 'edit' ? findStep(gamePlan.steps, s => s.id === step.stepId) : null;
  const sheet = step && (step.mode !== 'edit' || current) ? step : null;
  const k = current ? current.slot.options.indexOf(current.step) : 0;
  const askWhen = sheet?.mode === 'branch' || (sheet?.mode === 'edit' && current!.trail.length > 0 && k === 0);

  return (
    <>
      <div className="row-split section-row">
        <h2 className="section-title grow">Steps</h2>
        {gamePlan.steps.length > 0 ? (
          <button type="button" className="btn ghost small" aria-pressed={editing} onClick={() => setEditing(!editing)}>
            {editing ? 'Done' : 'Edit'}
          </button>
        ) : null}
        <button type="button" className="btn ghost small" onClick={() => setDescribing(true)}>
          Describe it
        </button>
      </div>

      <button type="button" className="game-plan-start" onClick={() => setStartOpen(true)}>
        {gamePlan.start || gamePlan.premise ? (
          <>
            <span className="game-plan-start-label">Starts</span>
            {gamePlan.start ? (
              <>
                {' '}
                in <strong>{gamePlan.start.name}</strong>
                {gamePlan.startRole ? `, ${ROLE_LABEL[gamePlan.startRole].toLowerCase()}` : ''}
              </>
            ) : null}
            {gamePlan.premise && <span className="game-plan-premise">When {lowerFirst(gamePlan.premise)}</span>}
          </>
        ) : (
          <span className="muted">Where does it start? Add a position and the situation it's for.</span>
        )}
      </button>

      {gamePlan.steps.length > 0 ? (
        <section className="panel steps-panel">
          <StepsOutline
            steps={gamePlan.steps}
            onEdit={
              editing
                ? {
                    step: stepId => setStep({ stepId, mode: 'edit' }),
                    add: (stepId, kind) => setStep({ stepId, mode: kind }),
                    moves: stepId => movesAt(gamePlan.steps, stepId),
                    move,
                    busy,
                  }
                : undefined
            }
          />
          {editing && (
            <div className="step-add steps-add-end">
              <button type="button" className="btn ghost small" onClick={() => setStep({ stepId: null, mode: 'end' })}>
                <Icon name="plus" size={16} />
                Add a step at the end
              </button>
            </div>
          )}
        </section>
      ) : (
        <>
          <p className="section-hint">
            The steps, in order, what to do when they react, and a plan B where you have one. Describe it in your own words, or build it a step at a
            time.
          </p>
          <button type="button" className="btn quiet small section-action" onClick={() => setStep({ stepId: null, mode: 'first' })}>
            <Icon name="plus" size={18} />
            First step
          </button>
        </>
      )}

      {sheet && (
        <StepSheet
          title={TITLES[sheet.mode]}
          initial={
            current
              ? {
                  trigger: k === 0 ? current.slot.trigger : null,
                  action: current.step.action,
                  technique: current.step.technique,
                  toPositionId: current.step.to?.id ?? null,
                  toName: current.step.to?.name ?? null,
                  toRole: current.step.toRole,
                  note: current.step.note,
                }
              : null
          }
          askWhen={askWhen}
          following={current ? countSteps(current.step.slots) : 0}
          busy={busy}
          onClose={() => setStep(null)}
          onSave={form => {
            const fields = { action: form.action, techniqueId: form.technique?.id ?? null, toPositionId: form.toPositionId, toRole: form.toRole, note: form.note };
            if (sheet.mode === 'edit') {
              // The reaction is the slot's: it's only asked (and only sent) where it can change.
              updateStep.mutate({ ...at, stepId: sheet.stepId, ...fields, ...(askWhen ? { trigger: form.trigger } : {}) }, done('Step saved'));
            } else if (sheet.mode === 'or') {
              // "Or" is one more alternative to this step, after the ones it has.
              addStep.mutate({ ...at, relation: 'or', of: sheet.stepId, ...fields }, done('Step added'));
            } else {
              // The main line grows at the end; "Then" and "If they…" hang under the step they were added from, after what's there.
              const relation = sheet.mode === 'branch' && form.trigger ? 'if' : 'then';
              addStep.mutate({ ...at, relation, of: sheet.stepId ?? undefined, ...fields, ...(relation === 'if' ? { trigger: form.trigger } : {}) }, done('Step added'));
            }
          }}
          // Without plan A, plan B is the plan: the server gives it the reaction the slot answers.
          onDelete={sheet.mode === 'edit' ? () => deleteStep.mutate({ ...at, stepId: sheet.stepId }, done('Step deleted')) : undefined}
          onPrefer={sheet.mode === 'edit' && k > 0 ? () => move(sheet.stepId, { within: 'choice', to: 'first' }) : undefined}
          // Plan B's way earlier is "Make this plan A"; from plan C on, one place at a time too.
          onEarlier={sheet.mode === 'edit' && k > 1 ? () => move(sheet.stepId, { within: 'choice', to: 'up' }) : undefined}
          onLater={sheet.mode === 'edit' && k < current!.slot.options.length - 1 ? () => move(sheet.stepId, { within: 'choice', to: 'down' }) : undefined}
        />
      )}
      {startOpen && <StartSheet gamePlan={gamePlan} onClose={() => setStartOpen(false)} />}
      {describing && <DescribeSheet gamePlan={gamePlan} onClose={() => setDescribing(false)} />}
    </>
  );
}

const lowerFirst = (t: string) => (/^[A-Z][a-z]/.test(t) ? t.charAt(0).toLowerCase() + t.slice(1) : t);

/** One step: when (for a branch), what to do, the card it is, where it leaves you, and why. */
function StepSheet({
  title,
  initial,
  askWhen,
  following,
  busy,
  onSave,
  onDelete,
  onPrefer,
  onEarlier,
  onLater,
  onClose,
}: {
  title: string;
  /** The step as it is, with the reaction that leads to it; null for a new one. */
  initial: (StepForm & { trigger: string | null }) | null;
  askWhen: boolean;
  /** Steps under this one, which go with it if it's deleted. */
  following: number;
  busy: boolean;
  onSave: (step: StepForm & { trigger: string | null }) => void;
  onDelete?: () => void;
  /** For an alternative: make it the preferred one (plan A). */
  onPrefer?: () => void;
  /** For one of several alternatives: one place earlier or later among them (plan C to B, A to B…). */
  onEarlier?: () => void;
  onLater?: () => void;
  onClose: () => void;
}) {
  const [when, setWhen] = useState(initial?.trigger ?? '');
  const [action, setAction] = useState(initial?.action ?? '');
  const [technique, setTechnique] = useState<TechniqueRef[]>(initial?.technique ? [initial.technique] : []);
  const [to, setTo] = useState<{ id: number | null; name: string | null }>({ id: initial?.toPositionId ?? null, name: initial?.toName ?? null });
  const [toRole, setToRole] = useState<Role | null>(initial?.toRole ?? null);
  const [note, setNote] = useState(initial?.note ?? '');
  const doText = action.trim() || technique[0]?.name || '';
  return (
    <Sheet title={title} onClose={onClose}>
      <form
        onSubmit={e => {
          e.preventDefault();
          if (!doText) return;
          onSave({
            trigger: when.trim() || null,
            action: doText,
            technique: technique[0] ?? null,
            toPositionId: to.id,
            toName: to.name,
            toRole: to.id ? toRole : null,
            note: note.trim() || null,
          });
        }}
      >
        {askWhen && (
          <label className="field">
            <span className="label">If they… (what they do)</span>
            <input className="input" autoFocus placeholder="post the far leg" value={when} onChange={e => setWhen(e.target.value)} />
          </label>
        )}
        <label className="field">
          <span className="label">Do</span>
          <input
            className="input"
            autoFocus={!askWhen}
            placeholder="Go to deep half"
            value={action}
            onChange={e => setAction(e.target.value)}
          />
        </label>
        <TechniquePicker label="Technique card (optional)" single selected={technique} onChange={setTechnique} />
        <PositionSelect label="Leaves you in (optional)" value={to.id} onChange={(id, name) => setTo({ id, name })} />
        {to.id !== null && <RoleSegments value={toRole} onChange={setToRole} />}
        <label className="field">
          <span className="label">Why, or the cue (optional)</span>
          <input className="input" placeholder="Make them post the underhook hand" value={note} onChange={e => setNote(e.target.value)} />
        </label>
        <button className="btn block" type="submit" disabled={busy || !doText}>
          Save step
        </button>
        {onPrefer && (
          <button type="button" className="btn quiet block" style={{ marginTop: 8 }} disabled={busy} onClick={onPrefer}>
            Make this plan A
          </button>
        )}
        {(onEarlier || onLater) && (
          <div className="row-split" style={{ marginTop: 8 }}>
            {onEarlier && (
              <button type="button" className="btn quiet grow" disabled={busy} onClick={onEarlier}>
                Try earlier
              </button>
            )}
            {onLater && (
              <button type="button" className="btn quiet grow" disabled={busy} onClick={onLater}>
                Try later
              </button>
            )}
          </div>
        )}
        {onDelete && (
          <button type="button" className="btn danger block" style={{ marginTop: 8 }} disabled={busy} onClick={onDelete}>
            {following ? `Delete step and the ${following} after it` : 'Delete step'}
          </button>
        )}
      </form>
    </Sheet>
  );
}

/** Pick a position, grouped by kind. */
export function PositionSelect({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number | null;
  onChange: (id: number | null, name: string | null) => void;
}) {
  const positions = usePositions();
  return (
    <label className="field">
      <span className="label">{label}</span>
      <select
        className="select"
        value={value ?? ''}
        onChange={e => {
          const id = e.target.value ? Number(e.target.value) : null;
          onChange(id, positions.data?.find(p => p.id === id)?.name ?? null);
        }}
      >
        <option value="">None</option>
        {CATEGORY_ORDER.map(cat => {
          const list = positions.data?.filter(p => p.category === cat) ?? [];
          if (!list.length) return null;
          return (
            <optgroup key={cat} label={CATEGORY_LABEL[cat]}>
              {list.map(p => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </optgroup>
          );
        })}
      </select>
    </label>
  );
}

function RoleSegments({ value, onChange }: { value: Role | null; onChange: (r: Role | null) => void }) {
  return (
    <div className="field">
      <div className="segments" role="group" aria-label="Top or bottom">
        {ROLES.filter(r => r !== 'neutral').map(r => (
          <button key={r} type="button" className="segment" aria-pressed={value === r} onClick={() => onChange(value === r ? null : r)}>
            On {r}
          </button>
        ))}
      </div>
    </div>
  );
}

/** Where the game plan starts and the situation it's for. */
function StartSheet({ gamePlan, onClose }: { gamePlan: GamePlanDetail; onClose: () => void }) {
  const [start, setStart] = useState<number | null>(gamePlan.start?.id ?? null);
  const [role, setRole] = useState<Role | null>(gamePlan.startRole);
  const [premise, setPremise] = useState(gamePlan.premise ?? '');
  const edit = useEditGamePlan();
  const toast = useToast();
  return (
    <Sheet title="Where it starts" onClose={onClose}>
      <form
        onSubmit={e => {
          e.preventDefault();
          edit.mutate(
            { id: gamePlan.id, startPositionId: start, startRole: start ? role : null, premise: premise.trim() || null },
            {
              onSuccess: r => {
                toast.show('Saved', { undoId: r.activityId });
                onClose();
              },
              onError: toast.error,
            },
          );
        }}
      >
        <PositionSelect label="Position" value={start} onChange={id => setStart(id)} />
        {start !== null && <RoleSegments value={role} onChange={setRole} />}
        <label className="field">
          <span className="label">When… (the situation, optional)</span>
          <input className="input" placeholder="they have the underhook and crossface" value={premise} onChange={e => setPremise(e.target.value)} />
        </label>
        <button className="btn block" type="submit" disabled={edit.isPending}>
          Save
        </button>
      </form>
    </Sheet>
  );
}

/** Say the game plan in your own words; Claude outlines it; check it, then save it (replacing the steps). */
function DescribeSheet({ gamePlan, onClose }: { gamePlan: GamePlanDetail; onClose: () => void }) {
  const [text, setText] = useState('');
  const draft = useDraftGamePlan();
  const edit = useEditGamePlan();
  const toast = useToast();
  const d = draft.data;
  const tree = d ? fromDraft(d) : [];
  return (
    <Sheet title="Describe the game plan" onClose={onClose}>
      {!d ? (
        <form
          onSubmit={e => {
            e.preventDefault();
            if (text.trim()) draft.mutate(text.trim(), { onError: toast.error });
          }}
        >
          <label className="field">
            <span className="label">In your own words</span>
            <textarea
              className="textarea"
              autoFocus
              rows={7}
              placeholder="From bottom half, if they have the underhook and crossface: John Wayne sweep to make them post, win the underhook, then shuck. If they post the far leg, go to deep half. If they base back, octopus."
              value={text}
              onChange={e => setText(e.target.value)}
            />
          </label>
          <button className="btn block" type="submit" disabled={draft.isPending || !text.trim()}>
            {draft.isPending ? 'Outlining…' : 'Outline it'}
          </button>
          {gamePlan.steps.length > 0 && <p className="muted small">You'll see the outline before it replaces the steps you have.</p>}
        </form>
      ) : (
        <>
          {(d.start || d.premise) && (
            <p className="game-plan-start static">
              <span className="game-plan-start-label">Starts</span>
              {d.start && (
                <>
                  {' '}
                  in <strong>{d.start.name}</strong>
                  {d.startRole ? `, ${d.startRole}` : ''}
                </>
              )}
              {d.premise && <span className="game-plan-premise">When {lowerFirst(d.premise)}</span>}
            </p>
          )}
          <section className="panel steps-panel">
            {tree.length ? <StepsOutline steps={tree} draft /> : <div className="empty">Claude didn't find any steps in that.</div>}
          </section>
          <div className="row-split" style={{ marginTop: 12 }}>
            <button type="button" className="btn quiet grow" onClick={() => draft.reset()}>
              Change the words
            </button>
            <button
              type="button"
              className="btn grow"
              disabled={edit.isPending || !tree.length}
              onClick={() =>
                edit.mutate(
                  {
                    id: gamePlan.id,
                    // Replaces every step: refused if the game plan changed somewhere else since this page read it.
                    expectedUpdatedAt: gamePlan.updatedAt,
                    steps: toInput(tree),
                    ...(d.start ? { startPositionId: d.start.id, startRole: d.startRole } : {}),
                    ...(d.premise ? { premise: d.premise } : {}),
                  },
                  {
                    onSuccess: r => {
                      toast.show('Steps saved', { undoId: r.activityId });
                      onClose();
                    },
                    onError: toast.error,
                  },
                )
              }
            >
              Save steps
            </button>
          </div>
        </>
      )}
    </Sheet>
  );
}
