import { useState } from 'react';
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
      trigger: n.trigger,
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

const countSteps = (nodes: Node[]): number => nodes.reduce((n, s) => n + 1 + countSteps(s.children), 0);

// ---------- reading ----------

/** The plan as an outline: the main line numbered, branches under the step they follow. Deeper ones open on tap. */
export function PlanOutline({
  plan,
  onEdit,
}: {
  plan: PlanStep[];
  /** Given while editing: tapping a step edits it, and each step offers "Then" and "If they…". */
  onEdit?: {
    step: (path: Path) => void;
    add: (path: Path, kind: 'then' | 'branch') => void;
  };
}) {
  return (
    <ol className={`plan${onEdit ? ' editing' : ''}`} aria-label="Plan">
      {plan.map((s, i) => (
        <StepItem key={s.id} step={s} path={[i]} onEdit={onEdit} />
      ))}
    </ol>
  );
}

function StepItem({ step, path, onEdit }: { step: PlanStep; path: Path; onEdit?: Parameters<typeof PlanOutline>[0]['onEdit'] }) {
  const depth = path.length - 1;
  // Two levels show; anything deeper waits behind a tap, so the outline stays readable on a phone.
  const [unfolded, setOpen] = useState(depth < 1);
  // While editing, every step shows, so each can be tapped.
  const open = unfolded || !!onEdit;
  const hidden = countSteps(fromPlan(step.children));
  const body = (
    <>
      {step.trigger && <span className="plan-when">If {step.trigger}</span>}
      <span className="plan-do">{step.action}</span>
      {(step.to || step.continuesIn.length > 0) && (
        <span className="plan-meta">
          {step.to && `→ ${step.to.name}${step.toRole ? ` (${ROLE_LABEL[step.toRole].toLowerCase()})` : ''}`}
          {step.continuesIn.map(a => (
            <span key={a.id}>
              {' '}
              · continues in <Link to={`/areas/${a.id}`}>{a.name}</Link>
            </span>
          ))}
        </span>
      )}
      {step.note && <span className="plan-note">{step.note}</span>}
    </>
  );
  return (
    <li className={`plan-step depth-${Math.min(depth, 3)}`}>
      <div className="plan-line">
        {depth === 0 && <span className="plan-num">{path[0]! + 1}</span>}
        {onEdit ? (
          <button type="button" className="plan-body" aria-label={`Edit step: ${step.action}`} onClick={() => onEdit.step(path)}>
            {body}
          </button>
        ) : step.technique ? (
          <Link className="plan-body" to={`/t/${step.technique.id}`}>
            {body}
          </Link>
        ) : (
          <div className="plan-body">{body}</div>
        )}
        {step.technique && <RankBar status={step.technique.status} />}
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
        </div>
      )}
      {step.children.length > 0 &&
        (open ? (
          <ol className="plan-branches">
            {step.children.map((c, i) => (
              <StepItem key={c.id} step={c} path={[...path, i]} onEdit={onEdit} />
            ))}
          </ol>
        ) : (
          <button type="button" className="btn ghost small plan-more" aria-expanded={false} onClick={() => setOpen(true)}>
            {hidden} more step{hidden === 1 ? '' : 's'}
            <Icon name="chevron" size={16} />
          </button>
        ))}
    </li>
  );
}

// ---------- editing ----------

/** Editing state on an area's page: which step's sheet is open, if any. */
type StepEdit = { path: Path; mode: 'edit' } | { path: Path; mode: 'then' | 'branch' } | { path: null; mode: 'first' };

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
              <button type="button" className="btn ghost small" onClick={() => setStep({ path: [tree.length - 1], mode: 'then' })}>
                <Icon name="plus" size={16} />
                Add a step at the end
              </button>
            </div>
          )}
        </section>
      ) : (
        <>
          <p className="section-hint">
            The steps, in order, and what to do when they react. Describe it in your own words, or build it a step at a time.
          </p>
          <button type="button" className="btn quiet small section-action" onClick={() => setStep({ path: null, mode: 'first' })}>
            <Icon name="plus" size={18} />
            First step
          </button>
        </>
      )}

      {step && (
        <StepSheet
          title={step.mode === 'edit' ? 'Edit step' : step.mode === 'branch' ? 'If they…' : step.mode === 'first' ? 'First step' : 'Then…'}
          initial={current}
          askWhen={step.mode === 'branch' || (step.mode === 'edit' && step.path.length > 1)}
          following={step.mode === 'edit' ? countSteps(current!.children) : 0}
          busy={edit.isPending}
          onClose={() => setStep(null)}
          onSave={node => {
            const next = clone(tree);
            if (step.mode === 'first') next.push(node);
            else if (step.mode === 'edit') {
              const list = siblingsAt(next, step.path);
              const i = step.path.at(-1)!;
              list[i] = { ...node, children: list[i]!.children };
            } else {
              const list = siblingsAt(next, step.path);
              const at = list[step.path.at(-1)!]!;
              // "Then" on the main line is the next main-line step; inside a branch it's what follows that step.
              if (step.mode === 'then' && step.path.length === 1) list.splice(step.path[0]! + 1, 0, node);
              else at.children.push(node);
            }
            save(next, step.mode === 'edit' ? 'Step saved' : 'Step added', () => setStep(null));
          }}
          onDelete={
            step.mode === 'edit'
              ? () => {
                  const next = clone(tree);
                  siblingsAt(next, step.path).splice(step.path.at(-1)!, 1);
                  save(next, 'Step deleted', () => setStep(null));
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
            {tree.length ? <DraftOutline nodes={tree} /> : <div className="empty">Claude didn't find any steps in that.</div>}
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

/** A drafted outline, read-only (cards it matched are named). */
function DraftOutline({ nodes, depth = 0 }: { nodes: Node[]; depth?: number }) {
  return (
    <ol className={depth ? 'plan-branches' : 'plan'}>
      {nodes.map((n, i) => (
        <li key={i} className={`plan-step depth-${Math.min(depth, 3)}`}>
          <div className="plan-line">
            {depth === 0 && <span className="plan-num">{i + 1}</span>}
            <div className="plan-body">
              {n.trigger && <span className="plan-when">If {n.trigger}</span>}
              <span className="plan-do">{n.action}</span>
              {(n.technique || n.toName) && (
                <span className="plan-meta">
                  {n.technique && n.technique.name.toLowerCase() !== n.action.toLowerCase() ? `Card: ${n.technique.name} ` : ''}
                  {n.toName ? `→ ${n.toName}` : ''}
                </span>
              )}
              {n.note && <span className="plan-note">{n.note}</span>}
            </div>
          </div>
          {n.children.length > 0 && <DraftOutline nodes={n.children} depth={depth + 1} />}
        </li>
      ))}
    </ol>
  );
}
