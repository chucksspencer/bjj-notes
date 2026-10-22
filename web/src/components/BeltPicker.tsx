import { useId } from 'react';
import type { BeltRank } from '../../../src/shared/api';
import { BELT_RANKS, beltName } from '../lib/belt';

/** A belt drawn in its own colours, whatever the app's theme: the end of the belt and its rank bar. */
export function BeltSwatch({ belt, small }: { belt: BeltRank; small?: boolean }) {
  return (
    <span className={`belt-swatch${small ? ' small' : ''}`} data-belt={belt} aria-hidden>
      <span className="belt-swatch-bar" />
    </span>
  );
}

/** Pick one of the five belts. */
export function BeltPicker({
  value,
  onChange,
  disabled,
  label,
}: {
  value: BeltRank;
  onChange: (b: BeltRank) => void;
  disabled?: boolean;
  label: string;
}) {
  const name = useId();
  return (
    <fieldset className="belt-picker" disabled={disabled}>
      <legend className="visually-hidden">{label}</legend>
      {BELT_RANKS.map(b => (
        <label key={b} className="belt-option">
          <input
            type="radio"
            className="visually-hidden"
            name={name}
            value={b}
            checked={value === b}
            aria-label={beltName(b)}
            onChange={() => onChange(b)}
          />
          <BeltSwatch belt={b} />
          <span className="belt-option-name">{b.charAt(0).toUpperCase() + b.slice(1)}</span>
        </label>
      ))}
    </fieldset>
  );
}
