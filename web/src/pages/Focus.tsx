import { useState } from 'react';
import { Link } from 'react-router';
import type { FocusItemView, TechniqueRef } from '../../../src/shared/api';
import { useAddFocus, useFocus, useFocusAction } from '../api';
import { DescriptionField, FocusActions, FocusEditSheet } from '../components/FocusControls';
import { Icon } from '../components/Icon';
import { Sheet } from '../components/Sheet';
import { TechniquePicker } from '../components/TechniquePicker';
import { useToast } from '../components/Toast';
import { firstLine, isQuiet, lastNoteText } from '../lib/format';
import { FocusHeader } from './Lab';

export function Focus() {
  const focus = useFocus();
  const [open, setOpen] = useState<number | null>(null);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<FocusItemView | null>(null);
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
            {view.active.map((item, i) => (
              <FocusRow
                key={item.id}
                item={item}
                today={view.today}
                first={i === 0}
                last={i === view.active.length - 1}
                expanded={open === item.id}
                onToggle={() => setOpen(open === item.id ? null : item.id)}
                onEdit={() => setEditing(item)}
              />
            ))}
          </section>

          {view.paused.length > 0 && <OffList title="Paused" items={view.paused} />}
          {view.backlog.length > 0 && <OffList title="Backlog" items={view.backlog} />}
        </>
      )}

      {adding && <AddFocus onClose={() => setAdding(false)} />}
      {editing && <FocusEditSheet item={editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

function FocusRow({
  item,
  today,
  first,
  last,
  expanded,
  onToggle,
  onEdit,
}: {
  item: FocusItemView;
  today: string;
  first: boolean;
  last: boolean;
  expanded: boolean;
  onToggle: () => void;
  onEdit: () => void;
}) {
  const quiet = isQuiet(item.lastNoteOn, today);
  const gist = firstLine(item.description);

  return (
    <div className={`row focus-row${quiet ? ' quiet' : ''}`}>
      <span className="focus-rank" aria-label={`Number ${item.rank}`}>
        {item.rank}
      </span>
      <div>
        <Link className="row-title" to={`/focus/${item.id}`}>
          {item.label}
        </Link>
        <span className="row-meta">{lastNoteText(item.lastNoteOn, today)}</span>
        {gist && <span className="focus-gist">{gist}</span>}
        {item.techniques.length > 0 && (
          <div className="chips">
            {item.techniques.map(t => (
              <Link key={t.id} className="chip" to={`/t/${t.id}`}>
                {t.name}
              </Link>
            ))}
          </div>
        )}
      </div>
      <button type="button" className="btn ghost focus-more" aria-expanded={expanded} aria-label={`Change ${item.label}`} onClick={onToggle}>
        <Icon name="more" />
      </button>
      {expanded && <FocusActions item={item} first={first} last={last} onEdit={onEdit} />}
    </div>
  );
}

function OffList({ title, items }: { title: string; items: FocusItemView[] }) {
  const act = useFocusAction();
  const toast = useToast();
  return (
    <>
      <h2 className="section-title">{title}</h2>
      <section className="panel" aria-label={title}>
        {items.map(item => (
          <div key={item.id} className="row row-split">
            <span className="grow">
              <Link className="row-title" to={`/focus/${item.id}`}>
                {item.label}
              </Link>
            </span>
            <button
              type="button"
              className="btn quiet small"
              disabled={act.isPending}
              onClick={() =>
                act.mutate(
                  { id: item.id, action: 'resume', position: 1 },
                  { onSuccess: () => toast.show(`${item.label} is back at the top`, { undoable: true }), onError: toast.error },
                )
              }
            >
              Resume
            </button>
          </div>
        ))}
      </section>
    </>
  );
}

function AddFocus({ onClose }: { onClose: () => void }) {
  const [label, setLabel] = useState('');
  const [description, setDescription] = useState('');
  const [techniques, setTechniques] = useState<TechniqueRef[]>([]);
  const [top, setTop] = useState(true);
  const add = useAddFocus();
  const toast = useToast();
  return (
    <Sheet title="Add to focus" onClose={onClose}>
      <form
        onSubmit={e => {
          e.preventDefault();
          const name = label.trim() || techniques[0]?.name;
          if (!name) return;
          add.mutate(
            { label: name, description: description.trim() || undefined, techniqueIds: techniques.map(t => t.id), position: top ? 1 : 999 },
            {
              onSuccess: () => {
                toast.show(`Added ${name}`, { undoable: true });
                onClose();
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
            value={label}
            onChange={e => setLabel(e.target.value)}
          />
        </label>
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
        <button className="btn block" type="submit" disabled={add.isPending || !(label.trim() || techniques.length)}>
          Add to focus
        </button>
      </form>
    </Sheet>
  );
}
