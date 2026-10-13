// How a session reads as a note's origin. Shared by the server (MCP replies) and the web app.
import type { SessionKind } from './api.js';

export const SESSION_KIND_LABEL: Record<SessionKind, string> = {
  class: 'Class',
  open_mat: 'Open mat',
  private: 'Private lesson',
  seminar: 'Seminar',
  competition: 'Competition',
  drilling: 'Drilling session',
  other: 'Session',
};

export interface SessionLike {
  kind: SessionKind;
  date: string;
  name?: string | null;
  instructor?: string | null;
  location?: string | null;
}

/**
 * "Class on 2026-10-12", "Zen camp seminar by Josh Jones on 2024-02-03".
 * `when` turns the date into a phrase ("on Feb 3, 2024", "today"); return null to leave it out.
 */
export function sessionLabel(s: SessionLike, when: (date: string) => string | null = d => `on ${d}`): string {
  const noun = SESSION_KIND_LABEL[s.kind].toLowerCase();
  const name = s.name?.trim();
  let head = noun;
  if (name) {
    // A named competition or event stands on its own; don't say "Zen camp seminar seminar".
    const nameSaysKind = name.toLowerCase().includes(noun.split(' ')[0]!);
    head = s.kind === 'competition' || s.kind === 'other' || nameSaysKind ? name : `${name} ${noun}`;
  }
  const parts = [head];
  if (s.instructor?.trim()) parts.push(`by ${s.instructor.trim()}`);
  if (s.location?.trim()) parts.push(`at ${s.location.trim()}`);
  const date = when(s.date);
  if (date) parts.push(date);
  const text = parts.join(' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * "from class", "from Zen camp seminar by Josh Jones on 2024-02-03": where a note came from,
 * leaving out the date when it's the note's own date.
 */
export function noteOrigin(
  note: { observedOn: string; session: SessionLike | null },
  when: (date: string) => string | null = d => `on ${d}`,
): string | null {
  if (!note.session) return null;
  return `from ${sessionPhrase(note.session, d => (d === note.observedOn ? null : when(d)))}`;
}

/** The label for use mid-sentence: "from class on …", while a named event keeps its capital. */
export function sessionPhrase(s: SessionLike, when?: (date: string) => string | null): string {
  const label = sessionLabel(s, when);
  return s.name?.trim() ? label : label.charAt(0).toLowerCase() + label.slice(1);
}
