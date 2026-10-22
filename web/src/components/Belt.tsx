import type { Status } from '../../../src/shared/api';
import { STATUS_LABEL, STATUSES, stripesFor } from '../lib/format';

/** Small rank bar with four stripes (black, or red on a black belt): how well a technique is known, at a glance. */
export function RankBar({ status }: { status: Status }) {
  const n = stripesFor(status);
  return (
    <span className="rank-bar" role="img" aria-label={`${STATUS_LABEL[status]} (${n} of 4 stripes)`}>
      {[1, 2, 3, 4].map(i => (
        <span key={i} className={`stripe${i <= n ? ' on' : ''}`} />
      ))}
    </span>
  );
}

/**
 * The belt: tap a stripe to set the status. Tapping the highest lit stripe takes one off,
 * so every level (including "seen", no stripes) is reachable.
 */
export function Belt({ status, onChange, disabled }: { status: Status; onChange: (s: Status) => void; disabled?: boolean }) {
  const n = stripesFor(status);
  return (
    <div>
      <div className="belt">
        <div className="weave" aria-hidden />
        <div className="bar" role="group" aria-label="Stripes">
          {[1, 2, 3, 4].map(i => {
            const next = i === n ? STATUSES[i - 1]! : STATUSES[i]!;
            return (
              <button
                key={i}
                type="button"
                className={`tape${i <= n ? ' on' : ''}`}
                aria-pressed={i <= n}
                aria-label={`${i} stripe${i > 1 ? 's' : ''}: ${STATUS_LABEL[STATUSES[i]!]}`}
                disabled={disabled}
                onClick={() => onChange(next)}
              />
            );
          })}
        </div>
      </div>
      <div className="belt-caption">
        <strong>{STATUS_LABEL[status]}</strong>
        <span className="muted small">Tap the stripes to change</span>
      </div>
    </div>
  );
}

/** The app's mark: the end of the belt (the signed-in person's; black with a red bar otherwise) and its rank bar. */
export function BeltMark() {
  return (
    <span className="belt-mark" aria-hidden>
      <span className="belt-mark-bar">
        <span />
        <span />
      </span>
    </span>
  );
}
