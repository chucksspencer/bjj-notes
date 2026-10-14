import type { LinkKind, NoteKind, PositionCategory, Role, Status, TechniqueType } from '../../../src/shared/api';

export const STATUSES: Status[] = ['seen', 'learning', 'drilling', 'hitting', 'reliable'];
export const STATUS_LABEL: Record<Status, string> = {
  seen: 'Seen',
  learning: 'Learning',
  drilling: 'Drilling',
  hitting: 'Hitting it live',
  reliable: 'Reliable',
};
export const stripesFor = (s: Status) => STATUSES.indexOf(s);

export const TYPES: TechniqueType[] = [
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
];
export const TYPE_LABEL: Record<TechniqueType, string> = {
  submission: 'Submission',
  sweep: 'Sweep',
  pass: 'Pass',
  escape: 'Escape',
  transition: 'Transition',
  takedown: 'Takedown',
  retention: 'Guard retention',
  control: 'Control',
  entry: 'Entry',
  counter: 'Counter',
  concept: 'Concept',
};
export const TYPE_PLURAL: Record<TechniqueType, string> = {
  submission: 'Submissions',
  sweep: 'Sweeps',
  pass: 'Passes',
  escape: 'Escapes',
  transition: 'Transitions',
  takedown: 'Takedowns',
  retention: 'Guard retention',
  control: 'Control',
  entry: 'Entries',
  counter: 'Counters',
  concept: 'Concepts',
};

export const ROLES: Role[] = ['top', 'bottom', 'neutral'];
export const ROLE_LABEL: Record<Role, string> = { top: 'Top', bottom: 'Bottom', neutral: 'Neutral' };

export const NOTE_KINDS: NoteKind[] = ['instruction', 'rolling', 'drilling', 'question', 'idea'];
export const NOTE_KIND_LABEL: Record<NoteKind, string> = {
  instruction: 'Taught',
  rolling: 'Rolling',
  drilling: 'Drilling',
  question: 'Question',
  idea: 'Idea',
};

export const CATEGORY_LABEL: Record<PositionCategory, string> = {
  guard: 'Guards',
  pin: 'Pins',
  back: 'Back',
  leg: 'Leg entanglements',
  transitional: 'In between',
  standing: 'Standing',
};
export const CATEGORY_ORDER: PositionCategory[] = ['guard', 'pin', 'back', 'leg', 'transitional', 'standing'];

/** How each link reads from this technique's point of view. */
export function linkPhrase(kind: LinkKind, direction: 'in' | 'out'): string {
  const out: Record<LinkKind, string> = {
    chain: 'Chains into',
    counter: 'Counters',
    variation: 'Variation of',
    setup: 'Sets up',
    related: 'Related to',
  };
  const inn: Record<LinkKind, string> = {
    chain: 'Follows',
    counter: 'Countered by',
    variation: 'Has variation',
    setup: 'Set up by',
    related: 'Related to',
  };
  return direction === 'out' ? out[kind] : inn[kind];
}

export const LINK_KINDS: { kind: LinkKind; label: string }[] = [
  { kind: 'chain', label: 'Chains into' },
  { kind: 'setup', label: 'Sets up' },
  { kind: 'counter', label: 'Counters' },
  { kind: 'variation', label: 'Variation of' },
  { kind: 'related', label: 'Related to' },
];

/** "Today", "Yesterday", "Mon", "Oct 3", "Oct 3, 2025". */
export function friendlyDate(iso: string, today: string): string {
  if (iso === today) return 'Today';
  const d = new Date(`${iso}T12:00:00Z`);
  const t = new Date(`${today}T12:00:00Z`);
  const days = Math.round((t.getTime() - d.getTime()) / 86_400_000);
  if (days === 1) return 'Yesterday';
  if (days > 1 && days < 7) return d.toLocaleDateString(undefined, { weekday: 'long', timeZone: 'UTC' });
  const sameYear = d.getUTCFullYear() === t.getUTCFullYear();
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }), timeZone: 'UTC' });
}

/** A date as it reads after a noun: "today", "yesterday", "on Monday", "on Oct 3, 2025". */
export function datePhrase(iso: string, today: string): string {
  const d = friendlyDate(iso, today);
  return d === 'Today' || d === 'Yesterday' ? d.toLowerCase() : `on ${d}`;
}

export function lastNoteText(iso: string | null, today: string): string {
  if (!iso) return 'No notes yet';
  const days = Math.round((Date.parse(`${today}T12:00:00Z`) - Date.parse(`${iso}T12:00:00Z`)) / 86_400_000);
  if (days <= 0) return 'Last note today';
  if (days === 1) return 'Last note yesterday';
  if (days < 7) return `Last note ${days} days ago`;
  if (days < 14) return 'Last note a week ago';
  if (days < 60) return `Last note ${Math.round(days / 7)} weeks ago`;
  return `Last note ${Math.round(days / 30)} months ago`;
}

/** How long ago a moment was: "today", "yesterday", "3 days ago", "2 weeks ago", "3 months ago". */
export function agoText(iso: string, now = Date.now()): string {
  const days = Math.floor((now - Date.parse(iso)) / 86_400_000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days} days ago`;
  if (days < 14) return 'a week ago';
  if (days < 60) return `${Math.round(days / 7)} weeks ago`;
  return `${Math.round(days / 30)} months ago`;
}

export const isQuiet = (iso: string | null, today: string) =>
  !iso || Date.parse(`${today}T12:00:00Z`) - Date.parse(`${iso}T12:00:00Z`) > 14 * 86_400_000;

export function localToday(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** "Submission, bottom" */
export function techniqueMeta(type: TechniqueType, role: Role | null): string {
  return role ? `${TYPE_LABEL[type]}, ${role}` : TYPE_LABEL[type];
}

/** "Pass, top, from half guard to side control": a technique's one-line description in lists. */
export function techniqueLine(
  type: TechniqueType,
  role: Role | null,
  edge?: { from: string | null; to: string | null; toRole: Role | null },
): string {
  const parts = [TYPE_LABEL[type], role];
  const lower = (n: string) => n.charAt(0).toLowerCase() + n.slice(1);
  if (edge?.from) parts.push(`from ${lower(edge.from)}${edge.to ? ` to ${lower(edge.to)}` : ''}`);
  else if (edge?.to) parts.push(`into ${lower(edge.to)}`);
  return parts.filter(Boolean).join(', ');
}

/** "From side control (bottom) to mount" */
export function edgeText(e: { from: string | null; fromRole: Role | null; to: string | null; toRole: Role | null }): string {
  const from = e.from ? `${e.from.charAt(0).toLowerCase()}${e.from.slice(1)}${e.fromRole ? ` (${e.fromRole})` : ''}` : null;
  const to = e.to ? `${e.to.charAt(0).toLowerCase()}${e.to.slice(1)}${e.toRole ? ` (${e.toRole})` : ''}` : e.toRole ? `${e.toRole}` : null;
  if (from && to) return `From ${from} to ${to}`;
  if (from) return `From ${from}`;
  if (to) return `Into ${to}`;
  return '';
}

// ---------- video ----------

export function youTubeId(url: string): string | null {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\.|^m\./, '');
    if (host === 'youtu.be') return u.pathname.slice(1).split('/')[0] || null;
    if (host.endsWith('youtube.com') || host.endsWith('youtube-nocookie.com')) {
      if (u.searchParams.get('v')) return u.searchParams.get('v');
      const m = u.pathname.match(/^\/(?:shorts|embed|live|v)\/([\w-]{6,})/);
      return m ? m[1]! : null;
    }
  } catch {
    // not a URL
  }
  return null;
}

/** "4:32", "1:02:03", "272", "4m32s" → seconds. */
export function parseTimestamp(t: string | null | undefined): number | null {
  if (!t) return null;
  const s = t.trim();
  if (/^\d+$/.test(s)) return Number(s);
  const hms = s.match(/^(?:(\d+):)?(\d{1,2}):(\d{2})$/);
  if (hms) return Number(hms[1] ?? 0) * 3600 + Number(hms[2]) * 60 + Number(hms[3]);
  const units = s.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/);
  if (units && (units[1] || units[2] || units[3])) return Number(units[1] ?? 0) * 3600 + Number(units[2] ?? 0) * 60 + Number(units[3] ?? 0);
  return null;
}

export function videoStart(url: string, timestamp: string | null): number | null {
  const fromTs = parseTimestamp(timestamp);
  if (fromTs !== null) return fromTs;
  try {
    const t = new URL(url).searchParams.get('t') ?? new URL(url).searchParams.get('start');
    return parseTimestamp(t);
  } catch {
    return null;
  }
}

export const isInstagram = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, '').endsWith('instagram.com');
  } catch {
    return false;
  }
};

export function hostLabel(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}
