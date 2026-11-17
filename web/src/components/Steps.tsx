import { createContext, Fragment, useContext, useState } from 'react';
import { Link } from 'react-router';
import type { GamePlanDetail, GamePlanDraft, GamePlanStep, GamePlanStepInput, Role, StepMove, TechniqueRef } from '../../../src/shared/api';
import { useDraftGamePlan, useEditGamePlan, useMoveStep, usePositions } from '../api';
import { CATEGORY_LABEL, CATEGORY_ORDER, ROLE_LABEL, ROLES } from '../lib/format';
import { RankBar } from './Belt';
import { Icon } from './Icon';
import { Sheet } from './Sheet';
import { TechniquePicker } from './TechniquePicker';
import { useToast } from './Toast';

// ---------- the steps as an editable tree ----------

/** One step while editing: what's stored, plus names to show. */
export interface Node {
  /** Its id, once saved (a drafted step has none). */
  id?: number;
  /** An alternative to the step before it in the same list (plan B). */
  or: boolean;
  trigger: string | null;
  action: string;
  technique: TechniqueRef | null;
  toPositionId: number | null;
  toName: string | null;
  toRole: Role | null;
  note: string | null;
  children: Node[];
}

/** Where a step is: its index at each level, from the main line down. */
type Path = number[];

export const fromSteps = (steps: GamePlanStep[]): Node[] =>
  steps.map(s => ({
    id: s.id,
    or: s.or,
    trigger: s.trigger,
    action: s.action,
    technique: s.technique,
    toPositionId: s.to?.id ?? null,
    toName: s.to?.name ?? null,
    toRole: s.toRole,
    note: s.note,
    children: fromSteps(s.children),
  }));

/** The tree as the flat outline the server takes. */
export function toInput(nodes: Node[], depth = 0): GamePlanStepInput[] {
  return nodes.flatMap(n => [
    {
      depth,
      or: n.or,
      trigger: n.or ? null : n.trigger,
      action: n.action,
      techniqueId: n.technique?.id ?? null,
      toPositionId: n.toPositionId,
      toRole: n.toRole,
      note: n.note,
    },
    ...toInput(n.children, depth + 1),
  ]);
}

/** A drafted outline (flat, with depths) as a tree. */
function fromDraft(draft: GamePlanDraft): Node[] {
  const top: Node[] = [];
  const stack: Node[] = [];
  for (const s of draft.steps) {
    const node: Node = {
      or: s.or === true,
      trigger: s.trigger ?? null,
      action: s.action,
      technique: s.techniqueId && s.techniqueName ? { id: s.techniqueId, name: s.techniqueName, type: 'concept', role: null, status: 'seen' } : null,
      toPositionId: s.toPositionId ?? null,
      toName: s.toName,
      toRole: s.toRole ?? null,
      note: s.note ?? null,
      children: [],
    };
    stack.length = s.depth;
    (s.depth === 0 ? top : stack[s.depth - 1]!.children).push(node);
    stack[s.depth] = node;
  }
  return top;
}

const clone = (nodes: Node[]): Node[] => nodes.map(n => ({ ...n, children: clone(n.children) }));

/** The list a step sits in, in a copy of the tree. */
function siblingsAt(tree: Node[], path: Path): Node[] {
  let list = tree;
  for (const i of path.slice(0, -1)) list = list[i]!.children;
  return list;
}

/** A step and its alternatives sit side by side in a list: where that run starts and ends (end not included). */
function choiceAt(list: { or: boolean }[], i: number): [number, number] {
  let start = i;
  while (start > 0 && list[start]!.or) start--;
  let end = i + 1;
  while (end < list.length && list[end]!.or) end++;
  return [start, end];
}

const countSteps = (nodes: { children: Node[] | GamePlanStep[] }[]): number => nodes.reduce((n, s) => n + 1 + countSteps(s.children), 0);

/** Where a step can move: up or down with its alternatives, and earlier or later among them. */
export type Moves = { up: StepMove | null; down: StepMove | null; earlier: StepMove | null; later: StepMove | null };

/**
 * The moves a step has, among its neighbours as the outline draws them. Under a step inside a branch, the
 * branches ("if they…") and what follows ("then", at the same indent) show as two runs, so a step moves within
 * its own run. On the main line, and under one of several alternatives, everything under a step is one run.
 */
export function movesAt(tree: Node[], path: Path): Moves {
  const none: Moves = { up: null, down: null, earlier: null, later: null };
  const list = siblingsAt(tree, path);
  const i = path.at(-1)!;
  const [start, end] = choiceAt(list, i);
  if (list[i]?.id === undefined) return none;
  const parentPath = path.slice(0, -1);
  const parentChoice = parentPath.length ? choiceAt(siblingsAt(tree, parentPath), parentPath.at(-1)!) : [0, 1];
  const split = path.length > 2 && parentChoice[1] - parentChoice[0] === 1;
  const runs: [number, number][] = [];
  for (let k = 0; k < list.length; ) {
    const [s, e] = choiceAt(list, k);
    if (!split || !!list[s]!.trigger === !!list[start]!.trigger) runs.push([s, e]);
    k = e;
  }
  const at = runs.findIndex(([s]) => s === start);
  const leader = i === start;
  return {
    up: leader && at > 0 ? { before: list[runs[at - 1]![0]]!.id! } : null,
    down: leader && at < runs.length - 1 ? { after: list[runs[at + 1]![0]]!.id! } : null,
    earlier: end - start > 1 && i > start ? { within: 'choice', to: 'up' } : null,
    later: end - start > 1 && i < end - 1 ? { within: 'choice', to: 'down' } : null,
  };
}

// ---------- reading ----------

/** A saved step, or one being drafted or edited: the outline draws both. */
type AnyStep = GamePlanStep | Node;

interface Outline {
  /** Given while editing: tapping a step edits it, and each step offers what can come next. */
  onEdit?: {
    step: (path: Path) => void;
    add: (path: Path, kind: 'then' | 'branch' | 'or') => void;
    /** Where the step can move, and moving it. */
    moves: (path: Path) => Moves;
    move: (path: Path, move: StepMove) => void;
    /** A change is being saved: moving waits. */
    busy: boolean;
  };
  /** Opens one step's part of the tree on its own. Without it (a draft), everything shows in place. */
  zoom?: (path: Path) => void;
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

/** Steps in a list, each with its alternatives: [index of the step, ...indexes of its "or"s]. */
function choices(list: AnyStep[]): number[][] {
  const out: number[][] = [];
  list.forEach((s, i) => {
    if (s.or && out.length) out.at(-1)!.push(i);
    else out.push([i]);
  });
  return out;
}

const stepAt = (steps: AnyStep[], path: Path): AnyStep | null => {
  let list = steps;
  let step: AnyStep | null = null;
  for (const i of path) {
    step = list[i] ?? null;
    if (!step) return null;
    list = step.children;
  }
  return step;
};

/** A step in a few words, for the trail back up the tree. */
const crumb = (s: AnyStep) => `${s.trigger && !s.or ? `If ${s.trigger}: ` : ''}${s.action}`;

/**
 * A game plan's steps as an outline. The main line is numbered. A step and its alternatives ("or": plan A, B…)
 * sit side by side, each a branch with its own steps nested under it. Under a step hang its "if they…" branches
 * and what comes next ("then"); inside a branch, a step that isn't one of several alternatives keeps what comes
 * next at the same indent, so a long sequence doesn't creep sideways. Anything under a step folds away, and a
 * branch that's deep in the tree opens on its own, with a trail back.
 */
export function StepsOutline({ steps, onEdit, draft = false }: { steps: AnyStep[]; onEdit?: Outline['onEdit']; draft?: boolean }) {
  const [root, setRoot] = useState<Path>([]);
  const [all, setAll] = useState(false);
  const total = countSteps(steps);
  const small = total <= SMALL_STEPS;
  // The step the view is opened on may have been deleted or moved since.
  const rootStep = root.length ? stepAt(steps, root) : null;
  const at = rootStep ? root : [];
  const foldable = steps.some(s => s.children.length > 0);
  const ctx: Outline = { onEdit, zoom: draft ? undefined : setRoot, all: all || small || draft, draft };
  return (
    <OutlineContext.Provider value={ctx}>
      {rootStep && (
        <nav className="steps-trail" aria-label="Where this is in the game plan">
          <button type="button" className="btn ghost small" onClick={() => setRoot([])}>
            <Icon name="back" size={16} />
            All steps
          </button>
          {at.slice(0, -1).map((_, i) => {
            const to = at.slice(0, i + 1);
            return (
              <button key={i} type="button" className="steps-crumb" onClick={() => setRoot(to)}>
                {crumb(stepAt(steps, to)!)}
              </button>
            );
          })}
        </nav>
      )}
      {/* Remounted when everything is opened or folded, so each step starts from the new default. */}
      <ol key={`${all}-${at.join('.')}`} className={`steps${onEdit ? ' editing' : ''}${rootStep ? ' zoomed' : ''}`} aria-label={draft ? 'Outline' : 'Steps'}>
        {rootStep ? (
          <li className="step level-0">
            {(rootStep.trigger || rootStep.or) && <span className="step-when">{rootStep.or ? 'Or' : `If ${rootStep.trigger}`}</span>}
            <Option step={rootStep} path={at} level={0} marker={null} choice root />
          </li>
        ) : (
          <Choices list={steps} base={[]} level={0} numbered />
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

/** Steps in a list, each with its alternatives beside it. `only` picks which to draw (by the first of each). */
function Choices({
  list,
  base,
  level,
  numbered = false,
  only,
}: {
  list: AnyStep[];
  base: Path;
  level: number;
  numbered?: boolean;
  only?: (first: AnyStep) => boolean;
}) {
  return (
    <>
      {choices(list).map((at, n) => {
        const first = list[at[0]!]!;
        if (only && !only(first)) return null;
        const choice = at.length > 1;
        return (
          <li key={first.id ?? at[0]} className={`step level-${Math.min(level, MAX_LEVEL)}${numbered ? ' numbered' : ''}${choice ? ' choice' : ''}`}>
            {!numbered && <span className="step-when">{first.trigger ? `If ${first.trigger}` : 'Then'}</span>}
            {at.map((i, k) => (
              <Fragment key={i}>
                {k > 0 && <span className="step-or">Or</span>}
                <Option step={list[i]!} path={[...base, i]} level={level} marker={numbered ? (k === 0 ? String(n + 1) : '') : null} choice={choice} />
              </Fragment>
            ))}
          </li>
        );
      })}
    </>
  );
}

/** One step (one alternative, where there are several): its line, and everything under it. */
function Option({
  step,
  path,
  level,
  marker,
  choice = false,
  root = false,
}: {
  step: AnyStep;
  path: Path;
  level: number;
  /** Its number on the main line (empty for an alternative there, so it lines up). */
  marker: string | null;
  /** One of several alternatives: a branch of its own, with what comes after it nested under it. */
  choice?: boolean;
  /** The step the view is opened on: always unfolded. */
  root?: boolean;
}) {
  const { onEdit, zoom, all, draft } = useContext(OutlineContext);
  // The main line shows its branches; deeper ones wait behind a tap unless there are only a few steps.
  const [unfolded, setOpen] = useState(all || level === 0);
  const under = countSteps(step.children);
  // Deep in the tree there's no room left to indent: what's under this step opens on its own instead.
  const elsewhere = !!zoom && !root && under > 0 && level >= MAX_LEVEL;
  // While editing, every step shows, so each can be tapped.
  const open = !elsewhere && (root || unfolded || !!onEdit);
  // A step as saved (with where it continues), rather than one in the editing tree or a draft.
  const saved = 'continuesIn' in step ? step : null;
  const body = (
    <>
      <span className="step-do">{step.action}</span>
      {saved && (saved.to || saved.continuesIn.length > 0) && (
        <span className="step-meta">
          {saved.to && `→ ${saved.to.name}${saved.toRole ? ` (${ROLE_LABEL[saved.toRole].toLowerCase()})` : ''}`}
          {saved.continuesIn.map(a => (
            <span key={a.id}>
              {' '}
              · continues in <Link to={`/game-plans/${a.id}`}>{a.name}</Link>
            </span>
          ))}
        </span>
      )}
      {!saved && (step.technique || (step as Node).toName) && (
        <span className="step-meta">
          {step.technique && step.technique.name.toLowerCase() !== step.action.toLowerCase() ? `Card: ${step.technique.name} ` : ''}
          {(step as Node).toName ? `→ ${(step as Node).toName}` : ''}
        </span>
      )}
      {step.note && <span className="step-note">{step.note}</span>}
    </>
  );
  // Inside a branch, what comes next stays at this indent; one of several alternatives keeps its steps under it.
  const flat = level >= 1 && !choice;
  const reactions = step.children.some(c => !c.or && c.trigger);
  const thens = step.children.some(c => !c.or && !c.trigger);
  return (
    <div className="step-option">
      <div className="step-line">
        {marker !== null && <span className="step-num">{marker}</span>}
        {onEdit ? (
          <button type="button" className="step-body" aria-label={`Edit step: ${step.action}`} onClick={() => onEdit.step(path)}>
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
            onClick={() => (elsewhere ? zoom?.(path) : setOpen(!open))}
          >
            {!open && <span>{under}</span>}
            <Icon name={elsewhere ? 'forward' : 'chevron'} size={18} />
          </button>
        )}
      </div>
      {onEdit && (
        <div className="step-add">
          <button type="button" className="btn ghost small" onClick={() => onEdit.add(path, 'then')}>
            <Icon name="plus" size={16} />
            Then
          </button>
          <button type="button" className="btn ghost small" onClick={() => onEdit.add(path, 'branch')}>
            <Icon name="plus" size={16} />
            If they…
          </button>
          <button type="button" className="btn ghost small" onClick={() => onEdit.add(path, 'or')}>
            <Icon name="plus" size={16} />
            Or
          </button>
          <MoveButtons action={step.action} moves={onEdit.moves(path)} busy={onEdit.busy} onMove={m => onEdit.move(path, m)} />
        </div>
      )}
      {open && (reactions || (thens && !flat)) && (
        <ol className="step-branches">
          {/* Nested (on the main line, and for alternatives): everything under it, in order. Flat: the branches. */}
          <Choices list={step.children} base={path} level={level + 1} only={flat ? first => !!first.trigger : undefined} />
        </ol>
      )}
      {open && flat && thens && (
        <ol className="step-then">
          <Choices list={step.children} base={path} level={level} only={first => !first.trigger} />
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

/** Editing state on a game plan's page: which step's sheet is open, if any. */
type StepEdit = { path: Path; mode: 'edit' } | { path: Path; mode: 'then' | 'branch' | 'or' } | { path: null; mode: 'first' | 'end' };

/**
 * The steps section of a game plan's page: the outline, and editing it a step at a time. Every change saves all
 * the steps at once, with Undo.
 */
export function StepsSection({ gamePlan }: { gamePlan: GamePlanDetail }) {
  const [editing, setEditing] = useState(false);
  const [step, setStep] = useState<StepEdit | null>(null);
  const [describing, setDescribing] = useState(false);
  const [startOpen, setStartOpen] = useState(false);
  const edit = useEditGamePlan();
  const moveStep = useMoveStep();
  const toast = useToast();
  const tree = fromSteps(gamePlan.steps);

  const move = (stepId: number, m: StepMove, after?: () => void) =>
    moveStep.mutate(
      { gamePlanId: gamePlan.id, stepId, ...m },
      {
        onSuccess: r => {
          toast.show(r.message, { undoId: r.activityId });
          after?.();
        },
        onError: toast.error,
      },
    );

  const save = (next: Node[], done: string, after?: () => void) =>
    edit.mutate(
      { id: gamePlan.id, steps: toInput(next) },
      {
        onSuccess: r => {
          toast.show(done, { undoId: r.activityId });
          after?.();
        },
        onError: toast.error,
      },
    );

  const current = step?.mode === 'edit' ? siblingsAt(tree, step.path)[step.path.at(-1)!]! : null;

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
                    step: path => setStep({ path, mode: 'edit' }),
                    add: (path, kind) => setStep({ path, mode: kind }),
                    moves: path => movesAt(tree, path),
                    move: (path, m) => move(siblingsAt(tree, path)[path.at(-1)!]!.id!, m),
                    busy: edit.isPending || moveStep.isPending,
                  }
                : undefined
            }
          />
          {editing && (
            <div className="step-add steps-add-end">
              <button type="button" className="btn ghost small" onClick={() => setStep({ path: null, mode: 'end' })}>
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
          <button type="button" className="btn quiet small section-action" onClick={() => setStep({ path: null, mode: 'first' })}>
            <Icon name="plus" size={18} />
            First step
          </button>
        </>
      )}

      {step && (
        <StepSheet
          title={
            step.mode === 'edit'
              ? 'Edit step'
              : step.mode === 'branch'
                ? 'If they…'
                : step.mode === 'or'
                  ? 'Or…'
                  : step.mode === 'first'
                    ? 'First step'
                    : step.mode === 'end'
                      ? 'Next step'
                      : 'Then…'
          }
          initial={current}
          askWhen={step.mode === 'branch' || (step.mode === 'edit' && step.path.length > 1 && !current!.or)}
          following={step.mode === 'edit' ? countSteps(current!.children) : 0}
          busy={edit.isPending || moveStep.isPending}
          onClose={() => setStep(null)}
          onSave={node => {
            const next = clone(tree);
            // The main line grows at the end; everything else hangs under the step it was added from.
            if (step.path === null) next.push(node);
            else if (step.mode === 'edit') {
              const list = siblingsAt(next, step.path);
              const i = step.path.at(-1)!;
              list[i] = { ...node, or: list[i]!.or, children: list[i]!.children };
            } else {
              const list = siblingsAt(next, step.path);
              const i = step.path.at(-1)!;
              const at = list[i]!;
              const [, end] = choiceAt(list, i);
              // "Or" is one more alternative to this step (a sibling of it), after the ones it has.
              if (step.mode === 'or') list.splice(end, 0, { ...node, or: true, trigger: null });
              // "Then" and "If they…" hang under the step they were added from, after what's there.
              else at.children.push(node);
            }
            save(next, step.mode === 'edit' ? 'Step saved' : 'Step added', () => setStep(null));
          }}
          onDelete={
            step.mode === 'edit'
              ? () => {
                  const next = clone(tree);
                  const list = siblingsAt(next, step.path);
                  const i = step.path.at(-1)!;
                  // Without plan A, plan B is the plan: it takes over the reaction it answers.
                  if (!list[i]!.or && list[i + 1]?.or) list[i + 1] = { ...list[i + 1]!, or: false, trigger: list[i]!.trigger };
                  list.splice(i, 1);
                  save(next, 'Step deleted', () => setStep(null));
                }
              : undefined
          }
          onPrefer={
            step.mode === 'edit' && current!.or && current!.id !== undefined
              ? () => move(current!.id!, { within: 'choice', to: 'first' }, () => setStep(null))
              : undefined
          }
          onEarlier={
            // Plan B's way earlier is "Make this plan A"; from plan C on, one place at a time too.
            step.mode === 'edit' && current!.id !== undefined && choiceAt(siblingsAt(tree, step.path), step.path.at(-1)!)[0] < step.path.at(-1)! - 1
              ? () => move(current!.id!, { within: 'choice', to: 'up' }, () => setStep(null))
              : undefined
          }
          onLater={
            step.mode === 'edit' && current!.id !== undefined && movesAt(tree, step.path).later
              ? () => move(current!.id!, { within: 'choice', to: 'down' }, () => setStep(null))
              : undefined
          }
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
  initial: Node | null;
  askWhen: boolean;
  /** Steps under this one, which go with it if it's deleted. */
  following: number;
  busy: boolean;
  onSave: (n: Node) => void;
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
            or: false,
            trigger: when.trim() || null,
            action: doText,
            technique: technique[0] ?? null,
            toPositionId: to.id,
            toName: to.name,
            toRole: to.id ? toRole : null,
            note: note.trim() || null,
            children: [],
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
