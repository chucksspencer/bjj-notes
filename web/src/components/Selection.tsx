import { useEffect, useState } from 'react';

export interface Selection {
  /** Whether the list is in select mode. */
  active: boolean;
  /** Picked ids that are still on screen (a filter can hide some). */
  ids: number[];
  has: (id: number) => boolean;
  toggle: (id: number) => void;
  start: () => void;
  stop: () => void;
  /** Every item on screen is picked. */
  all: boolean;
  toggleAll: () => void;
}

/** Picking several items on a list, e.g. to delete them together. Escape leaves select mode. */
export function useSelection(visibleIds: number[]): Selection {
  const [active, setActive] = useState(false);
  const [picked, setPicked] = useState<ReadonlySet<number>>(new Set());
  const ids = visibleIds.filter(id => picked.has(id));
  const all = visibleIds.length > 0 && ids.length === visibleIds.length;
  const stop = () => {
    setActive(false);
    setPicked(new Set());
  };

  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setActive(false);
        setPicked(new Set());
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active]);

  return {
    active,
    ids,
    has: id => picked.has(id),
    toggle: id =>
      setPicked(prev => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      }),
    start: () => {
      setPicked(new Set());
      setActive(true);
    },
    stop,
    all,
    toggleAll: () => setPicked(all ? new Set() : new Set(visibleIds)),
  };
}

/** Floating bar above the tabs while selecting: how many are picked, select all, delete. */
export function SelectionBar({
  selection,
  noun,
  busy,
  onDelete,
  action = 'Delete',
}: {
  selection: Selection;
  noun: string;
  busy?: boolean;
  onDelete: () => void;
  /** The button's label, e.g. "Toss". */
  action?: string;
}) {
  if (!selection.active) return null;
  const n = selection.ids.length;
  return (
    <div className="select-bar" role="toolbar" aria-label="Selection">
      <span className="select-count" aria-live="polite">
        {n ? `${n} selected` : `Select ${noun}`}
      </span>
      <button type="button" className="btn ghost small" onClick={selection.toggleAll}>
        {selection.all ? 'Select none' : 'Select all'}
      </button>
      <button type="button" className="btn small destroy" disabled={!n || busy} onClick={onDelete}>
        {action}
      </button>
    </div>
  );
}

/** "3 techniques", "1 note" */
export const countOf = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`;
