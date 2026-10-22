import type { BeltRank } from '../../../src/shared/api';

export const BELT_RANKS: BeltRank[] = ['white', 'blue', 'purple', 'brown', 'black'];

/** "Blue belt" */
export const beltName = (b: BeltRank) => `${b.charAt(0).toUpperCase()}${b.slice(1)} belt`;

/**
 * Colours the app for a belt (see the belt blocks at the top of styles.css). Without one (signed out)
 * the app is black with a red bar, like its icon.
 */
export function applyBelt(belt: BeltRank | null | undefined) {
  const root = document.documentElement;
  if (belt) root.dataset.belt = belt;
  else delete root.dataset.belt;
}
