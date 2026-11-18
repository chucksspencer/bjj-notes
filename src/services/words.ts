// Small helpers for the sentences the services say.

/** "1 note", "3 notes". */
export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
export const capitalise = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);
/** Trimmed text, or null when there's nothing left. */
export const clean = (t: string | null | undefined) => t?.trim() || null;
