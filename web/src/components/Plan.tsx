import { createContext, Fragment, useContext, useState } from 'react';
import { Link } from 'react-router';
import type { AreaDetail, PlanDraft, PlanStep, PlanStepInput, Role, TechniqueRef } from '../../../src/shared/api';
import { useDraftPlan, useEditArea, usePositions } from '../api';
import { CATEGORY_LABEL, CATEGORY_ORDER, ROLE_LABEL, ROLES } from '../lib/format';
import { RankBar } from './Belt';
import { Icon } from './Icon';
import { Sheet } from './Sheet';
import { TechniquePicker } from './TechniquePicker';
import { useToast } from './Toast';

// ---------- the plan as an editable tree ----------

/** One step while editing: what's stored, plus names to show. */
export interface Node {
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

export const fromPlan = (plan: PlanStep[]): Node[] =>
  plan.map(s => ({
    or: s.or,
    trigger: s.trigger,
    action: s.action,
    technique: s.technique,
    toPositionId: s.to?.id ?? null,
    toName: s.to?.name ?? null,
    toRole: s.toRole,
    note: s.note,
    children: fromPlan(s.children),
  }));

/** The tree as the flat outline the server takes. */
export function toInput(nodes: Node[], depth = 0): PlanStepInput[] {
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
function fromDraft(draft: PlanDraft): Node[] {
  const top: Node[] = [];
  const stack: Node[] = [];
  for (const s of draft.plan) {
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

const countSteps = (nodes: { children: Node[] | PlanStep[] }[]): number => nodes.reduce((n, s) => n + 1 + countSteps(s.children), 0);

// ---------- reading ----------

/** A saved step, or one being drafted or edited: the outline draws both. */
type AnyStep = PlanStep | Node;

interface Outline {
  /** Given while editing: tapping a step edits it, and each step offers what can come next. */
  onEdit?: {
    step: (path: Path) => void;
    add: (path: Path, kind: 'then' | 'branch' | 'or') => void;
  };
  /** Opens one step's part of the tree on its own. Without it (a draft), everything shows in place. */
  zoom?: (path: Path) => void;
  /** Every step showing, whatever the size of the plan. */
  all: boolean;
  /** A drafted outline: no card links or rank bars, since nothing is saved yet. */
  draft: boolean;
}

const OutlineContext = createContext<Outline>({ all: true, draft: false });

/** How far branches indent before a branch opens on its own instead. */
const MAX_LEVEL = 3;
/** A plan this short shows whole; a longer one starts with its branches folded. */
const SMALL_PLAN = 10;

/** Steps in a list, each with its alternatives: [index of the step, ...indexes of its "or"s]. */
function choices(list: AnyStep[]): number[][] {
  const out: number[][] = [];
  list.forEach((s, i) => {
    if (s.or && out.length) out.at(-1)!.push(i);
    else out.push([i]);
  });
  return out;
}

const stepAt = (plan: AnyStep[], path: Path): AnyStep | null => {
  let list = plan;
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
 * The plan as an outline. The main line is numbered; "if they…" branches hang under the step they follow;
 * what comes next in a branch ("then") stays at the same indent, so a long sequence doesn't creep sideways;
 * alternatives ("or") stack under the step they're alternatives to, lettered A, B, C in order of preference.
 * Anything under a step folds away, and a branch that's deep in the tree opens on its own, with a trail back.
 */
export function PlanOutline({ plan, onEdit, draft = false }: { plan: AnyStep[]; onEdit?: Outline['onEdit']; draft?: boolean }) {
  const [root, setRoot] = useState<Path>([]);
  const [all, setAll] = useState(false);
  const total = countSteps(plan);
  const small = total <= SMALL_PLAN;
  // The step the view is opened on may have been deleted or moved since.
  const rootStep = root.length ? stepAt(plan, root) : null;
  const at = rootStep ? root : [];
  const foldable = plan.some(s => s.children.length > 0);
  const ctx: Outline = { onEdit, zoom: draft ? undefined : setRoot, all: all || small || draft, draft };
  return (
    <OutlineContext.Provider value={ctx}>
      {rootStep && (
        <nav className="plan-trail" aria-label="Where this is in the plan">
          <button type="button" className="btn ghost small" onClick={() => setRoot([])}>
            <Icon name="back" size={16} />
            Whole plan
          </button>
          {at.slice(0, -1).map((_, i) => {
            const to = at.slice(0, i + 1);
            return (
              <button key={i} type="button" className="plan-crumb" onClick={() => setRoot(to)}>
                {crumb(stepAt(plan, to)!)}
              </button>
            );
          })}
        </nav>
      )}
      {/* Remounted when everything is opened or folded, so each step starts from the new default. */}
      <ol key={`${all}-${at.join('.')}`} className={`plan${onEdit ? ' editing' : ''}${rootStep ? ' zoomed' : ''}`} aria-label={draft ? 'Outline' : 'Plan'}>
        {rootStep ? (
          <li className="plan-step level-0">
            {(rootStep.trigger || rootStep.or) && <span className="plan-when">{rootStep.or ? 'Or' : `If ${rootStep.trigger}`}</span>}
            <Option step={rootStep} path={at} level={0} marker={null} choice={false} root />
          </li>
        ) : (
          <Choices list={plan} base={[]} level={0} numbered />
        )}
      </ol>
      {!onEdit && !small && !draft && foldable && (
        <button type="button" className="btn ghost small plan-all" aria-pressed={all} onClick={() => setAll(!all)}>
          {all ? 'Fold the branches' : `Show all ${total} steps`}
        </button>
      )}
    </OutlineContext.Provider>
  );
}

/** A list of steps, each drawn with its alternatives. `only` picks which to draw (by where each starts). */
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
          <li key={'id' in first ? first.id : at[0]} className={`plan-step level-${Math.min(level, MAX_LEVEL)}${numbered ? ' numbered' : ''}`}>
            {!numbered && <span className="plan-when">{first.trigger ? `If ${first.trigger}` : 'Then'}</span>}
            {at.map((i, k) => (
              <Fragment key={i}>
                {k > 0 && <span className="plan-or">or</span>}
                <Option
                  step={list[i]!}
                  path={[...base, i]}
                  level={level}
                  marker={numbered && k === 0 ? String(n + 1) : null}
                  letter={choice ? String.fromCharCode(65 + k) : null}
                  choice={choice}
                  second={k > 0}
                />
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
  letter = null,
  choice,
  second = false,
  root = false,
}: {
  step: AnyStep;
  path: Path;
  level: number;
  /** Its number on the main line. */
  marker: string | null;
  /** A, B, C… when it's one of several alternatives. */
  letter?: string | null;
  choice: boolean;
  /** Not the first alternative: plan B and on. */
  second?: boolean;
  /** The step the view is opened on: always unfolded. */
  root?: boolean;
}) {
  const { onEdit, zoom, all, draft } = useContext(OutlineContext);
  // The main line shows its branches; deeper ones, and fallbacks, wait behind a tap unless the plan is short.
  const [unfolded, setOpen] = useState(all || (level === 0 && !second));
  const under = countSteps(step.children);
  // Deep in the tree there's no room left to indent: what's under this step opens on its own instead.
  const elsewhere = !!zoom && !root && under > 0 && level >= MAX_LEVEL;
  // While editing, every step shows, so each can be tapped.
  const open = !elsewhere && (root || unfolded || !!onEdit);
  const saved = 'id' in step ? step : null;
  const body = (
    <>
      <span className="plan-do">{step.action}</span>
      {saved && (saved.to || saved.continuesIn.length > 0) && (
        <span className="plan-meta">
          {saved.to && `→ ${saved.to.name}${saved.toRole ? ` (${ROLE_LABEL[saved.toRole].toLowerCase()})` : ''}`}
          {saved.continuesIn.map(a => (
            <span key={a.id}>
              {' '}
              · continues in <Link to={`/areas/${a.id}`}>{a.name}</Link>
            </span>
          ))}
        </span>
      )}
      {!saved && (step.technique || (step as Node).toName) && (
        <span className="plan-meta">
          {step.technique && step.technique.name.toLowerCase() !== step.action.toLowerCase() ? `Card: ${step.technique.name} ` : ''}
          {(step as Node).toName ? `→ ${(step as Node).toName}` : ''}
        </span>
      )}
      {step.note && <span className="plan-note">{step.note}</span>}
    </>
  );
  // In a branch, what comes next stays at this indent; one of several alternatives keeps its own steps under it.
  const flat = level >= 1 && !choice;
  return (
    <div className="plan-option">
      <div className="plan-line">
        {marker && <span className="plan-num">{marker}</span>}
        {letter && (
          <span className="plan-letter" aria-label={`Plan ${letter}`}>
            {letter}
          </span>
        )}
        {onEdit ? (
          <button type="button" className="plan-body" aria-label={`Edit step: ${step.action}`} onClick={() => onEdit.step(path)}>
            {body}
          </button>
        ) : step.technique && !draft ? (
          <Link className="plan-body" to={`/t/${step.technique.id}`}>
            {body}
          </Link>
        ) : (
          <div className="plan-body">{body}</div>
        )}
        {step.technique && !draft && <RankBar status={step.technique.status} />}
        {under > 0 && !root && (elsewhere || !onEdit) && (
          <button
            type="button"
            className="plan-fold"
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
        <div className="plan-add">
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
        </div>
      )}
      {open && step.children.length > 0 && (
        <>
          {(!flat || step.children.some(c => !c.or && c.trigger)) && (
            <ol className="plan-branches">
              <Choices list={step.children} base={path} level={level + 1} only={flat ? first => !!first.trigger : undefined} />
            </ol>
          )}
          {flat && step.children.some(c => !c.or && !c.trigger) && (
            <ol className="plan-then">
              <Choices list={step.children} base={path} level={level} only={first => !first.trigger} />
            </ol>
          )}
        </>
      )}
    </div>
  );
}

// ---------- editing ----------

/** Editing state on an area's page: which step's sheet is open, if any. */
type StepEdit = { path: Path; mode: 'edit' } | { path: Path; mode: 'then' | 'branch' | 'or' } | { path: null; mode: 'first' };

/**
 * The plan section of an area's page: the outline, and editing it a step at a time. Every change saves the
 * whole plan at once, with Undo.
 */
export function PlanSection({ area }: { area: AreaDetail }) {
  const [editing, setEditing] = useState(false);
  const [step, setStep] = useState<StepEdit | null>(null);
  const [describing, setDescribing] = useState(false);
  const [startOpen, setStartOpen] = useState(false);
  const edit = useEditArea();
  const toast = useToast();
  const tree = fromPlan(area.plan);

  const save = (next: Node[], done: string, after?: () => void) =>
    edit.mutate(
      { id: area.id, plan: toInput(next) },
      {
        onSuccess: () => {
          toast.show(done, { undoable: true });
          after?.();
        },
        onError: toast.error,
      },
    );

  const current = step?.mode === 'edit' ? siblingsAt(tree, step.path)[step.path.at(-1)!]! : null;

  return (
    <>
      <div className="row-split section-row">
        <h2 className="section-title grow">Plan</h2>
        {area.plan.length > 0 ? (
          <button type="button" className="btn ghost small" aria-pressed={editing} onClick={() => setEditing(!editing)}>
            {editing ? 'Done' : 'Edit'}
          </button>
        ) : null}
        <button type="button" className="btn ghost small" onClick={() => setDescribing(true)}>
          Describe it
        </button>
      </div>

      <button type="button" className="plan-start" onClick={() => setStartOpen(true)}>
        {area.start || area.premise ? (
          <>
            <span className="plan-start-label">Starts</span>
            {area.start ? (
              <>
                {' '}
                in <strong>{area.start.name}</strong>
                {area.startRole ? `, ${ROLE_LABEL[area.startRole].toLowerCase()}` : ''}
              </>
            ) : null}
            {area.premise && <span className="plan-premise">When {lowerFirst(area.premise)}</span>}
          </>
        ) : (
          <span className="muted">Where does it start? Add a position and the situation it's for.</span>
        )}
      </button>

      {area.plan.length > 0 ? (
        <section className="panel plan-panel">
          <PlanOutline
            plan={area.plan}
            onEdit={editing ? { step: path => setStep({ path, mode: 'edit' }), add: (path, kind) => setStep({ path, mode: kind }) } : undefined}
          />
          {editing && (
            <div className="plan-add plan-add-end">
              <button type="button" className="btn ghost small" onClick={() => setStep({ path: [choiceAt(tree, tree.length - 1)[0]], mode: 'then' })}>
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
            step.mode === 'edit' ? 'Edit step' : step.mode === 'branch' ? 'If they…' : step.mode === 'or' ? 'Or…' : step.mode === 'first' ? 'First step' : 'Then…'
          }
          initial={current}
          askWhen={step.mode === 'branch' || (step.mode === 'edit' && step.path.length > 1 && !current!.or)}
          following={step.mode === 'edit' ? countSteps(current!.children) : 0}
          busy={edit.isPending}
          onClose={() => setStep(null)}
          onSave={node => {
            const next = clone(tree);
            if (step.mode === 'first') next.push(node);
            else if (step.mode === 'edit') {
              const list = siblingsAt(next, step.path);
              const i = step.path.at(-1)!;
              list[i] = { ...node, or: list[i]!.or, children: list[i]!.children };
            } else {
              const list = siblingsAt(next, step.path);
              const i = step.path.at(-1)!;
              const at = list[i]!;
              const [, end] = choiceAt(list, i);
              // "Or" is one more alternative to this step, after the ones it has.
              if (step.mode === 'or') list.splice(end, 0, { ...node, or: true, trigger: null });
              // "Then" on the main line is the next main-line step (whichever alternative was used); under an
              // alternative, or inside a branch, it's what follows that step.
              else if (step.mode === 'then' && step.path.length === 1 && !at.or) list.splice(end, 0, node);
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
            step.mode === 'edit' && current!.or
              ? () => {
                  const next = clone(tree);
                  const list = siblingsAt(next, step.path);
                  const i = step.path.at(-1)!;
                  const [start] = choiceAt(list, i);
                  const [mine] = list.splice(i, 1);
                  const was = list[start]!;
                  list[start] = { ...was, or: true, trigger: null };
                  list.splice(start, 0, { ...mine!, or: false, trigger: was.trigger });
                  save(next, 'Now plan A', () => setStep(null));
                }
              : undefined
          }
        />
      )}
      {startOpen && <StartSheet area={area} onClose={() => setStartOpen(false)} />}
      {describing && <DescribeSheet area={area} onClose={() => setDescribing(false)} />}
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

/** Where the plan starts and the situation it's for. */
function StartSheet({ area, onClose }: { area: AreaDetail; onClose: () => void }) {
  const [start, setStart] = useState<number | null>(area.start?.id ?? null);
  const [role, setRole] = useState<Role | null>(area.startRole);
  const [premise, setPremise] = useState(area.premise ?? '');
  const edit = useEditArea();
  const toast = useToast();
  return (
    <Sheet title="Where it starts" onClose={onClose}>
      <form
        onSubmit={e => {
          e.preventDefault();
          edit.mutate(
            { id: area.id, startPositionId: start, startRole: start ? role : null, premise: premise.trim() || null },
            {
              onSuccess: () => {
                toast.show('Saved', { undoable: true });
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

/** Say the plan in your own words; Claude outlines it; check it, then save it (replacing the plan). */
function DescribeSheet({ area, onClose }: { area: AreaDetail; onClose: () => void }) {
  const [text, setText] = useState('');
  const draft = useDraftPlan();
  const edit = useEditArea();
  const toast = useToast();
  const d = draft.data;
  const tree = d ? fromDraft(d) : [];
  return (
    <Sheet title="Describe the plan" onClose={onClose}>
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
          {area.plan.length > 0 && <p className="muted small">You'll see the outline before it replaces the plan you have.</p>}
        </form>
      ) : (
        <>
          {(d.start || d.premise) && (
            <p className="plan-start static">
              <span className="plan-start-label">Starts</span>
              {d.start && (
                <>
                  {' '}
                  in <strong>{d.start.name}</strong>
                  {d.startRole ? `, ${d.startRole}` : ''}
                </>
              )}
              {d.premise && <span className="plan-premise">When {lowerFirst(d.premise)}</span>}
            </p>
          )}
          <section className="panel plan-panel">
            {tree.length ? <PlanOutline plan={tree} draft /> : <div className="empty">Claude didn't find any steps in that.</div>}
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
                    id: area.id,
                    plan: toInput(tree),
                    ...(d.start ? { startPositionId: d.start.id, startRole: d.startRole } : {}),
                    ...(d.premise ? { premise: d.premise } : {}),
                  },
                  {
                    onSuccess: () => {
                      toast.show('Plan saved', { undoable: true });
                      onClose();
                    },
                    onError: toast.error,
                  },
                )
              }
            >
              Save plan
            </button>
          </div>
        </>
      )}
    </Sheet>
  );
}
