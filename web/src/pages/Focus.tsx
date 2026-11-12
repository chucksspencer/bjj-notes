import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import type { AreaView, TechniqueRef } from '../../../src/shared/api';
import { useAreas, useCreateArea, useFocus, useFocusAction } from '../api';
import { DescriptionField, FocusControls } from '../components/AreaControls';
import { Icon } from '../components/Icon';
import { Sheet } from '../components/Sheet';
import { TechniquePicker } from '../components/TechniquePicker';
import { useToast } from '../components/Toast';
import { firstLine, isQuiet, lastNoteText } from '../lib/format';
import { FocusHeader } from './Lab';

/** The focus list: the areas you're working on now, most important first. */
export function Focus() {
  const focus = useFocus();
  const [open, setOpen] = useState<number | null>(null);
  const [adding, setAdding] = useState(false);
  const view = focus.data;

  return (
    <div className="page band-page">
      <FocusHeader
        title="Focus"
        summary="The long game: what to work on over the coming weeks and months, most important first."
        action={
          <button type="button" className="btn small" onClick={() => setAdding(true)}>
            <Icon name="plus" size={18} />
            Add
          </button>
        }
      />

      {focus.isError && <div className="panel empty">Couldn't load your focus list. {focus.error.message}</div>}
      {view && (
        <>
          <section className="panel" aria-label="Working on">
            {view.active.length === 0 && (
              <div className="empty">Nothing on your focus list yet. Add what you're working on, most important first.</div>
            )}
            {view.active.map(item => (
              <FocusRow
                key={item.id}
                item={item}
                count={view.active.length}
                today={view.today}
                expanded={open === item.id}
                onToggle={() => setOpen(open === item.id ? null : item.id)}
              />
            ))}
          </section>
          <p className="section-hint list-foot">
            Areas you've moved on from stay in <Link to="/game">Game</Link>, plans and notes included.
          </p>
        </>
      )}

      {adding && <AddToFocus onClose={() => setAdding(false)} />}
    </div>
  );
}

function FocusRow({
  item,
  count,
  today,
  expanded,
  onToggle,
}: {
  item: AreaView;
  count: number;
  today: string;
  expanded: boolean;
  onToggle: () => void;
}) {
  const quiet = isQuiet(item.lastNoteOn, today);
  const gist = firstLine(item.premise ? `When ${item.premise.charAt(0).toLowerCase()}${item.premise.slice(1)}` : item.description);
  const meta = [lastNoteText(item.lastNoteOn, today), item.stepCount ? `plan of ${item.stepCount} step${item.stepCount === 1 ? '' : 's'}` : null]
    .filter(Boolean)
    .join(' · ');

  return (
    <div className={`row focus-row${quiet ? ' quiet' : ''}`}>
      <span className="focus-rank" aria-label={`Number ${item.rank}`}>
        {item.rank}
      </span>
      <div>
        <Link className="row-title" to={`/areas/${item.id}`}>
          {item.name}
        </Link>
        <span className="row-meta">{meta}</span>
        {gist && <span className="focus-gist">{gist}</span>}
      </div>
      <button type="button" className="btn ghost focus-more" aria-expanded={expanded} aria-label={`Change ${item.name}`} onClick={onToggle}>
        <Icon name="more" />
      </button>
      {expanded && <FocusControls area={item} count={count} compact />}
    </div>
  );
}

/** Put an area you have back on focus, or start a new one. */
function AddToFocus({ onClose }: { onClose: () => void }) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [techniques, setTechniques] = useState<TechniqueRef[]>([]);
  const [top, setTop] = useState(true);
  const areas = useAreas();
  const create = useCreateArea();
  const act = useFocusAction();
  const toast = useToast();
  const navigate = useNavigate();
  const words = name.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const off = (areas.data?.areas ?? []).filter(a => a.rank === null);
  const matching = words.length ? off.filter(a => words.every(w => [a.name, ...a.aliases].some(n => n.toLowerCase().includes(w)))) : off;
  const position = top ? 1 : 999;

  return (
    <Sheet title="Add to focus" onClose={onClose}>
      <form
        onSubmit={e => {
          e.preventDefault();
          const label = name.trim() || techniques[0]?.name;
          if (!label) return;
          create.mutate(
            { name: label, description: description.trim() || undefined, techniqueIds: techniques.map(t => t.id), position },
            {
              onSuccess: r => {
                toast.show(`Added ${label}`, { undoable: true });
                onClose();
                // A new area with nothing in it yet: open it, to describe it or give it a plan.
                if (!r.area.techniques.length && !r.area.description) navigate(`/areas/${r.area.id}`);
              },
              onError: toast.error,
            },
          );
        }}
      >
        <label className="field">
          <span className="label">What are you working on?</span>
          <input
            className="input"
            autoFocus
            placeholder="Stop getting flattened in half guard"
            value={name}
            onChange={e => setName(e.target.value)}
          />
        </label>
        {matching.length > 0 && (
          <div className="field">
            <span className="label">{words.length ? 'Areas you have' : 'Back on focus'}</span>
            <div className="panel">
              {matching.slice(0, 5).map(a => (
                <div key={a.id} className="row row-split">
                  <span className="grow">
                    <span className="row-title">{a.name}</span>
                    {a.stepCount > 0 && <span className="row-meta">Plan of {a.stepCount} steps</span>}
                  </span>
                  <button
                    type="button"
                    className="btn quiet small"
                    disabled={act.isPending}
                    onClick={() =>
                      act.mutate(
                        { id: a.id, action: 'add', position },
                        {
                          onSuccess: () => {
                            toast.show(`${a.name} is back on focus`, { undoable: true });
                            onClose();
                          },
                          onError: toast.error,
                        },
                      )
                    }
                  >
                    Put on focus
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}
        <DescriptionField value={description} onChange={setDescription} />
        <TechniquePicker label="Technique cards (optional)" selected={techniques} onChange={setTechniques} />
        <div className="field">
          <span className="label">Where on the list</span>
          <div className="segments">
            <button type="button" className="segment" aria-pressed={top} onClick={() => setTop(true)}>
              At the top
            </button>
            <button type="button" className="segment" aria-pressed={!top} onClick={() => setTop(false)}>
              At the bottom
            </button>
          </div>
        </div>
        <button className="btn block" type="submit" disabled={create.isPending || !(name.trim() || techniques.length)}>
          Add as a new area
        </button>
      </form>
    </Sheet>
  );
}
