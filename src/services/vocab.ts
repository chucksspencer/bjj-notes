// Allowed values, shared by the MCP tool schemas, the capture parser and the services.

export const TECHNIQUE_TYPES = [
  'submission',
  'sweep',
  'pass',
  'escape',
  'transition',
  'takedown',
  'retention',
  'control',
  'entry',
  'counter',
  'concept',
] as const;
export type TechniqueType = (typeof TECHNIQUE_TYPES)[number];

export const ROLES = ['top', 'bottom', 'neutral'] as const;
export type Role = (typeof ROLES)[number];

export const GI = ['gi', 'nogi', 'both'] as const;

export const STATUSES = ['seen', 'learning', 'drilling', 'hitting', 'reliable'] as const;

export const LINK_KINDS = ['chain', 'counter', 'variation', 'setup', 'related'] as const;

export const NOTE_KINDS = ['instruction', 'rolling', 'drilling', 'question', 'idea'] as const;
export type NoteKind = (typeof NOTE_KINDS)[number];

export const SOURCE_KINDS = ['class', 'youtube', 'instagram', 'instructional', 'book', 'article', 'other'] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];

export const SESSION_KINDS = ['class', 'open_mat', 'private', 'seminar', 'competition', 'drilling', 'other'] as const;

export const FOCUS_ACTIONS = ['add', 'move', 'resume', 'pause', 'backlog', 'complete', 'drop'] as const;
export type FocusAction = (typeof FOCUS_ACTIONS)[number];

/** Technique types you'd expect to have from each kind of position, used to point out gaps. */
export const EXPECTED_BY_CATEGORY: Record<string, Partial<Record<Role, TechniqueType[]>>> = {
  guard: { top: ['pass', 'submission'], bottom: ['sweep', 'submission', 'retention'] },
  pin: { top: ['transition', 'submission'], bottom: ['escape'] },
  back: { top: ['submission'], bottom: ['escape'] },
  leg: { neutral: ['submission', 'escape'], top: ['submission'], bottom: ['submission', 'escape'] },
  transitional: { top: ['transition', 'submission'], bottom: ['escape'] },
  standing: { neutral: ['takedown'] },
};

export function guessSourceKind(url: string): SourceKind {
  const host = (() => {
    try {
      return new URL(url).hostname.replace(/^www\./, '');
    } catch {
      return '';
    }
  })();
  if (host === 'youtu.be' || host.endsWith('youtube.com')) return 'youtube';
  if (host.endsWith('instagram.com')) return 'instagram';
  return 'other';
}

/** Today's date (YYYY-MM-DD) in the given IANA time zone, so late-evening notes land on the right day. */
export function todayIn(timeZone: string, now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

export function isoDate(d: Date | string): string {
  if (typeof d === 'string') return d.slice(0, 10);
  return d.toISOString().slice(0, 10);
}

/** The date `days` before a YYYY-MM-DD date. */
export function minusDays(date: string, days: number): string {
  return isoDate(new Date(Date.parse(`${date}T12:00:00Z`) - days * 86_400_000));
}

export function daysAgo(date: string | null, today = new Date()): string {
  if (!date) return 'no notes yet';
  const ms = Date.parse(isoDate(today)) - Date.parse(date);
  const days = Math.round(ms / 86_400_000);
  if (days <= 0) return 'last note today';
  if (days === 1) return 'last note yesterday';
  return `last note ${days} days ago`;
}
