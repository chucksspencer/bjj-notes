// Reading a game plan's steps: the outline, its slots with their options side by side, and each step's line.
import { createContext, Fragment, useContext, useState } from 'react';
import { Link } from 'react-router';
import type { StepMove } from '../../../../src/shared/api';
import { countSteps, findStep, type Slot } from '../../../../src/shared/steps';
import { ROLE_LABEL } from '../../lib/format';
import { RankBar } from '../Belt';
import { Icon } from '../Icon';
import type { AnyStep, Moves } from './model';

export interface Outline {
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
